# The Bookdelver server as an image. Built from this folder (the published
# server, or packages/server in the Bookdelver repository after
# `npm run server:export`): the bundle made in one stage, run in the next
# with its one dependency, `ws`.
#
#   docker build -t bookdelver-server .
#
# The published image is ghcr.io/cwpetrich/bookdelver-server, built by
# .github/workflows/image.yml on each version tag.
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json README.md LICENSE ./
RUN npm ci --omit=dev --ignore-scripts && mkdir /data && chown node:node /data
COPY --from=build /app/dist ./dist
USER node
ENV BOOKDELVER_DATA=/data
EXPOSE 8787
VOLUME ["/data"]
CMD ["node", "dist/bookdelver-server.mjs"]
