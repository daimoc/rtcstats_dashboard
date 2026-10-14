# rtcstats Dashboard

A self-hosted post-mortem dashboard for the standalone rtcstats deployment: a worker that runs deterministic rules over `features_*` to score and diagnose every dump, a read-only API, and a React frontend that shows the verdict first and the evidence charts second.

## Architecture

Four packages in one npm workspace:

| Package | Purpose |
|---------|---------|
| `@rtcstats-dashboard/rules` | Pure diagnostics library — 32 rules across 5 categories (connectivity, video, audio, device, api) |
| `@rtcstats-dashboard/analyzer` | Worker that runs `rules` over Postgres and writes two dashboard-owned tables |
| `@rtcstats-dashboard/api` | Fastify, read-only against rtcstats' schema plus the dashboard tables, proxies dumps out of MinIO |
| `@rtcstats-dashboard/web` | React + Vite + uPlot frontend, parses the raw dump client-side for charts |
| `@rtcstats-dashboard/db-features` | Shared feature-tree loader used by analyzer and api |

The dashboard never writes to `"rtcstats-server"` or `features_*`. The API connects to Postgres with a dedicated read-only role; only `analyzer` writes, and only to `dashboard_analysis` / `dashboard_observations`.

## Quick Start

### Prerequisites

- Node 22.x / npm 10.x
- Docker & Docker Compose (for local development)

### 1. Clone & install

```bash
git clone <repo-url>
cd rtcstats_dashboard
npm install
```

### 2. Start infrastructure

```bash
docker compose -f docker-compose.test.yml up -d   # Postgres + MinIO for tests
docker compose up -d                              # Full stack (Postgres + MinIO + API + analyzer)
```

### 3. Run migrations

```bash
DATABASE_URL=postgresql://postgres:postgres@localhost:5433/rtcstats \
  node scripts/migrate.mjs
```

### 4. Create an admin user

```bash
PASSWORD=your-secret-password node scripts/ops.mjs create-user
# Copy the PASSWORD_HASH output into your .env file
```

### 5. Run the analyzer

```bash
DATABASE_URL=postgresql://postgres:postgres@localhost:5433/rtcstats \
  node packages/analyzer/dist/run.js
```

### 6. Start the API server

```bash
DATABASE_URL=postgresql://postgres:postgres@localhost:5433/rtcstats \
  SESSION_SECRET=your-secret \
  PASSWORD_HASH=<from-step-4> \
  node packages/api/dist/server.js
```

### 7. Start the web frontend

```bash
cd packages/web
npm run dev
```

Open `http://localhost:5173` — log in with the password you created, then browse sessions.

## Development

### Run tests

```bash
# All packages
npx vitest run

# Single package
npx vitest run packages/rules
npx vitest run packages/analyzer
npx vitest run packages/api
npx vitest run packages/db-features
```

### Build all packages

```bash
npm run build
```

### Run E2E tests

```bash
cd packages/web
npx playwright test
```

## Single-container deployment (external Postgres + MinIO)

The root `Dockerfile` builds one image containing the web UI (nginx), the API and the
analyzer. Postgres and S3/MinIO are **not** included: point the container at existing
services with environment variables.

```bash
docker build -t rtcstats-dashboard .

docker run -d -p 8080:80 --restart unless-stopped \
  -e DATABASE_URL=postgresql://user:pw@db-host:5432/rtcstats \
  -e SESSION_SECRET=$(openssl rand -hex 32) \
  -e PASSWORD_HASH=<from `PASSWORD=... node scripts/ops.mjs create-user`> \
  -e S3_ENDPOINT=https://minio.example.com \
  -e S3_ACCESS_KEY_ID=... -e S3_SECRET_ACCESS_KEY=... \
  -e S3_BUCKET=rtcstats-dumps \
  rtcstats-dashboard
```

The UI is served on port 80 and proxies `/api/` to the API on `127.0.0.1:3000`; only port 80
needs publishing.

On startup the entrypoint runs `s/cripts/ops.mjs init` — applies `migrations/*.sql`, creates the
`dashboard_reader` / `dashboard_writer` roles and grants, and creates the S3 bucket if missing.
It is idempotent, so restarts are safe. Set `RUN_INIT=false` to skip it and initialize by hand.

`DATABASE_URL` must point at an **existing rtcstats database**: `dashboard_analysis` has a
foreign key to `"rtcstats-server"`, so init fails fast against an empty database. Grants on
upstream tables that are missing are logged as warnings rather than treated as fatal.

If any of the three processes exits, the container exits so the restart policy takes over.
`HEALTHCHECK` polls `/api/health`.

