import { getBasePath } from './config.js';

export interface SessionFilters {
  from?: string;
  to?: string;
  q?: string;
  user?: string;
  conference?: string;
  types?: string[];
  severity?: string;
  maxScore?: number;
  /** Calls whose audio or video MOS is at or below this value. */
  maxMos?: number;
  sort: 'date' | 'score';
  cursor?: string;
  limit: number;
}

export interface SessionSummary {
  dumpId: number;
  sessionStart: string | null;
  duration: number | null;
  rtcstatsUser: string | null;
  rtcstatsConference: string | null;
  experienceScore: number | null;
  audioScore: number | null;
  videoScore: number | null;
  connectivityScore: number | null;
  /** Mean received audio MOS (1–5); null when the dump was not scored. */
  audioMos: number | null;
  /** Mean received video MOS (1–5); null when the dump was not scored. */
  videoMos: number | null;
  worstSeverity: string | null;
  observationsCount: Record<string, number>;
  topObservationTypes: string[];
}

export interface SessionListResponse {
  items: SessionSummary[];
  nextCursor: string | null;
}

export function listSessionsUrl(filters: SessionFilters): string {
  const params = new URLSearchParams();
  if (filters.from) params.set('from', filters.from);
  if (filters.to) params.set('to', filters.to);
  if (filters.q) params.set('q', filters.q);
  if (filters.user) params.set('user', filters.user);
  if (filters.conference) params.set('conference', filters.conference);
  if (filters.types?.length) params.set('types', filters.types.join(','));
  if (filters.severity) params.set('severity', filters.severity);
  if (filters.maxScore != null) params.set('maxScore', String(filters.maxScore));
  if (filters.maxMos != null) params.set('maxMos', String(filters.maxMos));
  if (filters.sort) params.set('sort', filters.sort);
  if (filters.cursor) params.set('cursor', filters.cursor);
  if (filters.limit != null) params.set('limit', String(filters.limit));
  return `/api/sessions?${params.toString()}`;
}

export async function fetchSessions(filters: SessionFilters): Promise<SessionListResponse> {
  return apiFetch(listSessionsUrl(filters));
}

export interface Observation {
  pid: string | null;
  type: string;
  severity: 'critical' | 'warning' | 'info';
  category: string;
  firstSeenAt: number | null;
  observation: Record<string, unknown>;
}

export interface FeatureTrack {
  id: number;
  connectionId: number;
  trackIdentifier: string | null;
  kind: 'audio' | 'video' | null;
  direction: string | null;
  [key: string]: unknown;
}

export interface FeatureConnection {
  id: number;
  connectionIdentifier: string | null;
  tracks: FeatureTrack[];
  [key: string]: unknown;
}

export interface SessionDetailResponse {
  analysis: {
    dumpId: number;
    rulesVersion: string;
    status: 'ok' | 'failed' | 'insufficient_data';
    error: string | null;
    sessionStart: string | null;
    duration: number | null;
    rtcstatsUser: string | null;
    rtcstatsConference: string | null;
    experienceScore: number | null;
    audioScore: number | null;
    videoScore: number | null;
    connectivityScore: number | null;
    audioMos: number | null;
    videoMos: number | null;
    worstSeverity: string | null;
    observationsCount: Record<string, number>;
  };
  observations: Observation[];
  features: {
    metadata: { useragent: string | null; numberPeerconnections: number | null };
    client: { hardwareConcurrency: number | null; deviceMemory: number | null; operatingSystem: string | null; cpuPerformance: number | null } | null;
    connections: FeatureConnection[];
  } | null;
  dump: { sizeBytes: number | null; status: 'available' | 'missing' };
}

export async function fetchSessionDetail(dumpId: number): Promise<SessionDetailResponse> {
  return apiFetch(`/api/sessions/${dumpId}`);
}

export async function dumpDownloadUrl(dumpId: number): Promise<string> {
  const base = await getBasePath();
  const prefix = base === '/' ? '' : base;
  return `${prefix}/api/sessions/${dumpId}/dump`;
}

interface MeResponse {
  authenticated: boolean;
}

export async function fetchMe(): Promise<MeResponse> {
  return apiFetch('/api/me');
}

interface LoginResponse {
  authenticated: boolean;
}

export async function login(password: string): Promise<LoginResponse> {
  return apiFetch('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password })
  });
}

export async function logout(): Promise<void> {
  await apiFetch('/api/logout', { method: 'POST' });
}

async function apiFetch(url: string, init?: RequestInit): Promise<any> {
  const base = await getBasePath();
  const target = base === '/' ? url : base + url;
  return fetch(target, { credentials: 'include', ...init }).then(async (res) => {
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      throw new Error(body?.error ?? `API error ${res.status}: ${res.statusText}`);
    }
    return res.json();
  });
}
