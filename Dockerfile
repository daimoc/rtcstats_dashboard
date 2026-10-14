# All-in-one image: web UI (nginx) + API + analyzer.
# Postgres and S3/MinIO are external, configured through environment variables.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/rules/package.json packages/rules/package.json
COPY packages/db-features/package.json packages/db-features/package.json
COPY packages/mos/package.json packages/mos/package.json
COPY packages/analyzer/package.json packages/analyzer/package.json
COPY packages/api/package.json packages/api/package.json
COPY packages/web/package.json packages/web/package.json
RUN npm ci && npm install --save-dev typescript @types/pg
COPY packages packages
COPY migrations migrations
COPY scripts scripts
RUN ./node_modules/.bin/tsc -p packages/rules/tsconfig.json \
 && ./node_modules/.bin/tsc -p packages/db-features/tsconfig.json \
 && ./node_modules/.bin/tsc -p packages/mos/tsconfig.json \
 && ./node_modules/.bin/tsc -p packages/analyzer/tsconfig.json \
 && ./node_modules/.bin/tsc -p packages/api/tsconfig.json \
 && ./node_modules/.bin/tsc -p packages/web/tsconfig.json
RUN cd packages/web && ../../node_modules/.bin/vite build
RUN npm prune --omit=dev

FROM node:22-alpine
RUN apk add --no-cache nginx bash curl
WORKDIR /app
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/package.json package.json
COPY --from=build /app/packages/rules/dist packages/rules/dist
COPY --from=build /app/packages/rules/package.json packages/rules/package.json
COPY --from=build /app/packages/db-features/dist packages/db-features/dist
COPY --from=build /app/packages/db-features/package.json packages/db-features/package.json
COPY --from=build /app/packages/mos/dist packages/mos/dist
COPY --from=build /app/packages/mos/package.json packages/mos/package.json
COPY --from=build /app/packages/analyzer/dist packages/analyzer/dist
COPY --from=build /app/packages/analyzer/package.json packages/analyzer/package.json
COPY --from=build /app/packages/api/dist packages/api/dist
COPY --from=build /app/packages/api/package.json packages/api/package.json
COPY --from=build /app/packages/web/dist /usr/share/nginx/html
COPY migrations migrations
COPY scripts scripts
COPY docker/nginx.conf /etc/nginx/http.d/default.conf
COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
ENV BASE_PATH=/ \
    NODE_ENV=production \
    PORT=3000 \
    S3_REGION=us-east-1 \
    ANALYZER_POLL_INTERVAL_MS=10000 \
    ANALYZER_BATCH_SIZE=100
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://127.0.0.1/api/health || exit 1
ENTRYPOINT ["/entrypoint.sh"]
