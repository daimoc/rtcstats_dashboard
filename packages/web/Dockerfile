FROM node:22-alpine AS build
WORKDIR /app
COPY packages/web/package.json ./
RUN npm install
COPY packages/web ./
COPY tsconfig.base.json /tsconfig.base.json
RUN node node_modules/vite/bin/vite.js build

FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY packages/web/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]