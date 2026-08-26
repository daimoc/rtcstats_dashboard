import type pg from 'pg';
import type { AnalysisResult, Observation, Severity } from '@rtcstats-dashboard/rules';

function worstSeverity(observations: Observation[]): Severity | null {
  if (observations.some((o) => o.severity === 'critical')) return 'critical';
  if (observations.some((o) => o.severity === 'warning')) return 'warning';
  if (observations.some((o) => o.severity === 'info')) return 'info';
  return null;
}

function countsBySeverity(observations: Observation[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const o of observations) counts[o.severity] = (counts[o.severity] ?? 0) + 1;
  return counts;
}

export async function writeAnalysisResult(
  pool: pg.Pool,
  dumpId: number,
  rulesVersion: string,
  result: AnalysisResult
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const { rows } = await client.query(
      `update dashboard_analysis set
         rules_version = $2, status = $3, error = null,
         experience_score = $4, audio_score = $5, video_score = $6, connectivity_score = $7,
         observation_types = $8, worst_severity = $9, observations_count = $10
       where dump_id = $1
       returning id`,
      [
        dumpId, rulesVersion, result.status,
        result.scores?.experience ?? null,
        result.scores?.audio ?? null,
        result.scores?.video ?? null,
        result.scores?.connectivity ?? null,
        [...new Set(result.observations.map((o) => o.type))],
        worstSeverity(result.observations),
        countsBySeverity(result.observations)
      ]
    );
    const analysisId = rows[0].id;

    await client.query('delete from dashboard_observations where analysis_id = $1', [analysisId]);
    for (const obs of result.observations) {
      await client.query(
        `insert into dashboard_observations (analysis_id, pid, type, severity, category, first_seen_at, observation)
         values ($1, $2, $3, $4, $5, $6, $7)`,
        [analysisId, obs.pid, obs.type, obs.severity, obs.category, obs.firstSeenAt, obs.observation]
      );
    }
    await client.query('commit');
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
}

export async function writeFailure(
  pool: pg.Pool,
  dumpId: number,
  rulesVersion: string,
  errorMessage: string
): Promise<void> {
  await pool.query(
    `update dashboard_analysis set
       rules_version = $2, status = 'failed', error = $3,
       experience_score = null, audio_score = null, video_score = null, connectivity_score = null,
       observation_types = '{}', worst_severity = null, observations_count = '{}'
     where dump_id = $1`,
    [dumpId, rulesVersion, errorMessage]
  );
}
