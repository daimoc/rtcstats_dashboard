import { describe, it, expect } from 'vitest';
import { buildRegistry, getRuleIds } from '../src/registry.js';

describe('buildRegistry', () => {
  it('includes at least one rule from every category', () => {
    const registry = buildRegistry();
    const categories = new Set(registry.map((r) => r.category));
    expect(categories).toEqual(new Set(['connectivity', 'video', 'audio', 'device', 'api']));
  });

  it('has no duplicate rule ids', () => {
    const ids = getRuleIds(buildRegistry());
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('contains exactly 32 rules', () => {
    expect(buildRegistry()).toHaveLength(32);
  });
});
