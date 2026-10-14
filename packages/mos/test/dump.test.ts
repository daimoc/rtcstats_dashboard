import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readDumpMos } from '../src/dump.js';

const fixture = (name: string) =>
  new Uint8Array(readFileSync(fileURLToPath(new URL(`../../../test/fixtures/${name}`, import.meta.url))));

describe('readDumpMos', () => {
  it('scores the 30-minute fixture call', async () => {
    const { connections, summary } = await readDumpMos(fixture('sample_30min.gz'));

    expect(Object.keys(connections)).toEqual(expect.arrayContaining(['PC_0', 'PC_1']));
    expect(connections.PC_1.audio.length).toBeGreaterThan(1000);
    expect(connections.PC_1.video.length).toBeGreaterThan(1000);

    for (const stats of [summary.audio, summary.video]) {
      expect(stats).not.toBeNull();
      expect(stats!.mean).toBeGreaterThan(3.5);
      expect(stats!.mean).toBeLessThanOrEqual(5);
      expect(stats!.min).toBeLessThanOrEqual(stats!.mean);
      expect(stats!.seconds).toBeGreaterThan(1500);
    }
  });

  it('rejects data that is not an rtcstats dump', async () => {
    await expect(readDumpMos(new TextEncoder().encode('{"not":"a dump"}'))).rejects.toThrow();
  });
});
