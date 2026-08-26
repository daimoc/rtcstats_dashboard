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