| Variable | Default | Purpose |
| --- | --- | --- |
| `BASE_PATH` | `/` | Base path for the UI and API routes |
| `DATABASE_URL` | *(required)* | External Postgres connection string |
| `SESSION_SECRET` | `change-me-in-production` | Signs the session cookie |
| `PASSWORD_HASH` | *(empty)* | Admin password hash; without it nobody can log in |
| `S3_ENDPOINT` | *(unset)* | External MinIO/S3 endpoint; dump download is disabled if unset |
| `S3_REGION` | `us-east-1` | S3 region |
| `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | *(unset)* | S3 credentials |
| `S3_BUCKET` | *(unset)* | Bucket holding the dumps |
| `PORT` | `3000` | Internal API port behind nginx |
| `ANALYZER_POLL_INTERVAL_MS` | `10000` | Analyzer poll interval |
| `ANALYZER_BATCH_SIZE` | `100` | Dumps claimed per poll |
| `ANALYZER_MOS_MAX_DUMP_BYTES` | `26214400` | Compressed dumps larger than this are not scored for MOS |
| `RUN_INIT` | `true` | Run migrations/roles/bucket setup at startup |

## Project structure

```
rtcstats_dashboard/
  package.json                      # npm workspaces root
  tsconfig.base.json
  vitest.workspace.ts
  Dockerfile                        # All-in-one image (web + API + analyzer), external pg/minio
  docker/
    nginx.conf                      # Serves the UI, proxies /api to the local API
    entrypoint.sh                   # Runs init, then nginx + API + analyzer
  docker-compose.yml                # Local stack (Postgres + MinIO + API + analyzer)
  docker-compose.test.yml           # Test stack only (Postgres + MinIO)
  migrations/
    0001_dashboard_tables.sql       # dashboard_analysis, dashboard_observations, grants
    0002_session_search_index.sql   # Trigram indexes for the call-list search
    0003_call_mos.sql               # audio_mos / video_mos columns
  scripts/
    migrate.mjs                     # Applies migrations/*.sql
    create-roles.mjs                # Creates dashboard_reader / dashboard_writer roles
    ops.mjs                         # Operational script (init, backfill, create-user)
  test/
    fixtures/000_base_schema.sql    # Condensed upstream schema, TEST DB ONLY
  packages/
    rules/                          # Pure diagnostics library
    mos/                            # Audio/video MOS models, shared by analyzer and web
    analyzer/                       # Worker: claim, load, analyze, write
    api/                            # Fastify API: auth, sessions, dump proxy
    web/                            # React + Vite frontend
    db-features/                    # Shared feature-tree loader
```

## Dashboard tables

### `dashboard_analysis`

One row per dump, replaced on re-analysis. Contains:

- `status`: `ok` | `failed` | `insufficient_data`
- `experience_score`, `audio_score`, `video_score`, `connectivity_score` (0–100)
- `audio_mos`, `video_mos` (1–5): received call quality, see [Call quality (MOS)](#call-quality-mos)
- `worst_severity`, `observations_count`, `observation_types`
- `rules_version`: hand-bumped semver, stamped on every analysis row

### `dashboard_observations`

One row per observation, linked to `dashboard_analysis`. Contains:

- `type`: rule identifier (e.g. `video.freezes`)
- `severity`: `critical` | `warning` | `info`
- `category`: `connectivity` | `video` | `audio` | `device` | `api`
- `observation`: JSONB with rule-specific data

## Analyzer worker

The analyzer polls every 10 seconds (configurable) in batches of 100 dumps (configurable), claiming with `SELECT ... FOR UPDATE SKIP LOCKED`.

### CLI options

```bash
# Backfill all dumps
DATABASE_URL=... node packages/analyzer/dist/cli.js --force

# Backfill dumps since a date
DATABASE_URL=... node packages/analyzer/dist/cli.js --from 2026-01-01 --force

# Process a single dump
DATABASE_URL=... node packages/analyzer/dist/cli.js --dump-id 42 --force
```

## API endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/health` | No | Health check (200/503) |
| GET | `/api/rules` | No | Rule catalog (32 rules) |
| POST | `/api/login` | No | Login (sets session cookie) |
| POST | `/api/logout` | No | Logout (clears session cookie) |
| GET | `/api/me` | No | Check auth status |
| GET | `/api/sessions` | Yes | Session list with keyset pagination |
| GET | `/api/sessions/:dumpId` | Yes | Session detail (analysis + observations + features + dump status) |
| GET | `/api/sessions/:dumpId/dump` | Yes | Stream raw dump from S3/MinIO |

### Session list filters

Query parameters: `from`, `to`, `user`, `conference`, `types` (comma-separated), `severity`, `maxScore`, `maxMos` (calls whose worse MOS is at or below the value), `sort` (`date` or `score`), `cursor`, `limit` (default 25, max 100).

