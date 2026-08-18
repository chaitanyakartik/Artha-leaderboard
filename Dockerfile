# syntax=docker/dockerfile:1

# ---- builder: compile the one native dep (better-sqlite3) for linux ----
FROM node:20-bookworm-slim AS builder
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .

# ---- runtime: slim image, no build tools ----
FROM node:20-bookworm-slim AS runtime
ENV NODE_ENV=production \
    ARTHA_DATA=/app/data \
    PORT=5173
WORKDIR /app
# linux-built node_modules from the builder, then the app source (respects .dockerignore)
COPY --from=builder /app/node_modules ./node_modules
COPY . .
RUN chmod +x docker-entrypoint.sh \
    && mkdir -p /app/data \
    && chown -R node:node /app
USER node
EXPOSE 5173
# init-on-fresh-volume then start (see docker-entrypoint.sh)
ENTRYPOINT ["./docker-entrypoint.sh"]
