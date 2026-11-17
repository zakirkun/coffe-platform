# syntax=docker/dockerfile:1
FROM node:26-alpine AS base
RUN npm install -g pnpm@12.21.0
WORKDIR /repo

FROM base AS build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/protocol/package.json packages/protocol/
COPY packages/contracts/package.json packages/contracts/
COPY apps/api/package.json apps/api/
RUN pnpm install --frozen-lockfile --filter "@coffe/api..."
COPY packages/protocol packages/protocol
COPY packages/contracts packages/contracts
COPY apps/api apps/api
RUN pnpm --filter "@coffe/api..." build \
 && pnpm --filter @coffe/api deploy --prod --legacy /out \
 && cp -r apps/api/dist apps/api/drizzle /out/

FROM node:26-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out /app
USER node
EXPOSE 4000
CMD ["node", "dist/main.js"]
