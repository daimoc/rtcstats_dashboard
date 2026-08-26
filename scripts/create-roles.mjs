import pg from 'pg';

const BASE_TABLES = ['"rtcstats-server"', 'features_metadata', 'features_client', 'features_connection', 'features_track'];
const DASHBOARD_TABLES = ['dashboard_analysis', 'dashboard_observations'];

async function ensureRole(client, roleName, password) {
  const { rows } = await client.query('select 1 from pg_roles where rolname = $1', [roleName]);
  if (rows.length === 0) {
    await client.query(`create role "${roleName}" with login password '${password}'`);
    console.log(`created role ${roleName}`);
  } else {
    await client.query(`alter role "${roleName}" with password '${password}'`);
  }
}

async function main() {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await ensureRole(client, 'dashboard_reader', process.env.DASHBOARD_READER_PASSWORD);
    await ensureRole(client, 'dashboard_writer', process.env.DASHBOARD_WRITER_PASSWORD);

    for (const table of [...BASE_TABLES, ...DASHBOARD_TABLES]) {
      await client.query(`grant select on ${table} to dashboard_reader`);
    }
    for (const table of BASE_TABLES) {
      await client.query(`grant select on ${table} to dashboard_writer`);
    }
    for (const table of DASHBOARD_TABLES) {
      await client.query(`grant select, insert, update, delete on ${table} to dashboard_writer`);
    }
    for (const table of DASHBOARD_TABLES) {
      await client.query(`grant usage, select on all sequences in schema public to dashboard_writer`);
    }
    console.log('roles and grants applied');
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
