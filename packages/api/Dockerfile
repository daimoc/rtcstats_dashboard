FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/rules/package.json packages/rules/package.json
COPY packages/analyzer/package.json packages/analyzer/package.json
COPY packages/api/package.json packages/api/package.json
COPY packages/db-features/package.json packages/db-features/package.json
COPY packages/mos/package.json packages/mos/package.json
RUN npm ci && npm install --save-dev typescript @types/pg
COPY packages/rules packages/rules
COPY packages/analyzer packages/analyzer
COPY packages/api packages/api
COPY packages/db-features packages/db-features
COPY packages/mos packages/mos
COPY migrations migrations
COPY scripts scripts
RUN ./node_modules/.bin/tsc -p packages/rules/tsconfig.json && ./node_modules/.bin/tsc -p packages/db-features/tsconfig.json \
 && ./node_modules/.bin/tsc -p packages/mos/tsconfig.json && ./node_modules/.bin/tsc -p packages/analyzer/tsconfig.json && ./node_modules/.bin/tsc -p packages/api/tsconfig.json && ./node_modules/.bin/tsc -p packages/db-features/tsconfig.json

FROM node:22-alpine
WORKDIR /app
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/packages/rules/dist packages/rules/dist
COPY --from=build /app/packages/rules/package.json packages/rules/package.json
COPY --from=build /app/packages/analyzer/dist packages/analyzer/dist
COPY --from=build /app/packages/analyzer/package.json packages/analyzer/package.json
COPY --from=build /app/packages/api/dist packages/api/dist
COPY --from=build /app/packages/api/package.json packages/api/package.json
COPY --from=build /app/packages/db-features/dist packages/db-features/dist
COPY --from=build /app/packages/db-features/package.json packages/db-features/package.json
COPY --from=build /app/packages/mos/dist packages/mos/dist
COPY --from=build /app/packages/mos/package.json packages/mos/package.json
COPY migrations migrations
COPY scripts scripts
CMD ["node", "packages/api/dist/server.js"]
