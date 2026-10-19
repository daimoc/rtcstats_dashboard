import type { FeatureConnection, Observation, Rule, RuleContext, Severity } from '../types.js';

function forEachConnection(
  ctx: RuleContext,
  fn: (c: FeatureConnection) => Observation | null
): Observation[] {
  return ctx.connections.map(fn).filter((o): o is Observation => o !== null);
}

function makeObservation(
  type: string,
  severity: Severity,
  pid: string | null,
  data: Record<string, unknown>
): Observation {
  return { type, severity, category: 'connectivity', pid, firstSeenAt: null, observation: data };
}

const neverConnected: Rule = {
  id: 'connectivity.never_connected',
  category: 'connectivity',
  scope: 'connection',
  evaluate: (ctx) => forEachConnection(ctx, (c) => {
    if (c.connected !== false) return null;
    // Closed before any session description was applied: the application discarded the
    // connection (LiveKit opens one just to probe codec capabilities) rather than it
    // failing to connect. An offer applied but never answered still counts as a failure.
    if (c.setLocalDescriptionRole === null && c.setRemoteDescriptionRole === null) return null;
    return makeObservation('connectivity.never_connected', 'critical', c.connectionIdentifier, {});
  })
};

const slowIceConnect: Rule = {
  id: 'connectivity.slow_ice_connect',
  category: 'connectivity',
  scope: 'connection',
  evaluate: (ctx) => forEachConnection(ctx, (c) => {
    const t = c.iceConnectionTime;
    if (t == null) return null;
    if (t >= ctx.thresholds.iceConnectionTimeCriticalMs) {
      return makeObservation('connectivity.slow_ice_connect', 'critical', c.connectionIdentifier, { iceConnectionTime: t });
    }
    if (t >= ctx.thresholds.iceConnectionTimeWarningMs) {
      return makeObservation('connectivity.slow_ice_connect', 'warning', c.connectionIdentifier, { iceConnectionTime: t });
    }
    return null;
  })
};

const slowTurnGathering: Rule = {
  id: 'connectivity.slow_turn_gathering',
  category: 'connectivity',
  scope: 'connection',
  evaluate: (ctx) => forEachConnection(ctx, (c) => {
    const times = [c.gatheringTimeTurnUdp, c.gatheringTimeTurnTcp, c.gatheringTimeTurnTls]
      .filter((t): t is number => t != null);
    if (times.length === 0) return null;
    const worst = Math.max(...times);
    if (worst >= ctx.thresholds.turnGatheringCriticalMs) {
      return makeObservation('connectivity.slow_turn_gathering', 'critical', c.connectionIdentifier, { worst });
    }
    if (worst >= ctx.thresholds.turnGatheringWarningMs) {
      return makeObservation('connectivity.slow_turn_gathering', 'warning', c.connectionIdentifier, { worst });
    }
    return null;
  })
};

const iceRestart: Rule = {
  id: 'connectivity.ice_restart',
  category: 'connectivity',
  scope: 'connection',
  evaluate: (ctx) => forEachConnection(ctx, (c) => {
    if (!c.iceRestart) return null;
    return makeObservation('connectivity.ice_restart', 'warning', c.connectionIdentifier, {});
  })
};

const iceRestartFollowedBySrd: Rule = {
  id: 'connectivity.ice_restart_followed_by_srd',
  category: 'connectivity',
  scope: 'connection',
  evaluate: (ctx) => forEachConnection(ctx, (c) => {
    if (!c.iceRestartFollowedBySetRemoteDescription) return null;
    return makeObservation('connectivity.ice_restart_followed_by_srd', 'critical', c.connectionIdentifier, {});
  })
};

const nullCandidateAdded: Rule = {
  id: 'connectivity.null_candidate_added',
  category: 'connectivity',
  scope: 'connection',
  evaluate: (ctx) => forEachConnection(ctx, (c) => {
    if (!c.addedNullCandidate) return null;
    return makeObservation('connectivity.null_candidate_added', 'info', c.connectionIdentifier, {});
  })
};

const relayOnlyPath: Rule = {
  id: 'connectivity.relay_only_path',
  category: 'connectivity',
  scope: 'connection',
  evaluate: (ctx) => forEachConnection(ctx, (c) => {
    if (c.firstCandidatePairLocalType !== 'relay') return null;
    return makeObservation('connectivity.relay_only_path', 'warning', c.connectionIdentifier, {
      localType: c.firstCandidatePairLocalType,
      remoteType: c.firstCandidatePairRemoteType
    });
  })
};

