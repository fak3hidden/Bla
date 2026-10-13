# Bla — single-stage image. Node 22 ships node:sqlite, so there are no native deps.
FROM node:22-alpine

ENV NODE_ENV=production \
    BLA_HOST=0.0.0.0 \
    BLA_PORT=3000 \
    BLA_DATA_DIR=/data \
    BLA_DB=/data/bla.db

WORKDIR /app

# Install dependencies first so the layer caches well.
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

# Application code.
COPY server ./server
COPY src ./src
COPY public ./public
COPY scripts ./scripts
COPY test ./test
COPY README.md LICENSE ./

# Writable data volume (database + uploads + media).
RUN mkdir -p /data && chown -R node:node /data /app
VOLUME ["/data"]

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.BLA_PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--no-warnings", "server/index.js"]
