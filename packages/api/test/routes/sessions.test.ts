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
    observations_count: { warning: 1 },
    audio_mos: null,
    video_mos: null
  };
  const row = { ...defaults, ...overrides, dump_id: dump.rows[0].id };
  await pool.query(
    `insert into dashboard_analysis
       (dump_id, rules_version, status, session_start, duration, rtcstats_user, rtcstats_conference,
        experience_score, audio_score, video_score, connectivity_score, observation_types, worst_severity, observations_count,
        audio_mos, video_mos)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
    [row.dump_id, row.rules_version, row.status, row.session_start, row.duration, row.rtcstats_user, row.rtcstats_conference,
     row.experience_score, row.audio_score, row.video_score, row.connectivity_score, row.observation_types, row.worst_severity, row.observations_count,
     row.audio_mos, row.video_mos]
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
      'audioMos', 'audioScore', 'connectivityScore', 'dumpId', 'duration', 'experienceScore',
      'observationsCount', 'rtcstatsConference', 'rtcstatsUser', 'sessionStart',
      'topObservationTypes', 'videoMos', 'videoScore', 'worstSeverity'
    ]);
  });

  it('returns the call MOS with each session', async () => {
    await seedAnalysis(pool, { audio_mos: 4.25, video_mos: 3.5 });
    const response = await app.inject({ method: 'GET', url: '/api/sessions', headers: { cookie: authCookie() } });
    const item = response.json().items[0];
    expect(item.audioMos).toBeCloseTo(4.25, 5);
    expect(item.videoMos).toBeCloseTo(3.5, 5);
  });

  it('filters by maxMos on whichever of audio or video MOS is worse', async () => {
    await seedAnalysis(pool, { rtcstats_user: 'good', audio_mos: 4.3, video_mos: 4.1 });
    await seedAnalysis(pool, { rtcstats_user: 'poor-audio', audio_mos: 2.8, video_mos: 4.1 });
    await seedAnalysis(pool, { rtcstats_user: 'poor-video-only', audio_mos: null, video_mos: 2.5 });
    await seedAnalysis(pool, { rtcstats_user: 'unscored', audio_mos: null, video_mos: null });

    const response = await app.inject({ method: 'GET', url: '/api/sessions?maxMos=3', headers: { cookie: authCookie() } });
    const users = response.json().items.map((i: { rtcstatsUser: string }) => i.rtcstatsUser).sort();
    expect(users).toEqual(['poor-audio', 'poor-video-only']);
  });

  it('ignores an empty or invalid maxMos', async () => {
    await seedAnalysis(pool, { audio_mos: null, video_mos: null });
    for (const value of ['', 'abc']) {
      const response = await app.inject({ method: 'GET', url: `/api/sessions?maxMos=${value}`, headers: { cookie: authCookie() } });
      expect(response.json().items).toHaveLength(1);
    }
  });

  it('matches a partial rtcstats_user with q', async () => {
    await seedAnalysis(pool, { rtcstats_user: 'alice.anderson' });
    await seedAnalysis(pool, { rtcstats_user: 'bob' });

    const response = await app.inject({ method: 'GET', url: '/api/sessions?q=anders', headers: { cookie: authCookie() } });
    const body = response.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0].rtcstatsUser).toBe('alice.anderson');
  });

  it('matches a partial rtcstats_conference with q', async () => {
    await seedAnalysis(pool, { rtcstats_user: 'alice', rtcstats_conference: 'daily-standup' });
    await seedAnalysis(pool, { rtcstats_user: 'bob', rtcstats_conference: 'retro' });

    const response = await app.inject({ method: 'GET', url: '/api/sessions?q=stand', headers: { cookie: authCookie() } });
    const body = response.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0].rtcstatsConference).toBe('daily-standup');
  });

  it('matches q case-insensitively', async () => {
    await seedAnalysis(pool, { rtcstats_user: 'Alice' });

    const response = await app.inject({ method: 'GET', url: '/api/sessions?q=ALICE', headers: { cookie: authCookie() } });
    expect(response.json().items).toHaveLength(1);
  });

  it('combines q with a from/to date range', async () => {
    const old = new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString();
    const recent = new Date(Date.now() - 60 * 1000).toISOString();
    await seedAnalysis(pool, { rtcstats_user: 'alice', session_start: old });
    await seedAnalysis(pool, { rtcstats_user: 'alice', session_start: recent });
    await seedAnalysis(pool, { rtcstats_user: 'bob', session_start: recent });

    const from = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const response = await app.inject({
      method: 'GET',
      url: `/api/sessions?q=alice&from=${encodeURIComponent(from)}`,
      headers: { cookie: authCookie() }
    });
    const body = response.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0].sessionStart).not.toBeNull();
  });

  it('treats % and _ in q as literal characters, not wildcards', async () => {
    await seedAnalysis(pool, { rtcstats_user: '100%-packet-loss' });
    await seedAnalysis(pool, { rtcstats_user: 'alice' });

    const percent = await app.inject({ method: 'GET', url: `/api/sessions?q=${encodeURIComponent('%')}`, headers: { cookie: authCookie() } });
    const percentItems = percent.json().items;
    expect(percentItems).toHaveLength(1);
    expect(percentItems[0].rtcstatsUser).toBe('100%-packet-loss');

    const underscore = await app.inject({ method: 'GET', url: `/api/sessions?q=${encodeURIComponent('a_i')}`, headers: { cookie: authCookie() } });
    expect(underscore.json().items).toHaveLength(0);
  });

  it('returns every row when q is absent or empty', async () => {
    await seedAnalysis(pool, { rtcstats_user: 'alice' });
    await seedAnalysis(pool, { rtcstats_user: 'bob' });

    const absent = await app.inject({ method: 'GET', url: '/api/sessions', headers: { cookie: authCookie() } });
    expect(absent.json().items).toHaveLength(2);

    const empty = await app.inject({ method: 'GET', url: '/api/sessions?q=', headers: { cookie: authCookie() } });
    expect(empty.json().items).toHaveLength(2);
  });
});
