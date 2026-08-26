export type Severity = 'critical' | 'warning' | 'info';
export type Category = 'connectivity' | 'audio' | 'video' | 'device' | 'api';
export type AnalysisStatus = 'ok' | 'failed' | 'insufficient_data';

export interface Evidence {
  chart: string;
  from: number;
  to: number;
}

export interface Observation {
  type: string;
  severity: Severity;
  category: Category;
  pid: string | null;
  firstSeenAt: number | null;
  observation: Record<string, unknown>;
}

export interface FeatureTrack {
  id: number;
  connectionId: number;
  trackIdentifier: string | null;
  kind: 'audio' | 'video' | null;
  direction: string | null;
  frameCount: number | null;
  qualityLimitationResolutionChanges: number | null;
  bandwidthQualityLimitationPercentage: number | null;
  cpuQualityLimitationPercentage: number | null;
  otherQualityLimitationPercentage: number | null;
  averageEncodeTime: number | null;
  averageDecodeTime: number | null;
  freezeCount: number | null;
  totalFreezesDuration: number | null;
  qpSum: number | null;
  encoderImplementation: string | null;
  powerEfficientEncoder: boolean | null;
  decoderImplementation: string | null;
  powerEfficientDecoder: boolean | null;
  hasNullVideoDecoder: boolean | null;
  concealedSamples: number | null;
  totalSamplesReceived: number | null;
  concealmentPercentage: number | null;
  jitterBufferFlushes: number | null;
  hasPeriodicJitterBufferFlushes: boolean | null;
  insertedSamplesForDeceleration: number | null;
  removedSamplesForAcceleration: number | null;
  decelerationPercentage: number | null;
  accelerationPercentage: number | null;
  timeToFirstFrame: number | null;
}

export interface FeatureConnection {
  id: number;
  dumpId: number;
  connectionIdentifier: string | null;
  closed: boolean | null;
  iceConnected: boolean | null;
  iceConnectionTime: number | null;
  iceRestart: boolean | null;
  addIceCandidateFailure: string | null;
  setLocalDescriptionFailure: string | null;
  setRemoteDescriptionFailure: string | null;
  connected: boolean | null;
  dtlsVersion: string | null;
  dtlsRole: string | null;
  addedNullCandidate: boolean | null;
  firstCandidatePairLocalType: string | null;
  firstCandidatePairRemoteType: string | null;
  averageStunRoundTripTime: number | null;
  iceRestartFollowedBySetRemoteDescription: boolean | null;
  signalingDelay: number | null;
  setRemoteDescriptionDelay: number | null;
  setLocalDescriptionDelay: number | null;
  clockSkew: number | null;
  gatheringTimeTurnUdp: number | null;
  gatheringTimeTurnTcp: number | null;
  gatheringTimeTurnTls: number | null;
  tracks: FeatureTrack[];
}

export interface FeatureClient {
  id: number;
  dumpId: number;
  hardwareConcurrency: number | null;
  deviceMemory: number | null;
  calledGetUserMedia: boolean | null;
  getUserMediaSuccessCount: number | null;
  getUserMediaErrorCount: number | null;
  getUserMediaError: string | null;
  reloadCount: number | null;
  cpuPerformance: number | null;
  operatingSystem: string | null;
  audioEnded: boolean | null;
  audioShortDuration: boolean | null;
  videoEnded: boolean | null;
  videoShortDuration: boolean | null;
}

export interface FeatureMetadata {
  id: number;
  dumpId: number;
  startTime: string | null;
  useragent: string | null;
  numberPeerconnections: number | null;
}

export interface RuleWeights {
  [ruleId: string]: number;
}

export interface Thresholds {
  iceConnectionTimeWarningMs: number;
  iceConnectionTimeCriticalMs: number;
  turnGatheringWarningMs: number;
  turnGatheringCriticalMs: number;
  clockSkewWarningMs: number;
  clockSkewCriticalMs: number;
  signalingDelayWarningMs: number;
  signalingDelayCriticalMs: number;
  setDescriptionDelayWarningMs: number;
  setDescriptionDelayCriticalMs: number;
  freezeTotalWarningMs: number;
  freezeTotalCriticalMs: number;
  qualityLimitationWarningPct: number;
  qualityLimitationCriticalPct: number;
  resolutionChangesWarningCount: number;
  ttffWarningMs: number;
  ttffCriticalMs: number;
  encodeTimeWarningMs: number;
  encodeTimeCriticalMs: number;
  decodeTimeWarningMs: number;
  decodeTimeCriticalMs: number;
  qpWarning: number;
  qpCritical: number;
  concealmentWarningPct: number;
  concealmentCriticalPct: number;
  jitterBufferFlushesWarningCount: number;
  timeStretchingWarningPct: number;
  timeStretchingCriticalPct: number;
  lowCpuPerformanceThreshold: number;
  reloadCountWarningCount: number;
  weights: RuleWeights;
}

export interface RuleContext {
  metadata: FeatureMetadata;
  client: FeatureClient | null;
  connections: FeatureConnection[];
  thresholds: Thresholds;
}

export interface Rule {
  id: string;
  category: Category;
  scope: 'session' | 'connection' | 'track';
  evaluate(ctx: RuleContext): Observation[];
}

export interface Scores {
  connectivity: number | null;
  audio: number | null;
  video: number | null;
  experience: number;
}

export interface AnalysisResult {
  status: AnalysisStatus;
  scores: Scores | null;
  observations: Observation[];
}