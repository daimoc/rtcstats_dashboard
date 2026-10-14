-- Per-call mean opinion scores (1-5) computed by the analyzer from the raw dump:
-- audio from the ITU-T G.107 E-model, video from ITU-T P.1203.1 mode 0. Null when
-- the dump was unavailable or the call carried no inbound media of that kind.
alter table dashboard_analysis
  add column if not exists audio_mos real,
  add column if not exists video_mos real;

-- Backs the `maxMos` filter, which matches on the worse of the two scores.
create index if not exists dashboard_analysis_worst_mos_idx
  on dashboard_analysis (least(audio_mos, video_mos));
