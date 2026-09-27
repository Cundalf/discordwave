# ── build ──────────────────────────────────────────────────
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ── runtime ────────────────────────────────────────────────
FROM node:22-bookworm-slim AS runtime
# ffmpeg del sistema + sodium runtime deps
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
# ffmpeg-static es opcional: si existe el binario embebido lo usa, si no el del sistema
COPY --from=build /app/dist ./dist
USER node
CMD ["node", "dist/index.js"]
