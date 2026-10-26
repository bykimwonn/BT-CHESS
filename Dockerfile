# syntax=docker/dockerfile:1
FROM node:22.22-bookworm-slim AS build
WORKDIR /app
ENV NODE_ENV=development
COPY package.json package-lock.json ./
# postinstall vendors the GPL Stockfish distribution; copy that script first.
COPY scripts/vendor-engine.mjs ./scripts/vendor-engine.mjs
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:22.22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3001 \
    HOST=0.0.0.0 \
    ALLOW_EMBEDDED_DB=false
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist-server ./dist-server
COPY --from=build /app/dist/web ./dist/web
COPY --from=build /app/server/db/migrations ./server/db/migrations
COPY --from=build /app/docs/licenses ./docs/licenses
COPY --from=build /app/.env.example ./.env.example
RUN mkdir -p /app/data && chown -R node:node /app
USER node
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["npm", "start"]
