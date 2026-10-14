import { useEffect, useState } from 'react';
import type { ParseDumpMessage, ParseDumpRequest, ParsedDump } from '../workers/parseDump.worker.js';
import { dumpDownloadUrl } from './api.js';
import { formatBytes } from './format.js';

export type DumpState =
  | { status: 'loading' }
  /** The raw dump is no longer in the object store. */
  | { status: 'unavailable' }
  /** The deployment has no object storage wired up, so no dump can be fetched. */
  | { status: 'not-configured' }
  | { status: 'too-large'; size: number }
  | { status: 'error'; error: string }
  | { status: 'ready'; result: ParsedDump };

/**
 * Fetch a session's raw dump and decode it off the main thread.
 *
 * The API serves the dump gzipped as `application/gzip`, which the browser does not
 * unwrap on its own, so the worker gunzips it before decoding. Everything the panels
 * render comes from here: the aggregate `features_*` tree carries no timestamps and no
 * time series, so it cannot drive a timeline or a chart.
 */
export function useDumpData(dumpId: number | null, dumpStatus: 'available' | 'missing'): DumpState {
  const [state, setState] = useState<DumpState>({ status: 'loading' });

  useEffect(() => {
    if (dumpId == null || dumpStatus !== 'available') {
      setState({ status: 'unavailable' });
      return;
    }

    let cancelled = false;
    setState({ status: 'loading' });

    const controller = new AbortController();
    const worker = new Worker(new URL('../workers/parseDump.worker.ts', import.meta.url), {
      type: 'module'
    });

    worker.addEventListener('message', (event: MessageEvent<ParseDumpMessage>) => {
      if (cancelled) return;
      const message = event.data;
      if (message.type === 'parsed') setState({ status: 'ready', result: message.result });
      else if (message.type === 'tooLarge') setState({ status: 'too-large', size: message.size });
      else setState({ status: 'error', error: message.error });
    });

    worker.addEventListener('error', (event) => {
      if (!cancelled) setState({ status: 'error', error: event.message || 'dump worker failed' });
    });

    dumpDownloadUrl(dumpId)
      .then(url => fetch(url, { credentials: 'include', signal: controller.signal }))
      .then(async (res) => {
        if (cancelled) return;
        // 501 means no object storage is configured; 404 means this dump is gone. The
        // two look identical to a viewer but mean very different things to an operator.
        if (res.status === 501) {
          setState({ status: 'not-configured' });
          return;
        }
        if (res.status === 404) {
          setState({ status: 'unavailable' });
          return;
        }
        if (!res.ok) throw new Error(`Could not download the dump (${res.status})`);
        const blob = await res.blob();
        if (cancelled) return;
        worker.postMessage({ data: blob } satisfies ParseDumpRequest);
      })
      .catch((err: unknown) => {
        if (cancelled || (err instanceof DOMException && err.name === 'AbortError')) return;
        setState({ status: 'error', error: err instanceof Error ? err.message : String(err) });
      });

    return () => {
      cancelled = true;
      controller.abort();
      worker.terminate();
    };
  }, [dumpId, dumpStatus]);

  return state;
}

/**
 * The message to show in place of a panel's content, or null once the dump is decoded.
 *
 * Shared by both dump-driven panels so an unavailable dump reads the same way in each,
 * and so an empty panel always says why it is empty.
 */
export function describeDumpState(state: DumpState): string | null {
  switch (state.status) {
    case 'ready':
      return null;
    case 'loading':
      return 'Loading the raw dump…';
    case 'unavailable':
      return 'The raw dump is no longer in storage, so there is nothing to show here.';
    case 'not-configured':
      return 'This deployment has no dump storage configured, so there is nothing to show here.';
    case 'too-large':
      return `This dump is ${formatBytes(state.size)} — too large to parse in the browser. Download it instead.`;
    case 'error':
      return `Could not read the dump: ${state.error}`;
  }
}
