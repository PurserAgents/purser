# Purser engine. Built from the repository root: docker build -f engine/Dockerfile .
FROM node:24-bookworm-slim AS deps
# better-sqlite3 compiles its native module on install.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /app/engine
COPY engine/package.json engine/package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM node:24-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps /app/engine/node_modules engine/node_modules
# The engine imports the SDK's ABIs, types and EIP-712 code from packages/sdk/src, which import viem from here.
RUN ln -s /app/engine/node_modules /app/node_modules
COPY packages/sdk/src packages/sdk/src
COPY engine/package.json engine/tsconfig.json engine/
COPY engine/src engine/src
WORKDIR /app/engine
ENV PURSER_PORT=8787 PURSER_DB=/data/purser.sqlite
EXPOSE 8787
CMD ["node_modules/.bin/tsx", "src/main.ts"]
