import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');

export async function runMigrations(client) {
  await client.query(`
    create table if not exists dashboard_schema_migrations (
      filename text primary key,
      applied_at timestamptz not null default now()
    )
  `);

  const { rows } = await client.query('select filename from dashboard_schema_migrations');
  const applied = new Set(rows.map((r) => r.filename));

  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    await client.query('begin');
    try {
      await client.query(sql);
      await client.query('insert into dashboard_schema_migrations (filename) values ($1)', [file]);
      await client.query('commit');
      console.log(`applied ${file}`);
    } catch (err) {
      await client.query('rollback');
      throw new Error(`migration ${file} failed: ${err.message}`, { cause: err });
    }
  }
}

async function main() {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await runMigrations(client);
  } finally {
    await client.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
