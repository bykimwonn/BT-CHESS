# BetChess ZW - production image
#   docker build -t betchess-zw .
#   docker run -p 3000:3000 --env-file .env betchess-zw
FROM node:22-slim

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0

WORKDIR /app

# Install dependencies first so code changes do not bust the layer cache.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server.js ./
COPY lib ./lib
COPY public ./public
COPY scripts ./scripts

# Copy the browser assets (chess.js + Lichess Stockfish wasm) out of node_modules
# so the app has no CDN dependency at runtime.
RUN node scripts/vendor-assets.mjs

# JSON database lives here; mount a volume to persist it.
RUN mkdir -p /app/data
VOLUME ["/app/data"]

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/config').then(r=>{process.exit(r.ok?0:1)}).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
