import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import { createPool } from '../src/db.js';
import { claimNewDumps } from '../src/claim.js';
import { writeAnalysisResult, writeFailure } from '../src/write.js';
import type { AnalysisResult } from '@rtcstats-dashboard/rules';

const TEST_DATABASE_URL = 'postgresql://postgres:postgres@localhost:5433/dashboard_test';

describe('writeAnalysisResult / writeFailure', () => {
  let pool: pg.Pool;
  let dumpId: number;

  beforeAll(() => {
    pool = createPool(TEST_DATABASE_URL);
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query('truncate dashboard_observations, dashboard_analysis, "rtcstats-server", features_metadata restart identity cascade');
    const dump = await pool.query(
      `insert into "rtcstats-server" (rtcstats_user, session_start, session_end, features_processing_stop)
       values ('alice', now() - interval '5 minutes', now(), now()) returning id`
    );
    dumpId = dump.rows[0].id;
    await pool.query(`insert into features_metadata (dump_id, number_peerconnections) values ($1, 1)`, [dumpId]);
    await claimNewDumps(pool, '1.0.0', 10);
  });

  it('writes scores and observations for a successful analysis', async () => {
    const result: AnalysisResult = {
      status: 'ok',
      scores: { connectivity: 70, audio: null, video: 60, experience: 65 },
      observations: [
        { type: 'connectivity.slow_ice_connect', severity: 'warning', category: 'connectivity', pid: 'PC_0', firstSeenAt: 0, observation: {} },
        { type: 'video.freezes', severity: 'critical', category: 'video', pid: 'PC_0', firstSeenAt: 10, observation: { count: 3 } }
      ]
    };
    await writeAnalysisResult(pool, dumpId, '1.0.0', result);

    const analysis = await pool.query('select * from dashboard_analysis where dump_id = $1', [dumpId]);
    expect(analysis.rows[0].status).toBe('ok');
    expect(analysis.rows[0].experience_score).toBe(65);
    expect(analysis.rows[0].worst_severity).toBe('critical');
    expect(analysis.rows[0].observation_types.sort()).toEqual(['connectivity.slow_ice_connect', 'video.freezes']);
    expect(analysis.rows[0].observations_count).toEqual({ warning: 1, critical: 1 });

    const observations = await pool.query('select * from dashboard_observations where analysis_id = $1', [analysis.rows[0].id]);
    expect(observations.rows).toHaveLength(2);
  });

  it('replaces observations on re-analysis rather than accumulating them', async () => {
    const first: AnalysisResult = {
      status: 'ok',
      scores: { connectivity: 100, audio: null, video: null, experience: 100 },
      observations: [{ type: 'connectivity.ice_restart', severity: 'warning', category: 'connectivity', pid: null, firstSeenAt: null, observation: {} }]
    };
    await writeAnalysisResult(pool, dumpId, '1.0.0', first);

    const second: AnalysisResult = {
      status: 'ok',
      scores: { connectivity: 100, audio: null, video: null, experience: 100 },
      observations: []
    };
    await writeAnalysisResult(pool, dumpId, '1.0.1', second);

    const analysis = await pool.query('select id, rules_version from dashboard_analysis where dump_id = $1', [dumpId]);
    expect(analysis.rows[0].rules_version).toBe('1.0.1');
    const observations = await pool.query('select * from dashboard_observations where analysis_id = $1', [analysis.rows[0].id]);
    expect(observations.rows).toHaveLength(0);
  });

  it('records a terminal failure with null scores', async () => {
    await writeFailure(pool, dumpId, '1.0.0', 'TypeError: cannot read property of undefined');
    const analysis = await pool.query('select * from dashboard_analysis where dump_id = $1', [dumpId]);
    expect(analysis.rows[0].status).toBe('failed');
    expect(analysis.rows[0].error).toContain('TypeError');
    expect(analysis.rows[0].experience_score).toBeNull();
  });
});
