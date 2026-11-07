# DSH Anywhere - minimal container image running the RELAY only.
#
# Build from the REPOSITORY ROOT (the build context must contain relay/,
# shared/, phone/, package.json). The -f path is relative to that root:
#
#   docker build -f install/Dockerfile -t dsh-anywhere:local .
#
# Run (state = secret + pair-code.txt + event log lives in a named volume):
#
#   docker run -d --name dsh-anywhere \
#     -p 8787:8787 \
#     -v dsh-anywhere-state:/app/state \
#     -e DSH_ANYWHERE_TOKEN='<a-long-random-secret>' \
#     dsh-anywhere:local
#
#   docker logs dsh-anywhere          # shows the 6-digit pairing code + URL
#
# Zero third-party npm dependencies: there is NO npm install step. Only Node
# built-ins are used (http, fs, crypto, os, path, zlib, url, child_process).

# Node 22 is the engines.minimum. The relay only stores/broadcasts JSON events,
# so it does NOT need the built-in zstd decoder. Bump to 24-alpine (or install
# the zstd CLI) if you also run the host adapter inside this image, because
# DSH session logs are concatenated zstd frames.
ARG NODE_TAG=22-alpine
FROM node:${NODE_TAG}

ENV NODE_ENV=production \
    PORT=8787 \
    HOST=0.0.0.0 \
    DSH_ANYWHERE_HOME=/app/state

WORKDIR /app

# package.json declares "type": "module" + engines; copy it first for caching.
COPY package.json ./package.json

# relay/server.mjs is the entry point. shared/ holds code imported by relay
# and host; phone/ is the PWA that the relay serves as static files at / and
# /app/*. bin/cli.mjs is copied so "all"/"relay"/"host" also work in-container.
COPY relay/   ./relay/
COPY shared/  ./shared/
COPY phone/   ./phone/
COPY bin/     ./bin/

# Persist token / pairing code / event log here. Run as the unprivileged
# "node" user shipped by the official image; only this dir is writable.
RUN mkdir -p /app/state && chown -R node:node /app /app/state
VOLUME ["/app/state"]
USER node

EXPOSE 8787

# /api/health is unauthenticated and returns {"ok":true,...}.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O - "http://127.0.0.1:${PORT}/api/health" | grep -q '"ok":true' || exit 1

# Equivalent: node bin/cli.mjs relay. Direct entry keeps the process minimal.
CMD ["node", "relay/server.mjs"]
