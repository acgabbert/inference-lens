# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . ./
RUN npm run build

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production
# Stated rather than sniffed. The service otherwise infers containerization
# from /.dockerenv and cgroup markers, which are heuristics; this is our own
# image, so it can simply say so. Override with -e INFERENCE_LENS_CONTAINER=0
# when running with --network host, where loopback does reach the host.
ENV INFERENCE_LENS_CONTAINER=1
WORKDIR /app

# Vinext's standalone output includes the compiled application and only the
# runtime dependencies required by its Node server.
COPY --from=build --chown=node:node /app/dist/standalone ./
COPY --from=build --chmod=755 /app/scripts/docker-entrypoint.sh /usr/local/bin/

EXPOSE 3000

HEALTHCHECK --interval=5s --timeout=3s --start-period=5s --retries=10 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/').then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"]

USER node
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "server.js"]
