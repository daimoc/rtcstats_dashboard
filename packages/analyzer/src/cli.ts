import pgModule from 'pg';
import { RULES_VERSION } from '@rtcstats-dashboard/rules';
import { claimByDumpId, claimSince, claimStaleDumps } from './claim.js';
import type { DumpFetcher } from './dumpMos.js';
import { dumpFetcherFromEnv, processDump } from './run.js';
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

export async function runBackfill(
  pool: pg.Pool,
  options: CliOptions,
  fetchDump?: DumpFetcher
): Promise<{ processed: number; failed: number }> {
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
    const outcome = await processDump(pool, dumpId, options.rulesVersion, fetchDump);
    if (outcome === 'ok') processed += 1;
    else failed += 1;
  }
  return { processed, failed };
}

async function main() {
  const options = parseArgs(process.argv.slice(2), RULES_VERSION);
  const pool = new pgModule.Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const result = await runBackfill(pool, options, dumpFetcherFromEnv(pool));
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
