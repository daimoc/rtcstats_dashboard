import { readRTCStatsDump } from '@rtcstats/rtcstats-shared';
import { buildConnectionSeries, type ConnectionSeries } from '../lib/dumpSeries.js';
import { buildTimeline, type TimelineEvent } from '../lib/dumpTimeline.js';
import type { DecodedDump } from '../lib/dumpTypes.js';

const MAX_COMPRESSED_SIZE = 25 * 1024 * 1024; // 25 MB

export interface ParsedDump {
  timeline: TimelineEvent[];
  /** Chart data per dump-side connection id (`PC_0`, ...); only chartable ones appear. */
  connections: Record<string, ConnectionSeries>;
  /** Chartable connection ids in dump order, for the peer-connection selector. */
  connectionIds: string[];
}

export interface ParseDumpRequest {
  data: Blob;
}

export type ParseDumpMessage =
  | { type: 'tooLarge'; size: number }
  | { type: 'parsed'; result: ParsedDump }
  | { type: 'error'; error: string };

async function gunzip(blob: Blob): Promise<Blob> {
  const stream = blob.stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).blob();
}

/**
 * Decode the dump and derive everything the UI needs, here in the worker.
 *
 * The decoded dump holds every `getStats` report in full — far larger than the 4 MB of
 * JSON it came from — so deriving first and posting only the timeline and the chart
 * series keeps a multi-megabyte structured clone off the main thread.
 */
async function parse(compressed: Blob): Promise<ParsedDump> {
  const dump = (await readRTCStatsDump(await gunzip(compressed))) as unknown as DecodedDump;

  const connections: Record<string, ConnectionSeries> = {};
  const connectionIds: string[] = [];
  for (const [pcId, trace] of Object.entries(dump?.peerConnections ?? {})) {
    const series = buildConnectionSeries(trace);
    if (!series) continue;
    connections[pcId] = series;
    connectionIds.push(pcId);
  }

  return { timeline: buildTimeline(dump), connections, connectionIds };
}

function post(message: ParseDumpMessage): void {
  self.postMessage(message);
}

self.addEventListener('message', async (event: MessageEvent<ParseDumpRequest>) => {
  const blob = event.data.data;

  // Guard on the compressed size: decompressing first is what would blow up memory.
  if (blob.size > MAX_COMPRESSED_SIZE) {
    post({ type: 'tooLarge', size: blob.size });
    return;
  }

  try {
    post({ type: 'parsed', result: await parse(blob) });
  } catch (err) {
    // A truncated or malformed dump must not take the session page down with it.
    post({ type: 'error', error: err instanceof Error ? err.message : String(err) });
  }
});
