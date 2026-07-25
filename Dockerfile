# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . ./
RUN npm run build

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app

# Vinext's standalone output includes the compiled application and only the
# runtime dependencies required by its Node server.
COPY --from=build /app/dist/standalone ./

EXPOSE 3000

CMD ["node", "server.js"]
