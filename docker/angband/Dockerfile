# Angband TS game server (ai-server.ts) and the busho AI player share this image.
FROM node:22-slim

WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/@angband/core/package.json packages/@angband/core/
COPY packages/@angband/renderer/package.json packages/@angband/renderer/
COPY packages/@angband/web/package.json packages/@angband/web/
COPY tools/data-converter/package.json tools/data-converter/
RUN npm ci

COPY . .

EXPOSE 3000
CMD ["npx", "tsx", "packages/@angband/core/src/borg/ai-server.ts", "--port", "3000"]
