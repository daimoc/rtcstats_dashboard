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
    const metadata = await pool.query(
      `insert into features_metadata (dump_id, number_peerconnections) values ($1, 1) returning id`,
      [dumpId]
    );
    await pool.query(
      `insert into features_connection (dump_id, connection_identifier, connected, ice_connection_time)
       values ($1, 'PC_0', true, 500)`,
      [metadata.rows[0].id]
    );

    const result = await runBackfill(pool, { from: null, dumpId, rulesVersion: '1.0.0', force: false, batchSize: 100 });
    expect(result.processed).toBe(1);

    const { rows } = await pool.query('select status from dashboard_analysis where dump_id = $1', [dumpId]);
    expect(rows[0].status).toBe('ok');
  });
});
