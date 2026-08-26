import { apiRules } from './rules/api.js';
import { audioRules } from './rules/audio.js';
import { connectivityRules } from './rules/connectivity.js';
import { deviceRules } from './rules/device.js';
import { videoRules } from './rules/video.js';
import type { Rule } from './types.js';

export function buildRegistry(): Rule[] {
  return [...connectivityRules, ...videoRules, ...audioRules, ...deviceRules, ...apiRules];
}

export function getRuleIds(registry: Rule[]): string[] {
  return registry.map((rule) => rule.id);
}
