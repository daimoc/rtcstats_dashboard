import pg from 'pg';
import { createPool } from './src/db.js';
import { buildApp } from './src/app.js';
import { createS3Client } from './src/s3.js';

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('DATABASE_URL is required');
    process.exit(1);
  }

  const pool = createPool(databaseUrl);

  const s3 = process.env.S3_ENDPOINT
    ? {
        client: createS3Client({
          endpoint: process.env.S3_ENDPOINT,
          region: process.env.S3_REGION ?? 'us-east-1',
          accessKeyId: process.env.S3_ACCESS_KEY_ID ?? '',
          secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? '',
          bucket: process.env.S3_BUCKET ?? '',
          forcePathStyle: true
        }),
        bucket: process.env.S3_BUCKET ?? ''
      }
    : undefined;

  const app = buildApp({
    pool,
    config: {
      passwordHash: process.env.PASSWORD_HASH ?? '',
      sessionSecret: process.env.SESSION_SECRET ?? 'change-me-in-production'
    },
    s3
  });

  const port = Number(process.env.PORT ?? 3000);
  try {
    await app.listen({ port, host: '0.0.0.0' });
    console.log(JSON.stringify({
      level: 'info',
      msg: 'server_started',
      port,
      ts: new Date().toISOString()
    }));
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
