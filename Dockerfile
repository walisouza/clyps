# ── Build do app web ──
FROM node:22-bookworm-slim AS web
WORKDIR /web
COPY web/package.json web/package-lock.json* ./
RUN npm install
COPY web .
RUN npm run build

# ── Servidor (API + fila de cortes) ──
FROM node:22-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg python3 ca-certificates curl fonts-inter fontconfig \
 && curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
 && chmod +x /usr/local/bin/yt-dlp \
 && mkdir -p /usr/share/clyps \
 && curl -fsSL https://raw.githubusercontent.com/richardpl/arnndn-models/master/std.rnnn -o /usr/share/clyps/std.rnnn \
 && fc-cache -f \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app/server
COPY server/package.json server/package-lock.json* ./
RUN npm install --omit=dev
COPY server/src ./src
COPY --from=web /web/dist /app/web/dist

ENV NODE_ENV=production PORT=3000 DATA_DIR=/data WEB_DIR=/app/web/dist RNNOISE_MODEL=/usr/share/clyps/std.rnnn
VOLUME /data
EXPOSE 3000
CMD ["npx", "tsx", "src/index.ts"]
