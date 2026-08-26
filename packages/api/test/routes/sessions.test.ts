import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import { buildApp } from '../../src/app.js';
import { createSessionToken, hashPassword, SESSION_COOKIE_NAME } from '../../src/auth.js';
import { createPool } from '../../src/db.js';

const TEST_DATABASE_URL = 'postgresql://postgres:postgres@localhost:5433/dashboard_test';
const SESSION_SECRET = 'test-secret';

function authCookie() {
  return `${SESSION_COOKIE_NAME}=${createSessionToken(SESSION_SECRET)}`;
}

async function seedAnalysis(pool: pg.Pool, overrides: Record<string, unknown>) {
  const dump = await pool.query(`insert into "rtcstats-server" (rtcstats_user) values ('seed') returning id`);
  const defaults = {
    dump_id: dump.rows[0].id,
    rules_version: '1.0.0',
    status: 'ok',
    session_start: new Date().toISOString(),
    duration: 300,
    rtcstats_user: 'alice',
    rtcstats_conference: 'room1',
    experience_score: 80,
    audio_score: null,
    video_score: 80,
    connectivity_score: 90,
    observation_types: ['video.freezes'],
    worst_severity: 'warning',
    observations_count: { warning: 1 }
  };
  const row = { ...defaults, ...overrides, dump_id: dump.rows[0].id };
  await pool.query(
    `insert into dashboard_analysis
       (dump_id, rules_version, status, session_start, duration, rtcstats_user, rtcstats_conference,
        experience_score, audio_score, video_score, connectivity_score, observation_types, worst_severity, observations_count)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [row.dump_id, row.rules_version, row.status, row.session_start, row.duration, row.rtcstats_user, row.rtcstats_conference,
     row.experience_score, row.audio_score, row.video_score, row.connectivity_score, row.observation_types, row.worst_severity, row.observations_count]
  );
  return row.dump_id;
}

describe('GET /api/sessions', () => {
  let pool: pg.Pool;
  let app: ReturnType<typeof buildApp>;

  beforeAll(() => {
    pool = createPool(TEST_DATABASE_URL);
    app = buildApp({ pool, config: { passwordHash: hashPassword('x'), sessionSecret: SESSION_SECRET } });
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query('truncate dashboard_observations, dashboard_analysis, "rtcstats-server" restart identity cascade');
  });

  it('rejects an unauthenticated request', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/sessions' });
    expect(response.statusCode).toBe(401);
  });

  it('filters by exact rtcstats_user', async () => {
    await seedAnalysis(pool, { rtcstats_user: 'alice' });
    await seedAnalysis(pool, { rtcstats_user: 'bob' });

    const response = await app.inject({ method: 'GET', url: '/api/sessions?user=alice', headers: { cookie: authCookie() } });
    const body = response.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0].rtcstatsUser).toBe('alice');
  });

  it('filters by observation type via the GIN index', async () => {
    await seedAnalysis(pool, { observation_types: ['video.freezes'] });
    await seedAnalysis(pool, { observation_types: ['connectivity.ice_restart'] });

    const response = await app.inject({ method: 'GET', url: '/api/sessions?types=video.freezes', headers: { cookie: authCookie() } });
    expect(response.json().items).toHaveLength(1);
  });

  it('sorts worst-first, treating a null experience_score as worse-sorting-last is not required — nulls are simply reachable', async () => {
    await seedAnalysis(pool, { experience_score: 90, session_start: new Date(Date.now() - 1000).toISOString() });
    await seedAnalysis(pool, { experience_score: 40, session_start: new Date(Date.now() - 2000).toISOString() });
    await seedAnalysis(pool, { experience_score: null, status: 'insufficient_data', session_start: new Date(Date.now() - 3000).toISOString() });

    const response = await app.inject({ method: 'GET', url: '/api/sessions?sort=score&limit=10', headers: { cookie: authCookie() } });
    const scores = response.json().items.map((i: { experienceScore: number | null }) => i.experienceScore);
    expect(scores).toEqual([40, 90, null]);
  });

  it('paginates with a keyset cursor across all three score-sorted pages, including the null-scored row', async () => {
    await seedAnalysis(pool, { experience_score: 90 });
    await seedAnalysis(pool, { experience_score: 40 });
    await seedAnalysis(pool, { experience_score: null, status: 'insufficient_data' });

    const page1 = await app.inject({ method: 'GET', url: '/api/sessions?sort=score&limit=1', headers: { cookie: authCookie() } });
    const body1 = page1.json();
    expect(body1.items).toHaveLength(1);
    expect(body1.items[0].experienceScore).toBe(40);
    expect(body1.nextCursor).not.toBeNull();

    const page2 = await app.inject({ method: 'GET', url: `/api/sessions?sort=score&limit=1&cursor=${encodeURIComponent(body1.nextCursor)}`, headers: { cookie: authCookie() } });
    const body2 = page2.json();
    expect(body2.items[0].experienceScore).toBe(90);

    const page3 = await app.inject({ method: 'GET', url: `/api/sessions?sort=score&limit=1&cursor=${encodeURIComponent(body2.nextCursor)}`, headers: { cookie: authCookie() } });
    const body3 = page3.json();
    expect(body3.items[0].experienceScore).toBeNull();
    expect(body3.nextCursor).toBeNull();
  });

  it('returns only the fields the session list needs', async () => {
    await seedAnalysis(pool, { observation_types: ['video.freezes', 'connectivity.ice_restart', 'audio.concealment_ratio', 'device.frequent_reloads'] });
    const response = await app.inject({ method: 'GET', url: '/api/sessions', headers: { cookie: authCookie() } });
    const item = response.json().items[0];
    expect(item.topObservationTypes).toHaveLength(3);
    expect(Object.keys(item).sort()).toEqual([
      'audioScore', 'connectivityScore', 'dumpId', 'duration', 'experienceScore',
      'observationsCount', 'rtcstatsConference', 'rtcstatsUser', 'sessionStart',
      'topObservationTypes', 'videoScore', 'worstSeverity'
    ]);
  });
});