const dtlsHandshakeIncomplete: Rule = {
  id: 'connectivity.dtls_handshake_incomplete',
  category: 'connectivity',
  scope: 'connection',
  evaluate: (ctx) => forEachConnection(ctx, (c) => {
    if (c.connected !== true || c.dtlsVersion) return null;
    return makeObservation('connectivity.dtls_handshake_incomplete', 'warning', c.connectionIdentifier, {});
  })
};

const clockSkew: Rule = {
  id: 'connectivity.clock_skew',
  category: 'connectivity',
  scope: 'connection',
  evaluate: (ctx) => forEachConnection(ctx, (c) => {
    if (c.clockSkew == null) return null;
    const magnitude = Math.abs(c.clockSkew);
    if (magnitude >= ctx.thresholds.clockSkewCriticalMs) {
      return makeObservation('connectivity.clock_skew', 'critical', c.connectionIdentifier, { clockSkew: c.clockSkew });
    }
    if (magnitude >= ctx.thresholds.clockSkewWarningMs) {
      return makeObservation('connectivity.clock_skew', 'warning', c.connectionIdentifier, { clockSkew: c.clockSkew });
    }
    return null;
  })
};

const signalingDelay: Rule = {
  id: 'connectivity.signaling_delay',
  category: 'connectivity',
  scope: 'connection',
  evaluate: (ctx) => forEachConnection(ctx, (c) => {
    if (c.signalingDelay == null) return null;
    if (c.signalingDelay >= ctx.thresholds.signalingDelayCriticalMs) {
      return makeObservation('connectivity.signaling_delay', 'critical', c.connectionIdentifier, { signalingDelay: c.signalingDelay });
    }
    if (c.signalingDelay >= ctx.thresholds.signalingDelayWarningMs) {
      return makeObservation('connectivity.signaling_delay', 'warning', c.connectionIdentifier, { signalingDelay: c.signalingDelay });
    }
    return null;
  })
};

const slowSetRemoteDescription: Rule = {
  id: 'connectivity.slow_set_remote_description',
  category: 'connectivity',
  scope: 'connection',
  evaluate: (ctx) => forEachConnection(ctx, (c) => {
    if (c.setRemoteDescriptionDelay == null) return null;
    if (c.setRemoteDescriptionDelay >= ctx.thresholds.setDescriptionDelayCriticalMs) {
      return makeObservation('connectivity.slow_set_remote_description', 'critical', c.connectionIdentifier, { delay: c.setRemoteDescriptionDelay });
    }
    if (c.setRemoteDescriptionDelay >= ctx.thresholds.setDescriptionDelayWarningMs) {
      return makeObservation('connectivity.slow_set_remote_description', 'warning', c.connectionIdentifier, { delay: c.setRemoteDescriptionDelay });
    }
    return null;
  })
};

const slowSetLocalDescription: Rule = {
  id: 'connectivity.slow_set_local_description',
  category: 'connectivity',
  scope: 'connection',
  evaluate: (ctx) => forEachConnection(ctx, (c) => {
    if (c.setLocalDescriptionDelay == null) return null;
    if (c.setLocalDescriptionDelay >= ctx.thresholds.setDescriptionDelayCriticalMs) {
      return makeObservation('connectivity.slow_set_local_description', 'critical', c.connectionIdentifier, { delay: c.setLocalDescriptionDelay });
    }
    if (c.setLocalDescriptionDelay >= ctx.thresholds.setDescriptionDelayWarningMs) {
      return makeObservation('connectivity.slow_set_local_description', 'warning', c.connectionIdentifier, { delay: c.setLocalDescriptionDelay });
    }
    return null;
  })
};

export const connectivityRules: Rule[] = [
  neverConnected,
  slowIceConnect,
  slowTurnGathering,
  iceRestart,
  iceRestartFollowedBySrd,
  nullCandidateAdded,
  relayOnlyPath,
  dtlsHandshakeIncomplete,
  clockSkew,
  signalingDelay,
  slowSetRemoteDescription,
  slowSetLocalDescription
];
