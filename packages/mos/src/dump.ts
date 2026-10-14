import { readRTCStatsDump } from '@rtcstats/rtcstats-shared';
import { computeTraceMos, type ConnectionMos, type MosSample } from './extract.js';

export interface MosStats {
  /** Time-weighted mean over every scored interval. */
  mean: number;
  /** Worst scored interval. */
  min: number;
  /** Total seconds that were scored. */
  seconds: number;
}

export interface MosSummary {
  audio: MosStats | null;
  video: MosStats | null;
}

export interface DumpMos {
  /** Keyed by the dump's own connection id (`PC_0`, `PC_1`, ...). */
  connections: Record<string, ConnectionMos>;
  summary: MosSummary;
}

/** The dump's key for page-level events that belong to no peer connection. */
const PAGE_LEVEL_PC_ID = 'null';

export function summarize(samples: MosSample[]): MosStats | null {
  let weighted = 0;
  let seconds = 0;
  let min = Infinity;
  for (const sample of samples) {
    weighted += sample.mos * sample.seconds;
    seconds += sample.seconds;
    min = Math.min(min, sample.mos);
  }
  return seconds > 0 ? { mean: weighted / seconds, min, seconds } : null;
}

/** Score every peer connection of a decoded dump and roll them up into a call summary. */
export function computeDumpMos(peerConnections: Record<string, unknown[]>): DumpMos {
  const connections: Record<string, ConnectionMos> = {};
  for (const [pcId, trace] of Object.entries(peerConnections)) {
    if (pcId === PAGE_LEVEL_PC_ID || !Array.isArray(trace) || trace.length === 0) continue;
    connections[pcId] = computeTraceMos(trace);
  }

  const all = Object.values(connections);
  return {
    connections,
    summary: {
      audio: summarize(all.flatMap((c) => c.audio)),
      video: summarize(all.flatMap((c) => c.video))
    }
  };
}

async function gunzipIfNeeded(blob: Blob): Promise<Blob> {
  const magic = new Uint8Array(await blob.slice(0, 2).arrayBuffer());
  if (magic[0] !== 0x1f || magic[1] !== 0x8b) return blob;
  return new Response(blob.stream().pipeThrough(new DecompressionStream('gzip'))).blob();
}

/** Decode a stored dump (gzipped or not) and score it. Throws on an unreadable dump. */
export async function readDumpMos(data: Blob | Uint8Array<ArrayBuffer>): Promise<DumpMos> {
  const blob = data instanceof Blob ? data : new Blob([data]);
  const dump = (await readRTCStatsDump(await gunzipIfNeeded(blob))) as
    | { peerConnections?: Record<string, unknown[]> }
    | undefined;
  if (!dump) throw new Error('not an rtcstats dump');
  return computeDumpMos(dump.peerConnections ?? {});
}
