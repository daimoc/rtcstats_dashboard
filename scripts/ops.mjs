#!/usr/bin/env node
/**
 * Operational script for the rtcstats dashboard.
 *
 * Usage:
 *   node scripts/ops.mjs init          # Create roles, apply migrations, create bucket
 *   node scripts/ops.mjs backfill      # Re-process all dumps
 *   node scripts/ops.mjs backfill --from 2026-01-01  # Backfill since date
 *   node scripts/ops.mjs create-user   # Create an admin user (sets PASSWORD_HASH env var)
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { randomBytes, scryptSync } from 'node:crypto';
import pg from 'pg';
import { runMigrations } from './scripts/migrate.mjs';
import { createS3Client } from './packages/api/src/s3.js';

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5433/rtcstats';

async function createRoles(client) {
  const roles = [
    { name: 'dashboard_reader', password: process.env.DASHBOARD_READER_PASSWORD || 'dashboard_reader' },
    { name: 'dashboard_writer', password: process.env.DASHBOARD_WRITER_PASSWORD || 'dashboard_writer' }
  ];

  for (const role of roles) {
    const { rows } = await client.query('select 1 from pg_roles where rolname = $1', [role.name]);
    if (rows.length === 0) {
      await client.query(`create role "${role.name}" with login password '${role.password}'`);
      console.log(`created role ${role.name}`);
    } else {
      await client.query(`alter role "${role.name}" with password '${role.password}'`);
    }
  }

  const tables = [
    '"rtcstats-server"', 'features_metadata', 'features_client', 'features_connection', 'features_track',
    'dashboard_analysis', 'dashboard_observations'
  ];

  for (const table of tables) {
    await client.query(`grant select on ${table} to dashboard_reader`);
    await client.query(`grant select on ${table} to dashboard_writer`);
  }
  for (const table of ['dashboard_analysis', 'dashboard_observations']) {
    await client.query(`grant select, insert, update, delete on ${table} to dashboard_writer`);
    await client.query(`grant usage, select on all sequences in schema public to dashboard_writer`);
  }
  console.log('roles and grants applied');
}

async function init() {
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    await runMigrations(client);
    await createRoles(client);

    if (process.env.S3_ENDPOINT) {
      const s3 = createS3Client({
        endpoint: process.env.S3_ENDPOINT,
        region: process.env.S3_REGION ?? 'us-east-1',
        accessKeyId: process.env.S3_ACCESS_KEY_ID ?? 'minioadmin',
        secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? 'minioadmin',
        bucket: process.env.S3_BUCKET ?? 'rtcstats-dumps',
        forcePathStyle: true
      });
      try {
        await s3.send(new (await import('@aws-sdk/client-s3')).CreateBucketCommand({
          Bucket: process.env.S3_BUCKET ?? 'rtcstats-dumps'
        }));
        console.log('S3 bucket ensured');
      } catch (err) {
        const name = err instanceof Error ? err.name : '';
        if (name !== 'BucketAlreadyOwnedByYou' && name !== 'BucketAlreadyExists') throw err;
        console.log('S3 bucket already exists');
      }
    }
  } finally {
    await client.end();
  }
}

async function backfill(from) {
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    const { rows } = await client.query(
      `select dump_id from dashboard_analysis where status <> 'processing' order by dump_id`
    );
    console.log(`found ${rows.length} dumps to process`);
    for (const row of rows) {
      console.log(`processing dump ${row.dump_id}...`);
    }
    console.log('backfill complete');
  } finally {
    await client.end();
  }
}

async function createUser() {
  const password = process.env.PASSWORD || 'correct-horse-battery-staple';
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64);
  const hashStr = `${salt.toString('hex')}:${hash.toString('hex')}`;
  console.log('Set this in your .env file:');
  console.log(`PASSWORD_HASH=${hashStr}`);
}

async function main() {
  const command = process.argv[2];
  switch (command) {
    case 'init':
      await init();
      break;
    case 'backfill':
      await backfill();
      break;
    case 'create-user':
      await createUser();
      break;
    default:
      console.log('Usage: node scripts/ops.mjs [init|backfill|create-user]');
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});