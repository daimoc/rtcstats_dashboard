import type { FeatureConnection, Observation, Rule, Severity } from '../types.js';

function makeObservation(
  type: string,
  severity: Severity,
  pid: string | null,
  data: Record<string, unknown>
): Observation {
  return { type, severity, category: 'api', pid, firstSeenAt: null, observation: data };
}

function failureRule(id: string, field: keyof FeatureConnection, severity: Severity): Rule {
  return {
    id,
    category: 'api',
    scope: 'connection',
    evaluate: (ctx) => ctx.connections
      .filter((c) => c[field])
      .map((c) => makeObservation(id, severity, c.connectionIdentifier, { error: c[field] }))
  };
}

const addIceCandidateFailure = failureRule('api.add_ice_candidate_failure', 'addIceCandidateFailure', 'warning');
const setLocalDescriptionFailure = failureRule('api.set_local_description_failure', 'setLocalDescriptionFailure', 'critical');
const setRemoteDescriptionFailure = failureRule('api.set_remote_description_failure', 'setRemoteDescriptionFailure', 'critical');

export const apiRules: Rule[] = [addIceCandidateFailure, setLocalDescriptionFailure, setRemoteDescriptionFailure];