## Rules

32 rules across 5 categories:

| Category | Rules |
|----------|-------|
| **Connectivity** (12) | `never_connected`, `slow_ice_connect`, `slow_turn_gathering`, `ice_restart`, `ice_restart_followed_by_srd`, `null_candidate_added`, `relay_only_path`, `dtls_handshake_incomplete`, `clock_skew`, `signaling_delay`, `slow_set_remote_description`, `slow_set_local_description` |
| **Video** (10) | `freezes`, `quality_limitation_cpu`, `quality_limitation_bandwidth`, `frequent_resolution_changes`, `slow_time_to_first_frame`, `slow_encode`, `slow_decode`, `no_hw_acceleration`, `null_video_decoder`, `qp_degradation` |
| **Audio** (4) | `concealment_ratio`, `jitter_buffer_flushes`, `time_stretching`, `track_ended_unexpectedly` |
| **Device** (3) | `get_user_media_failure`, `low_cpu_performance`, `frequent_reloads` |
| **API** (3) | `add_ice_candidate_failure`, `set_local_description_failure`, `set_remote_description_failure` |

Scoring: each category starts at 100. Each observation subtracts `severityWeight(severity) * thresholds.weights[type]`, clamped to `[0, 100]`. `experience` is the mean of applicable category scores, reduced by device/api weights, clamped to `[0, 100]`.

## Call quality (MOS)

Besides the rule-based 0–100 scores, every call gets an estimated mean opinion score
(1–5) for the audio and the video it **received**. The rule scores come from the
aggregate `features_*` tables. Those tables carry no packet loss, jitter, bitrate or
frame rate, so MOS is computed from the raw dump's `getStats` time series instead,
by the `packages/mos` library:

- **Audio:** ITU-T G.107 E-model. The delay is RTT/2 plus the measured jitter buffer
  delay (falling back to 2 × jitter) plus the Opus algorithmic delay. Loss uses
  `Ie = 0`, `Bpl = 25.1`. G.113 has no Opus entry, so these values are borrowed from
  G.711 with PLC.
- **Video:** ITU-T P.1203.1 mode 0, computed from the received bitrate, the decoded
  frame rate and the resolution. Two adjustments are not part of the standard:
  - VP9, H.265 and AV1 bitrates are scaled up by a codec-efficiency heuristic.
  - Frozen time pulls the score towards 1. An interval where packets arrive but no
    frame decodes scores 1.

Each `getStats` interval is scored. Simultaneous streams of the same kind are
averaged, and the call value is the time-weighted mean over the whole call.

- **Analyzer:** downloads each dump from S3 and stores `audio_mos` / `video_mos`.
  MOS is best effort: if there is no S3 configured, the dump is missing or too large
  (`ANALYZER_MOS_MAX_DUMP_BYTES`), or the dump is corrupt, the columns stay null and
  the analysis still succeeds.
- **Call list:** shows both scores and can filter on them.
- **Detail page:** shows them in the header and plots MOS over time per peer
  connection in the Evidence charts. The browser computes that chart with the same
  library.

MOS bands follow G.107 user satisfaction: ≥ 4.0 good, 3.1–4.0 fair, < 3.1 poor. These
are objective estimates for comparing calls with each other, not a listening test.

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `DATABASE_URL` | *(required)* | Postgres connection string |
| `SESSION_SECRET` | `change-me-in-production` | HMAC secret for session cookies |
| `PASSWORD_HASH` | *(empty)* | Scrypt hash of admin password |
| `S3_ENDPOINT` | *(unset)* | S3/MinIO endpoint URL; disables dump download if unset |
| `S3_REGION` | `us-east-1` | S3 region |
| `S3_ACCESS_KEY_ID` | *(unset)* | S3 access key ID |
| `S3_SECRET_ACCESS_KEY` | *(unset)* | S3 secret access key |
| `S3_BUCKET` | *(unset)* | S3 bucket name for dumps |
| `BASE_PATH` | `/` | Base path for the UI and API routes |
| `PORT` | `3000` | Internal API port behind nginx |
| `ANALYZER_POLL_INTERVAL_MS` | `10000` | Analyzer poll interval in milliseconds |
| `ANALYZER_BATCH_SIZE` | `100` | Analyzer batch size (dumps claimed per poll) |
| `ANALYZER_MOS_MAX_DUMP_BYTES` | `26214400` (25 MB) | Compressed dump size above which the analyzer skips MOS (left null) |
| `RUN_INIT` | `true` | Run migrations/roles/bucket setup at startup |

## License

Internal tool — not licensed for external use.