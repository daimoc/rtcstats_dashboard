/**
 * Shape of a dump decoded by `@rtcstats/rtcstats-shared`.
 *
 * The on-disk format (`clientProtocol: rtcstats#5.0`, `fileFormat: 3`) stores numeric
 * method opcodes, delta-encoded timestamps and delta-compressed `getStats` reports.
 * `readRTCStatsDump` undoes all of that, so everything below is already decoded:
 * `type` is a real method name and `timestamp` an absolute epoch-ms value.
 */

export interface TraceEvent {
  /** Absolute epoch milliseconds, reconstructed from the cumulative deltas in the dump. */
  timestamp: number;
  /** Decoded method name, e.g. `oniceconnectionstatechange`, `ontrack`, `getStats`. */
  type: string;
  value: unknown;
  /** Trailing arguments; varies per method (element id, request id, track id, ...). */
  extra: unknown[];
}

export interface DecodedDump {
  url?: string;
  origin?: string;
  userAgent?: string;
  startTime?: number;
  clientProtocol?: string;
  fileFormat?: number;
  /**
   * Traces keyed by the dump's own connection id (`PC_0`, `PC_1`, ...). The key `null`
   * collects page-level events that belong to no peer connection, such as
   * `getUserMedia` and the signaling websocket.
   */
  peerConnections: Record<string, TraceEvent[]>;
}

/** The dump's key for page-level events that belong to no peer connection. */
export const PAGE_LEVEL_PC_ID = 'null';
