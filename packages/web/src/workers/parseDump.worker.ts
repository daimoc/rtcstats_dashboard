const MAX_COMPRESSED_SIZE = 25 * 1024 * 1024; // 25 MB

interface DecompressionWorkerMessage {
  data: Uint8Array | Blob;
}

interface TooLargeMessage {
  type: 'tooLarge';
  size: number;
}

interface ParseResultMessage {
  type: 'parsed';
  data: unknown;
}

interface ErrorMessage {
  type: 'error';
  error: string;
}

type WorkerMessage = TooLargeMessage | ParseResultMessage | ErrorMessage;

async function decompressAndParse(blob: Blob): Promise<unknown> {
  const stream = blob.stream();
  const gzipStream = stream.pipeThrough(new DecompressionStream('gzip'));
  const reader = gzipStream.getReader();
  const chunks: Uint8Array[] = [];
  let totalLength = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      const chunk = new Uint8Array(value);
      chunks.push(chunk);
      totalLength += chunk.length;
    }
  }

  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }

  const textDecoder = new TextDecoder('utf-8');
  const jsonStr = textDecoder.decode(result);
  return JSON.parse(jsonStr);
}

self.addEventListener('message', async (e: MessageEvent<DecompressionWorkerMessage>) => {
  const { data } = e.data;

  let blob: Blob;
  let size: number;

  if (data instanceof Blob) {
    blob = data;
    size = data.size;
  } else {
    const buffer = data.buffer as ArrayBuffer;
    blob = new Blob([buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)]);
    size = data.byteLength;
  }

  // Check compressed size (from Blob) before decompression
  if (blob.size > MAX_COMPRESSED_SIZE) {
    self.postMessage({ type: 'tooLarge' as const, size: blob.size } as WorkerMessage);
    return;
  }

  try {
    const parsed = await decompressAndParse(blob);
    self.postMessage({ type: 'parsed' as const, data: parsed } as WorkerMessage);
  } catch (err) {
    self.postMessage({ type: 'error' as const, error: err instanceof Error ? err.message : String(err) } as WorkerMessage);
  }
});

export default self;
