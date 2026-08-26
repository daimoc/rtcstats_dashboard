# rtcstats-dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a self-hosted post-mortem dashboard for the standalone rtcstats deployment: a worker that runs deterministic rules over `features_*` to score and diagnose every dump, a read-only API, and a React frontend that shows the verdict first and the evidence charts second.

**Architecture:** Four packages in one npm workspace — `rules` (pure diagnostics library), `analyzer` (worker that runs `rules` over Postgres and writes two new dashboard-owned tables), `api` (Fastify, read-only against rtcstats' schema plus the dashboard tables, proxies dumps out of MinIO), `web` (React + Vite + uPlot, parses the raw dump client-side for charts). The dashboard never writes to `"rtcstats-server"` or `features_*`.

**Tech Stack:** Node 22 / npm 10 workspaces, TypeScript, Vitest, Fastify, `pg`, `@aws-sdk/client-s3` (MinIO is S3-compatible), React + Vite + react-router, uPlot, Playwright.

**Spec:** `docs/superpowers/specs/2026-08-26-rtcstats-dashboard-design.md`

## Global Constraints

- Node 22.x / npm 10.x (confirmed local toolchain).
- The dashboard never writes to `"rtcstats-server"` or any `features_*` table. The API connects to Postgres with a dedicated read-only role; only `analyzer` writes, and only to `dashboard_analysis` / `dashboard_observations`.
- One row per dump in `dashboard_analysis`, replaced on re-analysis — never versioned/accumulated.
- `rules_version` is a hand-bumped semver constant, stamped on every analysis row. Only `--force` re-processes rows with `status='failed'`.
- Pagination on `/api/sessions` is keyset only (`(session_start, id)` or `(experience_score, id)`) — never offset.
- `/api/sessions/:dumpId/dump` proxies bytes through the API; it never returns a presigned MinIO URL.
- Session cookie: `httpOnly`, `sameSite=lax`, ~7 day expiry. Login is rate-limited to 10 attempts per IP per 15 minutes.
- Browser dump parsing asks for confirmation above 25 MB compressed (configurable).
- The analyzer worker polls every 10 seconds (configurable) in batches of 100 dumps (configurable), claiming with `SELECT ... FOR UPDATE SKIP LOCKED`.
- Human-readable observation text lives only in the frontend (`packages/web/src/messages/observationMessages.ts`), keyed by rule `type`. The rules library and the database never store prose.
- Charts use uPlot, not Highcharts (licensing — see spec).
- Every `features_*` column referenced below is verified against the actual migrations in `rtcstats_docker_deployment/migrations/*.sql` (read in full during planning), not guessed.
- **Join path gotcha:** `features_metadata.dump_id` references `"rtcstats-server".id`, but `features_client.dump_id` and `features_connection.dump_id` reference **`features_metadata.id`**, not `"rtcstats-server".id`. `features_track.connection_id` references `features_connection.id`. Any query joining these tables must follow this exact chain.

---

## File Structure

```
rtcstats_dashboard/
  package.json                      # npm workspaces root
  tsconfig.base.json
  vitest.workspace.ts
  docker-compose.test.yml           # Postgres + MinIO, integration tests only
  migrations/
    0001_dashboard_tables.sql       # dashboard_analysis, dashboard_observations, grants
  scripts/
    migrate.mjs                     # applies migrations/*.sql, tracks dashboard_schema_migrations
  test/
    fixtures/000_base_schema.sql    # condensed upstream schema, TEST DB ONLY (not shipped)
  packages/
    db-features/
      src/index.ts                 # shared feature-tree loader, used by analyzer and api
      test/*.test.ts
    rules/
      src/types.ts
      src/util.ts
      src/thresholds.ts
      src/scoring.ts
      src/analyze.ts
      src/registry.ts
      src/rules/connectivity.ts
      src/rules/video.ts
      src/rules/audio.ts
      src/rules/device.ts
      src/rules/api.ts
      src/index.ts
      test/*.test.ts
      test/fixtures/*.ts
    analyzer/
      src/db.ts
      src/featureLoader.ts
      src/claim.ts
      src/write.ts
      src/run.ts
      src/cli.ts
      Dockerfile
      test/*.test.ts
    api/
      src/app.ts
      src/auth.ts
      src/db.ts
      src/s3.ts
      src/routes/auth.ts
      src/routes/health.ts
      src/routes/rules.ts
      src/routes/sessions.ts
      src/routes/dump.ts
      Dockerfile
      test/*.test.ts
    web/
      src/lib/api.ts
      src/lib/auth.tsx
      src/pages/LoginPage.tsx
      src/pages/SessionBrowserPage.tsx
      src/pages/SessionDetailPage.tsx
      src/components/FilterBar.tsx
      src/components/SessionTable.tsx
      src/components/ScoreBadge.tsx
      src/components/VerdictList.tsx
      src/components/EvidenceCharts.tsx
      src/components/EventTimeline.tsx
      src/components/PeerConnectionSelector.tsx
      src/messages/observationMessages.ts
      src/workers/parseDump.worker.ts
      e2e/smoke.spec.ts
```

---

## Phase 1 — Rules library (`packages/rules`)

### Task 1: Monorepo scaffold + rules package types

**Files:**
- Create: `package.json` (root)
- Create: `tsconfig.base.json`
- Create: `vitest.workspace.ts`
- Create: `packages/rules/package.json`
- Create: `packages/rules/tsconfig.json`
- Create: `packages/rules/src/types.ts`
- Create: `packages/rules/src/util.ts`
- Test: `packages/rules/test/util.test.ts`

**Interfaces:**
- Produces: `Severity`, `Category`, `Evidence`, `Observation`, `FeatureTrack`, `FeatureConnection`, `FeatureClient`, `FeatureMetadata`, `RuleContext`, `Rule`, `AnalysisStatus` (all exported from `types.ts`); `clamp(value: number, min: number, max: number): number` from `util.ts`.

- [ ] **Step 1: Create the workspace root**

`package.json`:
```json
{
  "name": "rtcstats-dashboard",
  "private": true,
  "type": "module",
  "workspaces": ["packages/*"],
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "build": "npm run build --workspaces --if-present"
  },
  "devDependencies": {
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
```

`tsconfig.base.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true,
    "outDir": "dist"
  }
}
```

`vitest.workspace.ts`:
```ts
export default ['packages/*'];
```

- [ ] **Step 2: Run `npm install` at the repo root**

Run: `npm install`
Expected: lockfile created, no errors.

- [ ] **Step 3: Scaffold `packages/rules`**

`packages/rules/package.json`:
```json
{
  "name": "@rtcstats-dashboard/rules",
  "version": "0.1.0",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run"
  }
}
```

`packages/rules/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src" },
  "include": ["src"]
}
```

- [ ] **Step 4: Write `types.ts`**

`packages/rules/src/types.ts`:
```ts
export type Severity = 'critical' | 'warning' | 'info';
export type Category = 'connectivity' | 'audio' | 'video' | 'device' | 'api';
export type AnalysisStatus = 'ok' | 'failed' | 'insufficient_data';

export interface Evidence {
  chart: string;
  from: number;
  to: number;
}

export interface Observation {
  type: string;
  severity: Severity;
  category: Category;
  pid: string | null;
  firstSeenAt: number | null;
  observation: Record<string, unknown>;
}

export interface FeatureTrack {
  id: number;
  connectionId: number;
  trackIdentifier: string | null;
  kind: 'audio' | 'video' | null;
  direction: string | null;
  frameCount: number | null;
  qualityLimitationResolutionChanges: number | null;
  bandwidthQualityLimitationPercentage: number | null;
  cpuQualityLimitationPercentage: number | null;
  otherQualityLimitationPercentage: number | null;
  averageEncodeTime: number | null;
  averageDecodeTime: number | null;
  freezeCount: number | null;
  totalFreezesDuration: number | null;
  qpSum: number | null;
  encoderImplementation: string | null;
  powerEfficientEncoder: boolean | null;
  decoderImplementation: string | null;
  powerEfficientDecoder: boolean | null;
  hasNullVideoDecoder: boolean | null;
  concealedSamples: number | null;
  totalSamplesReceived: number | null;
  concealmentPercentage: number | null;
  jitterBufferFlushes: number | null;
  hasPeriodicJitterBufferFlushes: boolean | null;
  insertedSamplesForDeceleration: number | null;
  removedSamplesForAcceleration: number | null;
  decelerationPercentage: number | null;
  accelerationPercentage: number | null;
  timeToFirstFrame: number | null;
}

export interface FeatureConnection {
  id: number;
  dumpId: number;
  connectionIdentifier: string | null;
  closed: boolean | null;
  iceConnected: boolean | null;
  iceConnectionTime: number | null;
  iceRestart: boolean | null;
  addIceCandidateFailure: string | null;
  setLocalDescriptionFailure: string | null;
  setRemoteDescriptionFailure: string | null;
  connected: boolean | null;
  dtlsVersion: string | null;
  dtlsRole: string | null;
  addedNullCandidate: boolean | null;
  firstCandidatePairLocalType: string | null;
  firstCandidatePairRemoteType: string | null;
  averageStunRoundTripTime: number | null;
  iceRestartFollowedBySetRemoteDescription: boolean | null;
  signalingDelay: number | null;
  setRemoteDescriptionDelay: number | null;
  setLocalDescriptionDelay: number | null;
  clockSkew: number | null;
  gatheringTimeTurnUdp: number | null;
  gatheringTimeTurnTcp: number | null;
  gatheringTimeTurnTls: number | null;
  tracks: FeatureTrack[];
}

export interface FeatureClient {
  id: number;
  dumpId: number;
  hardwareConcurrency: number | null;
  deviceMemory: number | null;
  calledGetUserMedia: boolean | null;
  getUserMediaSuccessCount: number | null;
  getUserMediaErrorCount: number | null;
  getUserMediaError: string | null;
  reloadCount: number | null;
  cpuPerformance: number | null;
  operatingSystem: string | null;
  audioEnded: boolean | null;
  audioShortDuration: boolean | null;
  videoEnded: boolean | null;
  videoShortDuration: boolean | null;
}

export interface FeatureMetadata {
  id: number;
  dumpId: number;
  startTime: string | null;
  useragent: string | null;
  numberPeerconnections: number | null;
}

export interface RuleWeights {
  [ruleId: string]: number;
}

export interface Thresholds {
  iceConnectionTimeWarningMs: number;
  iceConnectionTimeCriticalMs: number;
  turnGatheringWarningMs: number;
  turnGatheringCriticalMs: number;
  clockSkewWarningMs: number;
  clockSkewCriticalMs: number;
  signalingDelayWarningMs: number;
  signalingDelayCriticalMs: number;
  setDescriptionDelayWarningMs: number;
  setDescriptionDelayCriticalMs: number;
  freezeTotalWarningMs: number;
  freezeTotalCriticalMs: number;
  qualityLimitationWarningPct: number;
  qualityLimitationCriticalPct: number;
  resolutionChangesWarningCount: number;
  ttffWarningMs: number;
  ttffCriticalMs: number;
  encodeTimeWarningMs: number;
  encodeTimeCriticalMs: number;
  decodeTimeWarningMs: number;
  decodeTimeCriticalMs: number;
  qpWarning: number;
  qpCritical: number;
  concealmentWarningPct: number;
  concealmentCriticalPct: number;
  jitterBufferFlushesWarningCount: number;
  timeStretchingWarningPct: number;
  timeStretchingCriticalPct: number;
  lowCpuPerformanceThreshold: number;
  reloadCountWarningCount: number;
  weights: RuleWeights;
}

export interface RuleContext {
  metadata: FeatureMetadata;
  client: FeatureClient | null;
  connections: FeatureConnection[];
  thresholds: Thresholds;
}

export interface Rule {
  id: string;
  category: Category;
  scope: 'session' | 'connection' | 'track';
  evaluate(ctx: RuleContext): Observation[];
}

export interface Scores {
  connectivity: number | null;
  audio: number | null;
  video: number | null;
  experience: number;
}

export interface AnalysisResult {
  status: AnalysisStatus;
  scores: Scores | null;
  observations: Observation[];
}
```

- [ ] **Step 5: Write the failing test for `clamp`**

`packages/rules/test/util.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { clamp } from '../src/util.js';

describe('clamp', () => {
  it('returns the value when within range', () => {
    expect(clamp(50, 0, 100)).toBe(50);
  });

  it('clamps to the minimum', () => {
    expect(clamp(-10, 0, 100)).toBe(0);
  });

  it('clamps to the maximum', () => {
    expect(clamp(150, 0, 100)).toBe(100);
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npx vitest run packages/rules/test/util.test.ts`
Expected: FAIL — `Cannot find module '../src/util.js'`

- [ ] **Step 7: Implement `util.ts`**

`packages/rules/src/util.ts`:
```ts
export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
```

- [ ] **Step 8: Run test to verify it passes**

Run: `npx vitest run packages/rules/test/util.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 9: Commit**

```bash
git add package.json tsconfig.base.json vitest.workspace.ts packages/rules
git commit -m "chore: scaffold workspace and rules package types"
```

### Task 2: Thresholds config + scoring

**Files:**
- Create: `packages/rules/src/thresholds.ts`
- Create: `packages/rules/src/scoring.ts`
- Test: `packages/rules/test/scoring.test.ts`

**Interfaces:**
- Consumes: `Thresholds`, `RuleWeights`, `Observation`, `RuleContext`, `Scores` (Task 1, `types.ts`); `clamp` (Task 1, `util.ts`).
- Produces: `defaultThresholds: Thresholds` from `thresholds.ts`; `score(observations: Observation[], ctx: RuleContext): Scores` from `scoring.ts`.

Scoring design (not in the spec verbatim — this is the concrete formula an implementer needs): each of `connectivity`, `audio`, `video` starts at 100 and is only computed if the session has, respectively, at least one connection, one audio track, or one video track — otherwise it's `null`. Each observation subtracts `severityWeight(severity) * thresholds.weights[type]` from its category's score, clamped to `[0, 100]`. `experience` is the mean of whichever of the three category scores are non-null (100 if none applied), then reduced by the summed weight of `device` and `api` observations (which have no dedicated score column in `dashboard_analysis`), clamped to `[0, 100]`.

- [ ] **Step 1: Write `thresholds.ts`**

`packages/rules/src/thresholds.ts`:
```ts
import type { Thresholds } from './types.js';

export const defaultThresholds: Thresholds = {
  iceConnectionTimeWarningMs: 4000,
  iceConnectionTimeCriticalMs: 8000,
  turnGatheringWarningMs: 2000,
  turnGatheringCriticalMs: 5000,
  clockSkewWarningMs: 200,
  clockSkewCriticalMs: 1000,
  signalingDelayWarningMs: 1000,
  signalingDelayCriticalMs: 5000,
  setDescriptionDelayWarningMs: 500,
  setDescriptionDelayCriticalMs: 2000,
  freezeTotalWarningMs: 5000,
  freezeTotalCriticalMs: 15000,
  qualityLimitationWarningPct: 20,
  qualityLimitationCriticalPct: 50,
  resolutionChangesWarningCount: 5,
  ttffWarningMs: 2000,
  ttffCriticalMs: 5000,
  encodeTimeWarningMs: 20,
  encodeTimeCriticalMs: 40,
  decodeTimeWarningMs: 20,
  decodeTimeCriticalMs: 40,
  qpWarning: 30,
  qpCritical: 40,
  concealmentWarningPct: 3,
  concealmentCriticalPct: 8,
  jitterBufferFlushesWarningCount: 3,
  timeStretchingWarningPct: 5,
  timeStretchingCriticalPct: 15,
  lowCpuPerformanceThreshold: 2,
  reloadCountWarningCount: 2,
  weights: {
    'connectivity.never_connected': 100,
    'connectivity.slow_ice_connect': 15,
    'connectivity.slow_turn_gathering': 10,
    'connectivity.ice_restart': 10,
    'connectivity.ice_restart_followed_by_srd': 25,
    'connectivity.null_candidate_added': 3,
    'connectivity.relay_only_path': 5,
    'connectivity.dtls_handshake_incomplete': 20,
    'connectivity.clock_skew': 10,
    'connectivity.signaling_delay': 10,
    'connectivity.slow_set_remote_description': 10,
    'connectivity.slow_set_local_description': 10,
    'video.freezes': 30,
    'video.quality_limitation_cpu': 15,
    'video.quality_limitation_bandwidth': 15,
    'video.frequent_resolution_changes': 8,
    'video.slow_time_to_first_frame': 15,
    'video.slow_encode': 10,
    'video.slow_decode': 10,
    'video.no_hw_acceleration': 5,
    'video.null_video_decoder': 40,
    'video.qp_degradation': 15,
    'audio.concealment_ratio': 25,
    'audio.jitter_buffer_flushes': 20,
    'audio.time_stretching': 15,
    'audio.track_ended_unexpectedly': 20,
    'device.get_user_media_failure': 30,
    'device.low_cpu_performance': 10,
    'device.frequent_reloads': 15,
    'api.add_ice_candidate_failure': 15,
    'api.set_local_description_failure': 40,
    'api.set_remote_description_failure': 40
  }
};
```

- [ ] **Step 2: Write the failing scoring tests**

`packages/rules/test/scoring.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { score } from '../src/scoring.js';
import { defaultThresholds } from '../src/thresholds.js';
import type { Observation, RuleContext } from '../src/types.js';

function makeCtx(overrides: Partial<RuleContext> = {}): RuleContext {
  return {
    metadata: { id: 1, dumpId: 1, startTime: null, useragent: null, numberPeerconnections: 1 },
    client: null,
    connections: [
      {
        id: 1, dumpId: 1, connectionIdentifier: 'PC_0', closed: true,
        iceConnected: true, iceConnectionTime: 500, iceRestart: false,
        addIceCandidateFailure: null, setLocalDescriptionFailure: null, setRemoteDescriptionFailure: null,
        connected: true, dtlsVersion: '1.2', dtlsRole: 'client', addedNullCandidate: true,
        firstCandidatePairLocalType: 'host', firstCandidatePairRemoteType: 'host',
        averageStunRoundTripTime: 20, iceRestartFollowedBySetRemoteDescription: false,
        signalingDelay: 100, setRemoteDescriptionDelay: 50, setLocalDescriptionDelay: 50,
        clockSkew: 0, gatheringTimeTurnUdp: null, gatheringTimeTurnTcp: null, gatheringTimeTurnTls: null,
        tracks: [
          { id: 1, connectionId: 1, trackIdentifier: 'v0', kind: 'video', direction: 'sendrecv',
            frameCount: 1000, qualityLimitationResolutionChanges: 0,
            bandwidthQualityLimitationPercentage: 0, cpuQualityLimitationPercentage: 0, otherQualityLimitationPercentage: 0,
            averageEncodeTime: 5, averageDecodeTime: 5, freezeCount: 0, totalFreezesDuration: 0,
            qpSum: 10000, encoderImplementation: 'libvpx', powerEfficientEncoder: true,
            decoderImplementation: 'libvpx', powerEfficientDecoder: true, hasNullVideoDecoder: false,
            concealedSamples: null, totalSamplesReceived: null, concealmentPercentage: null,
            jitterBufferFlushes: null, hasPeriodicJitterBufferFlushes: null,
            insertedSamplesForDeceleration: null, removedSamplesForAcceleration: null,
            decelerationPercentage: null, accelerationPercentage: null, timeToFirstFrame: 300 }
        ]
      }
    ],
    thresholds: defaultThresholds,
    ...overrides
  };
}

describe('score', () => {
  it('scores a clean session at 100 across all applicable categories', () => {
    const result = score([], makeCtx());
    expect(result.connectivity).toBe(100);
    expect(result.video).toBe(100);
    expect(result.audio).toBeNull();
    expect(result.experience).toBe(100);
  });

  it('subtracts a critical connectivity observation from connectivity and experience', () => {
    const observations: Observation[] = [
      { type: 'connectivity.slow_ice_connect', severity: 'critical', category: 'connectivity',
        pid: 'PC_0', firstSeenAt: 0, observation: {} }
    ];
    const result = score(observations, makeCtx());
    expect(result.connectivity).toBe(85);
    expect(result.video).toBe(100);
    expect(result.experience).toBeCloseTo(92.5, 5);
  });

  it('clamps a category score at 0 rather than going negative', () => {
    const observations: Observation[] = [
      { type: 'connectivity.never_connected', severity: 'critical', category: 'connectivity',
        pid: 'PC_0', firstSeenAt: 0, observation: {} },
      { type: 'connectivity.slow_ice_connect', severity: 'critical', category: 'connectivity',
        pid: 'PC_0', firstSeenAt: 0, observation: {} }
    ];
    const result = score(observations, makeCtx());
    expect(result.connectivity).toBe(0);
  });

  it('reduces experience by device/api weight without a dedicated device score', () => {
    const observations: Observation[] = [
      { type: 'device.get_user_media_failure', severity: 'critical', category: 'device',
        pid: null, firstSeenAt: 0, observation: {} }
    ];
    const result = score(observations, makeCtx());
    expect(result.connectivity).toBe(100);
    expect(result.video).toBe(100);
    expect(result.experience).toBe(70);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run packages/rules/test/scoring.test.ts`
Expected: FAIL — `Cannot find module '../src/scoring.js'`

- [ ] **Step 4: Implement `scoring.ts`**

`packages/rules/src/scoring.ts`:
```ts
import { clamp } from './util.js';
import type { Category, Observation, RuleContext, Scores, Severity } from './types.js';

function severityWeight(severity: Severity): number {
  if (severity === 'critical') return 1;
  if (severity === 'warning') return 0.4;
  return 0.1;
}

function deductionFor(observations: Observation[], category: Category, weights: Record<string, number>): number {
  return observations
    .filter((o) => o.category === category)
    .reduce((sum, o) => sum + severityWeight(o.severity) * (weights[o.type] ?? 10), 0);
}

export function score(observations: Observation[], ctx: RuleContext): Scores {
  const { weights } = ctx.thresholds;
  const hasConnections = ctx.connections.length > 0;
  const hasAudioTrack = ctx.connections.some((c) => c.tracks.some((t) => t.kind === 'audio'));
  const hasVideoTrack = ctx.connections.some((c) => c.tracks.some((t) => t.kind === 'video'));

  const connectivity = hasConnections
    ? clamp(100 - deductionFor(observations, 'connectivity', weights), 0, 100)
    : null;
  const audio = hasAudioTrack
    ? clamp(100 - deductionFor(observations, 'audio', weights), 0, 100)
    : null;
  const video = hasVideoTrack
    ? clamp(100 - deductionFor(observations, 'video', weights), 0, 100)
    : null;

  const applicable = [connectivity, audio, video].filter((s): s is number => s !== null);
  const base = applicable.length > 0
    ? applicable.reduce((a, b) => a + b, 0) / applicable.length
    : 100;

  const modifierDeduction =
    deductionFor(observations, 'device', weights) + deductionFor(observations, 'api', weights);

  const experience = clamp(base - modifierDeduction, 0, 100);

  return { connectivity, audio, video, experience };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run packages/rules/test/scoring.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 6: Commit**

```bash
git add packages/rules/src/thresholds.ts packages/rules/src/scoring.ts packages/rules/test/scoring.test.ts
git commit -m "feat(rules): add thresholds config and subtractive scoring"
```

### Task 3: `analyze()` entry point + rule registry

**Files:**
- Create: `packages/rules/src/registry.ts`
- Create: `packages/rules/src/analyze.ts`
- Test: `packages/rules/test/analyze.test.ts`

**Interfaces:**
- Consumes: `Rule`, `RuleContext`, `AnalysisResult`, `Observation` (Task 1); `score` (Task 2).
- Produces: `buildRegistry(): Rule[]` and `getRuleIds(registry: Rule[]): string[]` from `registry.ts` (registry is empty until Task 9 wires in real rule arrays — this task builds the mechanism only, tested with fake rules); `analyze(ctx: RuleContext, rules: Rule[]): AnalysisResult` from `analyze.ts`, which later tasks (analyzer worker) call directly. A session with zero connections and no client-level signal returns `status: 'insufficient_data'` with `scores: null` and no observations run.

- [ ] **Step 1: Write the failing tests**

`packages/rules/test/analyze.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { analyze } from '../src/analyze.js';
import { getRuleIds } from '../src/registry.js';
import { defaultThresholds } from '../src/thresholds.js';
import type { Rule, RuleContext } from '../src/types.js';

const emptyCtx: RuleContext = {
  metadata: { id: 1, dumpId: 1, startTime: null, useragent: null, numberPeerconnections: 0 },
  client: null,
  connections: [],
  thresholds: defaultThresholds
};

const ctxWithConnection: RuleContext = {
  ...emptyCtx,
  connections: [{
    id: 1, dumpId: 1, connectionIdentifier: 'PC_0', closed: true,
    iceConnected: true, iceConnectionTime: 500, iceRestart: false,
    addIceCandidateFailure: null, setLocalDescriptionFailure: null, setRemoteDescriptionFailure: null,
    connected: true, dtlsVersion: '1.2', dtlsRole: 'client', addedNullCandidate: true,
    firstCandidatePairLocalType: 'host', firstCandidatePairRemoteType: 'host',
    averageStunRoundTripTime: 20, iceRestartFollowedBySetRemoteDescription: false,
    signalingDelay: 100, setRemoteDescriptionDelay: 50, setLocalDescriptionDelay: 50,
    clockSkew: 0, gatheringTimeTurnUdp: null, gatheringTimeTurnTcp: null, gatheringTimeTurnTls: null,
    tracks: []
  }]
};

const fakeFiringRule: Rule = {
  id: 'fake.always_fires',
  category: 'connectivity',
  scope: 'session',
  evaluate: () => [{
    type: 'fake.always_fires', severity: 'warning', category: 'connectivity',
    pid: null, firstSeenAt: 0, observation: {}
  }]
};

const fakeSilentRule: Rule = {
  id: 'fake.never_fires',
  category: 'video',
  scope: 'session',
  evaluate: () => []
};

describe('analyze', () => {
  it('returns insufficient_data with no scores when there are no connections', () => {
    const result = analyze(emptyCtx, [fakeFiringRule]);
    expect(result.status).toBe('insufficient_data');
    expect(result.scores).toBeNull();
    expect(result.observations).toEqual([]);
  });

  it('runs every rule and returns ok when at least one connection exists', () => {
    const result = analyze(ctxWithConnection, [fakeFiringRule, fakeSilentRule]);
    expect(result.status).toBe('ok');
    expect(result.observations).toHaveLength(1);
    expect(result.observations[0].type).toBe('fake.always_fires');
    expect(result.scores?.connectivity).toBeLessThan(100);
  });
});

describe('getRuleIds', () => {
  it('lists the id of every rule in a registry', () => {
    expect(getRuleIds([fakeFiringRule, fakeSilentRule])).toEqual([
      'fake.always_fires',
      'fake.never_fires'
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/rules/test/analyze.test.ts`
Expected: FAIL — `Cannot find module '../src/analyze.js'`

- [ ] **Step 3: Implement `registry.ts`**

`packages/rules/src/registry.ts`:
```ts
import type { Rule } from './types.js';

export function buildRegistry(): Rule[] {
  return [];
}

export function getRuleIds(registry: Rule[]): string[] {
  return registry.map((rule) => rule.id);
}
```

- [ ] **Step 4: Implement `analyze.ts`**

`packages/rules/src/analyze.ts`:
```ts
import { score } from './scoring.js';
import type { AnalysisResult, Rule, RuleContext } from './types.js';

export function analyze(ctx: RuleContext, rules: Rule[]): AnalysisResult {
  if (ctx.connections.length === 0) {
    return { status: 'insufficient_data', scores: null, observations: [] };
  }

  const observations = rules.flatMap((rule) => rule.evaluate(ctx));
  const scores = score(observations, ctx);

  return { status: 'ok', scores, observations };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run packages/rules/test/analyze.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 6: Commit**

```bash
git add packages/rules/src/registry.ts packages/rules/src/analyze.ts packages/rules/test/analyze.test.ts
git commit -m "feat(rules): add analyze() entry point and rule registry"
```

### Task 4: Connectivity rules

**Files:**
- Create: `packages/rules/src/rules/connectivity.ts`
- Test: `packages/rules/test/rules/connectivity.test.ts`

**Interfaces:**
- Consumes: `Rule`, `RuleContext`, `Observation`, `FeatureConnection`, `Thresholds` (Task 1).
- Produces: `connectivityRules: Rule[]`, exporting 12 rules: `connectivity.never_connected`, `connectivity.slow_ice_connect`, `connectivity.slow_turn_gathering`, `connectivity.ice_restart`, `connectivity.ice_restart_followed_by_srd`, `connectivity.null_candidate_added`, `connectivity.relay_only_path`, `connectivity.dtls_handshake_incomplete`, `connectivity.clock_skew`, `connectivity.signaling_delay`, `connectivity.slow_set_remote_description`, `connectivity.slow_set_local_description`. Consumed by `registry.ts` in Task 9.

- [ ] **Step 1: Write the failing tests**

`packages/rules/test/rules/connectivity.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { connectivityRules } from '../../src/rules/connectivity.js';
import { defaultThresholds } from '../../src/thresholds.js';
import type { FeatureConnection, RuleContext } from '../../src/types.js';

function baseConnection(overrides: Partial<FeatureConnection> = {}): FeatureConnection {
  return {
    id: 1, dumpId: 1, connectionIdentifier: 'PC_0', closed: true,
    iceConnected: true, iceConnectionTime: 500, iceRestart: false,
    addIceCandidateFailure: null, setLocalDescriptionFailure: null, setRemoteDescriptionFailure: null,
    connected: true, dtlsVersion: '1.2', dtlsRole: 'client', addedNullCandidate: false,
    firstCandidatePairLocalType: 'host', firstCandidatePairRemoteType: 'host',
    averageStunRoundTripTime: 20, iceRestartFollowedBySetRemoteDescription: false,
    signalingDelay: 100, setRemoteDescriptionDelay: 50, setLocalDescriptionDelay: 50,
    clockSkew: 0, gatheringTimeTurnUdp: null, gatheringTimeTurnTcp: null, gatheringTimeTurnTls: null,
    tracks: [],
    ...overrides
  };
}

function ctxWith(connections: FeatureConnection[]): RuleContext {
  return {
    metadata: { id: 1, dumpId: 1, startTime: null, useragent: null, numberPeerconnections: connections.length },
    client: null,
    connections,
    thresholds: defaultThresholds
  };
}

function ruleById(id: string) {
  const rule = connectivityRules.find((r) => r.id === id);
  if (!rule) throw new Error(`rule ${id} not registered`);
  return rule;
}

describe('connectivity.never_connected', () => {
  it('fires critical when a connection never connected', () => {
    const ctx = ctxWith([baseConnection({ connected: false })]);
    const [obs] = ruleById('connectivity.never_connected').evaluate(ctx);
    expect(obs.severity).toBe('critical');
    expect(obs.pid).toBe('PC_0');
  });

  it('does not fire when connected', () => {
    const ctx = ctxWith([baseConnection({ connected: true })]);
    expect(ruleById('connectivity.never_connected').evaluate(ctx)).toHaveLength(0);
  });

  it('does not fire when connected is unknown (null)', () => {
    const ctx = ctxWith([baseConnection({ connected: null })]);
    expect(ruleById('connectivity.never_connected').evaluate(ctx)).toHaveLength(0);
  });
});

describe('connectivity.slow_ice_connect', () => {
  it('does not fire under the warning threshold', () => {
    const ctx = ctxWith([baseConnection({ iceConnectionTime: 3999 })]);
    expect(ruleById('connectivity.slow_ice_connect').evaluate(ctx)).toHaveLength(0);
  });

  it('fires warning between warning and critical thresholds', () => {
    const ctx = ctxWith([baseConnection({ iceConnectionTime: 4500 })]);
    const [obs] = ruleById('connectivity.slow_ice_connect').evaluate(ctx);
    expect(obs.severity).toBe('warning');
    expect(obs.observation.iceConnectionTime).toBe(4500);
  });

  it('fires critical above the critical threshold', () => {
    const ctx = ctxWith([baseConnection({ iceConnectionTime: 9000 })]);
    const [obs] = ruleById('connectivity.slow_ice_connect').evaluate(ctx);
    expect(obs.severity).toBe('critical');
  });

  it('does not fire when ice connection time is missing', () => {
    const ctx = ctxWith([baseConnection({ iceConnectionTime: null })]);
    expect(ruleById('connectivity.slow_ice_connect').evaluate(ctx)).toHaveLength(0);
  });
});

describe('connectivity.slow_turn_gathering', () => {
  it('fires on the slowest of the three TURN gathering times', () => {
    const ctx = ctxWith([baseConnection({ gatheringTimeTurnUdp: 1000, gatheringTimeTurnTcp: 6000, gatheringTimeTurnTls: null })]);
    const [obs] = ruleById('connectivity.slow_turn_gathering').evaluate(ctx);
    expect(obs.severity).toBe('critical');
  });

  it('does not fire when no TURN gathering times are present', () => {
    const ctx = ctxWith([baseConnection()]);
    expect(ruleById('connectivity.slow_turn_gathering').evaluate(ctx)).toHaveLength(0);
  });
});

describe('connectivity.ice_restart', () => {
  it('fires warning on an ICE restart', () => {
    const ctx = ctxWith([baseConnection({ iceRestart: true })]);
    const [obs] = ruleById('connectivity.ice_restart').evaluate(ctx);
    expect(obs.severity).toBe('warning');
  });
});

describe('connectivity.ice_restart_followed_by_srd', () => {
  it('fires critical when an ICE restart raced a setRemoteDescription', () => {
    const ctx = ctxWith([baseConnection({ iceRestartFollowedBySetRemoteDescription: true })]);
    const [obs] = ruleById('connectivity.ice_restart_followed_by_srd').evaluate(ctx);
    expect(obs.severity).toBe('critical');
  });
});

describe('connectivity.null_candidate_added', () => {
  it('fires info when a null (end-of-candidates) candidate was added', () => {
    const ctx = ctxWith([baseConnection({ addedNullCandidate: true })]);
    const [obs] = ruleById('connectivity.null_candidate_added').evaluate(ctx);
    expect(obs.severity).toBe('info');
  });
});

describe('connectivity.relay_only_path', () => {
  it('fires warning when the first candidate pair used a relay', () => {
    const ctx = ctxWith([baseConnection({ firstCandidatePairLocalType: 'relay' })]);
    const [obs] = ruleById('connectivity.relay_only_path').evaluate(ctx);
    expect(obs.severity).toBe('warning');
  });

  it('does not fire for a host candidate pair', () => {
    const ctx = ctxWith([baseConnection({ firstCandidatePairLocalType: 'host' })]);
    expect(ruleById('connectivity.relay_only_path').evaluate(ctx)).toHaveLength(0);
  });
});

describe('connectivity.dtls_handshake_incomplete', () => {
  it('fires warning when connected but no DTLS version was recorded', () => {
    const ctx = ctxWith([baseConnection({ connected: true, dtlsVersion: null })]);
    const [obs] = ruleById('connectivity.dtls_handshake_incomplete').evaluate(ctx);
    expect(obs.severity).toBe('warning');
  });

  it('does not fire when not connected', () => {
    const ctx = ctxWith([baseConnection({ connected: false, dtlsVersion: null })]);
    expect(ruleById('connectivity.dtls_handshake_incomplete').evaluate(ctx)).toHaveLength(0);
  });
});

describe('connectivity.clock_skew', () => {
  it('fires critical above the critical threshold in either direction', () => {
    const ctx = ctxWith([baseConnection({ clockSkew: -1500 })]);
    const [obs] = ruleById('connectivity.clock_skew').evaluate(ctx);
    expect(obs.severity).toBe('critical');
  });
});

describe('connectivity.signaling_delay', () => {
  it('fires warning above the warning threshold', () => {
    const ctx = ctxWith([baseConnection({ signalingDelay: 2000 })]);
    const [obs] = ruleById('connectivity.signaling_delay').evaluate(ctx);
    expect(obs.severity).toBe('warning');
  });
});

describe('connectivity.slow_set_remote_description', () => {
  it('fires critical above the critical threshold', () => {
    const ctx = ctxWith([baseConnection({ setRemoteDescriptionDelay: 3000 })]);
    const [obs] = ruleById('connectivity.slow_set_remote_description').evaluate(ctx);
    expect(obs.severity).toBe('critical');
  });
});

describe('connectivity.slow_set_local_description', () => {
  it('fires warning above the warning threshold', () => {
    const ctx = ctxWith([baseConnection({ setLocalDescriptionDelay: 800 })]);
    const [obs] = ruleById('connectivity.slow_set_local_description').evaluate(ctx);
    expect(obs.severity).toBe('warning');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/rules/test/rules/connectivity.test.ts`
Expected: FAIL — `Cannot find module '../../src/rules/connectivity.js'`

- [ ] **Step 3: Implement `connectivity.ts`**

`packages/rules/src/rules/connectivity.ts`:
```ts
import type { FeatureConnection, Observation, Rule, RuleContext, Severity } from '../types.js';

function forEachConnection(
  ctx: RuleContext,
  fn: (c: FeatureConnection) => Observation | null
): Observation[] {
  return ctx.connections.map(fn).filter((o): o is Observation => o !== null);
}

function makeObservation(
  type: string,
  severity: Severity,
  pid: string | null,
  data: Record<string, unknown>
): Observation {
  return { type, severity, category: 'connectivity', pid, firstSeenAt: null, observation: data };
}

const neverConnected: Rule = {
  id: 'connectivity.never_connected',
  category: 'connectivity',
  scope: 'connection',
  evaluate: (ctx) => forEachConnection(ctx, (c) => {
    if (c.connected !== false) return null;
    return makeObservation('connectivity.never_connected', 'critical', c.connectionIdentifier, {});
  })
};

const slowIceConnect: Rule = {
  id: 'connectivity.slow_ice_connect',
  category: 'connectivity',
  scope: 'connection',
  evaluate: (ctx) => forEachConnection(ctx, (c) => {
    const t = c.iceConnectionTime;
    if (t == null) return null;
    if (t >= ctx.thresholds.iceConnectionTimeCriticalMs) {
      return makeObservation('connectivity.slow_ice_connect', 'critical', c.connectionIdentifier, { iceConnectionTime: t });
    }
    if (t >= ctx.thresholds.iceConnectionTimeWarningMs) {
      return makeObservation('connectivity.slow_ice_connect', 'warning', c.connectionIdentifier, { iceConnectionTime: t });
    }
    return null;
  })
};

const slowTurnGathering: Rule = {
  id: 'connectivity.slow_turn_gathering',
  category: 'connectivity',
  scope: 'connection',
  evaluate: (ctx) => forEachConnection(ctx, (c) => {
    const times = [c.gatheringTimeTurnUdp, c.gatheringTimeTurnTcp, c.gatheringTimeTurnTls]
      .filter((t): t is number => t != null);
    if (times.length === 0) return null;
    const worst = Math.max(...times);
    if (worst >= ctx.thresholds.turnGatheringCriticalMs) {
      return makeObservation('connectivity.slow_turn_gathering', 'critical', c.connectionIdentifier, { worst });
    }
    if (worst >= ctx.thresholds.turnGatheringWarningMs) {
      return makeObservation('connectivity.slow_turn_gathering', 'warning', c.connectionIdentifier, { worst });
    }
    return null;
  })
};

const iceRestart: Rule = {
  id: 'connectivity.ice_restart',
  category: 'connectivity',
  scope: 'connection',
  evaluate: (ctx) => forEachConnection(ctx, (c) => {
    if (!c.iceRestart) return null;
    return makeObservation('connectivity.ice_restart', 'warning', c.connectionIdentifier, {});
  })
};

const iceRestartFollowedBySrd: Rule = {
  id: 'connectivity.ice_restart_followed_by_srd',
  category: 'connectivity',
  scope: 'connection',
  evaluate: (ctx) => forEachConnection(ctx, (c) => {
    if (!c.iceRestartFollowedBySetRemoteDescription) return null;
    return makeObservation('connectivity.ice_restart_followed_by_srd', 'critical', c.connectionIdentifier, {});
  })
};

const nullCandidateAdded: Rule = {
  id: 'connectivity.null_candidate_added',
  category: 'connectivity',
  scope: 'connection',
  evaluate: (ctx) => forEachConnection(ctx, (c) => {
    if (!c.addedNullCandidate) return null;
    return makeObservation('connectivity.null_candidate_added', 'info', c.connectionIdentifier, {});
  })
};

const relayOnlyPath: Rule = {
  id: 'connectivity.relay_only_path',
  category: 'connectivity',
  scope: 'connection',
  evaluate: (ctx) => forEachConnection(ctx, (c) => {
    if (c.firstCandidatePairLocalType !== 'relay') return null;
    return makeObservation('connectivity.relay_only_path', 'warning', c.connectionIdentifier, {
      localType: c.firstCandidatePairLocalType,
      remoteType: c.firstCandidatePairRemoteType
    });
  })
};

const dtlsHandshakeIncomplete: Rule = {
  id: 'connectivity.dtls_handshake_incomplete',
  category: 'connectivity',
  scope: 'connection',
  evaluate: (ctx) => forEachConnection(ctx, (c) => {
    if (c.connected !== true || c.dtlsVersion) return null;
    return makeObservation('connectivity.dtls_handshake_incomplete', 'warning', c.connectionIdentifier, {});
  })
};

const clockSkew: Rule = {
  id: 'connectivity.clock_skew',
  category: 'connectivity',
  scope: 'connection',
  evaluate: (ctx) => forEachConnection(ctx, (c) => {
    if (c.clockSkew == null) return null;
    const magnitude = Math.abs(c.clockSkew);
    if (magnitude >= ctx.thresholds.clockSkewCriticalMs) {
      return makeObservation('connectivity.clock_skew', 'critical', c.connectionIdentifier, { clockSkew: c.clockSkew });
    }
    if (magnitude >= ctx.thresholds.clockSkewWarningMs) {
      return makeObservation('connectivity.clock_skew', 'warning', c.connectionIdentifier, { clockSkew: c.clockSkew });
    }
    return null;
  })
};

const signalingDelay: Rule = {
  id: 'connectivity.signaling_delay',
  category: 'connectivity',
  scope: 'connection',
  evaluate: (ctx) => forEachConnection(ctx, (c) => {
    if (c.signalingDelay == null) return null;
    if (c.signalingDelay >= ctx.thresholds.signalingDelayCriticalMs) {
      return makeObservation('connectivity.signaling_delay', 'critical', c.connectionIdentifier, { signalingDelay: c.signalingDelay });
    }
    if (c.signalingDelay >= ctx.thresholds.signalingDelayWarningMs) {
      return makeObservation('connectivity.signaling_delay', 'warning', c.connectionIdentifier, { signalingDelay: c.signalingDelay });
    }
    return null;
  })
};

const slowSetRemoteDescription: Rule = {
  id: 'connectivity.slow_set_remote_description',
  category: 'connectivity',
  scope: 'connection',
  evaluate: (ctx) => forEachConnection(ctx, (c) => {
    if (c.setRemoteDescriptionDelay == null) return null;
    if (c.setRemoteDescriptionDelay >= ctx.thresholds.setDescriptionDelayCriticalMs) {
      return makeObservation('connectivity.slow_set_remote_description', 'critical', c.connectionIdentifier, { delay: c.setRemoteDescriptionDelay });
    }
    if (c.setRemoteDescriptionDelay >= ctx.thresholds.setDescriptionDelayWarningMs) {
      return makeObservation('connectivity.slow_set_remote_description', 'warning', c.connectionIdentifier, { delay: c.setRemoteDescriptionDelay });
    }
    return null;
  })
};

const slowSetLocalDescription: Rule = {
  id: 'connectivity.slow_set_local_description',
  category: 'connectivity',
  scope: 'connection',
  evaluate: (ctx) => forEachConnection(ctx, (c) => {
    if (c.setLocalDescriptionDelay == null) return null;
    if (c.setLocalDescriptionDelay >= ctx.thresholds.setDescriptionDelayCriticalMs) {
      return makeObservation('connectivity.slow_set_local_description', 'critical', c.connectionIdentifier, { delay: c.setLocalDescriptionDelay });
    }
    if (c.setLocalDescriptionDelay >= ctx.thresholds.setDescriptionDelayWarningMs) {
      return makeObservation('connectivity.slow_set_local_description', 'warning', c.connectionIdentifier, { delay: c.setLocalDescriptionDelay });
    }
    return null;
  })
};

export const connectivityRules: Rule[] = [
  neverConnected,
  slowIceConnect,
  slowTurnGathering,
  iceRestart,
  iceRestartFollowedBySrd,
  nullCandidateAdded,
  relayOnlyPath,
  dtlsHandshakeIncomplete,
  clockSkew,
  signalingDelay,
  slowSetRemoteDescription,
  slowSetLocalDescription
];
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/rules/test/rules/connectivity.test.ts`
Expected: PASS (19 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/rules/src/rules/connectivity.ts packages/rules/test/rules/connectivity.test.ts
git commit -m "feat(rules): add connectivity rule set"
```

### Task 5: Video rules

**Files:**
- Create: `packages/rules/src/rules/video.ts`
- Test: `packages/rules/test/rules/video.test.ts`

**Interfaces:**
- Consumes: `Rule`, `RuleContext`, `Observation`, `FeatureTrack`, `Thresholds` (Task 1).
- Produces: `videoRules: Rule[]`, 10 rules: `video.freezes`, `video.quality_limitation_cpu`, `video.quality_limitation_bandwidth`, `video.frequent_resolution_changes`, `video.slow_time_to_first_frame`, `video.slow_encode`, `video.slow_decode`, `video.no_hw_acceleration`, `video.null_video_decoder`, `video.qp_degradation`. Consumed by `registry.ts` in Task 9.

- [ ] **Step 1: Write the failing tests**

`packages/rules/test/rules/video.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { videoRules } from '../../src/rules/video.js';
import { defaultThresholds } from '../../src/thresholds.js';
import type { FeatureConnection, FeatureTrack, RuleContext } from '../../src/types.js';

function baseTrack(overrides: Partial<FeatureTrack> = {}): FeatureTrack {
  return {
    id: 1, connectionId: 1, trackIdentifier: 'v0', kind: 'video', direction: 'sendrecv',
    frameCount: 1000, qualityLimitationResolutionChanges: 0,
    bandwidthQualityLimitationPercentage: 0, cpuQualityLimitationPercentage: 0, otherQualityLimitationPercentage: 0,
    averageEncodeTime: 5, averageDecodeTime: 5, freezeCount: 0, totalFreezesDuration: 0,
    qpSum: 10000, encoderImplementation: 'libvpx', powerEfficientEncoder: true,
    decoderImplementation: 'libvpx', powerEfficientDecoder: true, hasNullVideoDecoder: false,
    concealedSamples: null, totalSamplesReceived: null, concealmentPercentage: null,
    jitterBufferFlushes: null, hasPeriodicJitterBufferFlushes: null,
    insertedSamplesForDeceleration: null, removedSamplesForAcceleration: null,
    decelerationPercentage: null, accelerationPercentage: null, timeToFirstFrame: 300,
    ...overrides
  };
}

function ctxWithTrack(track: FeatureTrack): RuleContext {
  const connection: FeatureConnection = {
    id: 1, dumpId: 1, connectionIdentifier: 'PC_0', closed: true,
    iceConnected: true, iceConnectionTime: 500, iceRestart: false,
    addIceCandidateFailure: null, setLocalDescriptionFailure: null, setRemoteDescriptionFailure: null,
    connected: true, dtlsVersion: '1.2', dtlsRole: 'client', addedNullCandidate: false,
    firstCandidatePairLocalType: 'host', firstCandidatePairRemoteType: 'host',
    averageStunRoundTripTime: 20, iceRestartFollowedBySetRemoteDescription: false,
    signalingDelay: 100, setRemoteDescriptionDelay: 50, setLocalDescriptionDelay: 50,
    clockSkew: 0, gatheringTimeTurnUdp: null, gatheringTimeTurnTcp: null, gatheringTimeTurnTls: null,
    tracks: [track]
  };
  return {
    metadata: { id: 1, dumpId: 1, startTime: null, useragent: null, numberPeerconnections: 1 },
    client: null,
    connections: [connection],
    thresholds: defaultThresholds
  };
}

function ruleById(id: string) {
  const rule = videoRules.find((r) => r.id === id);
  if (!rule) throw new Error(`rule ${id} not registered`);
  return rule;
}

describe('video.freezes', () => {
  it('does not fire under the warning threshold', () => {
    const ctx = ctxWithTrack(baseTrack({ freezeCount: 2, totalFreezesDuration: 2000 }));
    expect(ruleById('video.freezes').evaluate(ctx)).toHaveLength(0);
  });

  it('fires critical above the critical threshold', () => {
    const ctx = ctxWithTrack(baseTrack({ freezeCount: 10, totalFreezesDuration: 20000 }));
    const [obs] = ruleById('video.freezes').evaluate(ctx);
    expect(obs.severity).toBe('critical');
    expect(obs.observation.totalFreezesDuration).toBe(20000);
  });

  it('ignores a track with no freezes recorded', () => {
    const ctx = ctxWithTrack(baseTrack({ freezeCount: 0, totalFreezesDuration: 0 }));
    expect(ruleById('video.freezes').evaluate(ctx)).toHaveLength(0);
  });
});

describe('video.quality_limitation_cpu', () => {
  it('fires warning above the warning percentage', () => {
    const ctx = ctxWithTrack(baseTrack({ cpuQualityLimitationPercentage: 25 }));
    const [obs] = ruleById('video.quality_limitation_cpu').evaluate(ctx);
    expect(obs.severity).toBe('warning');
  });
});

describe('video.quality_limitation_bandwidth', () => {
  it('fires critical above the critical percentage', () => {
    const ctx = ctxWithTrack(baseTrack({ bandwidthQualityLimitationPercentage: 60 }));
    const [obs] = ruleById('video.quality_limitation_bandwidth').evaluate(ctx);
    expect(obs.severity).toBe('critical');
  });
});

describe('video.frequent_resolution_changes', () => {
  it('fires warning above the warning count', () => {
    const ctx = ctxWithTrack(baseTrack({ qualityLimitationResolutionChanges: 7 }));
    const [obs] = ruleById('video.frequent_resolution_changes').evaluate(ctx);
    expect(obs.severity).toBe('warning');
  });
});

describe('video.slow_time_to_first_frame', () => {
  it('fires critical above the critical threshold', () => {
    const ctx = ctxWithTrack(baseTrack({ timeToFirstFrame: 6000 }));
    const [obs] = ruleById('video.slow_time_to_first_frame').evaluate(ctx);
    expect(obs.severity).toBe('critical');
  });

  it('does not fire when unset', () => {
    const ctx = ctxWithTrack(baseTrack({ timeToFirstFrame: null }));
    expect(ruleById('video.slow_time_to_first_frame').evaluate(ctx)).toHaveLength(0);
  });
});

describe('video.slow_encode', () => {
  it('fires warning above the warning threshold for a sending track', () => {
    const ctx = ctxWithTrack(baseTrack({ direction: 'sendonly', averageEncodeTime: 25 }));
    const [obs] = ruleById('video.slow_encode').evaluate(ctx);
    expect(obs.severity).toBe('warning');
  });

  it('does not fire for a receive-only track', () => {
    const ctx = ctxWithTrack(baseTrack({ direction: 'recvonly', averageEncodeTime: 100 }));
    expect(ruleById('video.slow_encode').evaluate(ctx)).toHaveLength(0);
  });
});

describe('video.slow_decode', () => {
  it('fires warning above the warning threshold for a receiving track', () => {
    const ctx = ctxWithTrack(baseTrack({ direction: 'recvonly', averageDecodeTime: 25 }));
    const [obs] = ruleById('video.slow_decode').evaluate(ctx);
    expect(obs.severity).toBe('warning');
  });
});

describe('video.no_hw_acceleration', () => {
  it('fires info when the decoder is not power efficient', () => {
    const ctx = ctxWithTrack(baseTrack({ decoderImplementation: 'libvpx', powerEfficientDecoder: false }));
    const [obs] = ruleById('video.no_hw_acceleration').evaluate(ctx);
    expect(obs.severity).toBe('info');
  });

  it('does not fire when the implementation is unknown', () => {
    const ctx = ctxWithTrack(baseTrack({ decoderImplementation: null, powerEfficientDecoder: null }));
    expect(ruleById('video.no_hw_acceleration').evaluate(ctx)).toHaveLength(0);
  });
});

describe('video.null_video_decoder', () => {
  it('fires critical when the decoder is null', () => {
    const ctx = ctxWithTrack(baseTrack({ hasNullVideoDecoder: true }));
    const [obs] = ruleById('video.null_video_decoder').evaluate(ctx);
    expect(obs.severity).toBe('critical');
  });
});

describe('video.qp_degradation', () => {
  it('fires critical when average QP exceeds the critical threshold', () => {
    const ctx = ctxWithTrack(baseTrack({ frameCount: 1000, qpSum: 45000 }));
    const [obs] = ruleById('video.qp_degradation').evaluate(ctx);
    expect(obs.severity).toBe('critical');
    expect(obs.observation.averageQp).toBe(45);
  });

  it('does not fire when there are no frames to average over', () => {
    const ctx = ctxWithTrack(baseTrack({ frameCount: 0, qpSum: 0 }));
    expect(ruleById('video.qp_degradation').evaluate(ctx)).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/rules/test/rules/video.test.ts`
Expected: FAIL — `Cannot find module '../../src/rules/video.js'`

- [ ] **Step 3: Implement `video.ts`**

`packages/rules/src/rules/video.ts`:
```ts
import type { FeatureTrack, Observation, Rule, RuleContext, Severity } from '../types.js';

function forEachVideoTrack(
  ctx: RuleContext,
  fn: (t: FeatureTrack, connectionPid: string | null) => Observation | null
): Observation[] {
  const out: Observation[] = [];
  for (const c of ctx.connections) {
    for (const t of c.tracks) {
      if (t.kind !== 'video') continue;
      const obs = fn(t, c.connectionIdentifier);
      if (obs) out.push(obs);
    }
  }
  return out;
}

function makeObservation(
  type: string,
  severity: Severity,
  pid: string | null,
  data: Record<string, unknown>
): Observation {
  return { type, severity, category: 'video', pid, firstSeenAt: null, observation: data };
}

const freezes: Rule = {
  id: 'video.freezes',
  category: 'video',
  scope: 'track',
  evaluate: (ctx) => forEachVideoTrack(ctx, (t, pid) => {
    if (!t.freezeCount || !t.totalFreezesDuration) return null;
    const totalMs = t.totalFreezesDuration;
    if (totalMs >= ctx.thresholds.freezeTotalCriticalMs) {
      return makeObservation('video.freezes', 'critical', pid, { count: t.freezeCount, totalFreezesDuration: totalMs });
    }
    if (totalMs >= ctx.thresholds.freezeTotalWarningMs) {
      return makeObservation('video.freezes', 'warning', pid, { count: t.freezeCount, totalFreezesDuration: totalMs });
    }
    return null;
  })
};

function qualityLimitationRule(id: string, field: 'cpuQualityLimitationPercentage' | 'bandwidthQualityLimitationPercentage'): Rule {
  return {
    id,
    category: 'video',
    scope: 'track',
    evaluate: (ctx) => forEachVideoTrack(ctx, (t, pid) => {
      const pct = t[field];
      if (pct == null) return null;
      if (pct >= ctx.thresholds.qualityLimitationCriticalPct) {
        return makeObservation(id, 'critical', pid, { percentage: pct });
      }
      if (pct >= ctx.thresholds.qualityLimitationWarningPct) {
        return makeObservation(id, 'warning', pid, { percentage: pct });
      }
      return null;
    })
  };
}

const qualityLimitationCpu = qualityLimitationRule('video.quality_limitation_cpu', 'cpuQualityLimitationPercentage');
const qualityLimitationBandwidth = qualityLimitationRule('video.quality_limitation_bandwidth', 'bandwidthQualityLimitationPercentage');

const frequentResolutionChanges: Rule = {
  id: 'video.frequent_resolution_changes',
  category: 'video',
  scope: 'track',
  evaluate: (ctx) => forEachVideoTrack(ctx, (t, pid) => {
    if (t.qualityLimitationResolutionChanges == null) return null;
    if (t.qualityLimitationResolutionChanges < ctx.thresholds.resolutionChangesWarningCount) return null;
    return makeObservation('video.frequent_resolution_changes', 'warning', pid, {
      count: t.qualityLimitationResolutionChanges
    });
  })
};

const slowTimeToFirstFrame: Rule = {
  id: 'video.slow_time_to_first_frame',
  category: 'video',
  scope: 'track',
  evaluate: (ctx) => forEachVideoTrack(ctx, (t, pid) => {
    if (t.timeToFirstFrame == null) return null;
    if (t.timeToFirstFrame >= ctx.thresholds.ttffCriticalMs) {
      return makeObservation('video.slow_time_to_first_frame', 'critical', pid, { timeToFirstFrame: t.timeToFirstFrame });
    }
    if (t.timeToFirstFrame >= ctx.thresholds.ttffWarningMs) {
      return makeObservation('video.slow_time_to_first_frame', 'warning', pid, { timeToFirstFrame: t.timeToFirstFrame });
    }
    return null;
  })
};

const slowEncode: Rule = {
  id: 'video.slow_encode',
  category: 'video',
  scope: 'track',
  evaluate: (ctx) => forEachVideoTrack(ctx, (t, pid) => {
    if (t.direction !== 'sendonly' && t.direction !== 'sendrecv') return null;
    if (t.averageEncodeTime == null) return null;
    if (t.averageEncodeTime >= ctx.thresholds.encodeTimeCriticalMs) {
      return makeObservation('video.slow_encode', 'critical', pid, { averageEncodeTime: t.averageEncodeTime });
    }
    if (t.averageEncodeTime >= ctx.thresholds.encodeTimeWarningMs) {
      return makeObservation('video.slow_encode', 'warning', pid, { averageEncodeTime: t.averageEncodeTime });
    }
    return null;
  })
};

const slowDecode: Rule = {
  id: 'video.slow_decode',
  category: 'video',
  scope: 'track',
  evaluate: (ctx) => forEachVideoTrack(ctx, (t, pid) => {
    if (t.direction !== 'recvonly' && t.direction !== 'sendrecv') return null;
    if (t.averageDecodeTime == null) return null;
    if (t.averageDecodeTime >= ctx.thresholds.decodeTimeCriticalMs) {
      return makeObservation('video.slow_decode', 'critical', pid, { averageDecodeTime: t.averageDecodeTime });
    }
    if (t.averageDecodeTime >= ctx.thresholds.decodeTimeWarningMs) {
      return makeObservation('video.slow_decode', 'warning', pid, { averageDecodeTime: t.averageDecodeTime });
    }
    return null;
  })
};

const noHwAcceleration: Rule = {
  id: 'video.no_hw_acceleration',
  category: 'video',
  scope: 'track',
  evaluate: (ctx) => forEachVideoTrack(ctx, (t, pid) => {
    if (!t.decoderImplementation || t.powerEfficientDecoder == null) return null;
    if (t.powerEfficientDecoder) return null;
    return makeObservation('video.no_hw_acceleration', 'info', pid, {
      decoderImplementation: t.decoderImplementation
    });
  })
};

const nullVideoDecoder: Rule = {
  id: 'video.null_video_decoder',
  category: 'video',
  scope: 'track',
  evaluate: (ctx) => forEachVideoTrack(ctx, (t, pid) => {
    if (!t.hasNullVideoDecoder) return null;
    return makeObservation('video.null_video_decoder', 'critical', pid, {});
  })
};

const qpDegradation: Rule = {
  id: 'video.qp_degradation',
  category: 'video',
  scope: 'track',
  evaluate: (ctx) => forEachVideoTrack(ctx, (t, pid) => {
    if (!t.frameCount || t.qpSum == null) return null;
    const averageQp = t.qpSum / t.frameCount;
    if (averageQp >= ctx.thresholds.qpCritical) {
      return makeObservation('video.qp_degradation', 'critical', pid, { averageQp });
    }
    if (averageQp >= ctx.thresholds.qpWarning) {
      return makeObservation('video.qp_degradation', 'warning', pid, { averageQp });
    }
    return null;
  })
};

export const videoRules: Rule[] = [
  freezes,
  qualityLimitationCpu,
  qualityLimitationBandwidth,
  frequentResolutionChanges,
  slowTimeToFirstFrame,
  slowEncode,
  slowDecode,
  noHwAcceleration,
  nullVideoDecoder,
  qpDegradation
];
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/rules/test/rules/video.test.ts`
Expected: PASS (16 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/rules/src/rules/video.ts packages/rules/test/rules/video.test.ts
git commit -m "feat(rules): add video rule set"
```

### Task 6: Audio rules

**Files:**
- Create: `packages/rules/src/rules/audio.ts`
- Test: `packages/rules/test/rules/audio.test.ts`

**Interfaces:**
- Consumes: `Rule`, `RuleContext`, `Observation`, `FeatureTrack`, `FeatureClient` (Task 1).
- Produces: `audioRules: Rule[]`, 4 rules: `audio.concealment_ratio`, `audio.jitter_buffer_flushes`, `audio.time_stretching`, `audio.track_ended_unexpectedly`. Consumed by `registry.ts` in Task 9.

- [ ] **Step 1: Write the failing tests**

`packages/rules/test/rules/audio.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { audioRules } from '../../src/rules/audio.js';
import { defaultThresholds } from '../../src/thresholds.js';
import type { FeatureClient, FeatureConnection, FeatureTrack, RuleContext } from '../../src/types.js';

function baseAudioTrack(overrides: Partial<FeatureTrack> = {}): FeatureTrack {
  return {
    id: 1, connectionId: 1, trackIdentifier: 'a0', kind: 'audio', direction: 'sendrecv',
    frameCount: null, qualityLimitationResolutionChanges: null,
    bandwidthQualityLimitationPercentage: null, cpuQualityLimitationPercentage: null, otherQualityLimitationPercentage: null,
    averageEncodeTime: null, averageDecodeTime: null, freezeCount: null, totalFreezesDuration: null,
    qpSum: null, encoderImplementation: null, powerEfficientEncoder: null,
    decoderImplementation: null, powerEfficientDecoder: null, hasNullVideoDecoder: null,
    concealedSamples: 0, totalSamplesReceived: 100000, concealmentPercentage: 0,
    jitterBufferFlushes: 0, hasPeriodicJitterBufferFlushes: false,
    insertedSamplesForDeceleration: 0, removedSamplesForAcceleration: 0,
    decelerationPercentage: 0, accelerationPercentage: 0, timeToFirstFrame: null,
    ...overrides
  };
}

function ctxWith(track: FeatureTrack | null, client: FeatureClient | null = null): RuleContext {
  const connection: FeatureConnection = {
    id: 1, dumpId: 1, connectionIdentifier: 'PC_0', closed: true,
    iceConnected: true, iceConnectionTime: 500, iceRestart: false,
    addIceCandidateFailure: null, setLocalDescriptionFailure: null, setRemoteDescriptionFailure: null,
    connected: true, dtlsVersion: '1.2', dtlsRole: 'client', addedNullCandidate: false,
    firstCandidatePairLocalType: 'host', firstCandidatePairRemoteType: 'host',
    averageStunRoundTripTime: 20, iceRestartFollowedBySetRemoteDescription: false,
    signalingDelay: 100, setRemoteDescriptionDelay: 50, setLocalDescriptionDelay: 50,
    clockSkew: 0, gatheringTimeTurnUdp: null, gatheringTimeTurnTcp: null, gatheringTimeTurnTls: null,
    tracks: track ? [track] : []
  };
  return {
    metadata: { id: 1, dumpId: 1, startTime: null, useragent: null, numberPeerconnections: 1 },
    client,
    connections: [connection],
    thresholds: defaultThresholds
  };
}

function ruleById(id: string) {
  const rule = audioRules.find((r) => r.id === id);
  if (!rule) throw new Error(`rule ${id} not registered`);
  return rule;
}

describe('audio.concealment_ratio', () => {
  it('does not fire under the warning percentage', () => {
    const ctx = ctxWith(baseAudioTrack({ concealmentPercentage: 1 }));
    expect(ruleById('audio.concealment_ratio').evaluate(ctx)).toHaveLength(0);
  });

  it('fires critical above the critical percentage', () => {
    const ctx = ctxWith(baseAudioTrack({ concealmentPercentage: 10 }));
    const [obs] = ruleById('audio.concealment_ratio').evaluate(ctx);
    expect(obs.severity).toBe('critical');
  });
});

describe('audio.jitter_buffer_flushes', () => {
  it('fires warning above the warning count', () => {
    const ctx = ctxWith(baseAudioTrack({ jitterBufferFlushes: 5, hasPeriodicJitterBufferFlushes: false }));
    const [obs] = ruleById('audio.jitter_buffer_flushes').evaluate(ctx);
    expect(obs.severity).toBe('warning');
  });

  it('fires critical when flushes are periodic regardless of count', () => {
    const ctx = ctxWith(baseAudioTrack({ jitterBufferFlushes: 1, hasPeriodicJitterBufferFlushes: true }));
    const [obs] = ruleById('audio.jitter_buffer_flushes').evaluate(ctx);
    expect(obs.severity).toBe('critical');
  });

  it('does not fire for a couple of one-off flushes', () => {
    const ctx = ctxWith(baseAudioTrack({ jitterBufferFlushes: 1, hasPeriodicJitterBufferFlushes: false }));
    expect(ruleById('audio.jitter_buffer_flushes').evaluate(ctx)).toHaveLength(0);
  });
});

describe('audio.time_stretching', () => {
  it('fires critical when deceleration exceeds the critical percentage', () => {
    const ctx = ctxWith(baseAudioTrack({ decelerationPercentage: 20, accelerationPercentage: 0 }));
    const [obs] = ruleById('audio.time_stretching').evaluate(ctx);
    expect(obs.severity).toBe('critical');
  });

  it('fires warning when acceleration exceeds the warning percentage', () => {
    const ctx = ctxWith(baseAudioTrack({ decelerationPercentage: 0, accelerationPercentage: 7 }));
    const [obs] = ruleById('audio.time_stretching').evaluate(ctx);
    expect(obs.severity).toBe('warning');
  });
});

describe('audio.track_ended_unexpectedly', () => {
  it('fires warning when the audio track ended after a short duration', () => {
    const client: FeatureClient = {
      id: 1, dumpId: 1, hardwareConcurrency: 8, deviceMemory: 8,
      calledGetUserMedia: true, getUserMediaSuccessCount: 1, getUserMediaErrorCount: 0, getUserMediaError: null,
      reloadCount: 0, cpuPerformance: 5, operatingSystem: 'macOS',
      audioEnded: true, audioShortDuration: true, videoEnded: false, videoShortDuration: false
    };
    const ctx = ctxWith(baseAudioTrack(), client);
    const [obs] = ruleById('audio.track_ended_unexpectedly').evaluate(ctx);
    expect(obs.severity).toBe('warning');
  });

  it('does not fire when there is no client feature row', () => {
    const ctx = ctxWith(baseAudioTrack(), null);
    expect(ruleById('audio.track_ended_unexpectedly').evaluate(ctx)).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/rules/test/rules/audio.test.ts`
Expected: FAIL — `Cannot find module '../../src/rules/audio.js'`

- [ ] **Step 3: Implement `audio.ts`**

`packages/rules/src/rules/audio.ts`:
```ts
import type { FeatureTrack, Observation, Rule, RuleContext, Severity } from '../types.js';

function forEachAudioTrack(
  ctx: RuleContext,
  fn: (t: FeatureTrack, connectionPid: string | null) => Observation | null
): Observation[] {
  const out: Observation[] = [];
  for (const c of ctx.connections) {
    for (const t of c.tracks) {
      if (t.kind !== 'audio') continue;
      const obs = fn(t, c.connectionIdentifier);
      if (obs) out.push(obs);
    }
  }
  return out;
}

function makeObservation(
  type: string,
  severity: Severity,
  pid: string | null,
  data: Record<string, unknown>
): Observation {
  return { type, severity, category: 'audio', pid, firstSeenAt: null, observation: data };
}

const concealmentRatio: Rule = {
  id: 'audio.concealment_ratio',
  category: 'audio',
  scope: 'track',
  evaluate: (ctx) => forEachAudioTrack(ctx, (t, pid) => {
    if (t.concealmentPercentage == null) return null;
    if (t.concealmentPercentage >= ctx.thresholds.concealmentCriticalPct) {
      return makeObservation('audio.concealment_ratio', 'critical', pid, { percentage: t.concealmentPercentage });
    }
    if (t.concealmentPercentage >= ctx.thresholds.concealmentWarningPct) {
      return makeObservation('audio.concealment_ratio', 'warning', pid, { percentage: t.concealmentPercentage });
    }
    return null;
  })
};

const jitterBufferFlushes: Rule = {
  id: 'audio.jitter_buffer_flushes',
  category: 'audio',
  scope: 'track',
  evaluate: (ctx) => forEachAudioTrack(ctx, (t, pid) => {
    if (t.hasPeriodicJitterBufferFlushes) {
      return makeObservation('audio.jitter_buffer_flushes', 'critical', pid, { periodic: true, count: t.jitterBufferFlushes ?? 0 });
    }
    if (t.jitterBufferFlushes != null && t.jitterBufferFlushes >= ctx.thresholds.jitterBufferFlushesWarningCount) {
      return makeObservation('audio.jitter_buffer_flushes', 'warning', pid, { periodic: false, count: t.jitterBufferFlushes });
    }
    return null;
  })
};

const timeStretching: Rule = {
  id: 'audio.time_stretching',
  category: 'audio',
  scope: 'track',
  evaluate: (ctx) => forEachAudioTrack(ctx, (t, pid) => {
    const worst = Math.max(t.decelerationPercentage ?? 0, t.accelerationPercentage ?? 0);
    if (worst >= ctx.thresholds.timeStretchingCriticalPct) {
      return makeObservation('audio.time_stretching', 'critical', pid, { percentage: worst });
    }
    if (worst >= ctx.thresholds.timeStretchingWarningPct) {
      return makeObservation('audio.time_stretching', 'warning', pid, { percentage: worst });
    }
    return null;
  })
};

const trackEndedUnexpectedly: Rule = {
  id: 'audio.track_ended_unexpectedly',
  category: 'audio',
  scope: 'session',
  evaluate: (ctx) => {
    if (!ctx.client) return [];
    if (ctx.client.audioEnded && ctx.client.audioShortDuration) {
      return [makeObservation('audio.track_ended_unexpectedly', 'warning', null, {})];
    }
    return [];
  }
};

export const audioRules: Rule[] = [
  concealmentRatio,
  jitterBufferFlushes,
  timeStretching,
  trackEndedUnexpectedly
];
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/rules/test/rules/audio.test.ts`
Expected: PASS (9 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/rules/src/rules/audio.ts packages/rules/test/rules/audio.test.ts
git commit -m "feat(rules): add audio rule set"
```

### Task 7: Device rules

**Files:**
- Create: `packages/rules/src/rules/device.ts`
- Test: `packages/rules/test/rules/device.test.ts`

**Interfaces:**
- Consumes: `Rule`, `RuleContext`, `Observation`, `FeatureClient` (Task 1).
- Produces: `deviceRules: Rule[]`, 3 rules: `device.get_user_media_failure`, `device.low_cpu_performance`, `device.frequent_reloads`. Consumed by `registry.ts` in Task 9.

- [ ] **Step 1: Write the failing tests**

`packages/rules/test/rules/device.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { deviceRules } from '../../src/rules/device.js';
import { defaultThresholds } from '../../src/thresholds.js';
import type { FeatureClient, RuleContext } from '../../src/types.js';

function baseClient(overrides: Partial<FeatureClient> = {}): FeatureClient {
  return {
    id: 1, dumpId: 1, hardwareConcurrency: 8, deviceMemory: 8,
    calledGetUserMedia: true, getUserMediaSuccessCount: 1, getUserMediaErrorCount: 0, getUserMediaError: null,
    reloadCount: 0, cpuPerformance: 5, operatingSystem: 'macOS',
    audioEnded: false, audioShortDuration: false, videoEnded: false, videoShortDuration: false,
    ...overrides
  };
}

function ctxWith(client: FeatureClient | null): RuleContext {
  return {
    metadata: { id: 1, dumpId: 1, startTime: null, useragent: null, numberPeerconnections: 1 },
    client,
    connections: [{
      id: 1, dumpId: 1, connectionIdentifier: 'PC_0', closed: true,
      iceConnected: true, iceConnectionTime: 500, iceRestart: false,
      addIceCandidateFailure: null, setLocalDescriptionFailure: null, setRemoteDescriptionFailure: null,
      connected: true, dtlsVersion: '1.2', dtlsRole: 'client', addedNullCandidate: false,
      firstCandidatePairLocalType: 'host', firstCandidatePairRemoteType: 'host',
      averageStunRoundTripTime: 20, iceRestartFollowedBySetRemoteDescription: false,
      signalingDelay: 100, setRemoteDescriptionDelay: 50, setLocalDescriptionDelay: 50,
      clockSkew: 0, gatheringTimeTurnUdp: null, gatheringTimeTurnTcp: null, gatheringTimeTurnTls: null,
      tracks: []
    }],
    thresholds: defaultThresholds
  };
}

function ruleById(id: string) {
  const rule = deviceRules.find((r) => r.id === id);
  if (!rule) throw new Error(`rule ${id} not registered`);
  return rule;
}

describe('device.get_user_media_failure', () => {
  it('fires critical when every getUserMedia call failed', () => {
    const ctx = ctxWith(baseClient({ getUserMediaSuccessCount: 0, getUserMediaErrorCount: 2, getUserMediaError: 'NotAllowedError' }));
    const [obs] = ruleById('device.get_user_media_failure').evaluate(ctx);
    expect(obs.severity).toBe('critical');
    expect(obs.observation.error).toBe('NotAllowedError');
  });

  it('fires warning when some calls succeeded and some failed', () => {
    const ctx = ctxWith(baseClient({ getUserMediaSuccessCount: 1, getUserMediaErrorCount: 1 }));
    const [obs] = ruleById('device.get_user_media_failure').evaluate(ctx);
    expect(obs.severity).toBe('warning');
  });

  it('does not fire with no failures', () => {
    const ctx = ctxWith(baseClient({ getUserMediaSuccessCount: 1, getUserMediaErrorCount: 0 }));
    expect(ruleById('device.get_user_media_failure').evaluate(ctx)).toHaveLength(0);
  });

  it('does not fire when there is no client row', () => {
    expect(ruleById('device.get_user_media_failure').evaluate(ctxWith(null))).toHaveLength(0);
  });
});

describe('device.low_cpu_performance', () => {
  it('fires warning at or below the threshold', () => {
    const ctx = ctxWith(baseClient({ cpuPerformance: 2 }));
    const [obs] = ruleById('device.low_cpu_performance').evaluate(ctx);
    expect(obs.severity).toBe('warning');
  });

  it('does not fire above the threshold', () => {
    const ctx = ctxWith(baseClient({ cpuPerformance: 5 }));
    expect(ruleById('device.low_cpu_performance').evaluate(ctx)).toHaveLength(0);
  });
});

describe('device.frequent_reloads', () => {
  it('fires warning above the warning count', () => {
    const ctx = ctxWith(baseClient({ reloadCount: 3 }));
    const [obs] = ruleById('device.frequent_reloads').evaluate(ctx);
    expect(obs.severity).toBe('warning');
  });

  it('does not fire for zero reloads', () => {
    const ctx = ctxWith(baseClient({ reloadCount: 0 }));
    expect(ruleById('device.frequent_reloads').evaluate(ctx)).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/rules/test/rules/device.test.ts`
Expected: FAIL — `Cannot find module '../../src/rules/device.js'`

- [ ] **Step 3: Implement `device.ts`**

`packages/rules/src/rules/device.ts`:
```ts
import type { Observation, Rule, Severity } from '../types.js';

function makeObservation(
  type: string,
  severity: Severity,
  data: Record<string, unknown>
): Observation {
  return { type, severity, category: 'device', pid: null, firstSeenAt: null, observation: data };
}

const getUserMediaFailure: Rule = {
  id: 'device.get_user_media_failure',
  category: 'device',
  scope: 'session',
  evaluate: (ctx) => {
    const c = ctx.client;
    if (!c || !c.getUserMediaErrorCount) return [];
    const severity: Severity = c.getUserMediaSuccessCount ? 'warning' : 'critical';
    return [makeObservation('device.get_user_media_failure', severity, {
      successCount: c.getUserMediaSuccessCount,
      errorCount: c.getUserMediaErrorCount,
      error: c.getUserMediaError
    })];
  }
};

const lowCpuPerformance: Rule = {
  id: 'device.low_cpu_performance',
  category: 'device',
  scope: 'session',
  evaluate: (ctx) => {
    const c = ctx.client;
    if (!c || c.cpuPerformance == null) return [];
    if (c.cpuPerformance > ctx.thresholds.lowCpuPerformanceThreshold) return [];
    return [makeObservation('device.low_cpu_performance', 'warning', { cpuPerformance: c.cpuPerformance })];
  }
};

const frequentReloads: Rule = {
  id: 'device.frequent_reloads',
  category: 'device',
  scope: 'session',
  evaluate: (ctx) => {
    const c = ctx.client;
    if (!c || c.reloadCount == null) return [];
    if (c.reloadCount < ctx.thresholds.reloadCountWarningCount) return [];
    return [makeObservation('device.frequent_reloads', 'warning', { reloadCount: c.reloadCount })];
  }
};

export const deviceRules: Rule[] = [getUserMediaFailure, lowCpuPerformance, frequentReloads];
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/rules/test/rules/device.test.ts`
Expected: PASS (8 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/rules/src/rules/device.ts packages/rules/test/rules/device.test.ts
git commit -m "feat(rules): add device rule set"
```

### Task 8: API-failure rules

**Files:**
- Create: `packages/rules/src/rules/api.ts`
- Test: `packages/rules/test/rules/api.test.ts`

**Interfaces:**
- Consumes: `Rule`, `RuleContext`, `Observation`, `FeatureConnection` (Task 1).
- Produces: `apiRules: Rule[]`, 3 rules: `api.add_ice_candidate_failure`, `api.set_local_description_failure`, `api.set_remote_description_failure`. Consumed by `registry.ts` in Task 9.

- [ ] **Step 1: Write the failing tests**

`packages/rules/test/rules/api.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { apiRules } from '../../src/rules/api.js';
import { defaultThresholds } from '../../src/thresholds.js';
import type { FeatureConnection, RuleContext } from '../../src/types.js';

function baseConnection(overrides: Partial<FeatureConnection> = {}): FeatureConnection {
  return {
    id: 1, dumpId: 1, connectionIdentifier: 'PC_0', closed: true,
    iceConnected: true, iceConnectionTime: 500, iceRestart: false,
    addIceCandidateFailure: null, setLocalDescriptionFailure: null, setRemoteDescriptionFailure: null,
    connected: true, dtlsVersion: '1.2', dtlsRole: 'client', addedNullCandidate: false,
    firstCandidatePairLocalType: 'host', firstCandidatePairRemoteType: 'host',
    averageStunRoundTripTime: 20, iceRestartFollowedBySetRemoteDescription: false,
    signalingDelay: 100, setRemoteDescriptionDelay: 50, setLocalDescriptionDelay: 50,
    clockSkew: 0, gatheringTimeTurnUdp: null, gatheringTimeTurnTcp: null, gatheringTimeTurnTls: null,
    tracks: [],
    ...overrides
  };
}

function ctxWith(connection: FeatureConnection): RuleContext {
  return {
    metadata: { id: 1, dumpId: 1, startTime: null, useragent: null, numberPeerconnections: 1 },
    client: null,
    connections: [connection],
    thresholds: defaultThresholds
  };
}

function ruleById(id: string) {
  const rule = apiRules.find((r) => r.id === id);
  if (!rule) throw new Error(`rule ${id} not registered`);
  return rule;
}

describe('api.add_ice_candidate_failure', () => {
  it('fires warning when addIceCandidate failed', () => {
    const ctx = ctxWith(baseConnection({ addIceCandidateFailure: 'OperationError: ...' }));
    const [obs] = ruleById('api.add_ice_candidate_failure').evaluate(ctx);
    expect(obs.severity).toBe('warning');
    expect(obs.observation.error).toBe('OperationError: ...');
  });

  it('does not fire when null', () => {
    expect(ruleById('api.add_ice_candidate_failure').evaluate(ctxWith(baseConnection()))).toHaveLength(0);
  });
});

describe('api.set_local_description_failure', () => {
  it('fires critical when setLocalDescription failed', () => {
    const ctx = ctxWith(baseConnection({ setLocalDescriptionFailure: 'InvalidStateError' }));
    const [obs] = ruleById('api.set_local_description_failure').evaluate(ctx);
    expect(obs.severity).toBe('critical');
  });
});

describe('api.set_remote_description_failure', () => {
  it('fires critical when setRemoteDescription failed', () => {
    const ctx = ctxWith(baseConnection({ setRemoteDescriptionFailure: 'InvalidAccessError' }));
    const [obs] = ruleById('api.set_remote_description_failure').evaluate(ctx);
    expect(obs.severity).toBe('critical');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/rules/test/rules/api.test.ts`
Expected: FAIL — `Cannot find module '../../src/rules/api.js'`

- [ ] **Step 3: Implement `api.ts`**

`packages/rules/src/rules/api.ts`:
```ts
import type { FeatureConnection, Observation, Rule, Severity } from '../types.js';

function makeObservation(
  type: string,
  severity: Severity,
  pid: string | null,
  data: Record<string, unknown>
): Observation {
  return { type, severity, category: 'api', pid, firstSeenAt: null, observation: data };
}

function failureRule(id: string, field: keyof FeatureConnection, severity: Severity): Rule {
  return {
    id,
    category: 'api',
    scope: 'connection',
    evaluate: (ctx) => ctx.connections
      .filter((c) => c[field])
      .map((c) => makeObservation(id, severity, c.connectionIdentifier, { error: c[field] }))
  };
}

const addIceCandidateFailure = failureRule('api.add_ice_candidate_failure', 'addIceCandidateFailure', 'warning');
const setLocalDescriptionFailure = failureRule('api.set_local_description_failure', 'setLocalDescriptionFailure', 'critical');
const setRemoteDescriptionFailure = failureRule('api.set_remote_description_failure', 'setRemoteDescriptionFailure', 'critical');

export const apiRules: Rule[] = [addIceCandidateFailure, setLocalDescriptionFailure, setRemoteDescriptionFailure];
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/rules/test/rules/api.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/rules/src/rules/api.ts packages/rules/test/rules/api.test.ts
git commit -m "feat(rules): add api-failure rule set"
```

### Task 9: Wire the real registry + package entry point

**Files:**
- Modify: `packages/rules/src/registry.ts`
- Create: `packages/rules/src/index.ts`
- Test: `packages/rules/test/registry.test.ts`
- Test: `packages/rules/test/index.test.ts`

**Interfaces:**
- Consumes: `connectivityRules` (Task 4), `videoRules` (Task 5), `audioRules` (Task 6), `deviceRules` (Task 7), `apiRules` (Task 8), `analyze` (Task 3).
- Produces: `RULES_VERSION: string` and everything re-exported from `packages/rules/src/index.ts` (`analyze`, `buildRegistry`, `getRuleIds`, `defaultThresholds`, all `types.ts` exports) — this is the package's public API, imported by `packages/analyzer` starting in Task 11.

- [ ] **Step 1: Write the failing registry test**

`packages/rules/test/registry.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { buildRegistry, getRuleIds } from '../src/registry.js';

describe('buildRegistry', () => {
  it('includes at least one rule from every category', () => {
    const registry = buildRegistry();
    const categories = new Set(registry.map((r) => r.category));
    expect(categories).toEqual(new Set(['connectivity', 'video', 'audio', 'device', 'api']));
  });

  it('has no duplicate rule ids', () => {
    const ids = getRuleIds(buildRegistry());
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('contains exactly 32 rules', () => {
    expect(buildRegistry()).toHaveLength(32);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/rules/test/registry.test.ts`
Expected: FAIL — `buildRegistry()` returns `[]`, category set is empty, length is 0.

- [ ] **Step 3: Update `registry.ts` to wire in the real rule arrays**

`packages/rules/src/registry.ts`:
```ts
import { apiRules } from './rules/api.js';
import { audioRules } from './rules/audio.js';
import { connectivityRules } from './rules/connectivity.js';
import { deviceRules } from './rules/device.js';
import { videoRules } from './rules/video.js';
import type { Rule } from './types.js';

export function buildRegistry(): Rule[] {
  return [...connectivityRules, ...videoRules, ...audioRules, ...deviceRules, ...apiRules];
}

export function getRuleIds(registry: Rule[]): string[] {
  return registry.map((rule) => rule.id);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/rules/test/registry.test.ts`
Expected: PASS (3 tests — 12 connectivity + 10 video + 4 audio + 3 device + 3 api = 32)

- [ ] **Step 5: Write the failing package-entry-point test**

`packages/rules/test/index.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { analyze, buildRegistry, defaultThresholds, RULES_VERSION } from '../src/index.js';
import type { RuleContext } from '../src/index.js';

describe('index.ts public API', () => {
  it('exposes a semver RULES_VERSION', () => {
    expect(RULES_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('runs the full real registry end-to-end on a multi-problem session', () => {
    const ctx: RuleContext = {
      metadata: { id: 1, dumpId: 1, startTime: null, useragent: null, numberPeerconnections: 1 },
      client: {
        id: 1, dumpId: 1, hardwareConcurrency: 4, deviceMemory: 4,
        calledGetUserMedia: true, getUserMediaSuccessCount: 1, getUserMediaErrorCount: 0, getUserMediaError: null,
        reloadCount: 0, cpuPerformance: 5, operatingSystem: 'Windows',
        audioEnded: false, audioShortDuration: false, videoEnded: false, videoShortDuration: false
      },
      connections: [{
        id: 1, dumpId: 1, connectionIdentifier: 'PC_0', closed: true,
        iceConnected: true, iceConnectionTime: 9000, iceRestart: false,
        addIceCandidateFailure: null, setLocalDescriptionFailure: null, setRemoteDescriptionFailure: null,
        connected: true, dtlsVersion: '1.2', dtlsRole: 'client', addedNullCandidate: false,
        firstCandidatePairLocalType: 'host', firstCandidatePairRemoteType: 'host',
        averageStunRoundTripTime: 20, iceRestartFollowedBySetRemoteDescription: false,
        signalingDelay: 100, setRemoteDescriptionDelay: 50, setLocalDescriptionDelay: 50,
        clockSkew: 0, gatheringTimeTurnUdp: null, gatheringTimeTurnTcp: null, gatheringTimeTurnTls: null,
        tracks: [{
          id: 1, connectionId: 1, trackIdentifier: 'v0', kind: 'video', direction: 'recvonly',
          frameCount: 1000, qualityLimitationResolutionChanges: 0,
          bandwidthQualityLimitationPercentage: 0, cpuQualityLimitationPercentage: 0, otherQualityLimitationPercentage: 0,
          averageEncodeTime: null, averageDecodeTime: 5, freezeCount: 20, totalFreezesDuration: 25000,
          qpSum: 10000, encoderImplementation: null, powerEfficientEncoder: null,
          decoderImplementation: 'libvpx', powerEfficientDecoder: true, hasNullVideoDecoder: false,
          concealedSamples: null, totalSamplesReceived: null, concealmentPercentage: null,
          jitterBufferFlushes: null, hasPeriodicJitterBufferFlushes: null,
          insertedSamplesForDeceleration: null, removedSamplesForAcceleration: null,
          decelerationPercentage: null, accelerationPercentage: null, timeToFirstFrame: 300
        }]
      }],
      thresholds: defaultThresholds
    };

    const result = analyze(ctx, buildRegistry());
    expect(result.status).toBe('ok');
    const types = result.observations.map((o) => o.type);
    expect(types).toContain('connectivity.slow_ice_connect');
    expect(types).toContain('video.freezes');
    expect(result.scores?.connectivity).toBeLessThan(100);
    expect(result.scores?.video).toBeLessThan(100);
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npx vitest run packages/rules/test/index.test.ts`
Expected: FAIL — `Cannot find module '../src/index.js'`

- [ ] **Step 7: Implement `index.ts`**

`packages/rules/src/index.ts`:
```ts
export const RULES_VERSION = '1.0.0';

export * from './types.js';
export { analyze } from './analyze.js';
export { buildRegistry, getRuleIds } from './registry.js';
export { defaultThresholds } from './thresholds.js';
export { score } from './scoring.js';
```

- [ ] **Step 8: Run test to verify it passes**

Run: `npx vitest run packages/rules/test/index.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 9: Run the full rules package test suite**

Run: `npx vitest run packages/rules`
Expected: PASS (all tests across Tasks 1-9, ~64 tests total)

- [ ] **Step 10: Commit**

```bash
git add packages/rules/src/registry.ts packages/rules/src/index.ts packages/rules/test/registry.test.ts packages/rules/test/index.test.ts
git commit -m "feat(rules): wire full registry and export RULES_VERSION"
```

This completes Phase 1. `@rtcstats-dashboard/rules` is now a complete, independently-tested, pure diagnostics library — `npm run build --workspace packages/rules` should succeed and later phases import it as a normal package dependency.

---

## Phase 2 — Dashboard schema and test infrastructure

### Task 10: Dashboard migration, migration runner, roles, and the integration test stack

**Files:**
- Create: `migrations/0001_dashboard_tables.sql`
- Create: `scripts/migrate.mjs`
- Create: `scripts/create-roles.mjs`
- Create: `docker-compose.test.yml`
- Create: `test/fixtures/000_base_schema.sql`
- Modify: `vitest.workspace.ts`
- Create: `vitest.config.ts`
- Create: `package.json` dependency on `pg`
- Test: `test/migrate.test.ts`

**Interfaces:**
- Produces: `dashboard_analysis` and `dashboard_observations` tables (columns exactly as specified in the design doc); `runMigrations(client: pg.Client): Promise<void>` exported from `scripts/migrate.mjs`, used directly by this task's test and indirectly by every later integration test's setup; `dashboard_reader` and `dashboard_writer` Postgres roles from `scripts/create-roles.mjs`, consumed by `packages/api/src/db.ts` (Task 14) and `packages/analyzer/src/db.ts` (Task 11); the base schema in `test/fixtures/000_base_schema.sql` (`"rtcstats-server"`, `features_metadata`, `features_client`, `features_connection`, `features_track`), which every integration test from Task 11 onward seeds against.

This task's SQL and scripts are the only place this repository ever issues `CREATE TABLE` against `"rtcstats-server"` or `features_*` — and it does so **only inside `test/fixtures/`**, which is never applied to a real deployment. The real deployment already has these tables via `rtcstats_docker_deployment`.

- [ ] **Step 1: Add `pg` as a root dependency**

Run: `npm install pg@^8.13.0 --save`

- [ ] **Step 2: Write the dashboard migration**

`migrations/0001_dashboard_tables.sql`:
```sql
create table dashboard_analysis (
  id                  bigint generated by default as identity primary key,
  dump_id             bigint not null unique references "rtcstats-server"(id) on delete cascade,
  created_at          timestamptz not null default now(),
  rules_version       text not null,
  status              text not null default 'ok',
  error               text,
  session_start       timestamptz,
  duration            integer,
  rtcstats_user       text,
  rtcstats_conference text,
  experience_score    real,
  audio_score         real,
  video_score         real,
  connectivity_score  real,
  observation_types   text[] not null default '{}',
  worst_severity      text,
  observations_count  jsonb not null default '{}'
);

create table dashboard_observations (
  id             bigint generated by default as identity primary key,
  analysis_id    bigint not null references dashboard_analysis(id) on delete cascade,
  pid            text,
  type           text not null,
  severity       text not null,
  category       text not null,
  first_seen_at  double precision,
  observation    jsonb not null
);

create index on dashboard_analysis (session_start desc, experience_score);
create index on dashboard_analysis (rtcstats_user, session_start desc);
create index on dashboard_analysis (rtcstats_conference, session_start desc);
create index on dashboard_analysis using gin (observation_types);
create index on dashboard_observations (analysis_id);
```

- [ ] **Step 3: Write the migration runner**

`scripts/migrate.mjs`:
```js
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');

export async function runMigrations(client) {
  await client.query(`
    create table if not exists dashboard_schema_migrations (
      filename text primary key,
      applied_at timestamptz not null default now()
    )
  `);

  const { rows } = await client.query('select filename from dashboard_schema_migrations');
  const applied = new Set(rows.map((r) => r.filename));

  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    await client.query('begin');
    try {
      await client.query(sql);
      await client.query('insert into dashboard_schema_migrations (filename) values ($1)', [file]);
      await client.query('commit');
      console.log(`applied ${file}`);
    } catch (err) {
      await client.query('rollback');
      throw new Error(`migration ${file} failed: ${err.message}`, { cause: err });
    }
  }
}

async function main() {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await runMigrations(client);
  } finally {
    await client.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
```

- [ ] **Step 4: Write the roles/grants script**

`scripts/create-roles.mjs`:
```js
import pg from 'pg';

const BASE_TABLES = ['"rtcstats-server"', 'features_metadata', 'features_client', 'features_connection', 'features_track'];
const DASHBOARD_TABLES = ['dashboard_analysis', 'dashboard_observations'];

async function ensureRole(client, roleName, password) {
  const { rows } = await client.query('select 1 from pg_roles where rolname = $1', [roleName]);
  if (rows.length === 0) {
    await client.query(`create role "${roleName}" with login password '${password}'`);
    console.log(`created role ${roleName}`);
  } else {
    await client.query(`alter role "${roleName}" with password '${password}'`);
  }
}

async function main() {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await ensureRole(client, 'dashboard_reader', process.env.DASHBOARD_READER_PASSWORD);
    await ensureRole(client, 'dashboard_writer', process.env.DASHBOARD_WRITER_PASSWORD);

    for (const table of [...BASE_TABLES, ...DASHBOARD_TABLES]) {
      await client.query(`grant select on ${table} to dashboard_reader`);
    }
    for (const table of BASE_TABLES) {
      await client.query(`grant select on ${table} to dashboard_writer`);
    }
    for (const table of DASHBOARD_TABLES) {
      await client.query(`grant select, insert, update, delete on ${table} to dashboard_writer`);
    }
    for (const table of DASHBOARD_TABLES) {
      await client.query(`grant usage, select on all sequences in schema public to dashboard_writer`);
    }
    console.log('roles and grants applied');
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

Note: `password` is interpolated directly rather than passed as a bind parameter because Postgres does not allow parameterized identifiers/literals inside DDL (`CREATE ROLE ... PASSWORD $1` is not valid SQL). The values come from this deployment's own environment variables, never from user input, so this is not a SQL-injection risk in context — but it does mean these two env vars must never be set from anything external.

- [ ] **Step 5: Write the condensed base-schema test fixture**

`test/fixtures/000_base_schema.sql`:
```sql
-- TEST FIXTURE ONLY. Mirrors the final shape of rtcstats_docker_deployment's
-- migrations as of 2026-08-26, condensed for integration tests. Never applied
-- to a real deployment — that repo owns and applies the real migrations.

create extension if not exists "pgcrypto";

create table "rtcstats-server" (
  id bigint generated by default as identity primary key,
  created_at timestamptz not null default now(),
  session_start timestamptz,
  session_end timestamptz,
  blob_url text,
  rtcstats_user text,
  rtcstats_conference text,
  rtcstats_session text,
  features_processing_start timestamptz,
  features_processing_stop timestamptz,
  rtcstats_embed_url text,
  host_identifier text
);

create table features_metadata (
  id bigint generated by default as identity primary key,
  dump_id bigint references "rtcstats-server"(id),
  created_at timestamptz not null default now(),
  start_time timestamptz,
  useragent text,
  number_peerconnections smallint
);

create table features_client (
  id bigint generated by default as identity primary key,
  dump_id bigint references features_metadata(id) on delete cascade,
  hardware_concurrency smallint,
  device_memory smallint,
  called_get_user_media boolean default false,
  get_user_media_success_count integer default 0,
  get_user_media_error_count integer default 0,
  get_user_media_error text,
  reload_count integer,
  cpu_performance smallint,
  operating_system text,
  audio_ended boolean default false,
  audio_short_duration boolean default false,
  video_ended boolean default false,
  video_short_duration boolean default false
);

create table features_connection (
  id bigint generated by default as identity primary key,
  dump_id bigint references features_metadata(id) on delete cascade,
  connection_identifier text,
  closed boolean,
  ice_connected boolean default false,
  ice_connection_time integer,
  ice_restart boolean default false,
  add_ice_candidate_failure text,
  set_local_description_failure text,
  set_remote_description_failure text,
  connected boolean,
  dtls_version text,
  dtls_role text,
  added_null_candidate boolean,
  first_candidate_pair_local_type text,
  first_candidate_pair_remote_type text,
  average_stun_round_trip_time float,
  ice_restart_followed_by_set_remote_description boolean default false,
  signaling_delay integer,
  set_remote_description_delay integer,
  set_local_description_delay integer,
  clock_skew integer,
  gathering_time_turn_udp integer,
  gathering_time_turn_tcp integer,
  gathering_time_turn_tls integer
);

create table features_track (
  id bigint generated by default as identity primary key,
  connection_id bigint references features_connection(id) on delete cascade,
  track_identifier text,
  kind text,
  direction text,
  frame_count integer,
  quality_limitation_resolution_changes integer,
  bandwidth_quality_limitation_percentage float,
  cpu_quality_limitation_percentage float,
  other_quality_limitation_percentage float,
  average_encode_time float,
  average_decode_time float,
  freeze_count integer,
  total_freezes_duration float,
  qp_sum integer,
  encoder_implementation text,
  power_efficient_encoder boolean,
  decoder_implementation text,
  power_efficient_decoder boolean,
  has_null_video_decoder boolean,
  concealed_samples integer,
  total_samples_received integer,
  concealment_percentage float,
  jitter_buffer_flushes integer,
  has_periodic_jitter_buffer_flushes boolean,
  inserted_samples_for_deceleration integer,
  removed_samples_for_acceleration integer,
  deceleration_percentage float,
  acceleration_percentage float,
  time_to_first_frame integer
);

create index on features_metadata (dump_id);
create index on features_client (dump_id);
create index on features_connection (dump_id);
create index on features_track (connection_id);
```

- [ ] **Step 6: Write the test-only Postgres + MinIO stack**

`docker-compose.test.yml`:
```yaml
services:
  postgres-test:
    image: postgres:15-alpine
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
      POSTGRES_DB: dashboard_test
    ports:
      - "5433:5432"
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]
      interval: 2s
      timeout: 2s
      retries: 20

  minio-test:
    image: minio/minio:latest
    command: server /data
    environment:
      MINIO_ROOT_USER: minioadmin
      MINIO_ROOT_PASSWORD: minioadmin
    ports:
      - "9100:9000"
    healthcheck:
      test: ["CMD", "mc", "ready", "local"]
      interval: 2s
      timeout: 2s
      retries: 20
```

- [ ] **Step 7: Wire root Vitest to run root-level tests**

`vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['test/**/*.test.ts'] }
});
```

Update `vitest.workspace.ts`:
```ts
export default ['packages/*', '.'];
```

- [ ] **Step 8: Start the test stack and write the failing migration test**

Run: `docker compose -f docker-compose.test.yml up -d`
Run: `docker compose -f docker-compose.test.yml ps` — wait until both services report healthy.

`test/migrate.test.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { runMigrations } from '../scripts/migrate.mjs';

const TEST_DATABASE_URL = 'postgresql://postgres:postgres@localhost:5433/dashboard_test';

describe('runMigrations', () => {
  let client: pg.Client;

  beforeAll(async () => {
    client = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await client.connect();
    await client.query('drop table if exists dashboard_observations, dashboard_analysis, dashboard_schema_migrations, features_track, features_connection, features_client, features_metadata, "rtcstats-server" cascade');
    await client.query(readFileSync('test/fixtures/000_base_schema.sql', 'utf8'));
  });

  afterAll(async () => {
    await client.end();
  });

  it('creates dashboard_analysis and dashboard_observations', async () => {
    await runMigrations(client);
    const tables = await client.query(
      `select table_name from information_schema.tables where table_schema = 'public' and table_name in ('dashboard_analysis', 'dashboard_observations')`
    );
    expect(tables.rows.map((r) => r.table_name).sort()).toEqual(['dashboard_analysis', 'dashboard_observations']);
  });

  it('is idempotent on a second run', async () => {
    await runMigrations(client);
    const { rows } = await client.query('select filename from dashboard_schema_migrations');
    expect(rows).toHaveLength(1);
    expect(rows[0].filename).toBe('0001_dashboard_tables.sql');
  });
});
```

- [ ] **Step 9: Run test to verify it fails first, then passes**

Run: `npx vitest run test/migrate.test.ts`
Expected first (before Step 3's file exists, or before the test stack is up): FAIL with a connection error or missing-module error.
After Steps 3-8 are all in place, run again.
Expected: PASS (2 tests)

- [ ] **Step 10: Commit**

```bash
git add migrations scripts docker-compose.test.yml test/fixtures test/migrate.test.ts vitest.workspace.ts vitest.config.ts package.json package-lock.json
git commit -m "feat(db): add dashboard migration, migration runner, roles, and test stack"
```

From this point forward, every integration test in this plan assumes `docker compose -f docker-compose.test.yml up -d` is running and `node scripts/migrate.mjs` (with `DATABASE_URL=postgresql://postgres:postgres@localhost:5433/dashboard_test`) has been run after the base schema fixture is loaded.

---

## Phase 3 — Analyzer worker (`packages/analyzer`)

### Task 11: Postgres pool + feature loader

**Files:**
- Create: `packages/analyzer/package.json`
- Create: `packages/analyzer/tsconfig.json`
- Create: `packages/analyzer/src/db.ts`
- Create: `packages/analyzer/src/featureLoader.ts`
- Test: `packages/analyzer/test/featureLoader.test.ts`

**Interfaces:**
- Consumes: `FeatureMetadata`, `FeatureClient`, `FeatureConnection`, `FeatureTrack` types from `@rtcstats-dashboard/rules` (Phase 1, Task 1/9).
- Produces: `createPool(connectionString: string): pg.Pool` from `db.ts`; `FeatureBundle` type and `loadFeatures(pool: pg.Pool, dumpId: number): Promise<FeatureBundle | null>` from `featureLoader.ts` — `null` means features aren't extracted yet for this dump, consumed by `claim.ts`/`run.ts` in Task 13 to skip such dumps.

- [ ] **Step 1: Scaffold the package**

`packages/analyzer/package.json`:
```json
{
  "name": "@rtcstats-dashboard/analyzer",
  "version": "0.1.0",
  "type": "module",
  "main": "dist/run.js",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run",
    "start": "node dist/run.js",
    "backfill": "node dist/cli.js"
  },
  "dependencies": {
    "@rtcstats-dashboard/rules": "*",
    "pg": "^8.13.0"
  }
}
```

`packages/analyzer/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src" },
  "include": ["src"],
  "references": [{ "path": "../rules" }]
}
```

Run: `npm install` (links the `@rtcstats-dashboard/rules` workspace dependency)

- [ ] **Step 2: Write `db.ts`**

`packages/analyzer/src/db.ts`:
```ts
import pg from 'pg';

export function createPool(connectionString: string): pg.Pool {
  return new pg.Pool({ connectionString });
}
```

- [ ] **Step 3: Write the failing feature loader test**

`packages/analyzer/test/featureLoader.test.ts`:
```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import { createPool } from '../src/db.js';
import { loadFeatures } from '../src/featureLoader.js';

const TEST_DATABASE_URL = 'postgresql://postgres:postgres@localhost:5433/dashboard_test';

describe('loadFeatures', () => {
  let pool: pg.Pool;

  beforeAll(() => {
    pool = createPool(TEST_DATABASE_URL);
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query('truncate "rtcstats-server", features_metadata, features_client, features_connection, features_track restart identity cascade');
  });

  it('returns null when features have not been extracted for the dump', async () => {
    const { rows } = await pool.query(`insert into "rtcstats-server" (rtcstats_user) values ('u1') returning id`);
    const result = await loadFeatures(pool, rows[0].id);
    expect(result).toBeNull();
  });

  it('assembles metadata, client, connections, and tracks into a FeatureBundle', async () => {
    const dump = await pool.query(`insert into "rtcstats-server" (rtcstats_user) values ('u1') returning id`);
    const dumpId = dump.rows[0].id;

    const metadata = await pool.query(
      `insert into features_metadata (dump_id, start_time, useragent, number_peerconnections)
       values ($1, now(), 'Chrome/120', 1) returning id`,
      [dumpId]
    );
    const metadataId = metadata.rows[0].id;

    await pool.query(
      `insert into features_client (dump_id, hardware_concurrency, get_user_media_success_count, get_user_media_error_count, cpu_performance)
       values ($1, 8, 1, 0, 5)`,
      [metadataId]
    );

    const connection = await pool.query(
      `insert into features_connection (dump_id, connection_identifier, connected, ice_connection_time)
       values ($1, 'PC_0', true, 500) returning id`,
      [metadataId]
    );
    const connectionId = connection.rows[0].id;

    await pool.query(
      `insert into features_track (connection_id, kind, direction, freeze_count, total_freezes_duration)
       values ($1, 'video', 'recvonly', 3, 6000)`,
      [connectionId]
    );

    const bundle = await loadFeatures(pool, dumpId);
    expect(bundle).not.toBeNull();
    expect(bundle!.metadata.numberPeerconnections).toBe(1);
    expect(bundle!.client?.hardwareConcurrency).toBe(8);
    expect(bundle!.connections).toHaveLength(1);
    expect(bundle!.connections[0].connectionIdentifier).toBe('PC_0');
    expect(bundle!.connections[0].tracks).toHaveLength(1);
    expect(bundle!.connections[0].tracks[0].totalFreezesDuration).toBe(6000);
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `npx vitest run packages/analyzer/test/featureLoader.test.ts`
Expected: FAIL — `Cannot find module '../src/featureLoader.js'`

- [ ] **Step 5: Implement `featureLoader.ts`**

`packages/analyzer/src/featureLoader.ts`:
```ts
import type pg from 'pg';
import type { FeatureClient, FeatureConnection, FeatureMetadata, FeatureTrack } from '@rtcstats-dashboard/rules';

export interface FeatureBundle {
  metadata: FeatureMetadata;
  client: FeatureClient | null;
  connections: FeatureConnection[];
}

export async function loadFeatures(pool: pg.Pool, dumpId: number): Promise<FeatureBundle | null> {
  const metadataResult = await pool.query(
    `select id, dump_id, start_time, useragent, number_peerconnections
     from features_metadata where dump_id = $1`,
    [dumpId]
  );
  if (metadataResult.rows.length === 0) return null;
  const metadataRow = metadataResult.rows[0];
  const metadataId = metadataRow.id;

  const metadata: FeatureMetadata = {
    id: metadataRow.id,
    dumpId: metadataRow.dump_id,
    startTime: metadataRow.start_time,
    useragent: metadataRow.useragent,
    numberPeerconnections: metadataRow.number_peerconnections
  };

  const clientResult = await pool.query(
    `select id, dump_id, hardware_concurrency, device_memory,
            called_get_user_media, get_user_media_success_count, get_user_media_error_count, get_user_media_error,
            reload_count, cpu_performance, operating_system,
            audio_ended, audio_short_duration, video_ended, video_short_duration
     from features_client where dump_id = $1`,
    [metadataId]
  );
  const client: FeatureClient | null = clientResult.rows[0]
    ? {
        id: clientResult.rows[0].id,
        dumpId: clientResult.rows[0].dump_id,
        hardwareConcurrency: clientResult.rows[0].hardware_concurrency,
        deviceMemory: clientResult.rows[0].device_memory,
        calledGetUserMedia: clientResult.rows[0].called_get_user_media,
        getUserMediaSuccessCount: clientResult.rows[0].get_user_media_success_count,
        getUserMediaErrorCount: clientResult.rows[0].get_user_media_error_count,
        getUserMediaError: clientResult.rows[0].get_user_media_error,
        reloadCount: clientResult.rows[0].reload_count,
        cpuPerformance: clientResult.rows[0].cpu_performance,
        operatingSystem: clientResult.rows[0].operating_system,
        audioEnded: clientResult.rows[0].audio_ended,
        audioShortDuration: clientResult.rows[0].audio_short_duration,
        videoEnded: clientResult.rows[0].video_ended,
        videoShortDuration: clientResult.rows[0].video_short_duration
      }
    : null;

  const connectionRows = await pool.query(
    `select id, dump_id, connection_identifier, closed,
            ice_connected, ice_connection_time, ice_restart,
            add_ice_candidate_failure, set_local_description_failure, set_remote_description_failure,
            connected, dtls_version, dtls_role, added_null_candidate,
            first_candidate_pair_local_type, first_candidate_pair_remote_type,
            average_stun_round_trip_time, ice_restart_followed_by_set_remote_description,
            signaling_delay, set_remote_description_delay, set_local_description_delay,
            clock_skew, gathering_time_turn_udp, gathering_time_turn_tcp, gathering_time_turn_tls
     from features_connection where dump_id = $1`,
    [metadataId]
  );

  const connectionIds = connectionRows.rows.map((r) => r.id);
  const trackRows = connectionIds.length
    ? await pool.query(
        `select id, connection_id, track_identifier, kind, direction,
                frame_count, quality_limitation_resolution_changes,
                bandwidth_quality_limitation_percentage, cpu_quality_limitation_percentage, other_quality_limitation_percentage,
                average_encode_time, average_decode_time, freeze_count, total_freezes_duration,
                qp_sum, encoder_implementation, power_efficient_encoder, decoder_implementation, power_efficient_decoder,
                has_null_video_decoder, concealed_samples, total_samples_received, concealment_percentage,
                jitter_buffer_flushes, has_periodic_jitter_buffer_flushes,
                inserted_samples_for_deceleration, removed_samples_for_acceleration,
                deceleration_percentage, acceleration_percentage, time_to_first_frame
         from features_track where connection_id = any($1::bigint[])`,
        [connectionIds]
      )
    : { rows: [] };

  const tracksByConnection = new Map<number, FeatureTrack[]>();
  for (const t of trackRows.rows) {
    const track: FeatureTrack = {
      id: t.id,
      connectionId: t.connection_id,
      trackIdentifier: t.track_identifier,
      kind: t.kind,
      direction: t.direction,
      frameCount: t.frame_count,
      qualityLimitationResolutionChanges: t.quality_limitation_resolution_changes,
      bandwidthQualityLimitationPercentage: t.bandwidth_quality_limitation_percentage,
      cpuQualityLimitationPercentage: t.cpu_quality_limitation_percentage,
      otherQualityLimitationPercentage: t.other_quality_limitation_percentage,
      averageEncodeTime: t.average_encode_time,
      averageDecodeTime: t.average_decode_time,
      freezeCount: t.freeze_count,
      totalFreezesDuration: t.total_freezes_duration,
      qpSum: t.qp_sum,
      encoderImplementation: t.encoder_implementation,
      powerEfficientEncoder: t.power_efficient_encoder,
      decoderImplementation: t.decoder_implementation,
      powerEfficientDecoder: t.power_efficient_decoder,
      hasNullVideoDecoder: t.has_null_video_decoder,
      concealedSamples: t.concealed_samples,
      totalSamplesReceived: t.total_samples_received,
      concealmentPercentage: t.concealment_percentage,
      jitterBufferFlushes: t.jitter_buffer_flushes,
      hasPeriodicJitterBufferFlushes: t.has_periodic_jitter_buffer_flushes,
      insertedSamplesForDeceleration: t.inserted_samples_for_deceleration,
      removedSamplesForAcceleration: t.removed_samples_for_acceleration,
      decelerationPercentage: t.deceleration_percentage,
      accelerationPercentage: t.acceleration_percentage,
      timeToFirstFrame: t.time_to_first_frame
    };
    const list = tracksByConnection.get(t.connection_id) ?? [];
    list.push(track);
    tracksByConnection.set(t.connection_id, list);
  }

  const connections: FeatureConnection[] = connectionRows.rows.map((c) => ({
    id: c.id,
    dumpId: c.dump_id,
    connectionIdentifier: c.connection_identifier,
    closed: c.closed,
    iceConnected: c.ice_connected,
    iceConnectionTime: c.ice_connection_time,
    iceRestart: c.ice_restart,
    addIceCandidateFailure: c.add_ice_candidate_failure,
    setLocalDescriptionFailure: c.set_local_description_failure,
    setRemoteDescriptionFailure: c.set_remote_description_failure,
    connected: c.connected,
    dtlsVersion: c.dtls_version,
    dtlsRole: c.dtls_role,
    addedNullCandidate: c.added_null_candidate,
    firstCandidatePairLocalType: c.first_candidate_pair_local_type,
    firstCandidatePairRemoteType: c.first_candidate_pair_remote_type,
    averageStunRoundTripTime: c.average_stun_round_trip_time,
    iceRestartFollowedBySetRemoteDescription: c.ice_restart_followed_by_set_remote_description,
    signalingDelay: c.signaling_delay,
    setRemoteDescriptionDelay: c.set_remote_description_delay,
    setLocalDescriptionDelay: c.set_local_description_delay,
    clockSkew: c.clock_skew,
    gatheringTimeTurnUdp: c.gathering_time_turn_udp,
    gatheringTimeTurnTcp: c.gathering_time_turn_tcp,
    gatheringTimeTurnTls: c.gathering_time_turn_tls,
    tracks: tracksByConnection.get(c.id) ?? []
  }));

  return { metadata, client, connections };
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run packages/analyzer/test/featureLoader.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 7: Commit**

```bash
git add packages/analyzer/package.json packages/analyzer/tsconfig.json packages/analyzer/src/db.ts packages/analyzer/src/featureLoader.ts packages/analyzer/test/featureLoader.test.ts package-lock.json
git commit -m "feat(analyzer): add Postgres pool and feature loader"
```

### Task 12: Claim and write logic

**Files:**
- Create: `packages/analyzer/src/claim.ts`
- Create: `packages/analyzer/src/write.ts`
- Test: `packages/analyzer/test/claim.test.ts`
- Test: `packages/analyzer/test/write.test.ts`

**Interfaces:**
- Consumes: `createPool` (Task 11); `Observation`, `AnalysisResult` types from `@rtcstats-dashboard/rules` (Phase 1).
- Produces: `claimNewDumps(pool, rulesVersion, batchSize): Promise<number[]>`, `claimStaleDumps(pool, rulesVersion, batchSize, includeFailed?): Promise<number[]>` from `claim.ts`; `writeAnalysisResult(pool, dumpId, rulesVersion, result): Promise<void>`, `writeFailure(pool, dumpId, rulesVersion, errorMessage): Promise<void>` from `write.ts`. All four are called directly by `run.ts` and `cli.ts` in Task 13.

Claiming a **new** dump (no `dashboard_analysis` row yet) cannot use `FOR UPDATE` on `"rtcstats-server"`, because `dashboard_writer` only has `SELECT` there. Instead it uses `INSERT ... ON CONFLICT (dump_id) DO NOTHING RETURNING dump_id`: the unique constraint on `dump_id` makes exactly one concurrent insert succeed per dump, which is race-free without a lock. Reclaiming a **stale** dump (existing row, outdated `rules_version`) does use `FOR UPDATE SKIP LOCKED`, on `dashboard_analysis`, which the worker fully owns — this is the row-locking path the spec's global constraint refers to.

- [ ] **Step 1: Write the failing claim tests**

`packages/analyzer/test/claim.test.ts`:
```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import { createPool } from '../src/db.js';
import { claimNewDumps, claimStaleDumps } from '../src/claim.js';

const TEST_DATABASE_URL = 'postgresql://postgres:postgres@localhost:5433/dashboard_test';

async function insertReadyDump(pool: pg.Pool, user: string): Promise<number> {
  const dump = await pool.query(
    `insert into "rtcstats-server" (rtcstats_user, session_start, session_end, features_processing_stop)
     values ($1, now() - interval '10 minutes', now() - interval '9 minutes', now())
     returning id`,
    [user]
  );
  const dumpId = dump.rows[0].id;
  await pool.query(`insert into features_metadata (dump_id, number_peerconnections) values ($1, 1)`, [dumpId]);
  return dumpId;
}

describe('claimNewDumps / claimStaleDumps', () => {
  let pool: pg.Pool;

  beforeAll(() => {
    pool = createPool(TEST_DATABASE_URL);
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query('truncate dashboard_observations, dashboard_analysis, "rtcstats-server", features_metadata, features_client, features_connection, features_track restart identity cascade');
  });

  it('claims a dump with extracted features and no existing analysis row', async () => {
    const dumpId = await insertReadyDump(pool, 'alice');
    const claimed = await claimNewDumps(pool, '1.0.0', 10);
    expect(claimed).toEqual([dumpId]);

    const { rows } = await pool.query('select status, rtcstats_user from dashboard_analysis where dump_id = $1', [dumpId]);
    expect(rows[0].status).toBe('processing');
    expect(rows[0].rtcstats_user).toBe('alice');
  });

  it('does not reclaim a dump that already has an analysis row', async () => {
    const dumpId = await insertReadyDump(pool, 'bob');
    await claimNewDumps(pool, '1.0.0', 10);
    const secondClaim = await claimNewDumps(pool, '1.0.0', 10);
    expect(secondClaim).toEqual([]);
    void dumpId;
  });

  it('never lets two concurrent claimers double-claim the same dump', async () => {
    await Promise.all([insertReadyDump(pool, 'c1'), insertReadyDump(pool, 'c2'), insertReadyDump(pool, 'c3')]);
    const [claimA, claimB] = await Promise.all([
      claimNewDumps(pool, '1.0.0', 10),
      claimNewDumps(pool, '1.0.0', 10)
    ]);
    const overlap = claimA.filter((id) => claimB.includes(id));
    expect(overlap).toEqual([]);
    expect(claimA.length + claimB.length).toBe(3);
  });

  it('reclaims a dump whose rules_version is stale, via claimStaleDumps', async () => {
    const dumpId = await insertReadyDump(pool, 'dana');
    await claimNewDumps(pool, '1.0.0', 10);
    await pool.query(`update dashboard_analysis set status = 'ok', rules_version = '1.0.0' where dump_id = $1`, [dumpId]);

    const claimed = await claimStaleDumps(pool, '2.0.0', 10);
    expect(claimed).toEqual([dumpId]);
    const { rows } = await pool.query('select status from dashboard_analysis where dump_id = $1', [dumpId]);
    expect(rows[0].status).toBe('processing');
  });

  it('claimStaleDumps skips failed rows unless includeFailed is true', async () => {
    const dumpId = await insertReadyDump(pool, 'erin');
    await claimNewDumps(pool, '1.0.0', 10);
    await pool.query(`update dashboard_analysis set status = 'failed', rules_version = '1.0.0' where dump_id = $1`, [dumpId]);

    expect(await claimStaleDumps(pool, '2.0.0', 10)).toEqual([]);
    expect(await claimStaleDumps(pool, '2.0.0', 10, true)).toEqual([dumpId]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/analyzer/test/claim.test.ts`
Expected: FAIL — `Cannot find module '../src/claim.js'`

- [ ] **Step 3: Implement `claim.ts`**

`packages/analyzer/src/claim.ts`:
```ts
import type pg from 'pg';

export async function claimNewDumps(pool: pg.Pool, rulesVersion: string, batchSize: number): Promise<number[]> {
  const { rows } = await pool.query(
    `insert into dashboard_analysis (dump_id, rules_version, status, session_start, duration, rtcstats_user, rtcstats_conference)
     select sub.id, $1, 'processing', sub.session_start,
            extract(epoch from (sub.session_end - sub.session_start))::int,
            sub.rtcstats_user, sub.rtcstats_conference
     from (
       select rss.id, rss.session_start, rss.session_end, rss.rtcstats_user, rss.rtcstats_conference
       from "rtcstats-server" rss
       join features_metadata fm on fm.dump_id = rss.id
       where rss.features_processing_stop is not null
         and not exists (select 1 from dashboard_analysis da where da.dump_id = rss.id)
       order by rss.id
       limit $2
     ) sub
     on conflict (dump_id) do nothing
     returning dump_id`,
    [rulesVersion, batchSize]
  );
  return rows.map((r) => r.dump_id);
}

export async function claimStaleDumps(
  pool: pg.Pool,
  rulesVersion: string,
  batchSize: number,
  includeFailed = false
): Promise<number[]> {
  const statusFilter = includeFailed ? `status <> 'processing'` : `status not in ('processing', 'failed')`;
  const { rows } = await pool.query(
    `update dashboard_analysis
     set status = 'processing'
     where id in (
       select id from dashboard_analysis
       where rules_version <> $1 and ${statusFilter}
       order by id
       limit $2
       for update skip locked
     )
     returning dump_id`,
    [rulesVersion, batchSize]
  );
  return rows.map((r) => r.dump_id);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/analyzer/test/claim.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Write the failing write tests**

`packages/analyzer/test/write.test.ts`:
```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import { createPool } from '../src/db.js';
import { claimNewDumps } from '../src/claim.js';
import { writeAnalysisResult, writeFailure } from '../src/write.js';
import type { AnalysisResult } from '@rtcstats-dashboard/rules';

const TEST_DATABASE_URL = 'postgresql://postgres:postgres@localhost:5433/dashboard_test';

describe('writeAnalysisResult / writeFailure', () => {
  let pool: pg.Pool;
  let dumpId: number;

  beforeAll(() => {
    pool = createPool(TEST_DATABASE_URL);
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query('truncate dashboard_observations, dashboard_analysis, "rtcstats-server", features_metadata restart identity cascade');
    const dump = await pool.query(
      `insert into "rtcstats-server" (rtcstats_user, session_start, session_end, features_processing_stop)
       values ('alice', now() - interval '5 minutes', now(), now()) returning id`
    );
    dumpId = dump.rows[0].id;
    await pool.query(`insert into features_metadata (dump_id, number_peerconnections) values ($1, 1)`, [dumpId]);
    await claimNewDumps(pool, '1.0.0', 10);
  });

  it('writes scores and observations for a successful analysis', async () => {
    const result: AnalysisResult = {
      status: 'ok',
      scores: { connectivity: 70, audio: null, video: 60, experience: 65 },
      observations: [
        { type: 'connectivity.slow_ice_connect', severity: 'warning', category: 'connectivity', pid: 'PC_0', firstSeenAt: 0, observation: {} },
        { type: 'video.freezes', severity: 'critical', category: 'video', pid: 'PC_0', firstSeenAt: 10, observation: { count: 3 } }
      ]
    };
    await writeAnalysisResult(pool, dumpId, '1.0.0', result);

    const analysis = await pool.query('select * from dashboard_analysis where dump_id = $1', [dumpId]);
    expect(analysis.rows[0].status).toBe('ok');
    expect(analysis.rows[0].experience_score).toBe(65);
    expect(analysis.rows[0].worst_severity).toBe('critical');
    expect(analysis.rows[0].observation_types.sort()).toEqual(['connectivity.slow_ice_connect', 'video.freezes']);
    expect(analysis.rows[0].observations_count).toEqual({ warning: 1, critical: 1 });

    const observations = await pool.query('select * from dashboard_observations where analysis_id = $1', [analysis.rows[0].id]);
    expect(observations.rows).toHaveLength(2);
  });

  it('replaces observations on re-analysis rather than accumulating them', async () => {
    const first: AnalysisResult = {
      status: 'ok',
      scores: { connectivity: 100, audio: null, video: null, experience: 100 },
      observations: [{ type: 'connectivity.ice_restart', severity: 'warning', category: 'connectivity', pid: null, firstSeenAt: null, observation: {} }]
    };
    await writeAnalysisResult(pool, dumpId, '1.0.0', first);

    const second: AnalysisResult = {
      status: 'ok',
      scores: { connectivity: 100, audio: null, video: null, experience: 100 },
      observations: []
    };
    await writeAnalysisResult(pool, dumpId, '1.0.1', second);

    const analysis = await pool.query('select id, rules_version from dashboard_analysis where dump_id = $1', [dumpId]);
    expect(analysis.rows[0].rules_version).toBe('1.0.1');
    const observations = await pool.query('select * from dashboard_observations where analysis_id = $1', [analysis.rows[0].id]);
    expect(observations.rows).toHaveLength(0);
  });

  it('records a terminal failure with null scores', async () => {
    await writeFailure(pool, dumpId, '1.0.0', 'TypeError: cannot read property of undefined');
    const analysis = await pool.query('select * from dashboard_analysis where dump_id = $1', [dumpId]);
    expect(analysis.rows[0].status).toBe('failed');
    expect(analysis.rows[0].error).toContain('TypeError');
    expect(analysis.rows[0].experience_score).toBeNull();
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npx vitest run packages/analyzer/test/write.test.ts`
Expected: FAIL — `Cannot find module '../src/write.js'`

- [ ] **Step 7: Implement `write.ts`**

`packages/analyzer/src/write.ts`:
```ts
import type pg from 'pg';
import type { AnalysisResult, Observation, Severity } from '@rtcstats-dashboard/rules';

function worstSeverity(observations: Observation[]): Severity | null {
  if (observations.some((o) => o.severity === 'critical')) return 'critical';
  if (observations.some((o) => o.severity === 'warning')) return 'warning';
  if (observations.some((o) => o.severity === 'info')) return 'info';
  return null;
}

function countsBySeverity(observations: Observation[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const o of observations) counts[o.severity] = (counts[o.severity] ?? 0) + 1;
  return counts;
}

export async function writeAnalysisResult(
  pool: pg.Pool,
  dumpId: number,
  rulesVersion: string,
  result: AnalysisResult
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const { rows } = await client.query(
      `update dashboard_analysis set
         rules_version = $2, status = $3, error = null,
         experience_score = $4, audio_score = $5, video_score = $6, connectivity_score = $7,
         observation_types = $8, worst_severity = $9, observations_count = $10
       where dump_id = $1
       returning id`,
      [
        dumpId, rulesVersion, result.status,
        result.scores?.experience ?? null,
        result.scores?.audio ?? null,
        result.scores?.video ?? null,
        result.scores?.connectivity ?? null,
        [...new Set(result.observations.map((o) => o.type))],
        worstSeverity(result.observations),
        countsBySeverity(result.observations)
      ]
    );
    const analysisId = rows[0].id;

    await client.query('delete from dashboard_observations where analysis_id = $1', [analysisId]);
    for (const obs of result.observations) {
      await client.query(
        `insert into dashboard_observations (analysis_id, pid, type, severity, category, first_seen_at, observation)
         values ($1, $2, $3, $4, $5, $6, $7)`,
        [analysisId, obs.pid, obs.type, obs.severity, obs.category, obs.firstSeenAt, obs.observation]
      );
    }
    await client.query('commit');
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
}

export async function writeFailure(
  pool: pg.Pool,
  dumpId: number,
  rulesVersion: string,
  errorMessage: string
): Promise<void> {
  await pool.query(
    `update dashboard_analysis set
       rules_version = $2, status = 'failed', error = $3,
       experience_score = null, audio_score = null, video_score = null, connectivity_score = null,
       observation_types = '{}', worst_severity = null, observations_count = '{}'
     where dump_id = $1`,
    [dumpId, rulesVersion, errorMessage]
  );
}
```

- [ ] **Step 8: Run test to verify it passes**

Run: `npx vitest run packages/analyzer/test/write.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 9: Commit**

```bash
git add packages/analyzer/src/claim.ts packages/analyzer/src/write.ts packages/analyzer/test/claim.test.ts packages/analyzer/test/write.test.ts
git commit -m "feat(analyzer): add claim and write logic with concurrency tests"
```

### Task 13: Poll loop, backfill CLI, and Dockerfile

**Files:**
- Modify: `packages/analyzer/src/claim.ts` (add `claimByDumpId`, `claimSince`)
- Create: `packages/analyzer/src/run.ts`
- Create: `packages/analyzer/src/cli.ts`
- Create: `packages/analyzer/Dockerfile`
- Test: `packages/analyzer/test/claim-backfill.test.ts`
- Test: `packages/analyzer/test/run.test.ts`
- Test: `packages/analyzer/test/cli.test.ts`

**Interfaces:**
- Consumes: `claimNewDumps`, `claimStaleDumps` (Task 12); `loadFeatures` (Task 11); `writeAnalysisResult`, `writeFailure` (Task 12); `analyze`, `buildRegistry`, `defaultThresholds`, `RULES_VERSION` from `@rtcstats-dashboard/rules` (Phase 1).
- Produces: `claimByDumpId(pool, dumpId, rulesVersion, force): Promise<boolean>`, `claimSince(pool, sinceIso, rulesVersion, batchSize, force): Promise<number[]>` (added to `claim.ts`); `processDump(pool, dumpId, rulesVersion): Promise<'ok' | 'failed'>`, `runOnce(pool, batchSize): Promise<{processed: number; failed: number}>`, `getAnalysisLag(pool): Promise<number>`, `startPolling(pool, pollIntervalMs, batchSize): {stop: () => void}` (`run.ts`); `CliOptions`, `parseArgs(argv, defaultRulesVersion): CliOptions`, `runBackfill(pool, options): Promise<{processed: number; failed: number}>` (`cli.ts`). This is the last task in Phase 3 — the worker is fully runnable after this.

- [ ] **Step 1: Write the failing tests for the two new claim functions**

`packages/analyzer/test/claim-backfill.test.ts`:
```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import { createPool } from '../src/db.js';
import { claimByDumpId, claimNewDumps, claimSince } from '../src/claim.js';

const TEST_DATABASE_URL = 'postgresql://postgres:postgres@localhost:5433/dashboard_test';

async function insertReadyDump(pool: pg.Pool, user: string, sessionStart: string): Promise<number> {
  const dump = await pool.query(
    `insert into "rtcstats-server" (rtcstats_user, session_start, session_end, features_processing_stop)
     values ($1, $2::timestamptz, $2::timestamptz + interval '1 minute', now())
     returning id`,
    [user, sessionStart]
  );
  const dumpId = dump.rows[0].id;
  await pool.query(`insert into features_metadata (dump_id, number_peerconnections) values ($1, 1)`, [dumpId]);
  return dumpId;
}

describe('claimByDumpId', () => {
  let pool: pg.Pool;

  beforeAll(() => { pool = createPool(TEST_DATABASE_URL); });
  afterAll(async () => { await pool.end(); });
  beforeEach(async () => {
    await pool.query('truncate dashboard_observations, dashboard_analysis, "rtcstats-server", features_metadata restart identity cascade');
  });

  it('claims a brand-new dump by id, creating its analysis row', async () => {
    const dumpId = await insertReadyDump(pool, 'alice', '2026-08-20T10:00:00Z');
    expect(await claimByDumpId(pool, dumpId, '1.0.0', false)).toBe(true);
    const { rows } = await pool.query('select status from dashboard_analysis where dump_id = $1', [dumpId]);
    expect(rows[0].status).toBe('processing');
  });

  it('refuses to reclaim a failed dump without force', async () => {
    const dumpId = await insertReadyDump(pool, 'bob', '2026-08-20T10:00:00Z');
    await claimNewDumps(pool, '1.0.0', 10);
    await pool.query(`update dashboard_analysis set status = 'failed' where dump_id = $1`, [dumpId]);
    expect(await claimByDumpId(pool, dumpId, '1.0.1', false)).toBe(false);
  });

  it('reclaims a failed dump when force is true', async () => {
    const dumpId = await insertReadyDump(pool, 'carol', '2026-08-20T10:00:00Z');
    await claimNewDumps(pool, '1.0.0', 10);
    await pool.query(`update dashboard_analysis set status = 'failed' where dump_id = $1`, [dumpId]);
    expect(await claimByDumpId(pool, dumpId, '1.0.1', true)).toBe(true);
  });
});

describe('claimSince', () => {
  let pool: pg.Pool;

  beforeAll(() => { pool = createPool(TEST_DATABASE_URL); });
  afterAll(async () => { await pool.end(); });
  beforeEach(async () => {
    await pool.query('truncate dashboard_observations, dashboard_analysis, "rtcstats-server", features_metadata restart identity cascade');
  });

  it('reclaims only analyses on or after the given date with a stale rules_version', async () => {
    const oldDump = await insertReadyDump(pool, 'old', '2026-01-01T00:00:00Z');
    const newDump = await insertReadyDump(pool, 'new', '2026-08-20T00:00:00Z');
    await claimNewDumps(pool, '1.0.0', 10);
    await pool.query(`update dashboard_analysis set status = 'ok' where dump_id in ($1, $2)`, [oldDump, newDump]);

    const claimed = await claimSince(pool, '2026-06-01T00:00:00Z', '2.0.0', 10, false);
    expect(claimed).toEqual([newDump]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/analyzer/test/claim-backfill.test.ts`
Expected: FAIL — `claimByDumpId is not exported` / `claimSince is not exported`

- [ ] **Step 3: Add the two functions to `claim.ts`**

Append to `packages/analyzer/src/claim.ts`:
```ts
export async function claimByDumpId(
  pool: pg.Pool,
  dumpId: number,
  rulesVersion: string,
  force: boolean
): Promise<boolean> {
  await pool.query(
    `insert into dashboard_analysis (dump_id, rules_version, status, session_start, duration, rtcstats_user, rtcstats_conference)
     select rss.id, $2, 'processing', rss.session_start,
            extract(epoch from (rss.session_end - rss.session_start))::int,
            rss.rtcstats_user, rss.rtcstats_conference
     from "rtcstats-server" rss
     where rss.id = $1
     on conflict (dump_id) do nothing`,
    [dumpId, rulesVersion]
  );

  const statusFilter = force ? 'true' : `status <> 'failed'`;
  const { rowCount } = await pool.query(
    `update dashboard_analysis set status = 'processing' where dump_id = $1 and ${statusFilter}`,
    [dumpId]
  );
  return (rowCount ?? 0) > 0;
}

export async function claimSince(
  pool: pg.Pool,
  sinceIso: string,
  rulesVersion: string,
  batchSize: number,
  force: boolean
): Promise<number[]> {
  const statusFilter = force ? `status <> 'processing'` : `status not in ('processing', 'failed')`;
  const { rows } = await pool.query(
    `update dashboard_analysis
     set status = 'processing'
     where id in (
       select id from dashboard_analysis
       where session_start >= $1::timestamptz and rules_version <> $2 and ${statusFilter}
       order by id
       limit $3
       for update skip locked
     )
     returning dump_id`,
    [sinceIso, rulesVersion, batchSize]
  );
  return rows.map((r) => r.dump_id);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/analyzer/test/claim-backfill.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Write the failing tests for `run.ts`**

`packages/analyzer/test/run.test.ts`:
```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import { createPool } from '../src/db.js';
import { getAnalysisLag, processDump, runOnce } from '../src/run.js';

const TEST_DATABASE_URL = 'postgresql://postgres:postgres@localhost:5433/dashboard_test';

async function insertDumpWithFreezingVideo(pool: pg.Pool): Promise<number> {
  const dump = await pool.query(
    `insert into "rtcstats-server" (rtcstats_user, session_start, session_end, features_processing_stop)
     values ('alice', now() - interval '5 minutes', now(), now()) returning id`
  );
  const dumpId = dump.rows[0].id;
  const metadata = await pool.query(
    `insert into features_metadata (dump_id, number_peerconnections) values ($1, 1) returning id`,
    [dumpId]
  );
  const connection = await pool.query(
    `insert into features_connection (dump_id, connection_identifier, connected, ice_connection_time)
     values ($1, 'PC_0', true, 500) returning id`,
    [metadata.rows[0].id]
  );
  await pool.query(
    `insert into features_track (connection_id, kind, direction, freeze_count, total_freezes_duration)
     values ($1, 'video', 'recvonly', 10, 20000)`,
    [connection.rows[0].id]
  );
  return dumpId;
}

describe('processDump / runOnce / getAnalysisLag', () => {
  let pool: pg.Pool;

  beforeAll(() => { pool = createPool(TEST_DATABASE_URL); });
  afterAll(async () => { await pool.end(); });
  beforeEach(async () => {
    await pool.query('truncate dashboard_observations, dashboard_analysis, "rtcstats-server", features_metadata, features_client, features_connection, features_track restart identity cascade');
  });

  it('reports lag for dumps with extracted features and no analysis', async () => {
    await insertDumpWithFreezingVideo(pool);
    expect(await getAnalysisLag(pool)).toBe(1);
  });

  it('processes a claimed dump end-to-end via runOnce', async () => {
    await insertDumpWithFreezingVideo(pool);
    const result = await runOnce(pool, 10);
    expect(result.processed).toBe(1);
    expect(result.failed).toBe(0);
    expect(await getAnalysisLag(pool)).toBe(0);

    const { rows } = await pool.query('select status, video_score, observation_types from dashboard_analysis limit 1');
    expect(rows[0].status).toBe('ok');
    expect(rows[0].video_score).toBeLessThan(100);
    expect(rows[0].observation_types).toContain('video.freezes');
  });

  it('marks a dump failed when claimed but its features row is missing', async () => {
    const dump = await pool.query(
      `insert into "rtcstats-server" (rtcstats_user, features_processing_stop) values ('ghost', now()) returning id`
    );
    const dumpId = dump.rows[0].id;
    await pool.query(
      `insert into dashboard_analysis (dump_id, rules_version, status) values ($1, '1.0.0', 'processing')`,
      [dumpId]
    );
    const outcome = await processDump(pool, dumpId, '1.0.0');
    expect(outcome).toBe('failed');
    const { rows } = await pool.query('select status, error from dashboard_analysis where dump_id = $1', [dumpId]);
    expect(rows[0].status).toBe('failed');
    expect(rows[0].error).toContain('features not found');
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npx vitest run packages/analyzer/test/run.test.ts`
Expected: FAIL — `Cannot find module '../src/run.js'`

- [ ] **Step 7: Implement `run.ts`**

`packages/analyzer/src/run.ts`:
```ts
import pgModule from 'pg';
import { analyze, buildRegistry, defaultThresholds, RULES_VERSION } from '@rtcstats-dashboard/rules';
import { claimNewDumps, claimStaleDumps } from './claim.js';
import { loadFeatures } from './featureLoader.js';
import { writeAnalysisResult, writeFailure } from './write.js';
import type pg from 'pg';

export async function processDump(pool: pg.Pool, dumpId: number, rulesVersion: string): Promise<'ok' | 'failed'> {
  try {
    const bundle = await loadFeatures(pool, dumpId);
    if (!bundle) {
      await writeFailure(pool, dumpId, rulesVersion, 'features not found for claimed dump');
      return 'failed';
    }
    const result = analyze({ ...bundle, thresholds: defaultThresholds }, buildRegistry());
    await writeAnalysisResult(pool, dumpId, rulesVersion, result);
    return 'ok';
  } catch (err) {
    await writeFailure(pool, dumpId, rulesVersion, err instanceof Error ? err.message : String(err));
    return 'failed';
  }
}

export interface RunOnceResult {
  processed: number;
  failed: number;
}

export async function runOnce(pool: pg.Pool, batchSize: number): Promise<RunOnceResult> {
  const newDumps = await claimNewDumps(pool, RULES_VERSION, batchSize);
  const staleDumps = await claimStaleDumps(pool, RULES_VERSION, batchSize);
  const dumpIds = [...newDumps, ...staleDumps];

  let processed = 0;
  let failed = 0;
  for (const dumpId of dumpIds) {
    const outcome = await processDump(pool, dumpId, RULES_VERSION);
    if (outcome === 'ok') processed += 1;
    else failed += 1;
  }
  return { processed, failed };
}

export async function getAnalysisLag(pool: pg.Pool): Promise<number> {
  const { rows } = await pool.query(
    `select count(*)::int as lag
     from "rtcstats-server" rss
     join features_metadata fm on fm.dump_id = rss.id
     where rss.features_processing_stop is not null
       and not exists (select 1 from dashboard_analysis da where da.dump_id = rss.id)`
  );
  return rows[0].lag;
}

export function startPolling(pool: pg.Pool, pollIntervalMs: number, batchSize: number): { stop: () => void } {
  let stopped = false;

  async function loop() {
    while (!stopped) {
      try {
        const result = await runOnce(pool, batchSize);
        const lag = await getAnalysisLag(pool);
        console.log(JSON.stringify({ level: 'info', msg: 'poll_complete', ...result, lag, ts: new Date().toISOString() }));
      } catch (err) {
        console.error(JSON.stringify({
          level: 'error', msg: 'poll_failed',
          error: err instanceof Error ? err.message : String(err),
          ts: new Date().toISOString()
        }));
      }
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
  }

  loop();
  return { stop: () => { stopped = true; } };
}

async function main() {
  const pool = new pgModule.Pool({ connectionString: process.env.DATABASE_URL });
  const pollIntervalMs = Number(process.env.ANALYZER_POLL_INTERVAL_MS ?? 10000);
  const batchSize = Number(process.env.ANALYZER_BATCH_SIZE ?? 100);
  startPolling(pool, pollIntervalMs, batchSize);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
```

- [ ] **Step 8: Run test to verify it passes**

Run: `npx vitest run packages/analyzer/test/run.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 9: Write the failing tests for `cli.ts`**

`packages/analyzer/test/cli.test.ts`:
```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import { createPool } from '../src/db.js';
import { parseArgs, runBackfill } from '../src/cli.js';

describe('parseArgs', () => {
  it('defaults to no filters and the given rules version', () => {
    expect(parseArgs([], '1.0.0')).toEqual({ from: null, dumpId: null, rulesVersion: '1.0.0', force: false, batchSize: 100 });
  });

  it('parses --from, --dump-id, --rules-version, --force, --batch-size', () => {
    const options = parseArgs(
      ['--from', '2026-08-01', '--dump-id', '42', '--rules-version', '2.0.0', '--force', '--batch-size', '5'],
      '1.0.0'
    );
    expect(options).toEqual({ from: '2026-08-01', dumpId: 42, rulesVersion: '2.0.0', force: true, batchSize: 5 });
  });

  it('throws on an unknown flag', () => {
    expect(() => parseArgs(['--bogus'], '1.0.0')).toThrow('unknown argument: --bogus');
  });
});

const TEST_DATABASE_URL = 'postgresql://postgres:postgres@localhost:5433/dashboard_test';

describe('runBackfill', () => {
  let pool: pg.Pool;

  beforeAll(() => { pool = createPool(TEST_DATABASE_URL); });
  afterAll(async () => { await pool.end(); });
  beforeEach(async () => {
    await pool.query('truncate dashboard_observations, dashboard_analysis, "rtcstats-server", features_metadata, features_client, features_connection, features_track restart identity cascade');
  });

  it('processes a single dump when --dump-id is given', async () => {
    const dump = await pool.query(
      `insert into "rtcstats-server" (rtcstats_user, session_start, session_end, features_processing_stop)
       values ('alice', now() - interval '5 minutes', now(), now()) returning id`
    );
    const dumpId = dump.rows[0].id;
    await pool.query(`insert into features_metadata (dump_id, number_peerconnections) values ($1, 1)`, [dumpId]);

    const result = await runBackfill(pool, { from: null, dumpId, rulesVersion: '1.0.0', force: false, batchSize: 100 });
    expect(result.processed).toBe(1);

    const { rows } = await pool.query('select status from dashboard_analysis where dump_id = $1', [dumpId]);
    expect(rows[0].status).toBe('ok');
  });
});
```

- [ ] **Step 10: Run test to verify it fails**

Run: `npx vitest run packages/analyzer/test/cli.test.ts`
Expected: FAIL — `Cannot find module '../src/cli.js'`

- [ ] **Step 11: Implement `cli.ts`**

`packages/analyzer/src/cli.ts`:
```ts
import pgModule from 'pg';
import { RULES_VERSION } from '@rtcstats-dashboard/rules';
import { claimByDumpId, claimSince, claimStaleDumps } from './claim.js';
import { processDump } from './run.js';
import type pg from 'pg';

export interface CliOptions {
  from: string | null;
  dumpId: number | null;
  rulesVersion: string;
  force: boolean;
  batchSize: number;
}

const KNOWN_FLAGS = new Set(['--from', '--dump-id', '--rules-version', '--force', '--batch-size']);

export function parseArgs(argv: string[], defaultRulesVersion: string): CliOptions {
  const options: CliOptions = { from: null, dumpId: null, rulesVersion: defaultRulesVersion, force: false, batchSize: 100 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!KNOWN_FLAGS.has(arg)) throw new Error(`unknown argument: ${arg}`);
    if (arg === '--from') options.from = argv[++i];
    else if (arg === '--dump-id') options.dumpId = Number(argv[++i]);
    else if (arg === '--rules-version') options.rulesVersion = argv[++i];
    else if (arg === '--force') options.force = true;
    else if (arg === '--batch-size') options.batchSize = Number(argv[++i]);
  }
  return options;
}

export async function runBackfill(pool: pg.Pool, options: CliOptions): Promise<{ processed: number; failed: number }> {
  let dumpIds: number[];

  if (options.dumpId != null) {
    const claimed = await claimByDumpId(pool, options.dumpId, options.rulesVersion, options.force);
    dumpIds = claimed ? [options.dumpId] : [];
  } else if (options.from) {
    dumpIds = await claimSince(pool, options.from, options.rulesVersion, options.batchSize, options.force);
  } else {
    dumpIds = await claimStaleDumps(pool, options.rulesVersion, options.batchSize, options.force);
  }

  let processed = 0;
  let failed = 0;
  for (const dumpId of dumpIds) {
    const outcome = await processDump(pool, dumpId, options.rulesVersion);
    if (outcome === 'ok') processed += 1;
    else failed += 1;
  }
  return { processed, failed };
}

async function main() {
  const options = parseArgs(process.argv.slice(2), RULES_VERSION);
  const pool = new pgModule.Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const result = await runBackfill(pool, options);
    console.log(JSON.stringify(result));
  } finally {
    await pool.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
```

- [ ] **Step 12: Run test to verify it passes**

Run: `npx vitest run packages/analyzer/test/cli.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 13: Write the Dockerfile**

`packages/analyzer/Dockerfile`:
```dockerfile
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
```

- [ ] **Step 14: Run the full analyzer test suite**

Run: `npx vitest run packages/analyzer`
Expected: PASS (all tests across Tasks 11-13)

- [ ] **Step 15: Commit**

```bash
git add packages/analyzer/src/claim.ts packages/analyzer/src/run.ts packages/analyzer/src/cli.ts packages/analyzer/Dockerfile packages/analyzer/test/claim-backfill.test.ts packages/analyzer/test/run.test.ts packages/analyzer/test/cli.test.ts
git commit -m "feat(analyzer): add poll loop, backfill CLI, and Dockerfile"
```

This completes Phase 3. The analyzer is a fully runnable worker: `DATABASE_URL=... node packages/analyzer/dist/run.js` polls continuously, and `DATABASE_URL=... node packages/analyzer/dist/cli.js --from 2026-08-01 --force` backfills.

---

## Phase 4 — API (`packages/api`)

### Task 14: Fastify scaffold, auth primitives, and login/logout/me routes

**Files:**
- Create: `packages/api/package.json`
- Create: `packages/api/tsconfig.json`
- Create: `packages/api/src/db.ts`
- Create: `packages/api/src/auth.ts`
- Create: `packages/api/src/app.ts`
- Create: `packages/api/src/routes/auth.ts`
- Test: `packages/api/test/auth.test.ts`
- Test: `packages/api/test/routes/auth.test.ts`

**Interfaces:**
- Produces: `createPool(connectionString): pg.Pool` (`db.ts`); `hashPassword`, `verifyPassword`, `createSessionToken`, `verifySessionToken`, `SESSION_COOKIE_NAME`, `LoginRateLimiter` (`auth.ts`); `AppConfig`, `AppDeps`, `buildApp(deps: AppDeps): FastifyInstance` (`app.ts`) — `buildApp` is the single entry point every later route task (15-18) extends, and the one Task 19's server bootstrap calls.

- [ ] **Step 1: Scaffold the package**

`packages/api/package.json`:
```json
{
  "name": "@rtcstats-dashboard/api",
  "version": "0.1.0",
  "type": "module",
  "main": "dist/server.js",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run",
    "start": "node dist/server.js"
  },
  "dependencies": {
    "@rtcstats-dashboard/rules": "*",
    "@fastify/cookie": "^11.0.0",
    "@aws-sdk/client-s3": "^3.700.0",
    "fastify": "^5.1.0",
    "pg": "^8.13.0"
  }
}
```

`packages/api/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src" },
  "include": ["src"],
  "references": [{ "path": "../rules" }]
}
```

Run: `npm install`

- [ ] **Step 2: Write the failing auth primitive tests**

`packages/api/test/auth.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { LoginRateLimiter, createSessionToken, hashPassword, verifyPassword, verifySessionToken } from '../src/auth.js';

describe('hashPassword / verifyPassword', () => {
  it('verifies a matching password', () => {
    const hash = hashPassword('correct-horse-battery-staple');
    expect(verifyPassword('correct-horse-battery-staple', hash)).toBe(true);
  });

  it('rejects a wrong password', () => {
    const hash = hashPassword('correct-horse-battery-staple');
    expect(verifyPassword('wrong-password', hash)).toBe(false);
  });

  it('produces a different hash each time (random salt)', () => {
    expect(hashPassword('same-password')).not.toBe(hashPassword('same-password'));
  });
});

describe('createSessionToken / verifySessionToken', () => {
  it('verifies a freshly created token', () => {
    const token = createSessionToken('secret');
    expect(verifySessionToken(token, 'secret')).toBe(true);
  });

  it('rejects a token signed with a different secret', () => {
    const token = createSessionToken('secret-a');
    expect(verifySessionToken(token, 'secret-b')).toBe(false);
  });

  it('rejects an expired token', () => {
    const now = Date.now();
    const token = createSessionToken('secret', now - 8 * 24 * 60 * 60 * 1000);
    expect(verifySessionToken(token, 'secret', now)).toBe(false);
  });

  it('rejects a malformed token', () => {
    expect(verifySessionToken('not-a-real-token', 'secret')).toBe(false);
  });
});

describe('LoginRateLimiter', () => {
  it('blocks after the configured number of attempts within the window', () => {
    const limiter = new LoginRateLimiter({ maxAttempts: 3, windowMs: 1000 });
    const now = Date.now();
    limiter.registerAttempt('1.2.3.4', now);
    limiter.registerAttempt('1.2.3.4', now);
    limiter.registerAttempt('1.2.3.4', now);
    expect(limiter.isBlocked('1.2.3.4', now)).toBe(true);
  });

  it('does not block a different IP', () => {
    const limiter = new LoginRateLimiter({ maxAttempts: 1, windowMs: 1000 });
    const now = Date.now();
    limiter.registerAttempt('1.2.3.4', now);
    expect(limiter.isBlocked('5.6.7.8', now)).toBe(false);
  });

  it('forgets attempts once the window has passed', () => {
    const limiter = new LoginRateLimiter({ maxAttempts: 1, windowMs: 1000 });
    const now = Date.now();
    limiter.registerAttempt('1.2.3.4', now);
    expect(limiter.isBlocked('1.2.3.4', now + 2000)).toBe(false);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run packages/api/test/auth.test.ts`
Expected: FAIL — `Cannot find module '../src/auth.js'`

- [ ] **Step 4: Implement `auth.ts`**

`packages/api/src/auth.ts`:
```ts
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

export const SESSION_COOKIE_NAME = 'dashboard_session';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

export function verifyPassword(password: string, storedHash: string): boolean {
  const [saltHex, hashHex] = storedHash.split(':');
  if (!saltHex || !hashHex) return false;
  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(hashHex, 'hex');
  const actual = scryptSync(password, salt, 64);
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

export function createSessionToken(secret: string, now = Date.now()): string {
  const expiresAt = now + SESSION_TTL_MS;
  const payload = Buffer.from(JSON.stringify({ expiresAt })).toString('base64url');
  const signature = createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

export function verifySessionToken(token: string, secret: string, now = Date.now()): boolean {
  const [payload, signature] = token.split('.');
  if (!payload || !signature) return false;

  const expectedSignature = createHmac('sha256', secret).update(payload).digest('base64url');
  const sigBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expectedSignature);
  if (sigBuffer.length !== expectedBuffer.length || !timingSafeEqual(sigBuffer, expectedBuffer)) return false;

  try {
    const { expiresAt } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return typeof expiresAt === 'number' && expiresAt > now;
  } catch {
    return false;
  }
}

export interface RateLimiterOptions {
  maxAttempts: number;
  windowMs: number;
}

export class LoginRateLimiter {
  private attempts = new Map<string, number[]>();

  constructor(private options: RateLimiterOptions) {}

  registerAttempt(ip: string, now = Date.now()): void {
    const timestamps = (this.attempts.get(ip) ?? []).filter((t) => now - t < this.options.windowMs);
    timestamps.push(now);
    this.attempts.set(ip, timestamps);
  }

  isBlocked(ip: string, now = Date.now()): boolean {
    const timestamps = (this.attempts.get(ip) ?? []).filter((t) => now - t < this.options.windowMs);
    return timestamps.length >= this.options.maxAttempts;
  }
}

export function requireAuth(sessionSecret: string) {
  return async (
    request: { cookies: Record<string, string | undefined> },
    reply: { code: (n: number) => { send: (body: unknown) => void } }
  ) => {
    const token = request.cookies[SESSION_COOKIE_NAME];
    if (!token || !verifySessionToken(token, sessionSecret)) {
      reply.code(401).send({ error: 'unauthorized' });
    }
  };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run packages/api/test/auth.test.ts`
Expected: PASS (10 tests)

- [ ] **Step 6: Write the failing route test**

`packages/api/test/routes/auth.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { hashPassword } from '../../src/auth.js';

function testApp() {
  return buildApp({
    pool: {} as never,
    config: { passwordHash: hashPassword('correct-password'), sessionSecret: 'test-secret' }
  });
}

describe('POST /api/login', () => {
  it('sets a session cookie on a correct password', async () => {
    const app = testApp();
    const response = await app.inject({ method: 'POST', url: '/api/login', payload: { password: 'correct-password' } });
    expect(response.statusCode).toBe(200);
    expect(response.headers['set-cookie']).toBeDefined();
  });

  it('rejects an incorrect password', async () => {
    const app = testApp();
    const response = await app.inject({ method: 'POST', url: '/api/login', payload: { password: 'wrong' } });
    expect(response.statusCode).toBe(401);
  });

  it('rate-limits repeated failed attempts from the same IP', async () => {
    const app = testApp();
    let last;
    for (let i = 0; i < 11; i++) {
      last = await app.inject({ method: 'POST', url: '/api/login', payload: { password: 'wrong' } });
    }
    expect(last!.statusCode).toBe(429);
  });
});

describe('GET /api/me', () => {
  it('reports authenticated after login', async () => {
    const app = testApp();
    const login = await app.inject({ method: 'POST', url: '/api/login', payload: { password: 'correct-password' } });
    const cookie = login.headers['set-cookie'];
    const me = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie: Array.isArray(cookie) ? cookie[0] : cookie! } });
    expect(me.json()).toEqual({ authenticated: true });
  });

  it('reports unauthenticated with no cookie', async () => {
    const app = testApp();
    const me = await app.inject({ method: 'GET', url: '/api/me' });
    expect(me.json()).toEqual({ authenticated: false });
  });
});

describe('POST /api/logout', () => {
  it('clears the session cookie', async () => {
    const app = testApp();
    const response = await app.inject({ method: 'POST', url: '/api/logout' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['set-cookie']).toContain('dashboard_session=;');
  });
});
```

- [ ] **Step 7: Run test to verify it fails**

Run: `npx vitest run packages/api/test/routes/auth.test.ts`
Expected: FAIL — `Cannot find module '../../src/app.js'`

- [ ] **Step 8: Implement `routes/auth.ts` and `app.ts`**

`packages/api/src/routes/auth.ts`:
```ts
import type { FastifyInstance } from 'fastify';
import { LoginRateLimiter, SESSION_COOKIE_NAME, createSessionToken, verifyPassword, verifySessionToken } from '../auth.js';
import type { AppConfig } from '../app.js';

export function registerAuthRoutes(app: FastifyInstance, config: AppConfig, rateLimiter: LoginRateLimiter): void {
  app.post<{ Body: { password?: string } }>('/api/login', async (request, reply) => {
    const ip = request.ip;
    if (rateLimiter.isBlocked(ip)) {
      reply.code(429).send({ error: 'too_many_attempts' });
      return;
    }
    rateLimiter.registerAttempt(ip);

    const { password } = request.body ?? {};
    if (!password || !verifyPassword(password, config.passwordHash)) {
      reply.code(401).send({ error: 'invalid_password' });
      return;
    }

    const token = createSessionToken(config.sessionSecret);
    reply.setCookie(SESSION_COOKIE_NAME, token, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 7 * 24 * 60 * 60
    });
    reply.send({ authenticated: true });
  });

  app.post('/api/logout', async (_request, reply) => {
    reply.clearCookie(SESSION_COOKIE_NAME, { path: '/' });
    reply.send({ authenticated: false });
  });

  app.get('/api/me', async (request, reply) => {
    const token = request.cookies[SESSION_COOKIE_NAME];
    const authenticated = !!token && verifySessionToken(token, config.sessionSecret);
    reply.send({ authenticated });
  });
}
```

`packages/api/src/app.ts`:
```ts
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import type pg from 'pg';
import { LoginRateLimiter } from './auth.js';
import { registerAuthRoutes } from './routes/auth.js';

export interface AppConfig {
  passwordHash: string;
  sessionSecret: string;
}

export interface AppDeps {
  pool: pg.Pool;
  config: AppConfig;
}

export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({ logger: false });
  app.register(fastifyCookie);

  const rateLimiter = new LoginRateLimiter({ maxAttempts: 10, windowMs: 15 * 60 * 1000 });
  registerAuthRoutes(app, deps.config, rateLimiter);

  return app;
}
```

`packages/api/src/db.ts`:
```ts
import pg from 'pg';

export function createPool(connectionString: string): pg.Pool {
  return new pg.Pool({ connectionString });
}
```

- [ ] **Step 9: Run test to verify it passes**

Run: `npx vitest run packages/api/test/routes/auth.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 10: Commit**

```bash
git add packages/api/package.json packages/api/tsconfig.json packages/api/src packages/api/test package-lock.json
git commit -m "feat(api): add Fastify scaffold, auth primitives, and login routes"
```

### Task 15: Health check and rule catalog routes

**Files:**
- Create: `packages/api/src/routes/health.ts`
- Create: `packages/api/src/routes/rules.ts`
- Modify: `packages/api/src/app.ts`
- Test: `packages/api/test/routes/health.test.ts`
- Test: `packages/api/test/routes/rules.test.ts`

**Interfaces:**
- Consumes: `buildRegistry` from `@rtcstats-dashboard/rules` (Phase 1); `AppConfig`, `AppDeps`, `buildApp` (Task 14).
- Produces: `GET /api/health` (200 `{status: 'ok'}` / 503 `{status: 'error', detail}`); `GET /api/rules` (200, array of `{id: string; category: string}`). `AppDeps` gains an optional `checkS3` hook, used by nothing yet but consumed by Task 18 once the S3 client exists.

- [ ] **Step 1: Write the failing health test**

`packages/api/test/routes/health.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { hashPassword } from '../../src/auth.js';

function testApp(query: () => Promise<unknown>) {
  return buildApp({
    pool: { query } as never,
    config: { passwordHash: hashPassword('x'), sessionSecret: 'test-secret' }
  });
}

describe('GET /api/health', () => {
  it('returns ok when the database responds', async () => {
    const app = testApp(async () => ({ rows: [{ ok: 1 }] }));
    const response = await app.inject({ method: 'GET', url: '/api/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });

  it('returns 503 when the database is unreachable', async () => {
    const app = testApp(async () => { throw new Error('connection refused'); });
    const response = await app.inject({ method: 'GET', url: '/api/health' });
    expect(response.statusCode).toBe(503);
    expect(response.json().status).toBe('error');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/api/test/routes/health.test.ts`
Expected: FAIL — `/api/health` route not registered (404)

- [ ] **Step 3: Write the failing rules-catalog test**

`packages/api/test/routes/rules.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { hashPassword } from '../../src/auth.js';

describe('GET /api/rules', () => {
  it('returns every registered rule id and category', async () => {
    const app = buildApp({
      pool: {} as never,
      config: { passwordHash: hashPassword('x'), sessionSecret: 'test-secret' }
    });
    const response = await app.inject({ method: 'GET', url: '/api/rules' });
    expect(response.statusCode).toBe(200);
    const body = response.json() as Array<{ id: string; category: string }>;
    expect(body.length).toBe(32);
    expect(body).toContainEqual({ id: 'video.freezes', category: 'video' });
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `npx vitest run packages/api/test/routes/rules.test.ts`
Expected: FAIL — `/api/rules` route not registered (404)

- [ ] **Step 5: Implement `routes/health.ts` and `routes/rules.ts`**

`packages/api/src/routes/health.ts`:
```ts
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';

export function registerHealthRoute(app: FastifyInstance, pool: pg.Pool, checkS3?: () => Promise<void>): void {
  app.get('/api/health', async (_request, reply) => {
    try {
      await pool.query('select 1');
      if (checkS3) await checkS3();
      reply.send({ status: 'ok' });
    } catch (err) {
      reply.code(503).send({ status: 'error', detail: err instanceof Error ? err.message : String(err) });
    }
  });
}
```

`packages/api/src/routes/rules.ts`:
```ts
import type { FastifyInstance } from 'fastify';
import { buildRegistry } from '@rtcstats-dashboard/rules';

export function registerRulesRoute(app: FastifyInstance): void {
  app.get('/api/rules', async (_request, reply) => {
    const catalog = buildRegistry().map((rule) => ({ id: rule.id, category: rule.category }));
    reply.send(catalog);
  });
}
```

- [ ] **Step 6: Wire both routes into `app.ts`**

Modify `packages/api/src/app.ts`:
```ts
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import type pg from 'pg';
import { LoginRateLimiter } from './auth.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerHealthRoute } from './routes/health.js';
import { registerRulesRoute } from './routes/rules.js';

export interface AppConfig {
  passwordHash: string;
  sessionSecret: string;
}

export interface AppDeps {
  pool: pg.Pool;
  config: AppConfig;
  checkS3?: () => Promise<void>;
}

export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({ logger: false });
  app.register(fastifyCookie);

  const rateLimiter = new LoginRateLimiter({ maxAttempts: 10, windowMs: 15 * 60 * 1000 });
  registerAuthRoutes(app, deps.config, rateLimiter);
  registerHealthRoute(app, deps.pool, deps.checkS3);
  registerRulesRoute(app);

  return app;
}
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `npx vitest run packages/api/test/routes/health.test.ts packages/api/test/routes/rules.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 8: Commit**

```bash
git add packages/api/src/routes/health.ts packages/api/src/routes/rules.ts packages/api/src/app.ts packages/api/test/routes/health.test.ts packages/api/test/routes/rules.test.ts
git commit -m "feat(api): add health check and rule catalog routes"
```

### Task 16: Session list endpoint with filters and keyset pagination

**Files:**
- Create: `packages/api/src/routes/sessions.ts`
- Modify: `packages/api/src/app.ts`
- Test: `packages/api/test/routes/sessions.test.ts`

**Interfaces:**
- Consumes: `requireAuth`, `SESSION_COOKIE_NAME`, `createSessionToken` (Task 14); `AppDeps` (Task 15).
- Produces: `GET /api/sessions` (query params: `from`, `to`, `user`, `conference`, `types` (comma-separated), `severity`, `maxScore`, `sort` (`date`|`score`, default `date`), `cursor`, `limit` (default 25, max 100)); response `{items: SessionSummary[]; nextCursor: string | null}`. `SessionSummary` and `listSessions(pool, filters): Promise<SessionListResult>` are exported from `sessions.ts` and reused by Task 17 (session detail) for shared field mapping conventions.

**Cursor correctness note:** `dashboard_analysis.experience_score` is `NULL` for `insufficient_data`/`failed` rows. A naive `(sort_column, id) > (cursor_value, cursor_id)` tuple comparison silently excludes rows once `sort_column` is `NULL`, because SQL's three-valued logic makes any comparison against `NULL` unknown rather than true or false. Both sort orders use `NULLS LAST` and the cursor predicate has an explicit branch for "the cursor itself was on a null-valued row" and an `OR column IS NULL` branch so null-scored rows are reachable by keyset pagination like every other row.

- [ ] **Step 1: Write the failing test**

`packages/api/test/routes/sessions.test.ts`:
```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import { buildApp } from '../../src/app.js';
import { createSessionToken, hashPassword, SESSION_COOKIE_NAME } from '../../src/auth.js';
import { createPool } from '../../src/db.js';

const TEST_DATABASE_URL = 'postgresql://postgres:postgres@localhost:5433/dashboard_test';
const SESSION_SECRET = 'test-secret';

function authCookie() {
  return `${SESSION_COOKIE_NAME}=${createSessionToken(SESSION_SECRET)}`;
}

async function seedAnalysis(pool: pg.Pool, overrides: Record<string, unknown>) {
  const dump = await pool.query(`insert into "rtcstats-server" (rtcstats_user) values ('seed') returning id`);
  const defaults = {
    dump_id: dump.rows[0].id,
    rules_version: '1.0.0',
    status: 'ok',
    session_start: new Date().toISOString(),
    duration: 300,
    rtcstats_user: 'alice',
    rtcstats_conference: 'room1',
    experience_score: 80,
    audio_score: null,
    video_score: 80,
    connectivity_score: 90,
    observation_types: ['video.freezes'],
    worst_severity: 'warning',
    observations_count: { warning: 1 }
  };
  const row = { ...defaults, ...overrides, dump_id: dump.rows[0].id };
  await pool.query(
    `insert into dashboard_analysis
       (dump_id, rules_version, status, session_start, duration, rtcstats_user, rtcstats_conference,
        experience_score, audio_score, video_score, connectivity_score, observation_types, worst_severity, observations_count)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [row.dump_id, row.rules_version, row.status, row.session_start, row.duration, row.rtcstats_user, row.rtcstats_conference,
     row.experience_score, row.audio_score, row.video_score, row.connectivity_score, row.observation_types, row.worst_severity, row.observations_count]
  );
  return row.dump_id;
}

describe('GET /api/sessions', () => {
  let pool: pg.Pool;
  let app: ReturnType<typeof buildApp>;

  beforeAll(() => {
    pool = createPool(TEST_DATABASE_URL);
    app = buildApp({ pool, config: { passwordHash: hashPassword('x'), sessionSecret: SESSION_SECRET } });
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query('truncate dashboard_observations, dashboard_analysis, "rtcstats-server" restart identity cascade');
  });

  it('rejects an unauthenticated request', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/sessions' });
    expect(response.statusCode).toBe(401);
  });

  it('filters by exact rtcstats_user', async () => {
    await seedAnalysis(pool, { rtcstats_user: 'alice' });
    await seedAnalysis(pool, { rtcstats_user: 'bob' });

    const response = await app.inject({ method: 'GET', url: '/api/sessions?user=alice', headers: { cookie: authCookie() } });
    const body = response.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0].rtcstatsUser).toBe('alice');
  });

  it('filters by observation type via the GIN index', async () => {
    await seedAnalysis(pool, { observation_types: ['video.freezes'] });
    await seedAnalysis(pool, { observation_types: ['connectivity.ice_restart'] });

    const response = await app.inject({ method: 'GET', url: '/api/sessions?types=video.freezes', headers: { cookie: authCookie() } });
    expect(response.json().items).toHaveLength(1);
  });

  it('sorts worst-first, treating a null experience_score as worse-sorting-last is not required — nulls are simply reachable', async () => {
    await seedAnalysis(pool, { experience_score: 90, session_start: new Date(Date.now() - 1000).toISOString() });
    await seedAnalysis(pool, { experience_score: 40, session_start: new Date(Date.now() - 2000).toISOString() });
    await seedAnalysis(pool, { experience_score: null, status: 'insufficient_data', session_start: new Date(Date.now() - 3000).toISOString() });

    const response = await app.inject({ method: 'GET', url: '/api/sessions?sort=score&limit=10', headers: { cookie: authCookie() } });
    const scores = response.json().items.map((i: { experienceScore: number | null }) => i.experienceScore);
    expect(scores).toEqual([40, 90, null]);
  });

  it('paginates with a keyset cursor across all three score-sorted pages, including the null-scored row', async () => {
    await seedAnalysis(pool, { experience_score: 90 });
    await seedAnalysis(pool, { experience_score: 40 });
    await seedAnalysis(pool, { experience_score: null, status: 'insufficient_data' });

    const page1 = await app.inject({ method: 'GET', url: '/api/sessions?sort=score&limit=1', headers: { cookie: authCookie() } });
    const body1 = page1.json();
    expect(body1.items).toHaveLength(1);
    expect(body1.items[0].experienceScore).toBe(40);
    expect(body1.nextCursor).not.toBeNull();

    const page2 = await app.inject({ method: 'GET', url: `/api/sessions?sort=score&limit=1&cursor=${encodeURIComponent(body1.nextCursor)}`, headers: { cookie: authCookie() } });
    const body2 = page2.json();
    expect(body2.items[0].experienceScore).toBe(90);

    const page3 = await app.inject({ method: 'GET', url: `/api/sessions?sort=score&limit=1&cursor=${encodeURIComponent(body2.nextCursor)}`, headers: { cookie: authCookie() } });
    const body3 = page3.json();
    expect(body3.items[0].experienceScore).toBeNull();
    expect(body3.nextCursor).toBeNull();
  });

  it('returns only the fields the session list needs', async () => {
    await seedAnalysis(pool, { observation_types: ['video.freezes', 'connectivity.ice_restart', 'audio.concealment_ratio', 'device.frequent_reloads'] });
    const response = await app.inject({ method: 'GET', url: '/api/sessions', headers: { cookie: authCookie() } });
    const item = response.json().items[0];
    expect(item.topObservationTypes).toHaveLength(3);
    expect(Object.keys(item).sort()).toEqual([
      'audioScore', 'connectivityScore', 'dumpId', 'duration', 'experienceScore',
      'observationsCount', 'rtcstatsConference', 'rtcstatsUser', 'sessionStart',
      'topObservationTypes', 'videoScore', 'worstSeverity'
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/api/test/routes/sessions.test.ts`
Expected: FAIL — `/api/sessions` route not registered (404) / not authenticated as expected first

- [ ] **Step 3: Implement `routes/sessions.ts`**

`packages/api/src/routes/sessions.ts`:
```ts
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { requireAuth } from '../auth.js';

export interface SessionFilters {
  from?: string;
  to?: string;
  user?: string;
  conference?: string;
  types?: string[];
  severity?: string;
  maxScore?: number;
  sort: 'date' | 'score';
  cursor?: string;
  limit: number;
}

export interface SessionSummary {
  dumpId: number;
  sessionStart: string | null;
  duration: number | null;
  rtcstatsUser: string | null;
  rtcstatsConference: string | null;
  experienceScore: number | null;
  audioScore: number | null;
  videoScore: number | null;
  connectivityScore: number | null;
  worstSeverity: string | null;
  observationsCount: Record<string, number>;
  topObservationTypes: string[];
}

export interface SessionListResult {
  items: SessionSummary[];
  nextCursor: string | null;
}

interface DecodedCursor {
  sortValue: string | number | null;
  id: number;
}

function encodeCursor(cursor: DecodedCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

function decodeCursor(raw: string): DecodedCursor {
  return JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
}

function buildCursorCondition(
  column: string,
  direction: 'asc' | 'desc',
  castType: 'timestamptz' | 'real',
  decoded: DecodedCursor,
  push: (v: unknown) => string
): string {
  const idPlaceholder = push(decoded.id);
  const comparator = direction === 'desc' ? '<' : '>';

  if (decoded.sortValue === null) {
    return `(${column} is null and id ${comparator} ${idPlaceholder})`;
  }

  const sortPlaceholder = push(decoded.sortValue);
  return `((${column} ${comparator} ${sortPlaceholder}::${castType}) or (${column} = ${sortPlaceholder}::${castType} and id ${comparator} ${idPlaceholder}) or ${column} is null)`;
}

function toSummary(row: {
  dump_id: number; session_start: string | null; duration: number | null;
  rtcstats_user: string | null; rtcstats_conference: string | null;
  experience_score: number | null; audio_score: number | null; video_score: number | null; connectivity_score: number | null;
  worst_severity: string | null; observations_count: Record<string, number>; observation_types: string[];
}): SessionSummary {
  return {
    dumpId: row.dump_id,
    sessionStart: row.session_start,
    duration: row.duration,
    rtcstatsUser: row.rtcstats_user,
    rtcstatsConference: row.rtcstats_conference,
    experienceScore: row.experience_score,
    audioScore: row.audio_score,
    videoScore: row.video_score,
    connectivityScore: row.connectivity_score,
    worstSeverity: row.worst_severity,
    observationsCount: row.observations_count,
    topObservationTypes: (row.observation_types ?? []).slice(0, 3)
  };
}

export async function listSessions(pool: pg.Pool, filters: SessionFilters): Promise<SessionListResult> {
  const conditions: string[] = [];
  const values: unknown[] = [];
  let paramIndex = 1;

  function push(value: unknown): string {
    values.push(value);
    return `$${paramIndex++}`;
  }

  if (filters.from) conditions.push(`session_start >= ${push(filters.from)}::timestamptz`);
  if (filters.to) conditions.push(`session_start < ${push(filters.to)}::timestamptz`);
  if (filters.user) conditions.push(`rtcstats_user = ${push(filters.user)}`);
  if (filters.conference) conditions.push(`rtcstats_conference = ${push(filters.conference)}`);
  if (filters.severity) conditions.push(`worst_severity = ${push(filters.severity)}`);
  if (filters.maxScore != null) conditions.push(`experience_score <= ${push(filters.maxScore)}`);
  if (filters.types && filters.types.length > 0) conditions.push(`observation_types && ${push(filters.types)}::text[]`);

  const sortByScore = filters.sort === 'score';
  const sortColumn = sortByScore ? 'experience_score' : 'session_start';
  const sortDirection: 'asc' | 'desc' = sortByScore ? 'asc' : 'desc';
  const castType: 'timestamptz' | 'real' = sortByScore ? 'real' : 'timestamptz';

  if (filters.cursor) {
    const decoded = decodeCursor(filters.cursor);
    conditions.push(buildCursorCondition(sortColumn, sortDirection, castType, decoded, push));
  }

  const whereClause = conditions.length > 0 ? `where ${conditions.join(' and ')}` : '';
  const limitPlaceholder = push(filters.limit + 1);

  const { rows } = await pool.query(
    `select dump_id, session_start, duration, rtcstats_user, rtcstats_conference,
            experience_score, audio_score, video_score, connectivity_score,
            worst_severity, observations_count, observation_types
     from dashboard_analysis
     ${whereClause}
     order by ${sortColumn} ${sortDirection} nulls last, id ${sortDirection}
     limit ${limitPlaceholder}`,
    values
  );

  const hasMore = rows.length > filters.limit;
  const items = rows.slice(0, filters.limit).map(toSummary);

  let nextCursor: string | null = null;
  if (hasMore) {
    const last = items[items.length - 1];
    nextCursor = encodeCursor({
      sortValue: sortByScore ? last.experienceScore : last.sessionStart,
      id: last.dumpId
    });
  }

  return { items, nextCursor };
}

export function registerSessionsRoute(app: FastifyInstance, pool: pg.Pool, sessionSecret: string): void {
  app.get<{
    Querystring: {
      from?: string; to?: string; user?: string; conference?: string;
      types?: string; severity?: string; maxScore?: string; sort?: string;
      cursor?: string; limit?: string;
    };
  }>('/api/sessions', { preHandler: requireAuth(sessionSecret) }, async (request, reply) => {
    const q = request.query;
    const limit = Math.min(Number(q.limit ?? 25), 100);
    const filters: SessionFilters = {
      from: q.from,
      to: q.to,
      user: q.user,
      conference: q.conference,
      types: q.types ? q.types.split(',') : undefined,
      severity: q.severity,
      maxScore: q.maxScore != null ? Number(q.maxScore) : undefined,
      sort: q.sort === 'score' ? 'score' : 'date',
      cursor: q.cursor,
      limit
    };
    const result = await listSessions(pool, filters);
    reply.send(result);
  });
}
```

- [ ] **Step 4: Wire the route into `app.ts`**

Modify `packages/api/src/app.ts` — add the import and registration call:
```ts
import { registerSessionsRoute } from './routes/sessions.js';
```
```ts
  registerSessionsRoute(app, deps.pool, deps.config.sessionSecret);
```
(add both lines alongside the existing `registerHealthRoute`/`registerRulesRoute` calls, in the same order as the other route registrations)

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run packages/api/test/routes/sessions.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 6: Commit**

```bash
git add packages/api/src/routes/sessions.ts packages/api/src/app.ts packages/api/test/routes/sessions.test.ts
git commit -m "feat(api): add session list endpoint with keyset pagination"
```

### Task 17: Extract the feature-tree loader into a shared package

**Files:**
- Create: `packages/db-features/package.json`
- Create: `packages/db-features/tsconfig.json`
- Create: `packages/db-features/src/index.ts`
- Test: `packages/db-features/test/index.test.ts`
- Modify: `packages/analyzer/src/featureLoader.ts` (re-export, so Tasks 11-13's `import { loadFeatures } from '../src/featureLoader.js'` keeps working unchanged)
- Modify: `packages/analyzer/package.json` (add dependency)

**Interfaces:**
- Consumes: `FeatureMetadata`, `FeatureClient`, `FeatureConnection`, `FeatureTrack` from `@rtcstats-dashboard/rules` (Phase 1).
- Produces: `FeatureBundle`, `loadFeatures(pool: pg.Pool, dumpId: number): Promise<FeatureBundle | null>` from `@rtcstats-dashboard/db-features` — the session detail endpoint (Task 19) imports this package directly; `packages/analyzer` keeps importing its own local path, which now just re-exports.

The api package's session detail view needs the same metadata/client/connection/track assembly the analyzer already built in Task 11 to hand to the rules engine. Duplicating that ~150-line column mapping in two packages would let them silently drift; this task moves it to a package both depend on instead.

- [ ] **Step 1: Scaffold the package and move the test**

`packages/db-features/package.json`:
```json
{
  "name": "@rtcstats-dashboard/db-features",
  "version": "0.1.0",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run"
  },
  "dependencies": {
    "@rtcstats-dashboard/rules": "*",
    "pg": "^8.13.0"
  }
}
```

`packages/db-features/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src" },
  "include": ["src"],
  "references": [{ "path": "../rules" }]
}
```

Copy the test from Task 11 to the new package (same content, new location):

`packages/db-features/test/index.test.ts` — identical to `packages/analyzer/test/featureLoader.test.ts` from Task 11, with the import changed to `import { loadFeatures } from '../src/index.js';` and `createPool` inlined (no `db.ts` dependency needed here):
```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import { loadFeatures } from '../src/index.js';

const TEST_DATABASE_URL = 'postgresql://postgres:postgres@localhost:5433/dashboard_test';

describe('loadFeatures', () => {
  let pool: pg.Pool;

  beforeAll(() => {
    pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query('truncate "rtcstats-server", features_metadata, features_client, features_connection, features_track restart identity cascade');
  });

  it('returns null when features have not been extracted for the dump', async () => {
    const { rows } = await pool.query(`insert into "rtcstats-server" (rtcstats_user) values ('u1') returning id`);
    expect(await loadFeatures(pool, rows[0].id)).toBeNull();
  });

  it('assembles metadata, client, connections, and tracks into a FeatureBundle', async () => {
    const dump = await pool.query(`insert into "rtcstats-server" (rtcstats_user) values ('u1') returning id`);
    const dumpId = dump.rows[0].id;
    const metadata = await pool.query(
      `insert into features_metadata (dump_id, start_time, useragent, number_peerconnections)
       values ($1, now(), 'Chrome/120', 1) returning id`,
      [dumpId]
    );
    await pool.query(
      `insert into features_client (dump_id, hardware_concurrency) values ($1, 8)`,
      [metadata.rows[0].id]
    );
    const connection = await pool.query(
      `insert into features_connection (dump_id, connection_identifier) values ($1, 'PC_0') returning id`,
      [metadata.rows[0].id]
    );
    await pool.query(`insert into features_track (connection_id, kind) values ($1, 'video')`, [connection.rows[0].id]);

    const bundle = await loadFeatures(pool, dumpId);
    expect(bundle!.client?.hardwareConcurrency).toBe(8);
    expect(bundle!.connections[0].tracks[0].kind).toBe('video');
  });
});
```

- [ ] **Step 2: Move the implementation**

`packages/db-features/src/index.ts` — the exact content of `packages/analyzer/src/featureLoader.ts` from Task 11 (same `FeatureBundle` interface and `loadFeatures` function, unchanged), with the import path for `pg` unchanged and the import for the rules types unchanged (`from '@rtcstats-dashboard/rules'`).

- [ ] **Step 3: Run the new package's tests**

Run: `npx vitest run packages/db-features`
Expected: PASS (2 tests)

- [ ] **Step 4: Point `packages/analyzer` at the shared package**

Modify `packages/analyzer/package.json` — add `"@rtcstats-dashboard/db-features": "*"` to `dependencies`.

Run: `npm install`

Replace the entire contents of `packages/analyzer/src/featureLoader.ts` with:
```ts
export { loadFeatures } from '@rtcstats-dashboard/db-features';
export type { FeatureBundle } from '@rtcstats-dashboard/db-features';
```

- [ ] **Step 5: Run the full analyzer test suite to confirm nothing broke**

Run: `npx vitest run packages/analyzer`
Expected: PASS — every test from Tasks 11-13 still passes unchanged, since they import from `../src/featureLoader.js`, which now re-exports the shared implementation.

- [ ] **Step 6: Commit**

```bash
git add packages/db-features packages/analyzer/src/featureLoader.ts packages/analyzer/package.json package-lock.json
git commit -m "refactor: extract feature-tree loader into shared db-features package"
```

### Task 18: S3/MinIO client wrapper

**Files:**
- Create: `packages/api/src/s3.ts`
- Test: `packages/api/test/s3.test.ts`

**Interfaces:**
- Produces: `S3Config`, `createS3Client(config): S3Client`, `DumpHead`, `headDump(client, bucket, key): Promise<DumpHead>`, `getDumpStream(client, bucket, key): Promise<{body: Readable; contentLength: number | null}>`, `extractObjectKey(blobUrl, bucket): string` — all consumed by the session detail endpoint (Task 19, via `headDump`/`extractObjectKey`) and the dump proxy (Task 20, via `getDumpStream`).

`"rtcstats-server".blob_url` is written by `rtcstats-server` (a separate repository) and its exact format isn't fixed by any migration this plan has read — it could be a full `s3://bucket/key` URL, an `https://` URL, or a bare key. `extractObjectKey` handles all three so the dashboard isn't coupled to one assumption; if the real deployment's format doesn't match any of these three, the fallback branch (return the value as-is) at least fails obviously rather than silently.

- [ ] **Step 1: Write the failing tests**

`packages/api/test/s3.test.ts`:
```ts
import { CreateBucketCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createS3Client, extractObjectKey, getDumpStream, headDump } from '../src/s3.js';

const TEST_S3_CONFIG = {
  endpoint: 'http://localhost:9100',
  region: 'us-east-1',
  accessKeyId: 'minioadmin',
  secretAccessKey: 'minioadmin',
  bucket: 'dashboard-test-bucket',
  forcePathStyle: true
};

describe('extractObjectKey', () => {
  it('strips an s3:// prefix for the given bucket', () => {
    expect(extractObjectKey('s3://dashboard-test-bucket/dumps/abc.json.gz', 'dashboard-test-bucket')).toBe('dumps/abc.json.gz');
  });

  it('strips the bucket segment from an https:// URL path', () => {
    expect(extractObjectKey('https://minio.internal/dashboard-test-bucket/dumps/abc.json.gz', 'dashboard-test-bucket')).toBe('dumps/abc.json.gz');
  });

  it('treats a value with no scheme as an already-bare key', () => {
    expect(extractObjectKey('dumps/abc.json.gz', 'dashboard-test-bucket')).toBe('dumps/abc.json.gz');
  });
});

describe('headDump / getDumpStream', () => {
  let client: S3Client;

  beforeAll(async () => {
    client = createS3Client(TEST_S3_CONFIG);
    try {
      await client.send(new CreateBucketCommand({ Bucket: TEST_S3_CONFIG.bucket }));
    } catch (err) {
      const name = err instanceof Error ? err.name : '';
      if (name !== 'BucketAlreadyOwnedByYou' && name !== 'BucketAlreadyExists') throw err;
    }
    await client.send(new PutObjectCommand({ Bucket: TEST_S3_CONFIG.bucket, Key: 'dumps/present.json.gz', Body: Buffer.from('hello') }));
  });

  afterAll(() => {
    client.destroy();
  });

  it('reports exists:true with the correct size for a present object', async () => {
    const head = await headDump(client, TEST_S3_CONFIG.bucket, 'dumps/present.json.gz');
    expect(head).toEqual({ exists: true, sizeBytes: 5 });
  });

  it('reports exists:false for a missing object', async () => {
    const head = await headDump(client, TEST_S3_CONFIG.bucket, 'dumps/missing.json.gz');
    expect(head).toEqual({ exists: false, sizeBytes: null });
  });

  it('streams the object body back', async () => {
    const { contentLength, body } = await getDumpStream(client, TEST_S3_CONFIG.bucket, 'dumps/present.json.gz');
    expect(contentLength).toBe(5);
    const chunks: Buffer[] = [];
    for await (const chunk of body as AsyncIterable<Buffer>) chunks.push(chunk);
    expect(Buffer.concat(chunks).toString('utf8')).toBe('hello');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/api/test/s3.test.ts`
Expected: FAIL — `Cannot find module '../src/s3.js'`

- [ ] **Step 3: Implement `s3.ts`**

`packages/api/src/s3.ts`:
```ts
import { GetObjectCommand, HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { Readable } from 'node:stream';

export interface S3Config {
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  forcePathStyle?: boolean;
}

export function createS3Client(config: S3Config): S3Client {
  return new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    forcePathStyle: config.forcePathStyle ?? true
  });
}

export interface DumpHead {
  exists: boolean;
  sizeBytes: number | null;
}

function isNotFound(err: unknown): boolean {
  return err instanceof Error && (err.name === 'NotFound' || err.name === 'NoSuchKey');
}

export async function headDump(client: S3Client, bucket: string, key: string): Promise<DumpHead> {
  try {
    const result = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return { exists: true, sizeBytes: result.ContentLength ?? null };
  } catch (err) {
    if (isNotFound(err)) return { exists: false, sizeBytes: null };
    throw err;
  }
}

export async function getDumpStream(
  client: S3Client,
  bucket: string,
  key: string
): Promise<{ body: Readable; contentLength: number | null }> {
  const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  return { body: result.Body as Readable, contentLength: result.ContentLength ?? null };
}

export function extractObjectKey(blobUrl: string, bucket: string): string {
  const s3Prefix = `s3://${bucket}/`;
  if (blobUrl.startsWith(s3Prefix)) return blobUrl.slice(s3Prefix.length);

  try {
    const url = new URL(blobUrl);
    const pathname = url.pathname.replace(/^\//, '');
    return pathname.startsWith(`${bucket}/`) ? pathname.slice(bucket.length + 1) : pathname;
  } catch {
    return blobUrl;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/api/test/s3.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/s3.ts packages/api/test/s3.test.ts
git commit -m "feat(api): add S3/MinIO client wrapper"
```

### Task 19: Session detail endpoint

**Files:**
- Modify: `packages/api/package.json` (add `@rtcstats-dashboard/db-features` dependency)
- Modify: `packages/api/src/routes/sessions.ts` (add the detail route)
- Modify: `packages/api/src/app.ts` (thread an optional S3 dependency through)
- Test: `packages/api/test/routes/sessionDetail.test.ts`

**Interfaces:**
- Consumes: `loadFeatures` (Task 17, `@rtcstats-dashboard/db-features`); `headDump`, `extractObjectKey`, `S3Config` (Task 18); `requireAuth` (Task 14).
- Produces: `GET /api/sessions/:dumpId` → `{analysis, observations, features, dump}` in one response, composed before the raw dump has downloaded — `analysis` carries every column from `dashboard_analysis`, `observations` is severity-then-time ordered, `features` is the `FeatureBundle` from `db-features` (or `null` if features were never extracted, which cannot happen for a dump with an analysis row but is handled defensively), and `dump` is `{sizeBytes: number | null; status: 'available' | 'missing'}` — the frontend (Task 25) uses `dump.status` to distinguish "still downloading" from "gone from storage" rather than showing a spinner forever.

- [ ] **Step 1: Add the dependency**

Modify `packages/api/package.json` — add `"@rtcstats-dashboard/db-features": "*"` to `dependencies`.

Run: `npm install`

- [ ] **Step 2: Write the failing test**

`packages/api/test/routes/sessionDetail.test.ts`:
```ts
import { CreateBucketCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import { buildApp } from '../../src/app.js';
import { createSessionToken, hashPassword, SESSION_COOKIE_NAME } from '../../src/auth.js';
import { createPool } from '../../src/db.js';
import { createS3Client } from '../../src/s3.js';

const TEST_DATABASE_URL = 'postgresql://postgres:postgres@localhost:5433/dashboard_test';
const SESSION_SECRET = 'test-secret';
const BUCKET = 'dashboard-test-bucket';

function authCookie() {
  return `${SESSION_COOKIE_NAME}=${createSessionToken(SESSION_SECRET)}`;
}

describe('GET /api/sessions/:dumpId', () => {
  let pool: pg.Pool;
  let app: ReturnType<typeof buildApp>;

  beforeAll(async () => {
    pool = createPool(TEST_DATABASE_URL);
    const s3 = { client: createS3Client({
      endpoint: 'http://localhost:9100', region: 'us-east-1',
      accessKeyId: 'minioadmin', secretAccessKey: 'minioadmin', bucket: BUCKET, forcePathStyle: true
    }), bucket: BUCKET };
    try {
      await s3.client.send(new CreateBucketCommand({ Bucket: BUCKET }));
    } catch (err) {
      const name = err instanceof Error ? err.name : '';
      if (name !== 'BucketAlreadyOwnedByYou' && name !== 'BucketAlreadyExists') throw err;
    }
    app = buildApp({ pool, config: { passwordHash: hashPassword('x'), sessionSecret: SESSION_SECRET }, s3 });
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query('truncate dashboard_observations, dashboard_analysis, "rtcstats-server", features_metadata, features_client, features_connection, features_track restart identity cascade');
  });

  it('returns 404 for a dump with no analysis', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/sessions/999999', headers: { cookie: authCookie() } });
    expect(response.statusCode).toBe(404);
  });

  it('composes analysis, observations, features, and dump availability for a present dump', async () => {
    const dump = await pool.query(
      `insert into "rtcstats-server" (rtcstats_user, session_start, session_end, blob_url, features_processing_stop)
       values ('alice', now() - interval '5 minutes', now(), $1, now()) returning id`,
      [`s3://${BUCKET}/dumps/present.json.gz`]
    );
    const dumpId = dump.rows[0].id;

    const s3 = { client: createS3Client({
      endpoint: 'http://localhost:9100', region: 'us-east-1',
      accessKeyId: 'minioadmin', secretAccessKey: 'minioadmin', bucket: BUCKET, forcePathStyle: true
    }), bucket: BUCKET };
    await s3.client.send(new PutObjectCommand({ Bucket: BUCKET, Key: 'dumps/present.json.gz', Body: Buffer.from('x'.repeat(1234)) }));

    const metadata = await pool.query(`insert into features_metadata (dump_id, number_peerconnections) values ($1, 1) returning id`, [dumpId]);
    await pool.query(`insert into features_client (dump_id, hardware_concurrency) values ($1, 8)`, [metadata.rows[0].id]);

    const analysis = await pool.query(
      `insert into dashboard_analysis (dump_id, rules_version, status, session_start, duration, rtcstats_user, experience_score, worst_severity, observation_types, observations_count)
       values ($1, '1.0.0', 'ok', now(), 300, 'alice', 65, 'critical', '{video.freezes}', '{"critical":1}') returning id`,
      [dumpId]
    );
    await pool.query(
      `insert into dashboard_observations (analysis_id, pid, type, severity, category, first_seen_at, observation)
       values ($1, 'PC_0', 'video.freezes', 'critical', 'video', 12.5, '{"count":3}')`,
      [analysis.rows[0].id]
    );

    const response = await app.inject({ method: 'GET', url: `/api/sessions/${dumpId}`, headers: { cookie: authCookie() } });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.analysis.experienceScore).toBe(65);
    expect(body.observations).toHaveLength(1);
    expect(body.observations[0].type).toBe('video.freezes');
    expect(body.features.client.hardwareConcurrency).toBe(8);
    expect(body.dump).toEqual({ sizeBytes: 1234, status: 'available' });
  });

  it('reports dump.status as missing when the object is gone from storage', async () => {
    const dump = await pool.query(
      `insert into "rtcstats-server" (rtcstats_user, session_start, session_end, blob_url, features_processing_stop)
       values ('bob', now() - interval '5 minutes', now(), $1, now()) returning id`,
      [`s3://${BUCKET}/dumps/gone.json.gz`]
    );
    const dumpId = dump.rows[0].id;
    await pool.query(`insert into features_metadata (dump_id, number_peerconnections) values ($1, 1)`, [dumpId]);
    await pool.query(
      `insert into dashboard_analysis (dump_id, rules_version, status) values ($1, '1.0.0', 'ok')`,
      [dumpId]
    );

    const response = await app.inject({ method: 'GET', url: `/api/sessions/${dumpId}`, headers: { cookie: authCookie() } });
    expect(response.json().dump).toEqual({ sizeBytes: null, status: 'missing' });
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run packages/api/test/routes/sessionDetail.test.ts`
Expected: FAIL — `/api/sessions/:dumpId` route not registered (404 for a request that should be 200)

- [ ] **Step 4: Add the detail route to `routes/sessions.ts`**

Append to `packages/api/src/routes/sessions.ts`:
```ts
import { loadFeatures } from '@rtcstats-dashboard/db-features';
import { extractObjectKey, headDump } from '../s3.js';
import type { S3Client } from '@aws-sdk/client-s3';

const SEVERITY_RANK: Record<string, number> = { critical: 0, warning: 1, info: 2 };

export function registerSessionDetailRoute(
  app: FastifyInstance,
  pool: pg.Pool,
  s3: { client: S3Client; bucket: string } | undefined,
  sessionSecret: string
): void {
  app.get<{ Params: { dumpId: string } }>(
    '/api/sessions/:dumpId',
    { preHandler: requireAuth(sessionSecret) },
    async (request, reply) => {
      const dumpId = Number(request.params.dumpId);

      const analysisResult = await pool.query(
        `select id, dump_id, rules_version, status, error, session_start, duration,
                rtcstats_user, rtcstats_conference, experience_score, audio_score, video_score,
                connectivity_score, worst_severity, observations_count, observation_types
         from dashboard_analysis where dump_id = $1`,
        [dumpId]
      );
      if (analysisResult.rows.length === 0) {
        reply.code(404).send({ error: 'not_found' });
        return;
      }
      const a = analysisResult.rows[0];

      const observationsResult = await pool.query(
        `select pid, type, severity, category, first_seen_at, observation
         from dashboard_observations where analysis_id = $1`,
        [a.id]
      );
      const observations = observationsResult.rows
        .map((o) => ({
          pid: o.pid, type: o.type, severity: o.severity, category: o.category,
          firstSeenAt: o.first_seen_at, observation: o.observation
        }))
        .sort((x, y) => {
          const rankDiff = SEVERITY_RANK[x.severity] - SEVERITY_RANK[y.severity];
          if (rankDiff !== 0) return rankDiff;
          return (x.firstSeenAt ?? 0) - (y.firstSeenAt ?? 0);
        });

      const features = await loadFeatures(pool, dumpId);

      let dump: { sizeBytes: number | null; status: 'available' | 'missing' } = { sizeBytes: null, status: 'missing' };
      if (s3) {
        const blobUrlResult = await pool.query('select blob_url from "rtcstats-server" where id = $1', [dumpId]);
        const blobUrl = blobUrlResult.rows[0]?.blob_url as string | undefined;
        if (blobUrl) {
          const key = extractObjectKey(blobUrl, s3.bucket);
          const head = await headDump(s3.client, s3.bucket, key);
          dump = head.exists ? { sizeBytes: head.sizeBytes, status: 'available' } : { sizeBytes: null, status: 'missing' };
        }
      }

      reply.send({
        analysis: {
          dumpId: a.dump_id,
          rulesVersion: a.rules_version,
          status: a.status,
          error: a.error,
          sessionStart: a.session_start,
          duration: a.duration,
          rtcstatsUser: a.rtcstats_user,
          rtcstatsConference: a.rtcstats_conference,
          experienceScore: a.experience_score,
          audioScore: a.audio_score,
          videoScore: a.video_score,
          connectivityScore: a.connectivity_score,
          worstSeverity: a.worst_severity,
          observationsCount: a.observations_count
        },
        observations,
        features,
        dump
      });
    }
  );
}
```

- [ ] **Step 5: Wire the route and thread `s3` through `app.ts`**

Modify `packages/api/src/app.ts`:
```ts
import type { S3Client } from '@aws-sdk/client-s3';
import { registerSessionDetailRoute, registerSessionsRoute } from './routes/sessions.js';
```
```ts
export interface AppDeps {
  pool: pg.Pool;
  config: AppConfig;
  checkS3?: () => Promise<void>;
  s3?: { client: S3Client; bucket: string };
}
```
```ts
  registerSessionsRoute(app, deps.pool, deps.config.sessionSecret);
  registerSessionDetailRoute(app, deps.pool, deps.s3, deps.config.sessionSecret);
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run packages/api/test/routes/sessionDetail.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 7: Commit**

```bash
git add packages/api/package.json packages/api/src/routes/sessions.ts packages/api/src/app.ts packages/api/test/routes/sessionDetail.test.ts package-lock.json
git commit -m "feat(api): add session detail endpoint composing analysis, observations, and features"
```

### Task 20: Dump streaming proxy + health check S3 wiring

**Files:**
- Modify: `packages/api/src/s3.ts` (add `checkBucketReachable`)
- Create: `packages/api/src/routes/dump.ts`
- Modify: `packages/api/src/app.ts` (register the route)
- Test: `packages/api/test/routes/dump.test.ts`

**Interfaces:**
- Consumes: `headDump`, `getDumpStream`, `extractObjectKey` (Task 18); `requireAuth` (Task 14); `AppDeps.s3` (Task 19).
- Produces: `checkBucketReachable(client, bucket): Promise<void>` (`s3.ts`, throws on failure — this is what `AppDeps.checkS3` should be set to by Task 21's server bootstrap so `GET /api/health` reflects real object-store reachability); `GET /api/sessions/:dumpId/dump` streaming the gzipped bytes through with `Content-Length`, never a presigned URL, per the Global Constraints.

- [ ] **Step 1: Write the failing tests**

`packages/api/test/routes/dump.test.ts`:
```ts
import { CreateBucketCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import { buildApp } from '../../src/app.js';
import { createSessionToken, hashPassword, SESSION_COOKIE_NAME } from '../../src/auth.js';
import { createPool } from '../../src/db.js';
import { checkBucketReachable, createS3Client } from '../../src/s3.js';

const TEST_DATABASE_URL = 'postgresql://postgres:postgres@localhost:5433/dashboard_test';
const SESSION_SECRET = 'test-secret';
const BUCKET = 'dashboard-test-bucket';

function authCookie() {
  return `${SESSION_COOKIE_NAME}=${createSessionToken(SESSION_SECRET)}`;
}

function testS3() {
  return { client: createS3Client({
    endpoint: 'http://localhost:9100', region: 'us-east-1',
    accessKeyId: 'minioadmin', secretAccessKey: 'minioadmin', bucket: BUCKET, forcePathStyle: true
  }), bucket: BUCKET };
}

describe('checkBucketReachable', () => {
  it('resolves when the bucket exists', async () => {
    const s3 = testS3();
    try {
      await s3.client.send(new CreateBucketCommand({ Bucket: BUCKET }));
    } catch (err) {
      const name = err instanceof Error ? err.name : '';
      if (name !== 'BucketAlreadyOwnedByYou' && name !== 'BucketAlreadyExists') throw err;
    }
    await expect(checkBucketReachable(s3.client, BUCKET)).resolves.toBeUndefined();
  });

  it('rejects for a nonexistent bucket', async () => {
    const s3 = testS3();
    await expect(checkBucketReachable(s3.client, 'no-such-bucket-at-all')).rejects.toThrow();
  });
});

describe('GET /api/sessions/:dumpId/dump', () => {
  let pool: pg.Pool;
  let app: ReturnType<typeof buildApp>;
  const s3 = testS3();

  beforeAll(async () => {
    pool = createPool(TEST_DATABASE_URL);
    try {
      await s3.client.send(new CreateBucketCommand({ Bucket: BUCKET }));
    } catch (err) {
      const name = err instanceof Error ? err.name : '';
      if (name !== 'BucketAlreadyOwnedByYou' && name !== 'BucketAlreadyExists') throw err;
    }
    app = buildApp({ pool, config: { passwordHash: hashPassword('x'), sessionSecret: SESSION_SECRET }, s3 });
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query('truncate dashboard_observations, dashboard_analysis, "rtcstats-server" restart identity cascade');
  });

  it('streams the dump bytes with the correct content-length', async () => {
    const dump = await pool.query(
      `insert into "rtcstats-server" (rtcstats_user, blob_url) values ('alice', $1) returning id`,
      [`s3://${BUCKET}/dumps/stream-me.json.gz`]
    );
    const dumpId = dump.rows[0].id;
    await s3.client.send(new PutObjectCommand({ Bucket: BUCKET, Key: 'dumps/stream-me.json.gz', Body: Buffer.from('compressed-bytes') }));

    const response = await app.inject({ method: 'GET', url: `/api/sessions/${dumpId}/dump`, headers: { cookie: authCookie() } });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-length']).toBe('17');
    expect(response.body).toBe('compressed-bytes');
  });

  it('returns 404 when the dump has no blob_url', async () => {
    const dump = await pool.query(`insert into "rtcstats-server" (rtcstats_user) values ('bob') returning id`);
    const response = await app.inject({ method: 'GET', url: `/api/sessions/${dump.rows[0].id}/dump`, headers: { cookie: authCookie() } });
    expect(response.statusCode).toBe(404);
  });

  it('returns 404 when the object is gone from storage', async () => {
    const dump = await pool.query(
      `insert into "rtcstats-server" (rtcstats_user, blob_url) values ('carol', $1) returning id`,
      [`s3://${BUCKET}/dumps/never-existed.json.gz`]
    );
    const response = await app.inject({ method: 'GET', url: `/api/sessions/${dump.rows[0].id}/dump`, headers: { cookie: authCookie() } });
    expect(response.statusCode).toBe(404);
  });

  it('rejects an unauthenticated request', async () => {
    const dump = await pool.query(`insert into "rtcstats-server" (rtcstats_user) values ('dave') returning id`);
    const response = await app.inject({ method: 'GET', url: `/api/sessions/${dump.rows[0].id}/dump` });
    expect(response.statusCode).toBe(401);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/api/test/routes/dump.test.ts`
Expected: FAIL — `checkBucketReachable is not exported`, and the dump route is unregistered (404 where 200 expected)

- [ ] **Step 3: Add `checkBucketReachable` to `s3.ts`**

Append to `packages/api/src/s3.ts`:
```ts
import { HeadBucketCommand } from '@aws-sdk/client-s3';
```
(add to the existing `@aws-sdk/client-s3` import line)
```ts
export async function checkBucketReachable(client: S3Client, bucket: string): Promise<void> {
  await client.send(new HeadBucketCommand({ Bucket: bucket }));
}
```

- [ ] **Step 4: Implement `routes/dump.ts`**

`packages/api/src/routes/dump.ts`:
```ts
import type { S3Client } from '@aws-sdk/client-s3';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { requireAuth } from '../auth.js';
import { extractObjectKey, getDumpStream, headDump } from '../s3.js';

export function registerDumpRoute(
  app: FastifyInstance,
  pool: pg.Pool,
  s3: { client: S3Client; bucket: string } | undefined,
  sessionSecret: string
): void {
  app.get<{ Params: { dumpId: string } }>(
    '/api/sessions/:dumpId/dump',
    { preHandler: requireAuth(sessionSecret) },
    async (request, reply) => {
      if (!s3) {
        reply.code(503).send({ error: 'object_storage_not_configured' });
        return;
      }

      const dumpId = Number(request.params.dumpId);
      const result = await pool.query('select blob_url from "rtcstats-server" where id = $1', [dumpId]);
      const blobUrl = result.rows[0]?.blob_url as string | undefined;
      if (!blobUrl) {
        reply.code(404).send({ error: 'not_found' });
        return;
      }

      const key = extractObjectKey(blobUrl, s3.bucket);
      const head = await headDump(s3.client, s3.bucket, key);
      if (!head.exists) {
        reply.code(404).send({ error: 'dump_missing_from_storage' });
        return;
      }

      const { body, contentLength } = await getDumpStream(s3.client, s3.bucket, key);
      reply.header('content-type', 'application/gzip');
      if (contentLength != null) reply.header('content-length', contentLength);
      reply.send(body);
    }
  );
}
```

- [ ] **Step 5: Register the route in `app.ts`**

Modify `packages/api/src/app.ts`:
```ts
import { registerDumpRoute } from './routes/dump.js';
```
```ts
  registerDumpRoute(app, deps.pool, deps.s3, deps.config.sessionSecret);
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run packages/api/test/routes/dump.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 7: Commit**

```bash
git add packages/api/src/s3.ts packages/api/src/routes/dump.ts packages/api/src/app.ts packages/api/test/routes/dump.test.ts
git commit -m "feat(api): add dump streaming proxy and bucket health check"
```

### Task 21: Server bootstrap and API Dockerfile

**Files:**
- Create: `packages/api/src/server.ts`
- Modify: `packages/api/package.json` (add `@fastify/static`, `start` script already present)
- Create: `packages/api/Dockerfile`
- Test: `packages/api/test/server.test.ts`

**Interfaces:**
- Consumes: `buildApp` (Task 14/15/19/20 cumulative), `createPool` (Task 14), `createS3Client`, `checkBucketReachable` (Task 18/20).
- Produces: `requiredEnv(name): string` (throws with a clear message if unset — exported so it's unit-testable without booting a real server); the running server itself, which Task 28's end-to-end check exercises. This is the last task in Phase 4.

- [ ] **Step 1: Add `@fastify/static`**

Modify `packages/api/package.json` — add `"@fastify/static": "^8.0.0"` to `dependencies`.

Run: `npm install`

- [ ] **Step 2: Write the failing test for `requiredEnv`**

`packages/api/test/server.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { requiredEnv } from '../src/server.js';

describe('requiredEnv', () => {
  it('returns the value when the variable is set', () => {
    process.env.TEST_REQUIRED_VAR = 'hello';
    expect(requiredEnv('TEST_REQUIRED_VAR')).toBe('hello');
    delete process.env.TEST_REQUIRED_VAR;
  });

  it('throws a clear error when the variable is unset', () => {
    delete process.env.TEST_MISSING_VAR;
    expect(() => requiredEnv('TEST_MISSING_VAR')).toThrow('missing required environment variable: TEST_MISSING_VAR');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run packages/api/test/server.test.ts`
Expected: FAIL — `Cannot find module '../src/server.js'`

- [ ] **Step 4: Implement `server.ts`**

`packages/api/src/server.ts`:
```ts
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import { buildApp } from './app.js';
import { createPool } from './db.js';
import { checkBucketReachable, createS3Client } from './s3.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing required environment variable: ${name}`);
  return value;
}

async function main() {
  const pool = createPool(requiredEnv('DATABASE_URL'));
  const bucket = requiredEnv('S3_BUCKET');
  const s3Client = createS3Client({
    endpoint: requiredEnv('S3_ENDPOINT'),
    region: process.env.S3_REGION ?? 'us-east-1',
    accessKeyId: requiredEnv('S3_ACCESS_KEY'),
    secretAccessKey: requiredEnv('S3_SECRET_KEY'),
    bucket,
    forcePathStyle: true
  });

  const app = buildApp({
    pool,
    config: {
      passwordHash: requiredEnv('DASHBOARD_PASSWORD_HASH'),
      sessionSecret: requiredEnv('SESSION_SECRET')
    },
    s3: { client: s3Client, bucket },
    checkS3: () => checkBucketReachable(s3Client, bucket)
  });

  const webDist = path.join(__dirname, '..', '..', 'web', 'dist');
  await app.register(fastifyStatic, { root: webDist, wildcard: false });
  app.setNotFoundHandler((request, reply) => {
    if (request.raw.url?.startsWith('/api/')) {
      reply.code(404).send({ error: 'not_found' });
      return;
    }
    reply.sendFile('index.html');
  });

  const port = Number(process.env.PORT ?? 8080);
  await app.listen({ port, host: '0.0.0.0' });
  console.log(JSON.stringify({ level: 'info', msg: 'server_started', port }));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run packages/api/test/server.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 6: Write the Dockerfile**

`packages/api/Dockerfile`:
```dockerfile
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/rules/package.json packages/rules/package.json
COPY packages/db-features/package.json packages/db-features/package.json
COPY packages/api/package.json packages/api/package.json
COPY packages/web/package.json packages/web/package.json
RUN npm ci
COPY packages/rules packages/rules
COPY packages/db-features packages/db-features
COPY packages/api packages/api
COPY packages/web packages/web
RUN npm run build --workspace packages/rules --workspace packages/db-features --workspace packages/api --workspace packages/web

FROM node:22-alpine
WORKDIR /app
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/packages/rules/dist packages/rules/dist
COPY --from=build /app/packages/rules/package.json packages/rules/package.json
COPY --from=build /app/packages/db-features/dist packages/db-features/dist
COPY --from=build /app/packages/db-features/package.json packages/db-features/package.json
COPY --from=build /app/packages/api/dist packages/api/dist
COPY --from=build /app/packages/api/package.json packages/api/package.json
COPY --from=build /app/packages/web/dist packages/web/dist
COPY migrations migrations
COPY scripts scripts
EXPOSE 8080
CMD ["node", "packages/api/dist/server.js"]
```

- [ ] **Step 7: Run the full API test suite**

Run: `npx vitest run packages/api`
Expected: PASS (all tests across Tasks 14-21)

- [ ] **Step 8: Commit**

```bash
git add packages/api/src/server.ts packages/api/package.json packages/api/Dockerfile packages/api/test/server.test.ts package-lock.json
git commit -m "feat(api): add server bootstrap and Dockerfile"
```

This completes Phase 4. `packages/api` is a fully runnable service — the frontend built in Phase 5 is what `server.ts` serves as static assets alongside the `/api/*` routes.

---

## Phase 5 — Frontend (`packages/web`)

### Task 22: Vite scaffold, API client, and login/auth flow

**Files:**
- Create: `packages/web/package.json`
- Create: `packages/web/tsconfig.json`
- Create: `packages/web/vite.config.ts`
- Create: `packages/web/vitest.config.ts`
- Create: `packages/web/index.html`
- Create: `packages/web/src/main.tsx`
- Create: `packages/web/src/App.tsx`
- Create: `packages/web/src/lib/api.ts`
- Create: `packages/web/src/lib/auth.tsx`
- Create: `packages/web/src/pages/LoginPage.tsx`
- Test: `packages/web/test/api.test.ts`
- Test: `packages/web/test/auth.test.tsx`
- Test: `packages/web/test/LoginPage.test.tsx`

**Interfaces:**
- Produces: `ApiError`, `login`, `logout`, `fetchMe`, `SessionFilters`, `SessionSummary`, `SessionListResponse`, `listSessionsUrl`, `fetchSessions`, `SessionDetailResponse`, `fetchSessionDetail`, `dumpDownloadUrl`, `fetchRuleCatalog` (`lib/api.ts`) — the only module later frontend tasks use to talk to the API; `AuthProvider`, `useAuth(): {authenticated: boolean; loading: boolean; login: (password: string) => Promise<void>; logout: () => Promise<void>}`, `ProtectedRoute` (`lib/auth.tsx`), consumed by `App.tsx` and every page from Task 23 onward.

- [ ] **Step 1: Scaffold the package**

`packages/web/package.json`:
```json
{
  "name": "@rtcstats-dashboard/web",
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -p tsconfig.json && vite build",
    "test": "vitest run"
  },
  "dependencies": {
    "react": "^18.3.0",
    "react-dom": "^18.3.0",
    "react-router-dom": "^6.28.0",
    "uplot": "^1.6.31"
  },
  "devDependencies": {
    "@testing-library/jest-dom": "^6.6.0",
    "@testing-library/react": "^16.0.0",
    "@types/react": "^18.3.0",
    "@types/react-dom": "^18.3.0",
    "@vitejs/plugin-react": "^4.3.0",
    "jsdom": "^25.0.0",
    "vite": "^5.4.0"
  }
}
```

`packages/web/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "jsx": "react-jsx",
    "lib": ["ES2022", "DOM"],
    "module": "ESNext",
    "moduleResolution": "Bundler"
  },
  "include": ["src"]
}
```

`packages/web/vite.config.ts`:
```ts
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: { '/api': 'http://localhost:8080' }
  }
});
```

`packages/web/vitest.config.ts`:
```ts
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    include: ['test/**/*.test.{ts,tsx}']
  }
});
```

`packages/web/index.html`:
```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>rtcstats dashboard</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

Run: `npm install`

- [ ] **Step 2: Write the failing API client test**

`packages/web/test/api.test.ts`:
```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, fetchMe, fetchSessions, listSessionsUrl, login } from '../src/lib/api.js';

describe('listSessionsUrl', () => {
  it('encodes only the filters that are set', () => {
    expect(listSessionsUrl({ sort: 'date' })).toBe('/api/sessions?sort=date');
  });

  it('joins types with a comma', () => {
    const url = listSessionsUrl({ types: ['video.freezes', 'audio.concealment_ratio'] });
    expect(url).toBe('/api/sessions?types=video.freezes%2Caudio.concealment_ratio');
  });
});

describe('api client', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('login posts the password and returns the parsed body', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ authenticated: true })
    });
    const result = await login('secret');
    expect(result).toEqual({ authenticated: true });
    expect(fetch).toHaveBeenCalledWith('/api/login', expect.objectContaining({ method: 'POST' }));
  });

  it('throws ApiError with the status and server message on a non-2xx response', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      json: async () => ({ error: 'invalid_password' })
    });
    await expect(login('wrong')).rejects.toMatchObject({ status: 401, message: 'invalid_password' });
  });

  it('fetchMe calls /api/me and returns the parsed body', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, json: async () => ({ authenticated: false }) });
    expect(await fetchMe()).toEqual({ authenticated: false });
  });

  it('fetchSessions calls the sessions endpoint with encoded filters', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, json: async () => ({ items: [], nextCursor: null }) });
    await fetchSessions({ sort: 'score', limit: 10 });
    expect(fetch).toHaveBeenCalledWith('/api/sessions?sort=score&limit=10', expect.anything());
  });
});

describe('ApiError', () => {
  it('is an instance of Error carrying the status', () => {
    const err = new ApiError(404, 'not_found');
    expect(err).toBeInstanceOf(Error);
    expect(err.status).toBe(404);
    expect(err.message).toBe('not_found');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run packages/web/test/api.test.ts`
Expected: FAIL — `Cannot find module '../src/lib/api.js'`

- [ ] **Step 4: Implement `lib/api.ts`**

`packages/web/src/lib/api.ts`:
```ts
export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    ...init
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new ApiError(response.status, body.error ?? response.statusText);
  }
  return response.json() as Promise<T>;
}

export async function login(password: string): Promise<{ authenticated: boolean }> {
  return apiFetch('/api/login', { method: 'POST', body: JSON.stringify({ password }) });
}

export async function logout(): Promise<void> {
  await apiFetch('/api/logout', { method: 'POST' });
}

export async function fetchMe(): Promise<{ authenticated: boolean }> {
  return apiFetch('/api/me');
}

export interface SessionFilters {
  from?: string;
  to?: string;
  user?: string;
  conference?: string;
  types?: string[];
  severity?: string;
  maxScore?: number;
  sort?: 'date' | 'score';
  cursor?: string;
  limit?: number;
}

export interface SessionSummary {
  dumpId: number;
  sessionStart: string | null;
  duration: number | null;
  rtcstatsUser: string | null;
  rtcstatsConference: string | null;
  experienceScore: number | null;
  audioScore: number | null;
  videoScore: number | null;
  connectivityScore: number | null;
  worstSeverity: string | null;
  observationsCount: Record<string, number>;
  topObservationTypes: string[];
}

export interface SessionListResponse {
  items: SessionSummary[];
  nextCursor: string | null;
}

export function listSessionsUrl(filters: SessionFilters): string {
  const params = new URLSearchParams();
  if (filters.from) params.set('from', filters.from);
  if (filters.to) params.set('to', filters.to);
  if (filters.user) params.set('user', filters.user);
  if (filters.conference) params.set('conference', filters.conference);
  if (filters.types?.length) params.set('types', filters.types.join(','));
  if (filters.severity) params.set('severity', filters.severity);
  if (filters.maxScore != null) params.set('maxScore', String(filters.maxScore));
  if (filters.sort) params.set('sort', filters.sort);
  if (filters.cursor) params.set('cursor', filters.cursor);
  if (filters.limit != null) params.set('limit', String(filters.limit));
  return `/api/sessions?${params.toString()}`;
}

export async function fetchSessions(filters: SessionFilters): Promise<SessionListResponse> {
  return apiFetch(listSessionsUrl(filters));
}

export interface Observation {
  pid: string | null;
  type: string;
  severity: 'critical' | 'warning' | 'info';
  category: string;
  firstSeenAt: number | null;
  observation: Record<string, unknown>;
}

export interface FeatureTrack {
  id: number;
  connectionId: number;
  trackIdentifier: string | null;
  kind: 'audio' | 'video' | null;
  direction: string | null;
  [key: string]: unknown;
}

export interface FeatureConnection {
  id: number;
  connectionIdentifier: string | null;
  tracks: FeatureTrack[];
  [key: string]: unknown;
}

export interface SessionDetailResponse {
  analysis: {
    dumpId: number;
    rulesVersion: string;
    status: 'ok' | 'failed' | 'insufficient_data';
    error: string | null;
    sessionStart: string | null;
    duration: number | null;
    rtcstatsUser: string | null;
    rtcstatsConference: string | null;
    experienceScore: number | null;
    audioScore: number | null;
    videoScore: number | null;
    connectivityScore: number | null;
    worstSeverity: string | null;
    observationsCount: Record<string, number>;
  };
  observations: Observation[];
  features: {
    metadata: { useragent: string | null; numberPeerconnections: number | null };
    client: { hardwareConcurrency: number | null; deviceMemory: number | null; operatingSystem: string | null; cpuPerformance: number | null } | null;
    connections: FeatureConnection[];
  } | null;
  dump: { sizeBytes: number | null; status: 'available' | 'missing' };
}

export async function fetchSessionDetail(dumpId: number): Promise<SessionDetailResponse> {
  return apiFetch(`/api/sessions/${dumpId}`);
}

export function dumpDownloadUrl(dumpId: number): string {
  return `/api/sessions/${dumpId}/dump`;
}

export async function fetchRuleCatalog(): Promise<Array<{ id: string; category: string }>> {
  return apiFetch('/api/rules');
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run packages/web/test/api.test.ts`
Expected: PASS (8 tests)

- [ ] **Step 6: Write the failing auth-context test**

`packages/web/test/auth.test.tsx`:
```tsx
import '@testing-library/jest-dom/vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider, ProtectedRoute, useAuth } from '../src/lib/auth.js';

function Protected() {
  const { authenticated } = useAuth();
  return <div>protected content: {String(authenticated)}</div>;
}

function LoginStub() {
  const { login } = useAuth();
  return <button onClick={() => login('secret')}>log in</button>;
}

function renderApp(initialPath: string) {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<LoginStub />} />
          <Route path="/" element={<ProtectedRoute><Protected /></ProtectedRoute>} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>
  );
}

describe('AuthProvider / ProtectedRoute', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('redirects to /login when /api/me reports unauthenticated', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, json: async () => ({ authenticated: false }) });
    renderApp('/');
    expect(await screen.findByText('log in')).toBeInTheDocument();
  });

  it('renders protected content when already authenticated', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, json: async () => ({ authenticated: true }) });
    renderApp('/');
    expect(await screen.findByText('protected content: true')).toBeInTheDocument();
  });

  it('login() flips authenticated to true', async () => {
    (fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ authenticated: false }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ authenticated: true }) });
    renderApp('/login');
    await userEvent.click(await screen.findByText('log in'));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/login', expect.anything()));
  });
});
```

Add `@testing-library/user-event` to `packages/web/package.json` devDependencies as `"@testing-library/user-event": "^14.5.0"` and run `npm install`.

- [ ] **Step 7: Run test to verify it fails**

Run: `npx vitest run packages/web/test/auth.test.tsx`
Expected: FAIL — `Cannot find module '../src/lib/auth.js'`

- [ ] **Step 8: Implement `lib/auth.tsx`**

`packages/web/src/lib/auth.tsx`:
```tsx
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import { fetchMe, login as apiLogin, logout as apiLogout } from './api.js';

interface AuthContextValue {
  authenticated: boolean;
  loading: boolean;
  login: (password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [authenticated, setAuthenticated] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchMe()
      .then((result) => setAuthenticated(result.authenticated))
      .finally(() => setLoading(false));
  }, []);

  async function login(password: string) {
    const result = await apiLogin(password);
    setAuthenticated(result.authenticated);
  }

  async function logout() {
    await apiLogout();
    setAuthenticated(false);
  }

  return (
    <AuthContext.Provider value={{ authenticated, loading, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used within an AuthProvider');
  return context;
}

export function ProtectedRoute({ children }: { children: ReactNode }) {
  const { authenticated, loading } = useAuth();
  if (loading) return null;
  if (!authenticated) return <Navigate to="/login" replace />;
  return <>{children}</>;
}
```

- [ ] **Step 9: Run test to verify it passes**

Run: `npx vitest run packages/web/test/auth.test.tsx`
Expected: PASS (3 tests)

- [ ] **Step 10: Write the failing LoginPage test**

`packages/web/test/LoginPage.test.tsx`:
```tsx
import '@testing-library/jest-dom/vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../src/lib/auth.js';
import { LoginPage } from '../src/pages/LoginPage.js';

describe('LoginPage', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('submits the password and navigates to / on success', async () => {
    (fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ authenticated: false }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ authenticated: true }) });

    render(
      <MemoryRouter initialEntries={['/login']}>
        <AuthProvider>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/" element={<div>home page</div>} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>
    );

    await userEvent.type(await screen.findByLabelText('Password'), 'secret');
    await userEvent.click(screen.getByRole('button', { name: 'Log in' }));

    expect(await screen.findByText('home page')).toBeInTheDocument();
  });

  it('shows an error message on a rejected password', async () => {
    (fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ authenticated: false }) })
      .mockResolvedValueOnce({ ok: false, status: 401, statusText: 'Unauthorized', json: async () => ({ error: 'invalid_password' }) });

    render(
      <MemoryRouter initialEntries={['/login']}>
        <AuthProvider>
          <LoginPage />
        </AuthProvider>
      </MemoryRouter>
    );

    await userEvent.type(await screen.findByLabelText('Password'), 'wrong');
    await userEvent.click(screen.getByRole('button', { name: 'Log in' }));

    expect(await screen.findByText('invalid_password')).toBeInTheDocument();
  });
});
```

- [ ] **Step 11: Run test to verify it fails**

Run: `npx vitest run packages/web/test/LoginPage.test.tsx`
Expected: FAIL — `Cannot find module '../src/pages/LoginPage.js'`

- [ ] **Step 12: Implement `LoginPage.tsx`, `App.tsx`, and `main.tsx`**

`packages/web/src/pages/LoginPage.tsx`:
```tsx
import { useState, type FormEvent } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '../lib/auth.js';

export function LoginPage() {
  const { authenticated, login } = useAuth();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);

  if (authenticated) return <Navigate to="/" replace />;

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    try {
      await login(password);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <form onSubmit={handleSubmit}>
      <label htmlFor="password">Password</label>
      <input id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
      <button type="submit">Log in</button>
      {error && <p role="alert">{error}</p>}
    </form>
  );
}
```

`packages/web/src/App.tsx`:
```tsx
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { AuthProvider, ProtectedRoute } from './lib/auth.js';
import { LoginPage } from './pages/LoginPage.js';

export function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/" element={<ProtectedRoute><div>session browser placeholder — built in Task 23</div></ProtectedRoute>} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}
```

`packages/web/src/main.tsx`:
```tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
```

- [ ] **Step 13: Run test to verify it passes**

Run: `npx vitest run packages/web/test/LoginPage.test.tsx`
Expected: PASS (2 tests)

- [ ] **Step 14: Commit**

```bash
git add packages/web
git commit -m "feat(web): add Vite scaffold, API client, and login/auth flow"
```

### Task 23: Session browser page

**Files:**
- Create: `packages/web/src/components/ScoreBadge.tsx`
- Create: `packages/web/src/components/SessionTable.tsx`
- Create: `packages/web/src/components/FilterBar.tsx`
- Create: `packages/web/src/pages/SessionBrowserPage.tsx`
- Modify: `packages/web/src/App.tsx`
- Test: `packages/web/test/ScoreBadge.test.tsx`
- Test: `packages/web/test/SessionTable.test.tsx`
- Test: `packages/web/test/FilterBar.test.tsx`
- Test: `packages/web/test/SessionBrowserPage.test.tsx`

**Interfaces:**
- Consumes: `SessionSummary`, `SessionFilters`, `fetchSessions` (Task 22).
- Produces: `ScoreBadge({score, worstSeverity})`; `SessionTable({items, onChipClick})`; `FilterBar({filters, onChange})`, where `onChange(patch: Partial<SessionFilters>)`; `SessionBrowserPage` — the `/` route, replacing Task 22's placeholder. Row links point to `/sessions/:dumpId`, the route Task 25 fills in.

- [ ] **Step 1: Write the failing `ScoreBadge` test**

`packages/web/test/ScoreBadge.test.tsx`:
```tsx
import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ScoreBadge } from '../src/components/ScoreBadge.js';

describe('ScoreBadge', () => {
  it('renders a dash for a null score', () => {
    render(<ScoreBadge score={null} worstSeverity={null} />);
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('renders the score value', () => {
    render(<ScoreBadge score={72} worstSeverity="warning" />);
    expect(screen.getByText('72')).toBeInTheDocument();
  });

  it('marks a critical session with the critical class regardless of score', () => {
    render(<ScoreBadge score={95} worstSeverity="critical" />);
    expect(screen.getByText('95')).toHaveClass('score-critical');
  });

  it('marks a low score without a critical observation as critical too', () => {
    render(<ScoreBadge score={30} worstSeverity="warning" />);
    expect(screen.getByText('30')).toHaveClass('score-critical');
  });

  it('marks a healthy score as ok', () => {
    render(<ScoreBadge score={95} worstSeverity={null} />);
    expect(screen.getByText('95')).toHaveClass('score-ok');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/web/test/ScoreBadge.test.tsx`
Expected: FAIL — `Cannot find module '../src/components/ScoreBadge.js'`

- [ ] **Step 3: Implement `ScoreBadge.tsx`**

`packages/web/src/components/ScoreBadge.tsx`:
```tsx
export interface ScoreBadgeProps {
  score: number | null;
  worstSeverity: 'critical' | 'warning' | 'info' | null;
}

export function ScoreBadge({ score, worstSeverity }: ScoreBadgeProps) {
  if (score == null) return <span className="score-unknown">—</span>;

  const className =
    worstSeverity === 'critical' || score < 50
      ? 'score-critical'
      : worstSeverity === 'warning' || score < 80
        ? 'score-warning'
        : 'score-ok';

  return <span className={className}>{Math.round(score)}</span>;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/web/test/ScoreBadge.test.tsx`
Expected: PASS (5 tests)

- [ ] **Step 5: Write the failing `SessionTable` test**

`packages/web/test/SessionTable.test.tsx`:
```tsx
import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { SessionTable } from '../src/components/SessionTable.js';
import type { SessionSummary } from '../src/lib/api.js';

const rows: SessionSummary[] = [{
  dumpId: 42, sessionStart: '2026-08-20T10:00:00Z', duration: 305,
  rtcstatsUser: 'alice', rtcstatsConference: 'room1',
  experienceScore: 65, audioScore: null, videoScore: 60, connectivityScore: 90,
  worstSeverity: 'critical', observationsCount: { critical: 1 },
  topObservationTypes: ['video.freezes', 'connectivity.ice_restart']
}];

describe('SessionTable', () => {
  it('renders a row per session with a link to its detail page', () => {
    render(<MemoryRouter><SessionTable items={rows} onChipClick={() => {}} /></MemoryRouter>);
    expect(screen.getByRole('link', { name: /alice/ })).toHaveAttribute('href', '/sessions/42');
  });

  it('renders a chip per observation type and calls onChipClick when clicked', async () => {
    const onChipClick = vi.fn();
    render(<MemoryRouter><SessionTable items={rows} onChipClick={onChipClick} /></MemoryRouter>);
    await userEvent.click(screen.getByText('video.freezes'));
    expect(onChipClick).toHaveBeenCalledWith('video.freezes');
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npx vitest run packages/web/test/SessionTable.test.tsx`
Expected: FAIL — `Cannot find module '../src/components/SessionTable.js'`

- [ ] **Step 7: Implement `SessionTable.tsx`**

`packages/web/src/components/SessionTable.tsx`:
```tsx
import { Link } from 'react-router-dom';
import type { SessionSummary } from '../lib/api.js';
import { ScoreBadge } from './ScoreBadge.js';

export interface SessionTableProps {
  items: SessionSummary[];
  onChipClick: (type: string) => void;
}

export function SessionTable({ items, onChipClick }: SessionTableProps) {
  return (
    <table>
      <thead>
        <tr>
          <th>Start</th><th>Duration</th><th>User</th><th>Conference</th><th>Score</th><th>Observations</th>
        </tr>
      </thead>
      <tbody>
        {items.map((item) => (
          <tr key={item.dumpId}>
            <td><Link to={`/sessions/${item.dumpId}`}>{item.rtcstatsUser ?? `dump ${item.dumpId}`}</Link></td>
            <td>{item.duration != null ? `${item.duration}s` : '—'}</td>
            <td>{item.rtcstatsUser ?? '—'}</td>
            <td>{item.rtcstatsConference ?? '—'}</td>
            <td><ScoreBadge score={item.experienceScore} worstSeverity={item.worstSeverity as 'critical' | 'warning' | 'info' | null} /></td>
            <td>
              {item.topObservationTypes.map((type) => (
                <button key={type} onClick={() => onChipClick(type)}>{type}</button>
              ))}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
```

- [ ] **Step 8: Run test to verify it passes**

Run: `npx vitest run packages/web/test/SessionTable.test.tsx`
Expected: PASS (2 tests)

- [ ] **Step 9: Write the failing `FilterBar` test**

`packages/web/test/FilterBar.test.tsx`:
```tsx
import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { FilterBar } from '../src/components/FilterBar.js';
import type { SessionFilters } from '../src/lib/api.js';

const filters: SessionFilters = { sort: 'date' };

describe('FilterBar', () => {
  it('reports a user filter change', async () => {
    const onChange = vi.fn();
    render(<FilterBar filters={filters} onChange={onChange} />);
    await userEvent.type(screen.getByLabelText('User'), 'alice');
    expect(onChange).toHaveBeenLastCalledWith({ user: 'alice' });
  });

  it('toggles sort to score and back', async () => {
    const onChange = vi.fn();
    const { rerender } = render(<FilterBar filters={filters} onChange={onChange} />);
    await userEvent.click(screen.getByRole('button', { name: 'Worst first' }));
    expect(onChange).toHaveBeenCalledWith({ sort: 'score' });

    rerender(<FilterBar filters={{ sort: 'score' }} onChange={onChange} />);
    await userEvent.click(screen.getByRole('button', { name: 'Newest first' }));
    expect(onChange).toHaveBeenCalledWith({ sort: 'date' });
  });
});
```

- [ ] **Step 10: Run test to verify it fails**

Run: `npx vitest run packages/web/test/FilterBar.test.tsx`
Expected: FAIL — `Cannot find module '../src/components/FilterBar.js'`

- [ ] **Step 11: Implement `FilterBar.tsx`**

`packages/web/src/components/FilterBar.tsx`:
```tsx
import type { ChangeEvent } from 'react';
import type { SessionFilters } from '../lib/api.js';

export interface FilterBarProps {
  filters: SessionFilters;
  onChange: (patch: Partial<SessionFilters>) => void;
}

export function FilterBar({ filters, onChange }: FilterBarProps) {
  function textField(name: 'user' | 'conference', label: string) {
    return (
      <label>
        {label}
        <input
          id={label}
          aria-label={label}
          value={filters[name] ?? ''}
          onChange={(e: ChangeEvent<HTMLInputElement>) => onChange({ [name]: e.target.value || undefined })}
        />
      </label>
    );
  }

  return (
    <div>
      {textField('user', 'User')}
      {textField('conference', 'Conference')}
      <label>
        Severity
        <select
          aria-label="Severity"
          value={filters.severity ?? ''}
          onChange={(e) => onChange({ severity: e.target.value || undefined })}
        >
          <option value="">Any</option>
          <option value="critical">Critical</option>
          <option value="warning">Warning</option>
          <option value="info">Info</option>
        </select>
      </label>
      {filters.sort === 'score' ? (
        <button onClick={() => onChange({ sort: 'date' })}>Newest first</button>
      ) : (
        <button onClick={() => onChange({ sort: 'score' })}>Worst first</button>
      )}
    </div>
  );
}
```

- [ ] **Step 12: Run test to verify it passes**

Run: `npx vitest run packages/web/test/FilterBar.test.tsx`
Expected: PASS (2 tests)

- [ ] **Step 13: Write the failing `SessionBrowserPage` test**

`packages/web/test/SessionBrowserPage.test.tsx`:
```tsx
import '@testing-library/jest-dom/vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionBrowserPage } from '../src/pages/SessionBrowserPage.js';

function page(items: unknown[], nextCursor: string | null) {
  return { ok: true, json: async () => ({ items, nextCursor }) };
}

describe('SessionBrowserPage', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('defaults to the last 24 hours, writing that into the URL', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(page([], null));
    render(<MemoryRouter initialEntries={['/']}><SessionBrowserPage /></MemoryRouter>);
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    const calledUrl = (fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(calledUrl).toContain('from=');
    expect(calledUrl).toContain('sort=date');
  });

  it('fetches a second page with the returned cursor on Load more', async () => {
    (fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(page([{ dumpId: 1, sessionStart: null, duration: null, rtcstatsUser: 'a', rtcstatsConference: null, experienceScore: 90, audioScore: null, videoScore: null, connectivityScore: null, worstSeverity: null, observationsCount: {}, topObservationTypes: [] }], 'cursor-1'))
      .mockResolvedValueOnce(page([{ dumpId: 2, sessionStart: null, duration: null, rtcstatsUser: 'b', rtcstatsConference: null, experienceScore: 80, audioScore: null, videoScore: null, connectivityScore: null, worstSeverity: null, observationsCount: {}, topObservationTypes: [] }], null));

    render(<MemoryRouter initialEntries={['/']}><SessionBrowserPage /></MemoryRouter>);
    await screen.findByText('a');
    await userEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await screen.findByText('b');

    const secondCallUrl = (fetch as ReturnType<typeof vi.fn>).mock.calls[1][0] as string;
    expect(secondCallUrl).toContain('cursor=cursor-1');
  });

  it('clicking an observation chip re-fetches with that type in the filter', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(page(
      [{ dumpId: 1, sessionStart: null, duration: null, rtcstatsUser: 'a', rtcstatsConference: null, experienceScore: 90, audioScore: null, videoScore: null, connectivityScore: null, worstSeverity: null, observationsCount: {}, topObservationTypes: ['video.freezes'] }],
      null
    ));
    render(<MemoryRouter initialEntries={['/']}><SessionBrowserPage /></MemoryRouter>);
    await userEvent.click(await screen.findByText('video.freezes'));
    await waitFor(() => {
      const lastUrl = (fetch as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0] as string;
      expect(lastUrl).toContain('types=video.freezes');
    });
  });
});
```

- [ ] **Step 14: Run test to verify it fails**

Run: `npx vitest run packages/web/test/SessionBrowserPage.test.tsx`
Expected: FAIL — `Cannot find module '../src/pages/SessionBrowserPage.js'`

- [ ] **Step 15: Implement `SessionBrowserPage.tsx`**

`packages/web/src/pages/SessionBrowserPage.tsx`:
```tsx
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { FilterBar } from '../components/FilterBar.js';
import { SessionTable } from '../components/SessionTable.js';
import { fetchSessions, type SessionFilters, type SessionSummary } from '../lib/api.js';

function filtersFromParams(params: URLSearchParams): SessionFilters {
  const types = params.get('types');
  return {
    from: params.get('from') ?? undefined,
    to: params.get('to') ?? undefined,
    user: params.get('user') ?? undefined,
    conference: params.get('conference') ?? undefined,
    types: types ? types.split(',') : undefined,
    severity: params.get('severity') ?? undefined,
    sort: params.get('sort') === 'score' ? 'score' : 'date',
    limit: 25
  };
}

export function SessionBrowserPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [items, setItems] = useState<SessionSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);

  useEffect(() => {
    if (!searchParams.get('from')) {
      const from = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const next = new URLSearchParams(searchParams);
      next.set('from', from);
      if (!next.get('sort')) next.set('sort', 'date');
      setSearchParams(next, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const filters = filtersFromParams(searchParams);

  useEffect(() => {
    if (!filters.from) return;
    fetchSessions(filters).then((result) => {
      setItems(result.items);
      setNextCursor(result.nextCursor);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams.toString()]);

  function applyPatch(patch: Partial<SessionFilters>) {
    const next = new URLSearchParams(searchParams);
    for (const [key, value] of Object.entries(patch)) {
      if (value == null || value === '') next.delete(key);
      else next.set(key, Array.isArray(value) ? value.join(',') : String(value));
    }
    setSearchParams(next);
  }

  function loadMore() {
    if (!nextCursor) return;
    fetchSessions({ ...filters, cursor: nextCursor }).then((result) => {
      setItems((prev) => [...prev, ...result.items]);
      setNextCursor(result.nextCursor);
    });
  }

  function onChipClick(type: string) {
    const currentTypes = filters.types ?? [];
    if (currentTypes.includes(type)) return;
    applyPatch({ types: [...currentTypes, type] });
  }

  return (
    <div>
      <FilterBar filters={filters} onChange={applyPatch} />
      <SessionTable items={items} onChipClick={onChipClick} />
      {nextCursor && <button onClick={loadMore}>Load more</button>}
    </div>
  );
}
```

- [ ] **Step 16: Run test to verify it passes**

Run: `npx vitest run packages/web/test/SessionBrowserPage.test.tsx`
Expected: PASS (3 tests)

- [ ] **Step 17: Wire the page into `App.tsx`**

Modify `packages/web/src/App.tsx`:
```tsx
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { AuthProvider, ProtectedRoute } from './lib/auth.js';
import { LoginPage } from './pages/LoginPage.js';
import { SessionBrowserPage } from './pages/SessionBrowserPage.js';

export function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/" element={<ProtectedRoute><SessionBrowserPage /></ProtectedRoute>} />
          <Route path="/sessions/:dumpId" element={<ProtectedRoute><div>session detail placeholder — built in Task 25</div></ProtectedRoute>} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}
```

- [ ] **Step 18: Commit**

```bash
git add packages/web/src/components/ScoreBadge.tsx packages/web/src/components/SessionTable.tsx packages/web/src/components/FilterBar.tsx packages/web/src/pages/SessionBrowserPage.tsx packages/web/src/App.tsx packages/web/test/ScoreBadge.test.tsx packages/web/test/SessionTable.test.tsx packages/web/test/FilterBar.test.tsx packages/web/test/SessionBrowserPage.test.tsx
git commit -m "feat(web): add session browser page with filters and keyset pagination"
```

### Task 24: Observation messages, registry completeness test, and the detail page header + verdict

**Files:**
- Create: `packages/web/src/messages/observationMessages.ts`
- Create: `packages/web/src/components/VerdictList.tsx`
- Create: `packages/web/src/pages/SessionDetailPage.tsx`
- Modify: `packages/web/package.json` (add `@rtcstats-dashboard/rules` dependency)
- Modify: `packages/web/src/App.tsx`
- Test: `packages/web/test/observationMessages.test.ts`
- Test: `packages/web/test/VerdictList.test.tsx`
- Test: `packages/web/test/SessionDetailPage.test.tsx`

**Interfaces:**
- Consumes: `buildRegistry` from `@rtcstats-dashboard/rules` (Phase 1); `Observation`, `fetchSessionDetail`, `SessionDetailResponse` (Task 22).
- Produces: `observationMessages: Record<string, (o: Observation) => string>`, `describeObservation(o): string` — consumed by `VerdictList` here and reused unchanged when Task 26 wires "show evidence"; `VerdictList({observations, onShowEvidence})`; `SessionDetailPage` — the `/sessions/:dumpId` route, replacing Task 23's placeholder. This is the enforcement point for the Global Constraint that observation prose lives only in the frontend: a rule shipped without an entry here fails this task's test, not silently at render time.

- [ ] **Step 1: Add the dependency**

Modify `packages/web/package.json` — add `"@rtcstats-dashboard/rules": "*"` to `dependencies`.

Run: `npm install`

- [ ] **Step 2: Write the failing tests**

`packages/web/test/observationMessages.test.ts`:
```ts
import { buildRegistry } from '@rtcstats-dashboard/rules';
import { describe, expect, it } from 'vitest';
import { describeObservation, observationMessages } from '../src/messages/observationMessages.js';

describe('observationMessages registry completeness', () => {
  it('has a message template for every rule currently in the registry', () => {
    const ids = buildRegistry().map((r) => r.id);
    const missing = ids.filter((id) => !(id in observationMessages));
    expect(missing).toEqual([]);
  });
});

describe('describeObservation', () => {
  it('renders a concrete sentence for a known type', () => {
    const message = describeObservation({
      pid: 'PC_0', type: 'video.freezes', severity: 'critical', category: 'video',
      firstSeenAt: 10, observation: { count: 3, totalFreezesDuration: 6000 }
    });
    expect(message).toBe('Video froze 3 times, totaling 6.0s.');
  });

  it('falls back to a generic message for an unrecognized type', () => {
    const message = describeObservation({ pid: null, type: 'made.up', severity: 'info', category: 'video', firstSeenAt: null, observation: {} });
    expect(message).toBe('Unrecognized observation: made.up');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run packages/web/test/observationMessages.test.ts`
Expected: FAIL — `Cannot find module '../src/messages/observationMessages.js'`

- [ ] **Step 4: Implement `observationMessages.ts`**

`packages/web/src/messages/observationMessages.ts`:
```ts
import type { Observation } from '../lib/api.js';

type MessageFn = (o: Observation) => string;

function fmtSeconds(ms: unknown): string {
  return typeof ms === 'number' ? `${(ms / 1000).toFixed(1)}s` : String(ms);
}

function fmtPercent(value: unknown): string {
  return typeof value === 'number' ? `${value.toFixed(1)}%` : String(value);
}

export const observationMessages: Record<string, MessageFn> = {
  'connectivity.never_connected': () => 'This connection never established ICE connectivity.',
  'connectivity.slow_ice_connect': (o) => `ICE took ${fmtSeconds(o.observation.iceConnectionTime)} to connect.`,
  'connectivity.slow_turn_gathering': (o) => `Gathering TURN candidates took ${fmtSeconds(o.observation.worst)}.`,
  'connectivity.ice_restart': () => 'The connection performed an ICE restart.',
  'connectivity.ice_restart_followed_by_srd': () => 'An ICE restart raced a setRemoteDescription call.',
  'connectivity.null_candidate_added': () => 'End-of-candidates was signaled.',
  'connectivity.relay_only_path': (o) => `Traffic was routed through a relay (${String(o.observation.localType)}).`,
  'connectivity.dtls_handshake_incomplete': () => 'The connection reported connected without a completed DTLS handshake.',
  'connectivity.clock_skew': (o) => `Clock skew of ${o.observation.clockSkew}ms was detected.`,
  'connectivity.signaling_delay': (o) => `Signaling was delayed by ${fmtSeconds(o.observation.signalingDelay)}.`,
  'connectivity.slow_set_remote_description': (o) => `setRemoteDescription took ${fmtSeconds(o.observation.delay)}.`,
  'connectivity.slow_set_local_description': (o) => `setLocalDescription took ${fmtSeconds(o.observation.delay)}.`,
  'video.freezes': (o) => `Video froze ${o.observation.count} times, totaling ${fmtSeconds(o.observation.totalFreezesDuration)}.`,
  'video.quality_limitation_cpu': (o) => `Video was CPU-limited ${fmtPercent(o.observation.percentage)} of the time.`,
  'video.quality_limitation_bandwidth': (o) => `Video was bandwidth-limited ${fmtPercent(o.observation.percentage)} of the time.`,
  'video.frequent_resolution_changes': (o) => `Video resolution changed ${o.observation.count} times.`,
  'video.slow_time_to_first_frame': (o) => `The first video frame took ${fmtSeconds(o.observation.timeToFirstFrame)} to arrive.`,
  'video.slow_encode': (o) => `Average encode time was ${o.observation.averageEncodeTime}ms.`,
  'video.slow_decode': (o) => `Average decode time was ${o.observation.averageDecodeTime}ms.`,
  'video.no_hw_acceleration': (o) => `Video decoding used software (${String(o.observation.decoderImplementation)}), not hardware acceleration.`,
  'video.null_video_decoder': () => 'The video decoder reported as null — decoding was broken.',
  'video.qp_degradation': (o) => `Average QP reached ${Math.round(Number(o.observation.averageQp))}, indicating heavy compression.`,
  'audio.concealment_ratio': (o) => `${fmtPercent(o.observation.percentage)} of audio samples were concealed (packet loss).`,
  'audio.jitter_buffer_flushes': (o) => o.observation.periodic
    ? 'The jitter buffer flushed periodically.'
    : `The jitter buffer flushed ${o.observation.count} times.`,
  'audio.time_stretching': (o) => `Audio was time-stretched by ${fmtPercent(o.observation.percentage)}.`,
  'audio.track_ended_unexpectedly': () => 'The audio track ended shortly after starting.',
  'device.get_user_media_failure': (o) => `getUserMedia failed (${String(o.observation.error ?? 'unknown error')}).`,
  'device.low_cpu_performance': (o) => `Device CPU performance was rated low (${o.observation.cpuPerformance}).`,
  'device.frequent_reloads': (o) => `The page reloaded ${o.observation.reloadCount} times during the call.`,
  'api.add_ice_candidate_failure': (o) => `addIceCandidate failed: ${String(o.observation.error)}.`,
  'api.set_local_description_failure': (o) => `setLocalDescription failed: ${String(o.observation.error)}.`,
  'api.set_remote_description_failure': (o) => `setRemoteDescription failed: ${String(o.observation.error)}.`
};

export function describeObservation(observation: Observation): string {
  const template = observationMessages[observation.type];
  return template ? template(observation) : `Unrecognized observation: ${observation.type}`;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run packages/web/test/observationMessages.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 6: Write the failing `VerdictList` test**

`packages/web/test/VerdictList.test.tsx`:
```tsx
import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { VerdictList } from '../src/components/VerdictList.js';
import type { Observation } from '../src/lib/api.js';

const observations: Observation[] = [
  { pid: 'PC_0', type: 'video.freezes', severity: 'critical', category: 'video', firstSeenAt: 10, observation: { count: 3, totalFreezesDuration: 6000 } },
  { pid: 'PC_0', type: 'connectivity.ice_restart', severity: 'warning', category: 'connectivity', firstSeenAt: 5, observation: {} }
];

describe('VerdictList', () => {
  it('renders observations grouped under their severity heading', () => {
    render(<VerdictList observations={observations} onShowEvidence={() => {}} />);
    expect(screen.getByRole('heading', { name: 'critical' })).toBeInTheDocument();
    expect(screen.getByText(/Video froze 3 times/)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'warning' })).toBeInTheDocument();
  });

  it('renders nothing when there are no observations', () => {
    render(<VerdictList observations={[]} onShowEvidence={() => {}} />);
    expect(screen.getByText('No issues detected.')).toBeInTheDocument();
  });

  it('calls onShowEvidence with the clicked observation', async () => {
    const onShowEvidence = vi.fn();
    render(<VerdictList observations={observations} onShowEvidence={onShowEvidence} />);
    await userEvent.click(screen.getAllByText('Show evidence')[0]);
    expect(onShowEvidence).toHaveBeenCalledWith(observations[0]);
  });
});
```

- [ ] **Step 7: Run test to verify it fails**

Run: `npx vitest run packages/web/test/VerdictList.test.tsx`
Expected: FAIL — `Cannot find module '../src/components/VerdictList.js'`

- [ ] **Step 8: Implement `VerdictList.tsx`**

`packages/web/src/components/VerdictList.tsx`:
```tsx
import type { Observation } from '../lib/api.js';
import { describeObservation } from '../messages/observationMessages.js';

export interface VerdictListProps {
  observations: Observation[];
  onShowEvidence: (observation: Observation) => void;
}

const SEVERITY_ORDER = ['critical', 'warning', 'info'] as const;

export function VerdictList({ observations, onShowEvidence }: VerdictListProps) {
  if (observations.length === 0) return <p>No issues detected.</p>;

  return (
    <div>
      {SEVERITY_ORDER.filter((severity) => observations.some((o) => o.severity === severity)).map((severity) => (
        <section key={severity}>
          <h3>{severity}</h3>
          <ul>
            {observations.filter((o) => o.severity === severity).map((o, i) => (
              <li key={`${o.type}-${o.pid}-${i}`}>
                {describeObservation(o)}
                <button onClick={() => onShowEvidence(o)}>Show evidence</button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
```

- [ ] **Step 9: Run test to verify it passes**

Run: `npx vitest run packages/web/test/VerdictList.test.tsx`
Expected: PASS (3 tests)

- [ ] **Step 10: Write the failing `SessionDetailPage` test**

`packages/web/test/SessionDetailPage.test.tsx`:
```tsx
import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionDetailPage } from '../src/pages/SessionDetailPage.js';

describe('SessionDetailPage', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders the header and verdict as soon as the detail response arrives', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({
        analysis: {
          dumpId: 7, rulesVersion: '1.0.0', status: 'ok', error: null,
          sessionStart: '2026-08-20T10:00:00Z', duration: 300,
          rtcstatsUser: 'alice', rtcstatsConference: 'room1',
          experienceScore: 65, audioScore: null, videoScore: 60, connectivityScore: 90,
          worstSeverity: 'critical', observationsCount: { critical: 1 }
        },
        observations: [
          { pid: 'PC_0', type: 'video.freezes', severity: 'critical', category: 'video', firstSeenAt: 10, observation: { count: 3, totalFreezesDuration: 6000 } }
        ],
        features: { metadata: { useragent: 'Chrome/120', numberPeerconnections: 1 }, client: { hardwareConcurrency: 8, deviceMemory: 8, operatingSystem: 'macOS', cpuPerformance: 5 }, connections: [] },
        dump: { sizeBytes: 12345, status: 'available' }
      })
    });

    render(
      <MemoryRouter initialEntries={['/sessions/7']}>
        <Routes><Route path="/sessions/:dumpId" element={<SessionDetailPage />} /></Routes>
      </MemoryRouter>
    );

    expect(await screen.findByText('alice')).toBeInTheDocument();
    expect(await screen.findByText(/Video froze 3 times/)).toBeInTheDocument();
    expect(screen.getByText('macOS')).toBeInTheDocument();
  });
});
```

- [ ] **Step 11: Run test to verify it fails**

Run: `npx vitest run packages/web/test/SessionDetailPage.test.tsx`
Expected: FAIL — `Cannot find module '../src/pages/SessionDetailPage.js'`

- [ ] **Step 12: Implement `SessionDetailPage.tsx`**

`packages/web/src/pages/SessionDetailPage.tsx`:
```tsx
import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { VerdictList } from '../components/VerdictList.js';
import { dumpDownloadUrl, fetchSessionDetail, type Observation, type SessionDetailResponse } from '../lib/api.js';

export function SessionDetailPage() {
  const { dumpId } = useParams<{ dumpId: string }>();
  const [detail, setDetail] = useState<SessionDetailResponse | null>(null);

  useEffect(() => {
    if (!dumpId) return;
    fetchSessionDetail(Number(dumpId)).then(setDetail);
  }, [dumpId]);

  if (!detail) return <p>Loading…</p>;

  const { analysis, observations, features, dump } = detail;

  function onShowEvidence(_observation: Observation) {
    // Wired to zoom the evidence charts in Task 26.
  }

  return (
    <div>
      <header>
        <h1>{analysis.rtcstatsUser ?? `Session ${analysis.dumpId}`}</h1>
        <p>Experience score: {analysis.experienceScore ?? '—'}</p>
        <p>Audio: {analysis.audioScore ?? '—'} · Video: {analysis.videoScore ?? '—'} · Connectivity: {analysis.connectivityScore ?? '—'}</p>
        {features?.client && (
          <p>
            {features.client.operatingSystem} · {features.client.hardwareConcurrency} cores · {features.client.deviceMemory}GB
          </p>
        )}
        <p>Dump: {dump.status === 'available' ? `${dump.sizeBytes} bytes` : 'no longer in storage'}</p>
        {dump.status === 'available' && <a href={dumpDownloadUrl(analysis.dumpId)}>Download raw dump</a>}
      </header>
      <VerdictList observations={observations} onShowEvidence={onShowEvidence} />
    </div>
  );
}
```

- [ ] **Step 13: Run test to verify it passes**

Run: `npx vitest run packages/web/test/SessionDetailPage.test.tsx`
Expected: PASS (1 test)

- [ ] **Step 14: Wire the page into `App.tsx`**

Modify `packages/web/src/App.tsx` — replace the placeholder route:
```tsx
import { SessionDetailPage } from './pages/SessionDetailPage.js';
```
```tsx
          <Route path="/sessions/:dumpId" element={<ProtectedRoute><SessionDetailPage /></ProtectedRoute>} />
```

- [ ] **Step 15: Commit**

```bash
git add packages/web/package.json packages/web/src/messages packages/web/src/components/VerdictList.tsx packages/web/src/pages/SessionDetailPage.tsx packages/web/src/App.tsx packages/web/test/observationMessages.test.ts packages/web/test/VerdictList.test.tsx packages/web/test/SessionDetailPage.test.tsx package-lock.json
git commit -m "feat(web): add observation messages, verdict list, and session detail header"
```

### Task 25: Dump fetch + parse Web Worker with size-threshold confirmation

**Files:**
- Modify: `packages/web/package.json` (add `@rtcstats/rtcstats-shared`)
- Create: `packages/web/src/workers/parseDump.ts`
- Create: `packages/web/src/workers/parseDump.worker.ts`
- Modify: `packages/web/src/pages/SessionDetailPage.tsx`
- Test: `packages/web/test/parseDump.test.ts`

**Interfaces:**
- Consumes: `maybeUncompressDump`, `detectRTCStatsDump`, `readRTCStatsDump`, `createRtcStatsTimeSeries` from the real, published `@rtcstats/rtcstats-shared` package (verified in `/home/dfe/Documents/Projets/WebRTC/rtcstats/packages/rtcstats-shared/{dump.js,timeseries.js}` during planning — this is the same MIT-licensed parsing code `dump-importer` uses, not a reimplementation); `dumpDownloadUrl` (Task 22).
- Produces: `ParsedConnection`, `ParsedDump`, `UnsupportedDumpFormatError`, `parseDumpBlob(blob: Blob): Promise<ParsedDump>`, `exceedsSizeThreshold(sizeBytes, thresholdBytes?): boolean` (default threshold 25 MB, from the Global Constraints) — from `parseDump.ts`. `parseDump.worker.ts` is a thin, untested `self.onmessage` wrapper around `parseDumpBlob`, run inside a real Web Worker. Task 26 (evidence charts) consumes `ParsedConnection.series`, keyed by stats id, each an object of `{type, [property]: [[timestamp, value], ...]}`.

**Why an external dependency instead of reimplementing the parser:** the rtcstats dump format is delta-compressed (`statsDecompression` restores values that were dropped because they hadn't changed since the previous sample) and has its own property/type compression tables. Reimplementing that here would duplicate non-trivial logic this session verified by reading the source, and would drift the moment the format changes. `@rtcstats/rtcstats-shared` is MIT-licensed and published to the public npm registry (`publishConfig.access: "public"`, currently at `2.6.1`), so it's a normal dependency, not a cross-repo workspace hack.

- [ ] **Step 1: Add the dependency**

Modify `packages/web/package.json` — add `"@rtcstats/rtcstats-shared": "^2.6.1"` to `dependencies`.

Run: `npm install`

- [ ] **Step 2: Write the failing test**

`packages/web/test/parseDump.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { exceedsSizeThreshold, parseDumpBlob, UnsupportedDumpFormatError } from '../src/workers/parseDump.js';

function rtcStatsDumpBlob(): Blob {
  const lines = [
    'RTCStatsDump',
    JSON.stringify({ userAgent: 'Chrome/120.0', origin: 'https://example.com', url: 'room1' }),
    JSON.stringify(['create', 'PC_0', { type: 'create' }, 0]),
    JSON.stringify([
      'getStats',
      'PC_0',
      { RTCInboundVideo1: { type: 'inbound-rtp', timestamp: 1000, framesReceived: 10 } },
      50
    ])
  ];
  return new Blob([lines.join('\n') + '\n'], { type: 'text/plain' });
}

describe('parseDumpBlob', () => {
  it('parses a real RTCStatsDump into per-connection timeseries', async () => {
    const result = await parseDumpBlob(rtcStatsDumpBlob());
    expect(result.userAgent).toBe('Chrome/120.0');
    expect(result.connections).toHaveLength(1);
    expect(result.connections[0].connectionId).toBe('PC_0');
    const series = result.connections[0].series.RTCInboundVideo1;
    expect(series.type).toBe('inbound-rtp');
    expect(series.framesReceived).toEqual([[1000, 10]]);
  });

  it('throws UnsupportedDumpFormatError for a non-RTCStatsDump blob', async () => {
    const blob = new Blob(['{"not":"an rtcstats dump"}'], { type: 'application/json' });
    await expect(parseDumpBlob(blob)).rejects.toBeInstanceOf(UnsupportedDumpFormatError);
  });
});

describe('exceedsSizeThreshold', () => {
  it('is false under the default 25MB threshold', () => {
    expect(exceedsSizeThreshold(10 * 1024 * 1024)).toBe(false);
  });

  it('is true over the default 25MB threshold', () => {
    expect(exceedsSizeThreshold(30 * 1024 * 1024)).toBe(true);
  });

  it('respects a custom threshold', () => {
    expect(exceedsSizeThreshold(1000, 500)).toBe(true);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run packages/web/test/parseDump.test.ts`
Expected: FAIL — `Cannot find module '../src/workers/parseDump.js'`

- [ ] **Step 4: Implement `parseDump.ts`**

`packages/web/src/workers/parseDump.ts`:
```ts
import {
  createRtcStatsTimeSeries,
  detectRTCStatsDump,
  maybeUncompressDump,
  readRTCStatsDump
} from '@rtcstats/rtcstats-shared';

export class UnsupportedDumpFormatError extends Error {}

export interface ParsedConnection {
  connectionId: string;
  series: Record<string, Record<string, unknown>>;
}

export interface ParsedDump {
  userAgent: string | undefined;
  connections: ParsedConnection[];
}

export async function parseDumpBlob(blob: Blob): Promise<ParsedDump> {
  const uncompressed = await maybeUncompressDump(blob);

  const isRtcStatsDump = await detectRTCStatsDump(uncompressed);
  if (!isRtcStatsDump) {
    throw new UnsupportedDumpFormatError('Only the RTCStatsDump format is supported for evidence charts.');
  }

  const data = await readRTCStatsDump(uncompressed);
  if (!data) {
    throw new UnsupportedDumpFormatError('Failed to parse RTCStatsDump.');
  }

  const connections: ParsedConnection[] = Object.entries(data.peerConnections)
    .filter(([connectionId]) => connectionId !== 'null')
    .map(([connectionId, trace]) => ({
      connectionId,
      series: createRtcStatsTimeSeries(trace as never)
    }));

  return { userAgent: data.userAgent, connections };
}

export function exceedsSizeThreshold(sizeBytes: number, thresholdBytes = 25 * 1024 * 1024): boolean {
  return sizeBytes > thresholdBytes;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run packages/web/test/parseDump.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 6: Write the (untested) Worker entry point**

`packages/web/src/workers/parseDump.worker.ts`:
```ts
import { parseDumpBlob } from './parseDump.js';

self.onmessage = async (event: MessageEvent<Blob>) => {
  try {
    const result = await parseDumpBlob(event.data);
    self.postMessage({ ok: true, result });
  } catch (err) {
    self.postMessage({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
};
```

- [ ] **Step 7: Wire fetch-and-parse into `SessionDetailPage.tsx`, gated by the size threshold**

Modify `packages/web/src/pages/SessionDetailPage.tsx`:
```tsx
import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { VerdictList } from '../components/VerdictList.js';
import { dumpDownloadUrl, fetchSessionDetail, type Observation, type SessionDetailResponse } from '../lib/api.js';
import { exceedsSizeThreshold, type ParsedDump } from '../workers/parseDump.js';

export function SessionDetailPage() {
  const { dumpId } = useParams<{ dumpId: string }>();
  const [detail, setDetail] = useState<SessionDetailResponse | null>(null);
  const [parsedDump, setParsedDump] = useState<ParsedDump | null>(null);
  const [parseState, setParseState] = useState<'idle' | 'confirming' | 'loading' | 'error'>('idle');

  useEffect(() => {
    if (!dumpId) return;
    fetchSessionDetail(Number(dumpId)).then(setDetail);
  }, [dumpId]);

  async function loadEvidence() {
    if (!dumpId) return;
    setParseState('loading');
    try {
      const response = await fetch(dumpDownloadUrl(Number(dumpId)), { credentials: 'include' });
      const blob = await response.blob();
      const worker = new Worker(new URL('../workers/parseDump.worker.ts', import.meta.url), { type: 'module' });
      worker.postMessage(blob);
      worker.onmessage = (event: MessageEvent<{ ok: boolean; result?: ParsedDump; error?: string }>) => {
        if (event.data.ok && event.data.result) {
          setParsedDump(event.data.result);
          setParseState('idle');
        } else {
          setParseState('error');
        }
        worker.terminate();
      };
    } catch {
      setParseState('error');
    }
  }

  function onLoadEvidenceClick() {
    if (!detail) return;
    if (detail.dump.sizeBytes != null && exceedsSizeThreshold(detail.dump.sizeBytes)) {
      setParseState('confirming');
      return;
    }
    void loadEvidence();
  }

  if (!detail) return <p>Loading…</p>;

  const { analysis, observations, features, dump } = detail;

  function onShowEvidence(_observation: Observation) {
    // Wired to zoom the evidence charts in Task 26.
  }

  return (
    <div>
      <header>
        <h1>{analysis.rtcstatsUser ?? `Session ${analysis.dumpId}`}</h1>
        <p>Experience score: {analysis.experienceScore ?? '—'}</p>
        <p>Audio: {analysis.audioScore ?? '—'} · Video: {analysis.videoScore ?? '—'} · Connectivity: {analysis.connectivityScore ?? '—'}</p>
        {features?.client && (
          <p>
            {features.client.operatingSystem} · {features.client.hardwareConcurrency} cores · {features.client.deviceMemory}GB
          </p>
        )}
        <p>Dump: {dump.status === 'available' ? `${dump.sizeBytes} bytes` : 'no longer in storage'}</p>
        {dump.status === 'available' && <a href={dumpDownloadUrl(analysis.dumpId)}>Download raw dump</a>}
      </header>
      <VerdictList observations={observations} onShowEvidence={onShowEvidence} />
      {dump.status === 'available' && !parsedDump && (
        <div>
          {parseState === 'confirming' ? (
            <>
              <p>This dump is over 25MB compressed. Parsing it in your browser may be slow.</p>
              <button onClick={() => void loadEvidence()}>Parse anyway</button>
            </>
          ) : (
            <button onClick={onLoadEvidenceClick} disabled={parseState === 'loading'}>
              {parseState === 'loading' ? 'Parsing…' : 'Load evidence charts'}
            </button>
          )}
          {parseState === 'error' && <p role="alert">Failed to parse the dump.</p>}
        </div>
      )}
      {parsedDump && <p>Parsed {parsedDump.connections.length} connection(s) — charts built in Task 26.</p>}
    </div>
  );
}
```

- [ ] **Step 8: Run the full web test suite to confirm nothing broke**

Run: `npx vitest run packages/web`
Expected: PASS — the existing `SessionDetailPage` test from Task 24 still passes, since it never clicks "Load evidence charts".

- [ ] **Step 9: Commit**

```bash
git add packages/web/package.json packages/web/src/workers packages/web/src/pages/SessionDetailPage.tsx packages/web/test/parseDump.test.ts package-lock.json
git commit -m "feat(web): add dump parse Web Worker with size-threshold confirmation"
```

### Task 26: Evidence charts, event timeline, and peer-connection selector

**Files:**
- Modify: `packages/web/src/workers/parseDump.ts` (extract non-`getStats` trace events per connection)
- Modify: `packages/web/test/parseDump.test.ts`
- Create: `packages/web/src/components/PeerConnectionSelector.tsx`
- Create: `packages/web/src/components/EventTimeline.tsx`
- Create: `packages/web/src/components/EvidenceCharts.tsx`
- Modify: `packages/web/src/pages/SessionDetailPage.tsx`
- Test: `packages/web/test/PeerConnectionSelector.test.tsx`
- Test: `packages/web/test/EventTimeline.test.tsx`
- Test: `packages/web/test/EvidenceCharts.test.tsx`

**Interfaces:**
- Consumes: `ParsedDump`, `ParsedConnection` (Task 25, extended here with `events`); uPlot (already a `packages/web` dependency from Task 22).
- Produces: `PeerConnectionSelector({connectionIds, selected, onSelect})`; `EventTimeline({events})`; `EvidenceCharts({series, properties, focusRange})`, where `focusRange` is in the same millisecond units as the series timestamps (elapsed ms since the dump started, per `readRTCStatsDump`'s `timestamp` field verified in Task 25). "Show evidence" now does something real: it sets `focusRange` centered on the observation's `firstSeenAt` and switches `PeerConnectionSelector` to the observation's `pid`.

**On chart selection:** rather than hardcode which stats properties are "interesting" (a judgment call that varies by session and isn't specified anywhere in the spec), `EvidenceCharts` charts every numeric property already present in the parsed series for the selected connection. This keeps the component generic instead of encoding domain assumptions the plan has no authority to make.

- [ ] **Step 1: Write the failing test for the events extension**

Modify `packages/web/test/parseDump.test.ts` — add inside the existing `describe('parseDumpBlob', ...)` block:
```ts
  it('extracts non-getStats trace events per connection', async () => {
    const result = await parseDumpBlob(rtcStatsDumpBlob());
    expect(result.connections[0].events).toEqual([{ type: 'create', timestamp: 0 }]);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/web/test/parseDump.test.ts`
Expected: FAIL — `result.connections[0].events` is `undefined`

- [ ] **Step 3: Extend `parseDump.ts` with event extraction**

Modify `packages/web/src/workers/parseDump.ts`:
```ts
export interface ParsedConnection {
  connectionId: string;
  series: Record<string, Record<string, unknown>>;
  events: Array<{ type: string; timestamp: number }>;
}
```
```ts
  const connections: ParsedConnection[] = Object.entries(data.peerConnections)
    .filter(([connectionId]) => connectionId !== 'null')
    .map(([connectionId, trace]) => ({
      connectionId,
      series: createRtcStatsTimeSeries(trace as never),
      events: (trace as Array<{ type: string; timestamp: number }>)
        .filter((event) => event.type !== 'getStats')
        .map((event) => ({ type: event.type, timestamp: event.timestamp }))
    }));
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/web/test/parseDump.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Write the failing `PeerConnectionSelector` test**

`packages/web/test/PeerConnectionSelector.test.tsx`:
```tsx
import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { PeerConnectionSelector } from '../src/components/PeerConnectionSelector.js';

describe('PeerConnectionSelector', () => {
  it('renders nothing for a single-connection session', () => {
    const { container } = render(<PeerConnectionSelector connectionIds={['PC_0']} selected="PC_0" onSelect={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders a button per connection and reports selection', async () => {
    const onSelect = vi.fn();
    render(<PeerConnectionSelector connectionIds={['PC_0', 'PC_1']} selected="PC_0" onSelect={onSelect} />);
    await userEvent.click(screen.getByRole('button', { name: 'PC_1' }));
    expect(onSelect).toHaveBeenCalledWith('PC_1');
    expect(screen.getByRole('button', { name: 'PC_0' })).toHaveAttribute('aria-pressed', 'true');
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npx vitest run packages/web/test/PeerConnectionSelector.test.tsx`
Expected: FAIL — `Cannot find module '../src/components/PeerConnectionSelector.js'`

- [ ] **Step 7: Implement `PeerConnectionSelector.tsx`**

`packages/web/src/components/PeerConnectionSelector.tsx`:
```tsx
export interface PeerConnectionSelectorProps {
  connectionIds: string[];
  selected: string | null;
  onSelect: (connectionId: string) => void;
}

export function PeerConnectionSelector({ connectionIds, selected, onSelect }: PeerConnectionSelectorProps) {
  if (connectionIds.length <= 1) return null;

  return (
    <div role="tablist">
      {connectionIds.map((id) => (
        <button key={id} aria-pressed={id === selected} onClick={() => onSelect(id)}>
          {id}
        </button>
      ))}
    </div>
  );
}
```

- [ ] **Step 8: Run test to verify it passes**

Run: `npx vitest run packages/web/test/PeerConnectionSelector.test.tsx`
Expected: PASS (2 tests)

- [ ] **Step 9: Write the failing `EventTimeline` test**

`packages/web/test/EventTimeline.test.tsx`:
```tsx
import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { EventTimeline } from '../src/components/EventTimeline.js';

describe('EventTimeline', () => {
  it('renders one entry per event with elapsed seconds', () => {
    render(<EventTimeline events={[{ type: 'create', timestamp: 0 }, { type: 'oniceconnectionstatechange', timestamp: 4200 }]} />);
    expect(screen.getByText('0.0s — create')).toBeInTheDocument();
    expect(screen.getByText('4.2s — oniceconnectionstatechange')).toBeInTheDocument();
  });

  it('renders nothing for an empty event list', () => {
    const { container } = render(<EventTimeline events={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});
```

- [ ] **Step 10: Run test to verify it fails**

Run: `npx vitest run packages/web/test/EventTimeline.test.tsx`
Expected: FAIL — `Cannot find module '../src/components/EventTimeline.js'`

- [ ] **Step 11: Implement `EventTimeline.tsx`**

`packages/web/src/components/EventTimeline.tsx`:
```tsx
export interface TimelineEvent {
  type: string;
  timestamp: number;
}

export interface EventTimelineProps {
  events: TimelineEvent[];
}

export function EventTimeline({ events }: EventTimelineProps) {
  if (events.length === 0) return null;

  return (
    <ul aria-label="Event timeline">
      {events.map((event, i) => (
        <li key={`${event.type}-${event.timestamp}-${i}`}>
          {(event.timestamp / 1000).toFixed(1)}s — {event.type}
        </li>
      ))}
    </ul>
  );
}
```

- [ ] **Step 12: Run test to verify it passes**

Run: `npx vitest run packages/web/test/EventTimeline.test.tsx`
Expected: PASS (2 tests)

- [ ] **Step 13: Write the failing `EvidenceCharts` test**

`packages/web/test/EvidenceCharts.test.tsx`:
```tsx
import '@testing-library/jest-dom/vitest';
import { render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const destroy = vi.fn();
const setScale = vi.fn();
const MockUplot = vi.fn().mockImplementation(() => ({ destroy, setScale }));
vi.mock('uplot', () => ({ default: MockUplot }));

const { EvidenceCharts } = await import('../src/components/EvidenceCharts.js');

const series = { RTCInboundVideo1: { type: 'inbound-rtp', framesReceived: [[1000, 10], [2000, 20]] } };

describe('EvidenceCharts', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('constructs one uPlot instance per requested property with data', () => {
    render(<EvidenceCharts series={series} properties={['RTCInboundVideo1.framesReceived']} focusRange={null} />);
    expect(MockUplot).toHaveBeenCalledTimes(1);
  });

  it('skips a property with no data points', () => {
    render(<EvidenceCharts series={series} properties={['RTCInboundVideo1.missingProp']} focusRange={null} />);
    expect(MockUplot).not.toHaveBeenCalled();
  });

  it('zooms every chart to the focus range, converted from ms to seconds', () => {
    render(<EvidenceCharts series={series} properties={['RTCInboundVideo1.framesReceived']} focusRange={{ from: 1000, to: 2000 }} />);
    expect(setScale).toHaveBeenCalledWith('x', { min: 1, max: 2 });
  });
});
```

- [ ] **Step 14: Run test to verify it fails**

Run: `npx vitest run packages/web/test/EvidenceCharts.test.tsx`
Expected: FAIL — `Cannot find module '../src/components/EvidenceCharts.js'`

- [ ] **Step 15: Implement `EvidenceCharts.tsx`**

`packages/web/src/components/EvidenceCharts.tsx`:
```tsx
import { useEffect, useRef } from 'react';
import uPlot from 'uplot';

export interface EvidenceChartsProps {
  series: Record<string, Record<string, unknown>>;
  properties: string[];
  focusRange: { from: number; to: number } | null;
}

function toUplotSeries(points: Array<[number, unknown]>): [number[], Array<number | null>] {
  return [points.map(([t]) => t / 1000), points.map(([, v]) => (typeof v === 'number' ? v : null))];
}

export function EvidenceCharts({ series, properties, focusRange }: EvidenceChartsProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const plotsRef = useRef<uPlot[]>([]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    plotsRef.current.forEach((plot) => plot.destroy());
    plotsRef.current = [];
    container.innerHTML = '';

    for (const key of properties) {
      const [statsId, property] = key.split('.');
      const points = series[statsId]?.[property] as Array<[number, unknown]> | undefined;
      if (!points || points.length === 0) continue;

      const [xs, ys] = toUplotSeries(points);
      const chartDiv = document.createElement('div');
      container.appendChild(chartDiv);
      const plot = new uPlot({ width: 600, height: 200, series: [{}, { label: property }], title: key }, [xs, ys], chartDiv);
      plotsRef.current.push(plot);
    }

    return () => {
      plotsRef.current.forEach((plot) => plot.destroy());
      plotsRef.current = [];
    };
  }, [series, properties]);

  useEffect(() => {
    if (!focusRange) return;
    plotsRef.current.forEach((plot) => plot.setScale('x', { min: focusRange.from / 1000, max: focusRange.to / 1000 }));
  }, [focusRange]);

  return <div ref={containerRef} data-testid="evidence-charts" />;
}
```

- [ ] **Step 16: Run test to verify it passes**

Run: `npx vitest run packages/web/test/EvidenceCharts.test.tsx`
Expected: PASS (3 tests)

- [ ] **Step 17: Wire everything into `SessionDetailPage.tsx`**

Modify `packages/web/src/pages/SessionDetailPage.tsx` — add state and replace the placeholder paragraph:
```tsx
import { EventTimeline } from '../components/EventTimeline.js';
import { EvidenceCharts } from '../components/EvidenceCharts.js';
import { PeerConnectionSelector } from '../components/PeerConnectionSelector.js';
```
```tsx
  const [selectedConnectionId, setSelectedConnectionId] = useState<string | null>(null);
  const [focusRange, setFocusRange] = useState<{ from: number; to: number } | null>(null);
```
Set `selectedConnectionId` to the first connection once `parsedDump` arrives (inside the worker's `onmessage` success branch, after `setParsedDump(event.data.result)`):
```tsx
          setParsedDump(event.data.result);
          setSelectedConnectionId(event.data.result.connections[0]?.connectionId ?? null);
```
Replace `onShowEvidence`:
```tsx
  function onShowEvidence(observation: Observation) {
    if (observation.pid) setSelectedConnectionId(observation.pid);
    const centerMs = (observation.firstSeenAt ?? 0) * 1000;
    setFocusRange({ from: Math.max(0, centerMs - 5000), to: centerMs + 15000 });
  }
```
Replace the final `{parsedDump && <p>...</p>}` block:
```tsx
      {parsedDump && selectedConnectionId && (() => {
        const connection = parsedDump.connections.find((c) => c.connectionId === selectedConnectionId);
        if (!connection) return null;
        const properties = Object.entries(connection.series).flatMap(([statsId, report]) =>
          Object.keys(report).filter((key) => key !== 'type').map((key) => `${statsId}.${key}`)
        );
        return (
          <div>
            <PeerConnectionSelector
              connectionIds={parsedDump.connections.map((c) => c.connectionId)}
              selected={selectedConnectionId}
              onSelect={setSelectedConnectionId}
            />
            <EventTimeline events={connection.events} />
            <EvidenceCharts series={connection.series} properties={properties} focusRange={focusRange} />
          </div>
        );
      })()}
```

- [ ] **Step 18: Run the full web test suite**

Run: `npx vitest run packages/web`
Expected: PASS — all tests from Tasks 22-26.

- [ ] **Step 19: Commit**

```bash
git add packages/web/src/workers/parseDump.ts packages/web/test/parseDump.test.ts packages/web/src/components/PeerConnectionSelector.tsx packages/web/src/components/EventTimeline.tsx packages/web/src/components/EvidenceCharts.tsx packages/web/src/pages/SessionDetailPage.tsx packages/web/test/PeerConnectionSelector.test.tsx packages/web/test/EventTimeline.test.tsx packages/web/test/EvidenceCharts.test.tsx
git commit -m "feat(web): add evidence charts, event timeline, and peer-connection selector"
```

This completes Phase 5's component work. Task 27 adds the end-to-end Playwright smoke test.

### Task 27: End-to-end Playwright smoke test

**Files:**
- Create: `scripts/seed-e2e.mjs`
- Create: `packages/web/playwright.config.ts`
- Create: `packages/web/e2e/smoke.spec.ts`
- Modify: `packages/web/package.json` (add `@playwright/test`, `test:e2e` script)

**Interfaces:**
- Consumes: the built `packages/api` server (Task 21) and `packages/web` static assets, run against `docker-compose.test.yml` (Task 10); `hashPassword` (Task 14) to compute a known password hash at config-load time.
- Produces: `npm run test:e2e --workspace packages/web` — the one full-stack check in this plan that exercises login through evidence-chart rendering in a real browser. This is the last task before Phase 6 (integration/deployment wiring).

This test requires, before running: `docker compose -f docker-compose.test.yml up -d`, `DATABASE_URL=postgresql://postgres:postgres@localhost:5433/dashboard_test node scripts/migrate.mjs`, `npm run build --workspace packages/rules --workspace packages/db-features --workspace packages/api --workspace packages/web`, then `node scripts/seed-e2e.mjs`.

- [ ] **Step 1: Write the seed script**

`scripts/seed-e2e.mjs`:
```js
import { CreateBucketCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import pg from 'pg';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5433/dashboard_test';
const S3_ENDPOINT = process.env.S3_ENDPOINT ?? 'http://localhost:9100';
const BUCKET = process.env.S3_BUCKET ?? 'dashboard-e2e-bucket';

async function main() {
  const pool = new pg.Pool({ connectionString: DATABASE_URL });
  await pool.query(
    'truncate dashboard_observations, dashboard_analysis, "rtcstats-server", features_metadata, features_client, features_connection, features_track restart identity cascade'
  );

  const dump = await pool.query(
    `insert into "rtcstats-server" (rtcstats_user, session_start, session_end, blob_url, features_processing_stop)
     values ('e2e-user', now() - interval '10 minutes', now(), $1, now()) returning id`,
    [`s3://${BUCKET}/dumps/e2e.json`]
  );
  const dumpId = dump.rows[0].id;

  const metadata = await pool.query(
    `insert into features_metadata (dump_id, number_peerconnections) values ($1, 1) returning id`,
    [dumpId]
  );
  await pool.query(`insert into features_client (dump_id, hardware_concurrency, cpu_performance) values ($1, 8, 5)`, [metadata.rows[0].id]);
  const connection = await pool.query(
    `insert into features_connection (dump_id, connection_identifier, connected, ice_connection_time) values ($1, 'PC_0', true, 9000) returning id`,
    [metadata.rows[0].id]
  );
  await pool.query(
    `insert into features_track (connection_id, kind, direction, freeze_count, total_freezes_duration) values ($1, 'video', 'recvonly', 10, 20000)`,
    [connection.rows[0].id]
  );

  const analysis = await pool.query(
    `insert into dashboard_analysis
       (dump_id, rules_version, status, session_start, duration, rtcstats_user,
        experience_score, video_score, connectivity_score, worst_severity, observation_types, observations_count)
     values ($1, '1.0.0', 'ok', now(), 300, 'e2e-user', 55, 60, 85, 'critical',
             '{video.freezes,connectivity.slow_ice_connect}', '{"critical":1,"warning":1}')
     returning id`,
    [dumpId]
  );
  await pool.query(
    `insert into dashboard_observations (analysis_id, pid, type, severity, category, first_seen_at, observation)
     values ($1, 'PC_0', 'video.freezes', 'critical', 'video', 12, '{"count":10,"totalFreezesDuration":20000}')`,
    [analysis.rows[0].id]
  );

  const s3 = new S3Client({
    endpoint: S3_ENDPOINT, region: 'us-east-1', forcePathStyle: true,
    credentials: { accessKeyId: 'minioadmin', secretAccessKey: 'minioadmin' }
  });
  try {
    await s3.send(new CreateBucketCommand({ Bucket: BUCKET }));
  } catch (err) {
    if (err.name !== 'BucketAlreadyOwnedByYou' && err.name !== 'BucketAlreadyExists') throw err;
  }
  const dumpLines = [
    'RTCStatsDump',
    JSON.stringify({ userAgent: 'Chrome/120.0', origin: 'https://example.com', url: 'room1' }),
    JSON.stringify(['create', 'PC_0', { type: 'create' }, 0]),
    JSON.stringify(['getStats', 'PC_0', { RTCInboundVideo1: { type: 'inbound-rtp', timestamp: 1000, framesReceived: 10 } }, 50])
  ];
  await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: 'dumps/e2e.json', Body: dumpLines.join('\n') + '\n' }));

  console.log(`seeded dump ${dumpId}`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 2: Add Playwright to the web package**

Modify `packages/web/package.json` — add `"@playwright/test": "^1.48.0"` to `devDependencies` and `"test:e2e": "playwright test"` to `scripts`.

Run: `npm install` then `npx playwright install --with-deps chromium` (installs the browser binary Playwright drives; a one-time setup step for this machine, not part of the app's dependency tree).

- [ ] **Step 3: Write `playwright.config.ts`**

`packages/web/playwright.config.ts`:
```ts
import { defineConfig } from '@playwright/test';
import { hashPassword } from '../api/dist/auth.js';

export default defineConfig({
  testDir: './e2e',
  webServer: {
    command: 'node ../api/dist/server.js',
    port: 8080,
    reuseExistingServer: !process.env.CI,
    env: {
      DATABASE_URL: 'postgresql://postgres:postgres@localhost:5433/dashboard_test',
      S3_ENDPOINT: 'http://localhost:9100',
      S3_ACCESS_KEY: 'minioadmin',
      S3_SECRET_KEY: 'minioadmin',
      S3_BUCKET: 'dashboard-e2e-bucket',
      DASHBOARD_PASSWORD_HASH: hashPassword('e2e-password'),
      SESSION_SECRET: 'e2e-secret',
      PORT: '8080'
    }
  },
  use: { baseURL: 'http://localhost:8080' }
});
```

Note: `packages/api/dist/auth.js` must exist before this config loads (`npm run build --workspace packages/api`, done in Step 2's build prerequisite) — `hashPassword` runs once at config-evaluation time so every test run gets a freshly-salted hash for the same known password, which is fine since nothing persists it between runs.

- [ ] **Step 4: Write the smoke test**

`packages/web/e2e/smoke.spec.ts`:
```ts
import { expect, test } from '@playwright/test';

test('login, filter, open a session, read the verdict, and zoom evidence', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Password').fill('e2e-password');
  await page.getByRole('button', { name: 'Log in' }).click();

  await expect(page.getByRole('link', { name: 'e2e-user' })).toBeVisible();

  await page.getByLabel('User').fill('e2e-user');
  await expect(page.getByRole('link', { name: 'e2e-user' })).toBeVisible();

  await page.getByRole('link', { name: 'e2e-user' }).click();
  await expect(page.getByRole('heading', { name: 'e2e-user' })).toBeVisible();
  await expect(page.getByText(/Video froze 10 times/)).toBeVisible();

  await page.getByRole('button', { name: 'Load evidence charts' }).click();
  await expect(page.getByTestId('evidence-charts')).toBeVisible();

  await page.getByRole('button', { name: 'Show evidence' }).first().click();
});
```

- [ ] **Step 5: Run the smoke test**

Run, in order:
```bash
docker compose -f docker-compose.test.yml up -d
DATABASE_URL=postgresql://postgres:postgres@localhost:5433/dashboard_test node scripts/migrate.mjs
npm run build --workspace packages/rules --workspace packages/db-features --workspace packages/api --workspace packages/web
node scripts/seed-e2e.mjs
npm run test:e2e --workspace packages/web
```
Expected: PASS (1 test)

- [ ] **Step 6: Commit**

```bash
git add scripts/seed-e2e.mjs packages/web/playwright.config.ts packages/web/e2e packages/web/package.json package-lock.json
git commit -m "test(e2e): add Playwright smoke test covering login through evidence charts"
```

This completes Phase 5.

---

## Phase 6 — Integration and deployment wiring

### Task 28: Wire into the real deployment, operational scripts, and README

**Files:**
- Create: `scripts/setup-db.mjs`
- Create: `scripts/hash-password.mjs`
- Create: `README.md`
- Reference (not modified by this repo): `rtcstats_docker_deployment/docker-compose.yml`, `rtcstats_docker_deployment/.env`

**Interfaces:**
- Consumes: `runMigrations` (Task 10, via `scripts/migrate.mjs`), `scripts/create-roles.mjs` (Task 10), `hashPassword` (Task 14, via the built `packages/api/dist/auth.js`).
- Produces: `scripts/setup-db.mjs` (runs migration then role creation in one step — the single command a deploy needs), `scripts/hash-password.mjs <password>` (prints a `DASHBOARD_PASSWORD_HASH` value an operator can paste into `.env` without writing any code); the README documenting exactly what to add to the sibling `rtcstats_docker_deployment` repo. This is the final task in the plan.

This task's compose snippet was written against the real values read from `rtcstats_docker_deployment/docker-compose.yml` and `config/config.yaml` during planning: the Postgres and MinIO services are named `postgres` and `minio` in that compose file's default network, the dump bucket is `rdvtest` (not a placeholder name), and `.env.example` already defines `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`, `MINIO_ROOT_USER`, `MINIO_ROOT_PASSWORD`. The two repos are checked out as sibling directories in this environment (`.../WebRTC/rtcstats_dashboard` and `.../WebRTC/rtcstats_docker_deployment`), which is what the snippet's build `context: ../rtcstats_dashboard` assumes.

- [ ] **Step 1: Write the combined DB setup script**

`scripts/setup-db.mjs`:
```js
import { execFileSync } from 'node:child_process';

execFileSync('node', ['scripts/migrate.mjs'], { stdio: 'inherit', env: process.env });
execFileSync('node', ['scripts/create-roles.mjs'], { stdio: 'inherit', env: process.env });
```

This exists because a deploy needs both steps every time (applying new dashboard migrations and re-asserting grants, since Task 10's `create-roles.mjs` is safe to re-run whenever the privilege set changes) and they must always run in this order — one command instead of two reduces the chance of a deploy running only one of them.

- [ ] **Step 2: Write the password-hash helper**

`scripts/hash-password.mjs`:
```js
import { hashPassword } from '../packages/api/dist/auth.js';

const password = process.argv[2];
if (!password) {
  console.error('usage: node scripts/hash-password.mjs <password>');
  process.exit(1);
}
console.log(hashPassword(password));
```

Run (after `npm run build --workspace packages/api`): `node scripts/hash-password.mjs some-password` — confirm it prints a `salt:hash` string, and that running it twice with the same password prints two different strings (random salt per Task 14's `hashPassword`).

- [ ] **Step 3: Write the README**

`README.md`:
```markdown
# rtcstats-dashboard

Self-hosted post-mortem analysis dashboard for a standalone rtcstats deployment
(`rtcstats_docker_deployment`). An analyzer worker scores every dump against a
deterministic rules engine; a read-only API and a React frontend let you browse
sessions worst-first and see why a call went wrong.

See `docs/superpowers/specs/2026-08-26-rtcstats-dashboard-design.md` for the design.

## Local development

```bash
npm install
docker compose -f docker-compose.test.yml up -d
DATABASE_URL=postgresql://postgres:postgres@localhost:5433/dashboard_test node scripts/setup-db.mjs
npm run build --workspace packages/rules --workspace packages/db-features --workspace packages/api --workspace packages/web
node scripts/hash-password.mjs dev-password   # paste the output below
DATABASE_URL=postgresql://postgres:postgres@localhost:5433/dashboard_test \
S3_ENDPOINT=http://localhost:9100 S3_ACCESS_KEY=minioadmin S3_SECRET_KEY=minioadmin S3_BUCKET=dashboard-test-bucket \
DASHBOARD_PASSWORD_HASH=<paste> SESSION_SECRET=dev-secret \
node packages/api/dist/server.js
```

Run tests: `npm test` (unit + integration, requires `docker-compose.test.yml` up) or per-package with `npx vitest run packages/<name>`. Run the smoke test with `npm run test:e2e --workspace packages/web` (see Task 27's prerequisites).

## Deploying alongside `rtcstats_docker_deployment`

This repo is checked out as a sibling of `rtcstats_docker_deployment`. Add these
services to that repo's `docker-compose.yml` (matching the pattern its existing
`metabase`/`metabase-init` services already use):

```yaml
  dashboard-migrate:
    build:
      context: ../rtcstats_dashboard
      dockerfile: packages/analyzer/Dockerfile
    entrypoint: ["node", "scripts/setup-db.mjs"]
    env_file:
      - .env
    environment:
      DATABASE_URL: postgresql://${POSTGRES_USER:-postgres}:${POSTGRES_PASSWORD:-rtcstatspass}@postgres:5432/${POSTGRES_DB:-rtcstats}
      DASHBOARD_READER_PASSWORD: ${DASHBOARD_READER_PASSWORD}
      DASHBOARD_WRITER_PASSWORD: ${DASHBOARD_WRITER_PASSWORD}
    depends_on:
      postgres:
        condition: service_healthy
    restart: on-failure

  dashboard-analyzer:
    build:
      context: ../rtcstats_dashboard
      dockerfile: packages/analyzer/Dockerfile
    container_name: rtcstats-dashboard-analyzer
    restart: unless-stopped
    environment:
      DATABASE_URL: postgresql://dashboard_writer:${DASHBOARD_WRITER_PASSWORD}@postgres:5432/${POSTGRES_DB:-rtcstats}
      ANALYZER_POLL_INTERVAL_MS: 10000
      ANALYZER_BATCH_SIZE: 100
    depends_on:
      postgres:
        condition: service_healthy
      dashboard-migrate:
        condition: service_completed_successfully

  dashboard-api:
    build:
      context: ../rtcstats_dashboard
      dockerfile: packages/api/Dockerfile
    container_name: rtcstats-dashboard-api
    restart: unless-stopped
    environment:
      DATABASE_URL: postgresql://dashboard_reader:${DASHBOARD_READER_PASSWORD}@postgres:5432/${POSTGRES_DB:-rtcstats}
      S3_ENDPOINT: http://minio:9000
      S3_ACCESS_KEY: ${MINIO_ROOT_USER:-minioadmin}
      S3_SECRET_KEY: ${MINIO_ROOT_PASSWORD:-minioadmin}
      S3_BUCKET: rdvtest
      DASHBOARD_PASSWORD_HASH: ${DASHBOARD_PASSWORD_HASH}
      SESSION_SECRET: ${SESSION_SECRET}
      PORT: 8080
    ports:
      - "${DASHBOARD_PORT:-8090}:8080"
    depends_on:
      postgres:
        condition: service_healthy
      minio:
        condition: service_healthy
      dashboard-migrate:
        condition: service_completed_successfully
```

And add to that repo's `.env` (generate `DASHBOARD_PASSWORD_HASH` with this repo's
`node scripts/hash-password.mjs <password>` after `npm run build --workspace packages/api`;
generate `SESSION_SECRET`, `DASHBOARD_READER_PASSWORD`, `DASHBOARD_WRITER_PASSWORD` with
e.g. `openssl rand -hex 32`):

```
DASHBOARD_PASSWORD_HASH=...
SESSION_SECRET=...
DASHBOARD_READER_PASSWORD=...
DASHBOARD_WRITER_PASSWORD=...
DASHBOARD_PORT=8090
```

Then, from `rtcstats_docker_deployment`:

```bash
docker compose build dashboard-migrate dashboard-analyzer dashboard-api
docker compose up -d dashboard-migrate
docker compose up -d dashboard-analyzer dashboard-api
```

## Verifying a deployment

```bash
curl -f http://localhost:8090/api/health
```
Expect `{"status":"ok"}`. Then open `http://localhost:8090` in a browser, log in
with the password used for `DASHBOARD_PASSWORD_HASH`, and confirm the session
browser loads (it will be empty until `dashboard-analyzer` has processed at
least one dump — check `docker compose logs dashboard-analyzer` for
`poll_complete` lines with `processed > 0`).
```

- [ ] **Step 4: Manually verify against the real stack (not the test stack)**

This step has no automated assertion — it is the final human checkpoint before calling the feature done. If a real `rtcstats_docker_deployment` instance is available with at least one dump already collected:
1. Apply Step 3's compose changes and bring up the three new services.
2. Run the `curl` health check from Step 3.
3. Log in, confirm the session list shows real sessions once `dashboard-analyzer` has caught up (`docker compose logs -f dashboard-analyzer`), open one, and confirm the verdict and evidence charts render against a real dump.

- [ ] **Step 5: Commit**

```bash
git add scripts/setup-db.mjs scripts/hash-password.mjs README.md
git commit -m "docs: add deployment wiring, operational scripts, and README"
```

This completes the plan. All six phases are implemented and independently tested: `packages/rules` (pure diagnostics), `packages/db-features` (shared loader), `packages/analyzer` (worker), `packages/api` (read-only service), `packages/web` (frontend), and the operational scripts tying them into the existing `rtcstats_docker_deployment` stack.
