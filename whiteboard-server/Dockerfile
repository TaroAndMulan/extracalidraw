# Builds the self-hosted whiteboard (app + server) into a small image that only
# needs Node.js. Build from the repository root:
#
#   docker build -f whiteboard-server/Dockerfile -t extracalidraw-whiteboard .
#
# (or use deploy/docker-compose.yml)

# ---- build (runs on the build machine's platform; the output is portable) ----
FROM --platform=$BUILDPLATFORM node:22-bookworm-slim AS build

WORKDIR /opt/app
COPY . .

RUN --mount=type=cache,target=/usr/local/share/.cache/yarn \
    yarn --frozen-lockfile --network-timeout 600000

RUN yarn whiteboard:build

# ---- runtime ----
FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    PORT=3002 \
    DATA_DIR=/data \
    STATIC_DIR=/app/public

WORKDIR /app
COPY --from=build /opt/app/whiteboard-server/dist/server.mjs ./server.mjs
COPY --from=build /opt/app/whiteboard-app/build ./public

RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 3002

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:3002/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.mjs"]
