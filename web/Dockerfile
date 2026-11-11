# Purser website. Built from the repository root: docker build -f web/Dockerfile .
FROM node:24-bookworm-slim AS build
ENV NEXT_TELEMETRY_DISABLED=1
WORKDIR /app/web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
# The framework guides are read from packages/sdk/guides at build time.
COPY packages/sdk/guides /app/packages/sdk/guides
COPY web/ ./
RUN npm run build && npm prune --omit=dev

FROM node:24-bookworm-slim
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
WORKDIR /app/web
COPY --from=build /app/packages/sdk/guides /app/packages/sdk/guides
COPY --from=build /app/web/package.json /app/web/next.config.ts ./
COPY --from=build /app/web/node_modules ./node_modules
COPY --from=build /app/web/public ./public
COPY --from=build /app/web/src/assets ./src/assets
COPY --from=build /app/web/.next ./.next
EXPOSE 3000
CMD ["sh", "-c", "exec node_modules/.bin/next start -p ${PORT:-3000}"]
