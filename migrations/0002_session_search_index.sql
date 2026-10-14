-- Substring search across the call list: `q` matches either the user or the
-- conference with a case-insensitive ILIKE '%...%'. A leading wildcard makes a
-- btree index useless, so index both columns with trigrams instead.
create extension if not exists pg_trgm;

create index on dashboard_analysis using gin (rtcstats_user gin_trgm_ops);
create index on dashboard_analysis using gin (rtcstats_conference gin_trgm_ops);
