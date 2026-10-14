#!/bin/bash
# Entrypoint for the all-in-one rtcstats-dashboard image.
# Runs nginx (static UI + /api proxy), the API and the analyzer in one container,
# against an external Postgres and an external S3/MinIO endpoint.
set -euo pipefail

if [ -z "${DATABASE_URL:-}" ]; then
  echo "DATABASE_URL is required" >&2
  exit 1
fi
if [ -z "${PASSWORD_HASH:-}" ]; then
  echo "warning: PASSWORD_HASH is empty, nobody will be able to log in" >&2
fi
if [ -z "${SESSION_SECRET:-}" ]; then
  echo "warning: SESSION_SECRET is unset, falling back to the built-in default" >&2
fi

BASE_PATH="${BASE_PATH:-/}"
BASE_PATH="${BASE_PATH%/}"
if [ -z "$BASE_PATH" ]; then
  BASE_PATH="/"
fi

# Generate runtime config for the frontend
cat > /usr/share/nginx/html/config.json <<EOF
{"basePath":"${BASE_PATH}"}
EOF

# Generate nginx config with correct BASE_PATH
WEB_LOCATION_BLOCK=""
API_LOCATION_BLOCK=""

if [ "$BASE_PATH" = "/" ]; then
  WEB_LOCATION_BLOCK='    location / {
        try_files $uri $uri/ /index.html;
    }

    location /api/ {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection '"'"'upgrade'"'"';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }'
else
  WEB_LOCATION_BLOCK="    location ${BASE_PATH}/ {
        alias /usr/share/nginx/html/;
        try_files \$uri \$uri/ ${BASE_PATH}/index.html;
    }

    location = ${BASE_PATH} {
        return 301 ${BASE_PATH}/;
    }

    location ${BASE_PATH}/api/ {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection '"'"'upgrade'"'"';
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_cache_bypass \$http_upgrade;
    }"
fi

# Write generated nginx config
cat > /etc/nginx/http.d/default.conf <<NGINX_EOF
server {
    listen 80;
    server_name localhost;
    root /usr/share/nginx/html;
    index index.html;

${WEB_LOCATION_BLOCK}

${API_LOCATION_BLOCK}
}
NGINX_EOF

if [ "${RUN_INIT:-true}" = "true" ]; then
  if ! node scripts/ops.mjs init; then
    echo "init failed: DATABASE_URL must point at an existing rtcstats database" >&2
    echo "(the dashboard tables reference \"rtcstats-server\"); set RUN_INIT=false to skip" >&2
    exit 1
  fi
fi

nginx -g 'daemon off;' &
BASE_PATH=$BASE_PATH node packages/api/dist/server.js &
node packages/analyzer/dist/run.js &

# Exit as soon as any of the three dies, so the restart policy can take over.
status=0
wait -n || status=$?
echo "a supervised process exited with status ${status}, shutting down" >&2
kill 0 2>/dev/null || true
exit "${status}"
