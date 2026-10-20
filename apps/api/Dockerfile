# Build from the repository root:
#   docker build -f apps/api/Dockerfile .
FROM node:22-alpine AS build
RUN corepack enable && corepack prepare pnpm@12.14.0 --activate
WORKDIR /repo
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/api/package.json apps/api/package.json
COPY packages/contract/package.json packages/contract/package.json
RUN pnpm install --frozen-lockfile --filter @hamalert/api...
COPY apps/api apps/api
RUN pnpm --filter @hamalert/api build

FROM node:22-alpine
RUN corepack enable && corepack prepare pnpm@12.14.0 --activate
WORKDIR /repo
ENV NODE_ENV=production
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/api/package.json apps/api/package.json
COPY packages/contract/package.json packages/contract/package.json
RUN pnpm install --frozen-lockfile --filter @hamalert/api --prod
COPY --from=build /repo/apps/api/dist apps/api/dist
EXPOSE 8082
CMD ["node", "apps/api/dist/index.js"]
