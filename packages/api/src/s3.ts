import { GetObjectCommand, HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { Readable } from 'node:stream';

export interface S3Config {
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  forcePathStyle?: boolean;
}

export function createS3Client(config: S3Config): S3Client {
  return new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    forcePathStyle: config.forcePathStyle ?? true
  });
}

export interface DumpHead {
  exists: boolean;
  sizeBytes: number | null;
}

function isNotFound(err: unknown): boolean {
  return err instanceof Error && (err.name === 'NotFound' || err.name === 'NoSuchKey');
}

export async function headDump(client: S3Client, bucket: string, key: string): Promise<DumpHead> {
  try {
    const result = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return { exists: true, sizeBytes: result.ContentLength ?? null };
  } catch (err) {
    if (isNotFound(err)) return { exists: false, sizeBytes: null };
    throw err;
  }
}

export async function getDumpStream(
  client: S3Client,
  bucket: string,
  key: string
): Promise<{ body: Readable; contentLength: number | null }> {
  const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  return { body: result.Body as Readable, contentLength: result.ContentLength ?? null };
}

export function extractObjectKey(blobUrl: string, bucket: string): string {
  const s3Prefix = `s3://${bucket}/`;
  if (blobUrl.startsWith(s3Prefix)) return blobUrl.slice(s3Prefix.length);

  try {
    const url = new URL(blobUrl);
    const pathname = url.pathname.replace(/^\//, '');
    return pathname.startsWith(`${bucket}/`) ? pathname.slice(bucket.length + 1) : pathname;
  } catch {
    return blobUrl;
  }
}
