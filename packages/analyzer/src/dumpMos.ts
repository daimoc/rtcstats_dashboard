import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { readDumpMos } from '@rtcstats-dashboard/mos';
import type pg from 'pg';

/** Per-call MOS as stored on `dashboard_analysis`. */
export interface CallMos {
  audio: number | null;
  video: number | null;
}

/**
 * Fetches a dump's raw bytes, or resolves null when there is nothing to read (no blob
 * url, object gone, or too large to decode). Injected so tests need no object store.
 */
export type DumpFetcher = (dumpId: number) => Promise<Uint8Array<ArrayBuffer> | null>;

export interface S3DumpConfig {
  client: S3Client;
  bucket: string;
  /** Compressed size above which a dump is skipped rather than decoded in memory. */
  maxBytes: number;
}

function isNotFound(err: unknown): boolean {
  return err instanceof Error && (err.name === 'NotFound' || err.name === 'NoSuchKey');
}

/** Same mapping from `blob_url` to object key as the API's dump proxy. */
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

export function createS3DumpFetcher(pool: pg.Pool, config: S3DumpConfig): DumpFetcher {
  return async (dumpId) => {
    const { rows } = await pool.query('select blob_url from "rtcstats-server" where id = $1', [dumpId]);
    const blobUrl = rows[0]?.blob_url as string | undefined;
    if (!blobUrl) return null;

    try {
      const result = await config.client.send(
        new GetObjectCommand({ Bucket: config.bucket, Key: extractObjectKey(blobUrl, config.bucket) })
      );
      if (result.ContentLength != null && result.ContentLength > config.maxBytes) {
        result.Body?.transformToWebStream().cancel();
        return null;
      }
      if (!result.Body) return null;
      return new Uint8Array(await result.Body.transformToByteArray());
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  };
}

/** Score a call from its raw dump; null when the dump could not be fetched. */
export async function computeCallMos(fetchDump: DumpFetcher, dumpId: number): Promise<CallMos | null> {
  const bytes = await fetchDump(dumpId);
  if (!bytes) return null;
  const { summary } = await readDumpMos(bytes);
  return { audio: summary.audio?.mean ?? null, video: summary.video?.mean ?? null };
}
