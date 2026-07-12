# Single image, two start commands (backend + worker) — research D2.
FROM node:22-alpine

RUN corepack enable
WORKDIR /app

# Install dependencies against the committed lockfile, then build the bundles.
# `pnpm build` also runs the web stage (`pnpm --filter @brigadir/web build`,
# feature 005 / R1): the Vite SPA is emitted to /app/apps/web/dist, which the
# backend's ServeStaticModule serves at `/` (WEB_DIST_PATH defaults there).
COPY . .
RUN pnpm install --frozen-lockfile && pnpm build

ENV NODE_ENV=production

# Overridden per-service by docker-compose (backend vs worker). The backend
# process serves both `/api/*` and the built SPA from the same image.
CMD ["node", "dist/apps/backend/main.api.js"]
