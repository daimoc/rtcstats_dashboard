FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/rules/package.json packages/rules/package.json
COPY packages/analyzer/package.json packages/analyzer/package.json
RUN npm ci
COPY packages/rules packages/rules
COPY packages/analyzer packages/analyzer
RUN npm run build --workspace packages/rules --workspace packages/analyzer

FROM node:22-alpine
WORKDIR /app
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/packages/rules/dist packages/rules/dist
COPY --from=build /app/packages/rules/package.json packages/rules/package.json
COPY --from=build /app/packages/analyzer/dist packages/analyzer/dist
COPY --from=build /app/packages/analyzer/package.json packages/analyzer/package.json
COPY migrations migrations
COPY scripts scripts
CMD ["node", "packages/analyzer/dist/run.js"]
