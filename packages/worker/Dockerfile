# Kaap's watcher as one container, built from source. Build from the repository root:
#
#   docker build -f packages/worker/Dockerfile -t kaap-watcher .
#
# Three stages. The first compiles the rules engine bridge to WebAssembly. The second installs the
# watcher's packages, with the compiler its database library needs. The third is plain Node with
# those packages, the watcher's source and that one wasm file, and no compiler. No key is ever in
# the image: the watcher's key is a file on a mounted disk, named by
# KAAP_WORKER_CREDENTIALS_FILE, and every other setting is an environment variable (.env.example
# at the repository root lists them).

FROM rust:1.93.0-slim-bookworm AS bridge
RUN rustup target add wasm32-unknown-unknown
WORKDIR /src
# kaap-core takes its dependency versions from the root manifest, so that file comes along. The
# bridge has its own lock file, which pins every crate to the version the guard was built with.
COPY Cargo.toml ./
COPY packages/verdict packages/verdict
COPY packages/core packages/core
COPY packages/worker/bridge packages/worker/bridge
RUN cargo build --locked --manifest-path packages/worker/bridge/Cargo.toml --target wasm32-unknown-unknown --release

FROM node:24-bookworm-slim AS packages
# better-sqlite3 compiles its native part on install.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /app
# npm checks the lock file against every workspace it names, so each one's manifest is here. Only
# the watcher's packages are installed.
COPY package.json package-lock.json ./
COPY packages/worker/package.json packages/worker/package.json
COPY packages/cli/package.json packages/cli/package.json
COPY packages/attack/package.json packages/attack/package.json
RUN npm ci --omit=dev -w packages/worker

FROM node:24-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=packages /app/node_modules node_modules
COPY --from=packages /app/packages/worker packages/worker
COPY package.json ./
COPY packages/worker/src packages/worker/src
# The watcher reads the sealed reader's text key from the deployment record.
COPY deployments deployments
COPY --from=bridge /src/packages/worker/bridge/target/wasm32-unknown-unknown/release/kaap_worker_bridge.wasm packages/worker/dist/kaap-worker-bridge.wasm
EXPOSE 8787
CMD ["node", "packages/worker/src/main.ts"]
