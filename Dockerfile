# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
COPY web/package.json web/package-lock.json* ./web/
RUN npm ci && npm ci --prefix web
COPY . .
RUN npm run build --prefix web && npx tsc -p tsconfig.json

FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates dumb-init \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY --from=build /app/web/dist ./web/dist
RUN mkdir -p /data/uploads
ENV DATABASE_PATH=/data/signer.db
ENV DATA_DIR=/data
ENV HTTP_PORT=3000
ENV SMTP_PORT=25
ENV SMTP_SUBMISSION_PORT=587
ENV SMTP_ALT_PORT=2525
EXPOSE 3000 25 587 2525
VOLUME ["/data"]
# Root is required to bind SMTP port 25. Restrict the container with a network
# policy / NSG so only Microsoft 365 and Google mail hosts can reach it.
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/server.js"]
