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
