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
