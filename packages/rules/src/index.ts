// Bumped whenever stored results change shape or meaning, so the analyzer re-scores every
// call. 1.1.0 added the audio/video MOS columns; 1.1.1 stopped never_connected from
// firing on connections closed before any session description was applied.
export const RULES_VERSION = '1.1.1';

export * from './types.js';
export { analyze } from './analyze.js';
export { buildRegistry, getRuleIds } from './registry.js';
export { defaultThresholds } from './thresholds.js';
export { score } from './scoring.js';
