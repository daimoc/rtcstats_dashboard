import type { Rule } from './types.js';

export function buildRegistry(): Rule[] {
  return [];
}

export function getRuleIds(registry: Rule[]): string[] {
  return registry.map((rule) => rule.id);
}
