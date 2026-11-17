# syntax=docker/dockerfile:1
FROM node:26-alpine AS base
RUN npm install -g pnpm@12.21.0
WORKDIR /repo

FROM base AS build
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/contracts/package.json packages/contracts/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile --filter "@coffe/web..."
COPY packages/contracts packages/contracts
COPY apps/web apps/web
RUN pnpm --filter "@coffe/web..." build

FROM node:26-alpine
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3000
WORKDIR /app
# Standalone output keeps the monorepo layout (outputFileTracingRoot = repo root).
COPY --from=build /repo/apps/web/.next/standalone ./
COPY --from=build /repo/apps/web/.next/static ./apps/web/.next/static
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
