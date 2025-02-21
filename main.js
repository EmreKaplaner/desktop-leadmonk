// main.js
const { app, BrowserWindow, dialog } = require('electron');
const { spawn, execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const net = require('net');

// 1) Single-instance lock to avoid collisions with multiple app launches.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  // Another instance is already running, so exit.
  app.quit();
} else {
  // Listen for second-instance event (someone tries to open app again).
  app.on('second-instance', () => {
    // Focus the existing window if we have one.
    if (BrowserWindow.getAllWindows().length) {
      const win = BrowserWindow.getAllWindows()[0];
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
}

// Async wrapper
(async () => {
  const { default: isDev } = await import('electron-is-dev');

  let pgProcess = null;
  let listmonkProcess = null;
  // We'll track if we're quitting intentionally, so we don't show "crashed unexpectedly"
  let isQuitting = false;
  let mainWindow = null;

  // Directories / binaries
  let pgBinDir, listmonkBinary, configPath;
  if (isDev) {
    pgBinDir = path.join(__dirname, 'pg-dist', 'macos', 'bin');
    listmonkBinary = path.join(__dirname, 'listmonk');
    configPath = path.join(__dirname, 'config.toml');
  } else {
    pgBinDir = path.join(process.resourcesPath, 'pg-dist', 'bin');
    listmonkBinary = path.join(process.resourcesPath, 'listmonk');
    configPath = path.join(process.resourcesPath, 'config.toml');
  }

  const postgresCmd = path.join(pgBinDir, 'postgres');
  const initdbCmd = path.join(pgBinDir, 'initdb');

  console.log('isDev =', isDev);
  console.log('postgresCmd =>', postgresCmd);
  console.log('initdbCmd   =>', initdbCmd);
  console.log('listmonkBinary =>', listmonkBinary);
  console.log('configPath     =>', configPath);

  // Data dir for Postgres
  const DATA_DIR = path.join(app.getPath('userData'), 'listmonk-db');
  console.log('DATA_DIR =>', DATA_DIR);

  // 2) Find an ephemeral port for Postgres.
  //    We'll attempt to find a free port starting around 54321,
  //    but we can shift if it’s already taken.
  async function findFreePort(startPort = 54321, maxAttempts = 20) {
    let port = startPort;
    for (let i = 0; i < maxAttempts; i++) {
      const isFree = await new Promise((resolve) => {
        const tester = net.createServer()
          .once('error', () => resolve(false))
          .once('listening', () => {
            tester.once('close', () => resolve(true)).close();
          })
          .listen(port);
      });
      if (isFree) {
        return port;
      }
      port++;
    }
    // If we can’t find a free port after maxAttempts, just return the startPort anyway
    // or throw an error. We'll throw, so we know the DB can't start.
    throw new Error(`No free port found for Postgres starting at ${startPort}`);
  }

  // Utility: create or append logs to a file for child processes.
  function createLogStream(logFileName) {
    const logDir = path.join(app.getPath('userData'), 'logs');
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    const fullPath = path.join(logDir, logFileName);
    const logStream = fs.createWriteStream(fullPath, { flags: 'a' });
    return logStream;
  }

  // 3) Clean leftover Postgres lockfiles if they exist (e.g. postmaster.pid).
  function cleanLeftoverLockFile() {
    const pidFile = path.join(DATA_DIR, 'postmaster.pid');
    if (fs.existsSync(pidFile)) {
      console.log('[startup] Found leftover postmaster.pid; removing it.');
      try {
        fs.unlinkSync(pidFile);
      } catch (err) {
        console.warn('[startup] Could not remove leftover lock file:', err);
      }
    }
  }

  // 4) Initialize the Postgres data directory if needed.
  async function initDbIfNeeded() {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    // Remove leftover lockfiles if any
    cleanLeftoverLockFile();

    const initMarker = path.join(DATA_DIR, 'initialized.txt');
    if (!fs.existsSync(initMarker)) {
      console.log('[startup] Running initdb...');
      await new Promise((resolve, reject) => {
        const proc = spawn(initdbCmd, [
          '-D', DATA_DIR,
          '--username=postgres',
          '--auth=trust',
          '--auth-local=trust'
        ]);

        proc.on('error', (err) => {
          console.error('[initdb spawn error]', err);
          reject(err);
        });
        proc.stdout.on('data', (d) => console.log('[initdb]', d.toString()));
        proc.stderr.on('data', (d) => console.error('[initdb ERR]', d.toString()));

        proc.on('close', (code) => {
          if (code === 0) {
            fs.writeFileSync(initMarker, 'done');
            resolve();
          } else {
            reject(new Error(`initdb exited with code ${code}`));
          }
        });
      });
    }
  }

  // 5) Start Postgres on a chosen ephemeral port
  async function startPostgres(port) {
    return new Promise((resolve, reject) => {
      console.log(`[startup] Starting Postgres on port ${port} from:`, postgresCmd);

      // Create a log stream for Postgres
      const pgLogStream = createLogStream('postgres.log');

      const proc = spawn(postgresCmd, [
        '-D', DATA_DIR,
        '-p', port.toString()
      ], {
        // We'll pipe stdout/stderr for logging
        stdio: ['ignore', 'pipe', 'pipe']
      });

      proc.stdout.pipe(pgLogStream);
      proc.stderr.pipe(pgLogStream);

      proc.on('error', (err) => {
        console.error('[postgres spawn error]', err);
        reject(err);
      });

      // We'll consider "database system is ready" as success
      function checkLine(line) {
        if (line.includes('database system is ready to accept connections')) {
          resolve();
        }
      }

      proc.stdout.on('data', (data) => {
        const txt = data.toString();
        console.log('[postgres]', txt);
        checkLine(txt);
      });

      proc.stderr.on('data', (data) => {
        const txt = data.toString();
        console.error('[postgres ERR]', txt);
        checkLine(txt);
      });

      proc.on('close', (code) => {
        console.log(`[postgres] exited with code ${code}`);
        if (!isQuitting && code !== 0) {
          dialog.showErrorBox('Postgres Error', 'Postgres crashed unexpectedly.');
        }
      });

      pgProcess = proc;
    });
  }

  // 6) Run Listmonk migrations (install) with ephemeral DB.
  async function installListmonk(pgPort) {
    console.log('[startup] Installing (migrating) Listmonk schema...');
    return new Promise((resolve, reject) => {
      const envVars = {
        ...process.env,
        LISTMONK_db__host: '127.0.0.1',
        LISTMONK_db__port: pgPort.toString(),
        LISTMONK_db__database: 'postgres',
        LISTMONK_db__user: 'postgres',
        LISTMONK_db__password: '',
        LISTMONK_app__address: '127.0.0.1:0' // ephemeral
      };

      execFile(
        listmonkBinary,
        ['--config', configPath, '--install', '--idempotent', '--yes'],
        { env: envVars },
        (err, stdout, stderr) => {
          if (err) {
            console.error('[listmonk install ERR]', stderr);
            return reject(err);
          }
          console.log('[listmonk install OUT]', stdout);
          resolve();
        }
      );
    });
  }

  // 7) Start Listmonk on ephemeral port, parse logs to retrieve the actual port.
  async function startListmonk(pgPort) {
    console.log('[startup] Starting Listmonk...');

    return new Promise((resolve, reject) => {
      // Create a log stream for Listmonk
      const lmLogStream = createLogStream('listmonk.log');

      const envVars = {
        ...process.env,
        LISTMONK_db__host: '127.0.0.1',
        LISTMONK_db__port: pgPort.toString(),
        LISTMONK_db__database: 'postgres',
        LISTMONK_db__user: 'postgres',
        LISTMONK_db__password: '',
        LISTMONK_app__address: '127.0.0.1:0'
      };

      const proc = spawn(listmonkBinary, [
        '--config', configPath
      ], {
        env: envVars,
        stdio: ['ignore', 'pipe', 'pipe']
      });

      listmonkProcess = proc;

      proc.stdout.pipe(lmLogStream);
      proc.stderr.pipe(lmLogStream);

      let ephemeralPort = null;

      proc.on('error', (err) => {
        console.error('[listmonk spawn error]', err);
        reject(err);
      });

      proc.stdout.on('data', (data) => {
        const line = data.toString();
        console.log('[listmonk]', line);

        // Attempt to parse ephemeral port from lines like:
        // "http server started on 127.0.0.1:12345"
        // or "Web server listening on http://127.0.0.1:12345"
        let match = line.match(/http server started on 127\.0\.0\.1:(\d+)/);
        if (!match) {
          // try the other pattern
          match = line.match(/Web server listening on http:\/\/127\.0\.0\.1:(\d+)/);
        }
        if (match) {
          ephemeralPort = match[1];
          resolve({ ephemeralPort });
        }
      });

      proc.stderr.on('data', (data) => {
        const txt = data.toString();
        console.error('[listmonk ERR]', txt);
      });

      proc.on('close', (code) => {
        console.log(`[listmonk] exited with code ${code}`);
        if (!isQuitting && code !== 0) {
          dialog.showErrorBox('Listmonk Stopped', 'Listmonk crashed unexpectedly.');
        }
      });
    });
  }

  // Create main browser window
  function createWindow(port) {
    mainWindow = new BrowserWindow({ width: 1280, height: 800 });
    const finalPort = port || '9000';
    mainWindow.loadURL(`http://127.0.0.1:${finalPort}`);
  }

  // App readiness
  app.whenReady().then(async () => {
    try {
      // Step A) ephemeral DB init (ensure data dir exists)
      await initDbIfNeeded();

      // Step B) find a free port for Postgres
      const pgPort = await findFreePort();

      // Step C) start Postgres
      await startPostgres(pgPort);
      console.log(`Postgres started on port ${pgPort}`);

      // Step D) listmonk install => ephemeral DB
      await installListmonk(pgPort);
      console.log('Listmonk DB schema installed.');

      // Step E) start listmonk => ephemeral port
      const { ephemeralPort } = await startListmonk(pgPort);
      const finalPort = ephemeralPort || '9000';
      console.log(`Listmonk is up on ephemeral port ${finalPort}, now loading Electron window...`);

      // Step F) show the window
      createWindow(finalPort);

    } catch (err) {
      dialog.showErrorBox('Startup Error', err.toString());
      app.quit();
    }
  });

  // 8) Handle all windows closed
  app.on('window-all-closed', () => {
    app.quit();
  });

  // We'll set isQuitting = true so we don't show "crashed unexpectedly"
  app.on('before-quit', () => {
    isQuitting = true;
  });

  // 9) Graceful shutdown
  app.on('will-quit', () => {
    // Send SIGTERM so Postgres can clean up. If that fails, we do .kill() anyway.
    if (listmonkProcess) {
      try {
        listmonkProcess.kill('SIGTERM');
      } catch (_) {
        listmonkProcess.kill();
      }
    }
    if (pgProcess) {
      try {
        pgProcess.kill('SIGTERM');
      } catch (_) {
        pgProcess.kill();
      }
    }
  });

})().catch((err) => {
  console.error('[Main Error]', err);
  process.exit(1);
});
