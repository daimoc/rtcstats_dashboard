import pgModule from 'pg';
import { S3Client } from '@aws-sdk/client-s3';
import { analyze, buildRegistry, defaultThresholds, RULES_VERSION } from '@rtcstats-dashboard/rules';
import { claimNewDumps, claimStaleDumps } from './claim.js';
import { computeCallMos, createS3DumpFetcher, type CallMos, type DumpFetcher } from './dumpMos.js';
import { loadFeatures } from './featureLoader.js';
import { writeAnalysisResult, writeFailure } from './write.js';
import type pg from 'pg';

/**
 * MOS comes from the raw dump rather than the features, so it is best effort: a missing,
 * oversized or corrupt dump leaves the MOS columns null but never fails the analysis.
 */
async function tryComputeCallMos(fetchDump: DumpFetcher | undefined, dumpId: number): Promise<CallMos | null> {
  if (!fetchDump) return null;
  try {
    return await computeCallMos(fetchDump, dumpId);
  } catch (err) {
    console.error(JSON.stringify({
      level: 'warn', msg: 'mos_failed', dumpId,
      error: err instanceof Error ? err.message : String(err),
      ts: new Date().toISOString()
    }));
    return null;
  }
}

export async function processDump(
  pool: pg.Pool,
  dumpId: number,
  rulesVersion: string,
  fetchDump?: DumpFetcher
): Promise<'ok' | 'failed'> {
  try {
    const bundle = await loadFeatures(pool, dumpId);
    if (!bundle) {
      await writeFailure(pool, dumpId, rulesVersion, 'features not found for claimed dump');
      return 'failed';
    }
    const result = analyze({ ...bundle, thresholds: defaultThresholds }, buildRegistry());
    const mos = await tryComputeCallMos(fetchDump, dumpId);
    await writeAnalysisResult(pool, dumpId, rulesVersion, result, mos);
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

export async function runOnce(pool: pg.Pool, batchSize: number, fetchDump?: DumpFetcher): Promise<RunOnceResult> {
  const newDumps = await claimNewDumps(pool, RULES_VERSION, batchSize);
  const staleDumps = await claimStaleDumps(pool, RULES_VERSION, batchSize);
  const dumpIds = [...newDumps, ...staleDumps];

  let processed = 0;
  let failed = 0;
  for (const dumpId of dumpIds) {
    const outcome = await processDump(pool, dumpId, RULES_VERSION, fetchDump);
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

export function startPolling(
  pool: pg.Pool,
  pollIntervalMs: number,
  batchSize: number,
  fetchDump?: DumpFetcher
): { stop: () => void } {
  let stopped = false;

  async function loop() {
    while (!stopped) {
      try {
        const result = await runOnce(pool, batchSize, fetchDump);
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

/** Same 25 MB ceiling the browser applies before decoding a dump. */
const DEFAULT_MOS_MAX_DUMP_BYTES = 25 * 1024 * 1024;

/** The dump fetcher configured from the environment, or undefined without S3. */
export function dumpFetcherFromEnv(pool: pg.Pool, env = process.env): DumpFetcher | undefined {
  if (!env.S3_ENDPOINT) return undefined;
  return createS3DumpFetcher(pool, {
    client: new S3Client({
      endpoint: env.S3_ENDPOINT,
      region: env.S3_REGION ?? 'us-east-1',
      credentials: { accessKeyId: env.S3_ACCESS_KEY_ID ?? '', secretAccessKey: env.S3_SECRET_ACCESS_KEY ?? '' },
      forcePathStyle: true
    }),
    bucket: env.S3_BUCKET ?? '',
    maxBytes: Number(env.ANALYZER_MOS_MAX_DUMP_BYTES ?? DEFAULT_MOS_MAX_DUMP_BYTES)
  });
}

async function main() {
  const pool = new pgModule.Pool({ connectionString: process.env.DATABASE_URL });
  const pollIntervalMs = Number(process.env.ANALYZER_POLL_INTERVAL_MS ?? 10000);
  const batchSize = Number(process.env.ANALYZER_BATCH_SIZE ?? 100);
  startPolling(pool, pollIntervalMs, batchSize, dumpFetcherFromEnv(pool));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
