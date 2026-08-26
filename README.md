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

## Project structure

```
rtcstats_dashboard/
  package.json                      # npm workspaces root
  tsconfig.base.json
  vitest.workspace.ts
  docker-compose.yml                # Production stack (Postgres + MinIO + API + analyzer)
  docker-compose.test.yml           # Test stack only (Postgres + MinIO)
  migrations/
    0001_dashboard_tables.sql       # dashboard_analysis, dashboard_observations, grants
  scripts/
    migrate.mjs                     # Applies migrations/*.sql
    create-roles.mjs                # Creates dashboard_reader / dashboard_writer roles
    ops.mjs                         # Operational script (init, backfill, create-user)
  test/
    fixtures/000_base_schema.sql    # Condensed upstream schema, TEST DB ONLY
  packages/
    rules/                          # Pure diagnostics library
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

Query parameters: `from`, `to`, `user`, `conference`, `types` (comma-separated), `severity`, `maxScore`, `sort` (`date` or `score`), `cursor`, `limit` (default 25, max 100).

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

## Environment variables

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | Postgres connection string |
| `SESSION_SECRET` | HMAC secret for session tokens |
| `PASSWORD_HASH` | Scrypt hash of admin password |
| `S3_ENDPOINT` | S3/MinIO endpoint URL |
| `S3_BUCKET` | S3 bucket name for dumps |
| `ANALYZER_POLL_INTERVAL_MS` | Analyzer poll interval (default: 10000) |
| `ANALYZER_BATCH_SIZE` | Analyzer batch size (default: 100) |

## License

Internal tool — not licensed for external use.