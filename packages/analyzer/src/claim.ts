import type pg from 'pg';

export async function claimNewDumps(pool: pg.Pool, rulesVersion: string, batchSize: number): Promise<number[]> {
  const { rows } = await pool.query(
    `insert into dashboard_analysis (dump_id, rules_version, status, session_start, duration, rtcstats_user, rtcstats_conference)
     select sub.id, $1, 'processing', sub.session_start,
            extract(epoch from (sub.session_end - sub.session_start))::int,
            sub.rtcstats_user, sub.rtcstats_conference
     from (
       select rss.id, rss.session_start, rss.session_end, rss.rtcstats_user, rss.rtcstats_conference
       from "rtcstats-server" rss
       join features_metadata fm on fm.dump_id = rss.id
       where rss.features_processing_stop is not null
         and not exists (select 1 from dashboard_analysis da where da.dump_id = rss.id)
       order by rss.id
       limit $2
     ) sub
     on conflict (dump_id) do nothing
     returning dump_id`,
    [rulesVersion, batchSize]
  );
  return rows.map((r) => r.dump_id);
}

export async function claimStaleDumps(
  pool: pg.Pool,
  rulesVersion: string,
  batchSize: number,
  includeFailed = false
): Promise<number[]> {
  const statusFilter = includeFailed ? `status <> 'processing'` : `status not in ('processing', 'failed')`;
  const { rows } = await pool.query(
    `update dashboard_analysis
     set status = 'processing'
     where id in (
       select id from dashboard_analysis
       where rules_version <> $1 and ${statusFilter}
       order by id
       limit $2
       for update skip locked
     )
     returning dump_id`,
    [rulesVersion, batchSize]
  );
  return rows.map((r) => r.dump_id);
}

export async function claimByDumpId(
  pool: pg.Pool,
  dumpId: number,
  rulesVersion: string,
  force: boolean
): Promise<boolean> {
  await pool.query(
    `insert into dashboard_analysis (dump_id, rules_version, status, session_start, duration, rtcstats_user, rtcstats_conference)
     select rss.id, $2, 'processing', rss.session_start,
            extract(epoch from (rss.session_end - rss.session_start))::int,
            rss.rtcstats_user, rss.rtcstats_conference
     from "rtcstats-server" rss
     where rss.id = $1
     on conflict (dump_id) do nothing`,
    [dumpId, rulesVersion]
  );

  const statusFilter = force ? 'true' : `status <> 'failed'`;
  const { rowCount } = await pool.query(
    `update dashboard_analysis set status = 'processing' where dump_id = $1 and ${statusFilter}`,
    [dumpId]
  );
  return (rowCount ?? 0) > 0;
}

export async function claimSince(
  pool: pg.Pool,
  sinceIso: string,
  rulesVersion: string,
  batchSize: number,
  force: boolean
): Promise<number[]> {
  const statusFilter = force ? `status <> 'processing'` : `status not in ('processing', 'failed')`;
  const { rows } = await pool.query(
    `update dashboard_analysis
     set status = 'processing'
     where id in (
       select id from dashboard_analysis
       where session_start >= $1::timestamptz and rules_version <> $2 and ${statusFilter}
       order by id
       limit $3
       for update skip locked
     )
     returning dump_id`,
    [sinceIso, rulesVersion, batchSize]
  );
  return rows.map((r) => r.dump_id);
}
