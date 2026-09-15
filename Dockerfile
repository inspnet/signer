# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
COPY web/package.json web/package-lock.json* ./web/
RUN npm install && cd web && npm install
COPY . .
RUN npm run build --prefix web && npx tsc -p tsconfig.json

FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates dumb-init \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY --from=build /app/dist ./dist
COPY --from=build /app/web/dist ./web/dist
RUN mkdir -p /data/uploads
ENV DATABASE_PATH=/data/signer.db
ENV DATA_DIR=/data
ENV HTTP_PORT=3000
ENV SMTP_PORT=0
ENV SMTP_SUBMISSION_PORT=587
ENV SMTP_ALT_PORT=0
ENV SMTP_REQUIRE_TLS=true
EXPOSE 3000 587
VOLUME ["/data"]
# Bind 25 only when SMTP_PORT=25 (Exchange Online smart-host + STARTTLS).
# Firewall that port to Microsoft/Google mail hosts — never the open internet.
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/server.js"]
