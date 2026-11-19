FROM node:24-bookworm-slim AS build

ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0

RUN corepack enable \
  && corepack prepare pnpm@10 --activate

WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod

WORKDIR /app/web
COPY web/package.json web/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY web/ ./
RUN pnpm run build


FROM node:24-bookworm-slim AS runtime

ENV NODE_ENV=production \
    DUMATE2API_HOST=127.0.0.1 \
    DUMATE2API_PORT=18081 \
    DUMATE_ADMIN_HOST=0.0.0.0 \
    DUMATE_ADMIN_PORT=9080 \
    DUMATE_ADMIN_GATEWAY_PORT=18081 \
    DUMATE_ADMIN_DATA=/app/data

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates gosu tini \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/web/dist ./web/dist
COPY package.json pnpm-lock.yaml ./
COPY src ./src
COPY login-helper ./login-helper
COPY docker/healthcheck.js ./docker/healthcheck.js
COPY docker/entrypoint.sh /usr/local/bin/dumate-entrypoint

RUN mkdir -p /app/data \
  && chown -R node:node /app/data \
  && chmod +x /usr/local/bin/dumate-entrypoint

EXPOSE 9080
VOLUME ["/app/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "docker/healthcheck.js"]

STOPSIGNAL SIGTERM

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/dumate-entrypoint"]
