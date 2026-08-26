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
