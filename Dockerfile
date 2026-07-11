# Single image, two start commands (backend + worker) — research D2.
FROM node:22-alpine

RUN corepack enable
WORKDIR /app

# Install dependencies against the committed lockfile, then build the bundles.
COPY . .
RUN pnpm install --frozen-lockfile && pnpm build

ENV NODE_ENV=production

# Overridden per-service by docker-compose (backend vs worker).
CMD ["node", "dist/apps/backend/main.api.js"]
