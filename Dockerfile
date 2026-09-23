# syntax=docker/dockerfile:1

FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:24-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
# Fail the build here if the native DAVE (voice encryption) binary is missing for this platform.
RUN npm ci --omit=dev && npm cache clean --force && node -e "require('@snazzah/davey')"
COPY --from=build /app/dist ./dist
COPY assets ./assets
USER node
CMD ["node", "dist/index.js"]
