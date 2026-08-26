import type { S3Client } from '@aws-sdk/client-s3';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { loadFeatures } from '@rtcstats-dashboard/db-features';
import { extractObjectKey, headDump } from '../s3.js';
import { requireAuth } from '../auth.js';

export interface SessionFilters {
  from?: string;
  to?: string;
  user?: string;
  conference?: string;
  types?: string[];
  severity?: string;
  maxScore?: number;
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
  worstSeverity: string | null;
  observationsCount: Record<string, number>;
  topObservationTypes: string[];
}

export interface SessionListResult {
  items: SessionSummary[];
  nextCursor: string | null;
}

interface DecodedCursor {
  sortValue: string | number | null;
  id: number;
}

function encodeCursor(cursor: DecodedCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

function decodeCursor(raw: string): DecodedCursor {
  return JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
}

function buildCursorCondition(
  column: string,
  direction: 'asc' | 'desc',
  castType: 'timestamptz' | 'real',
  decoded: DecodedCursor,
  push: (v: unknown) => string
): string {
  const idPlaceholder = push(decoded.id);
  const comparator = direction === 'desc' ? '<' : '>';

  if (decoded.sortValue === null) {
    return `(${column} is null and id ${comparator} ${idPlaceholder})`;
  }

  const sortPlaceholder = push(decoded.sortValue);
  return `((${column} ${comparator} ${sortPlaceholder}::${castType}) or (${column} = ${sortPlaceholder}::${castType} and id ${comparator} ${idPlaceholder}) or ${column} is null)`;
}

function toSummary(row: {
  dump_id: number; session_start: string | null; duration: number | null;
  rtcstats_user: string | null; rtcstats_conference: string | null;
  experience_score: number | null; audio_score: number | null; video_score: number | null; connectivity_score: number | null;
  worst_severity: string | null; observations_count: Record<string, number>; observation_types: string[];
}): SessionSummary {
  return {
    dumpId: row.dump_id,
    sessionStart: row.session_start,
    duration: row.duration,
    rtcstatsUser: row.rtcstats_user,
    rtcstatsConference: row.rtcstats_conference,
    experienceScore: row.experience_score,
    audioScore: row.audio_score,
    videoScore: row.video_score,
    connectivityScore: row.connectivity_score,
    worstSeverity: row.worst_severity,
    observationsCount: row.observations_count,
    topObservationTypes: (row.observation_types ?? []).slice(0, 3)
  };
}

export async function listSessions(pool: pg.Pool, filters: SessionFilters): Promise<SessionListResult> {
  const conditions: string[] = [];
  const values: unknown[] = [];
  let paramIndex = 1;

  function push(value: unknown): string {
    values.push(value);
    return `$${paramIndex++}`;
  }

  if (filters.from) conditions.push(`session_start >= ${push(filters.from)}::timestamptz`);
  if (filters.to) conditions.push(`session_start < ${push(filters.to)}::timestamptz`);
  if (filters.user) conditions.push(`rtcstats_user = ${push(filters.user)}`);
  if (filters.conference) conditions.push(`rtcstats_conference = ${push(filters.conference)}`);
  if (filters.severity) conditions.push(`worst_severity = ${push(filters.severity)}`);
  if (filters.maxScore != null) conditions.push(`experience_score <= ${push(filters.maxScore)}`);
  if (filters.types && filters.types.length > 0) conditions.push(`observation_types && ${push(filters.types)}::text[]`);

  const sortByScore = filters.sort === 'score';
  const sortColumn = sortByScore ? 'experience_score' : 'session_start';
  const sortDirection: 'asc' | 'desc' = sortByScore ? 'asc' : 'desc';
  const castType: 'timestamptz' | 'real' = sortByScore ? 'real' : 'timestamptz';

  if (filters.cursor) {
    const decoded = decodeCursor(filters.cursor);
    conditions.push(buildCursorCondition(sortColumn, sortDirection, castType, decoded, push));
  }

  const whereClause = conditions.length > 0 ? `where ${conditions.join(' and ')}` : '';
  const limitPlaceholder = push(filters.limit + 1);

  const { rows } = await pool.query(
    `select dump_id, session_start, duration, rtcstats_user, rtcstats_conference,
            experience_score, audio_score, video_score, connectivity_score,
            worst_severity, observations_count, observation_types
     from dashboard_analysis
     ${whereClause}
     order by ${sortColumn} ${sortDirection} nulls last, id ${sortDirection}
     limit ${limitPlaceholder}`,
    values
  );

  const hasMore = rows.length > filters.limit;
  const items = rows.slice(0, filters.limit).map(toSummary);

  let nextCursor: string | null = null;
  if (hasMore) {
    const last = items[items.length - 1];
    nextCursor = encodeCursor({
      sortValue: sortByScore ? last.experienceScore : last.sessionStart,
      id: last.dumpId
    });
  }

  return { items, nextCursor };
}

export function registerSessionsRoute(app: FastifyInstance, pool: pg.Pool, sessionSecret: string): void {
  app.get<{
    Querystring: {
      from?: string; to?: string; user?: string; conference?: string;
      types?: string; severity?: string; maxScore?: string; sort?: string;
      cursor?: string; limit?: string;
    };
  }>('/api/sessions', { preHandler: requireAuth(sessionSecret) }, async (request, reply) => {
    const q = request.query;
    const limit = Math.min(Number(q.limit ?? 25), 100);
    const filters: SessionFilters = {
      from: q.from,
      to: q.to,
      user: q.user,
      conference: q.conference,
      types: q.types ? q.types.split(',') : undefined,
      severity: q.severity,
      maxScore: q.maxScore != null ? Number(q.maxScore) : undefined,
      sort: q.sort === 'score' ? 'score' : 'date',
      cursor: q.cursor,
      limit
    };
    const result = await listSessions(pool, filters);
    reply.send(result);
  });
}

const SEVERITY_RANK: Record<string, number> = { critical: 0, warning: 1, info: 2 };

export function registerSessionDetailRoute(
  app: FastifyInstance,
  pool: pg.Pool,
  s3: { client: S3Client; bucket: string } | undefined,
  sessionSecret: string
): void {
  app.get<{ Params: { dumpId: string } }>(
    '/api/sessions/:dumpId',
    { preHandler: requireAuth(sessionSecret) },
    async (request, reply) => {
      const dumpId = Number(request.params.dumpId);

      const analysisResult = await pool.query(
        `select id, dump_id, rules_version, status, error, session_start, duration,
                rtcstats_user, rtcstats_conference, experience_score, audio_score, video_score,
                connectivity_score, worst_severity, observations_count, observation_types
         from dashboard_analysis where dump_id = $1`,
        [dumpId]
      );
      if (analysisResult.rows.length === 0) {
        reply.code(404).send({ error: 'not_found' });
        return;
      }
      const a = analysisResult.rows[0];

      const observationsResult = await pool.query(
        `select pid, type, severity, category, first_seen_at, observation
         from dashboard_observations where analysis_id = $1`,
        [a.id]
      );
      const observations = observationsResult.rows
        .map((o) => ({
          pid: o.pid, type: o.type, severity: o.severity, category: o.category,
          firstSeenAt: o.first_seen_at, observation: o.observation
        }))
        .sort((x, y) => {
          const rankDiff = SEVERITY_RANK[x.severity] - SEVERITY_RANK[y.severity];
          if (rankDiff !== 0) return rankDiff;
          return (x.firstSeenAt ?? 0) - (y.firstSeenAt ?? 0);
        });

      const features = await loadFeatures(pool, dumpId);

      let dump: { sizeBytes: number | null; status: 'available' | 'missing' } = { sizeBytes: null, status: 'missing' };
      if (s3) {
        const blobUrlResult = await pool.query('select blob_url from "rtcstats-server" where id = $1', [dumpId]);
        const blobUrl = blobUrlResult.rows[0]?.blob_url as string | undefined;
        if (blobUrl) {
          const key = extractObjectKey(blobUrl, s3.bucket);
          const head = await headDump(s3.client, s3.bucket, key);
          dump = head.exists ? { sizeBytes: head.sizeBytes, status: 'available' } : { sizeBytes: null, status: 'missing' };
        }
      }

      reply.send({
        analysis: {
          dumpId: a.dump_id,
          rulesVersion: a.rules_version,
          status: a.status,
          error: a.error,
          sessionStart: a.session_start,
          duration: a.duration,
          rtcstatsUser: a.rtcstats_user,
          rtcstatsConference: a.rtcstats_conference,
          experienceScore: a.experience_score,
          audioScore: a.audio_score,
          videoScore: a.video_score,
          connectivityScore: a.connectivity_score,
          worstSeverity: a.worst_severity,
          observationsCount: a.observations_count
        },
        observations,
        features,
        dump
      });
    }
  );
}
