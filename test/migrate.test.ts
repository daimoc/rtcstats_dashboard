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
