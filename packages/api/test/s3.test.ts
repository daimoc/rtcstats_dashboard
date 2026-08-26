import { CreateBucketCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createS3Client, extractObjectKey, getDumpStream, headDump } from '../src/s3.js';

const TEST_S3_CONFIG = {
  endpoint: 'http://localhost:9100',
  region: 'us-east-1',
  accessKeyId: 'minioadmin',
  secretAccessKey: 'minioadmin',
  bucket: 'dashboard-test-bucket',
  forcePathStyle: true
};

describe('extractObjectKey', () => {
  it('strips an s3:// prefix for the given bucket', () => {
    expect(extractObjectKey('s3://dashboard-test-bucket/dumps/abc.json.gz', 'dashboard-test-bucket')).toBe('dumps/abc.json.gz');
  });

  it('strips the bucket segment from an https:// URL path', () => {
    expect(extractObjectKey('https://minio.internal/dashboard-test-bucket/dumps/abc.json.gz', 'dashboard-test-bucket')).toBe('dumps/abc.json.gz');
  });

  it('treats a value with no scheme as an already-bare key', () => {
    expect(extractObjectKey('dumps/abc.json.gz', 'dashboard-test-bucket')).toBe('dumps/abc.json.gz');
  });
});

describe('headDump / getDumpStream', () => {
  let client: S3Client;

  beforeAll(async () => {
    client = createS3Client(TEST_S3_CONFIG);
    try {
      await client.send(new CreateBucketCommand({ Bucket: TEST_S3_CONFIG.bucket }));
    } catch (err) {
      const name = err instanceof Error ? err.name : '';
      if (name !== 'BucketAlreadyOwnedByYou' && name !== 'BucketAlreadyExists') throw err;
    }
    await client.send(new PutObjectCommand({ Bucket: TEST_S3_CONFIG.bucket, Key: 'dumps/present.json.gz', Body: Buffer.from('hello') }));
  });

  afterAll(() => {
    client.destroy();
  });

  it('reports exists:true with the correct size for a present object', async () => {
    const head = await headDump(client, TEST_S3_CONFIG.bucket, 'dumps/present.json.gz');
    expect(head).toEqual({ exists: true, sizeBytes: 5 });
  });

  it('reports exists:false for a missing object', async () => {
    const head = await headDump(client, TEST_S3_CONFIG.bucket, 'dumps/missing.json.gz');
    expect(head).toEqual({ exists: false, sizeBytes: null });
  });

  it('streams the object body back', async () => {
    const { contentLength, body } = await getDumpStream(client, TEST_S3_CONFIG.bucket, 'dumps/present.json.gz');
    expect(contentLength).toBe(5);
    const chunks: Buffer[] = [];
    for await (const chunk of body as AsyncIterable<Buffer>) chunks.push(chunk);
    expect(Buffer.concat(chunks).toString('utf8')).toBe('hello');
  });
});
