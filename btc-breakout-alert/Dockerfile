# Headless background watcher (scripts/watch.ts) — sends Telegram breakout
# alerts with no browser. This image does NOT build the web app; it only runs
# the watcher process. Deploy it to any always-on host (Railway, Fly.io, a VPS,
# a Raspberry Pi…) and set TELEGRAM_TOKEN + TELEGRAM_CHAT_ID as env vars.
FROM node:22-alpine

WORKDIR /app

# Install deps including tsx (a devDependency the watcher runs through).
COPY package.json package-lock.json* ./
RUN npm install --include=dev

# Only the source the watcher actually imports.
COPY tsconfig*.json ./
COPY src ./src
COPY scripts ./scripts

CMD ["npm", "run", "watch"]
