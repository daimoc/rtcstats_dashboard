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
