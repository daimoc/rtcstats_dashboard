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
