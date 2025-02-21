# Use GNU grep (installed as “ggrep” on macOS) to support -P.
GREP ?= ggrep

# Try to get the commit hash from 1) git 2) the VERSION file 3) fallback.
LAST_COMMIT := $(or $(shell git rev-parse --short HEAD 2> /dev/null),$(shell head -n 1 VERSION | $(GREP) -oP -m 1 "^[a-z0-9]+$$"),"")

# Try to get the semver from 1) git 2) the VERSION file 3) fallback.
VERSION := $(or $(LISTMONK_VERSION),$(shell git describe --tags --abbrev=0 2> /dev/null),$(shell $(GREP) -oP 'tag: \Kv\d+\.\d+\.\d+(-[a-zA-Z0-9.-]+)?' VERSION),"v0.0.0")

BUILDSTR := ${VERSION} (\#${LAST_COMMIT} $(shell date -u +"%Y-%m-%dT%H:%M:%S%z"))

YARN ?= yarn
GOPATH ?= $(HOME)/go
STUFFBIN ?= $(GOPATH)/bin/stuffbin
FRONTEND_YARN_MODULES = frontend/node_modules
FRONTEND_DIST = frontend/dist
FRONTEND_DEPS = \
	$(FRONTEND_YARN_MODULES) \
	frontend/index.html \
	frontend/package.json \
	frontend/vite.config.js \
	frontend/.eslintrc.js \
	$(shell find frontend/fontello frontend/public frontend/src -type f)

BIN := listmonk
STATIC := config.toml.sample \
	schema.sql queries.sql permissions.json \
	static/public:/public \
	static/email-templates \
	frontend/dist:/admin \
	i18n:/i18n

.PHONY: build
build: $(BIN)

$(STUFFBIN):
	go install github.com/knadh/stuffbin/...

$(FRONTEND_YARN_MODULES): frontend/package.json frontend/yarn.lock
	cd frontend && $(YARN) install
	touch -c $(FRONTEND_YARN_MODULES)

# Default build => local architecture
$(BIN): $(shell find . -type f -name "*.go") go.mod go.sum schema.sql queries.sql permissions.json
	CGO_ENABLED=0 go build -o ${BIN} \
		-ldflags="-s -w -X 'main.buildString=${BUILDSTR}' -X 'main.versionString=${VERSION}'" \
		cmd/*.go

# Apple Silicon build => if you want an arm64 binary
.PHONY: build-arm64
build-arm64: $(shell find . -type f -name "*.go") go.mod go.sum schema.sql queries.sql permissions.json
	GOOS=darwin GOARCH=arm64 CGO_ENABLED=0 go build -o ${BIN} \
		-ldflags="-s -w -X 'main.buildString=${BUILDSTR}' -X 'main.versionString=${VERSION}'" \
		cmd/*.go

.PHONY: run
run:
	CGO_ENABLED=0 go run -ldflags="-s -w -X 'main.buildString=${BUILDSTR}' -X 'main.versionString=${VERSION}' -X 'main.frontendDir=frontend/dist'" cmd/*.go

$(FRONTEND_DIST): $(FRONTEND_DEPS)
	export VUE_APP_VERSION="${VERSION}" && cd frontend && $(YARN) build
	touch -c $(FRONTEND_DIST)

.PHONY: build-frontend
build-frontend: $(FRONTEND_DIST)

.PHONY: run-frontend
run-frontend:
	export VUE_APP_VERSION="${VERSION}" && cd frontend && $(YARN) dev

.PHONY: test
test:
	go test ./...

# Creates a stuffed binary with static assets
.PHONY: dist
dist: $(STUFFBIN) build build-frontend pack-bin

.PHONY: pack-bin
pack-bin: build-frontend $(BIN) $(STUFFBIN)
	$(STUFFBIN) -a stuff -in ${BIN} -out ${BIN} ${STATIC}

.PHONY: release-dry
release-dry:
	goreleaser release --parallelism 1 --clean --snapshot --skip=publish

.PHONY: release
release:
	goreleaser release --parallelism 1 --clean

# Docker dev stuff
.PHONY: build-dev-docker
build-dev-docker: build
	cd dev; \
	docker compose build ;

.PHONY: dev-docker
dev-docker: build-dev-docker
	cd dev; \
	docker compose up

.PHONY: run-backend-docker
run-backend-docker:
	CGO_ENABLED=0 go run -ldflags="-s -w -X 'main.buildString=${BUILDSTR}' -X 'main.versionString=${VERSION}' -X 'main.frontendDir=frontend/dist'" cmd/*.go --config=dev/config.toml

.PHONY: rm-dev-docker
rm-dev-docker: build
	cd dev; \
	docker compose down -v ;

.PHONY: init-dev-docker
init-dev-docker: build-dev-docker
	cd dev; \
	docker compose run --rm backend sh -c "make dist && ./listmonk --install --idempotent --yes --config dev/config.toml"

# Local non-docker init
.PHONY: init
init: $(BIN)
	@echo "Attempting to create pgcrypto extension (if not already present)..."
	@psql -d listmonk -c "CREATE EXTENSION IF NOT EXISTS pgcrypto;" || echo "Warning: Unable to create pgcrypto extension. Ensure your PostgreSQL user has the required permissions."
	@echo "Initializing database schema..."
	./$(BIN) --config config.toml --install --idempotent --yes
