# The relayer as a container, for Fly.io or Render. Build from the repo root:
#   docker build -f relayer/deploy/Dockerfile .
FROM node:22-slim
WORKDIR /app

# Only what the relayer needs: the root manifest, the SDK and the relayer.
COPY package.json package-lock.json ./
COPY packages/sdk/package.json packages/sdk/
COPY relayer/package.json relayer/
RUN npm ci -w @pmec/relayer -w @pmec/sdk --include-workspace-root=false --no-audit --no-fund

COPY tsconfig.base.json ./
COPY packages/sdk packages/sdk
COPY relayer/src relayer/src
COPY relayer/config relayer/config
COPY relayer/fixtures relayer/fixtures
COPY relayer/tsconfig.json relayer/
COPY relayer/deploy/entrypoint.sh relayer/deploy/
# Optional starting database (market names, pair records, trade history).
COPY relayer/deploy/seed/ relayer/deploy/seed/

ENV NODE_ENV=production \
    NODE_NO_WARNINGS=1 \
    RELAYER_HOST=0.0.0.0 \
    RELAYER_DATA_DIR=/data \
    ORACLE_KEYPAIR=/run/keys/oracle.json \
    ADMIN_KEYPAIR=/run/keys/admin.json
EXPOSE 8787
CMD ["sh", "relayer/deploy/entrypoint.sh"]
