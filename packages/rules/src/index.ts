export const RULES_VERSION = '1.0.0';

export * from './types.js';
export { analyze } from './analyze.js';
export { buildRegistry, getRuleIds } from './registry.js';
export { defaultThresholds } from './thresholds.js';
export { score } from './scoring.js';
