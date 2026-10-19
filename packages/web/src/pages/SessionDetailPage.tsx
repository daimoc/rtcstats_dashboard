import { useEffect, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { ConnectionTimelines } from '../components/ConnectionTimelines.js';
import { EvidenceCharts } from '../components/EvidenceCharts.js';
import { EventTimeline } from '../components/EventTimeline.js';
import { PeerConnectionSelector } from '../components/PeerConnectionSelector.js';
import { MosBadge, ScoreRing, scoreTone, type Severity } from '../components/ScoreBadge.js';
import { VerdictList } from '../components/VerdictList.js';
import { fetchSessionDetail, type SessionDetailResponse } from '../lib/api.js';
import { getBasePath } from '../lib/config.js';
import { formatBytes, formatDateTime, formatDuration } from '../lib/format.js';
import { useDumpData } from '../lib/useDumpData.js';
import styles from './SessionDetailPage.module.css';

const TONE_VAR: Record<string, string> = {
  critical: 'var(--critical)',
  warning: 'var(--warning)',
  ok: 'var(--ok)',
  unknown: 'var(--text-faint)'
};

function SubScore({ label, score }: { label: string; score: number | null }) {
  const color = TONE_VAR[scoreTone(score, null)];

  return (
    <div className={styles.subScore} style={{ color }}>
      <div className={styles.subScoreHead}>
        <span className={styles.subScoreLabel}>{label}</span>
        <span className={styles.subScoreValue}>{score == null ? '—' : Math.round(score)}</span>
      </div>
      <div className={styles.meter}>
        <div className={styles.meterFill} style={{ width: `${score == null ? 0 : Math.max(0, Math.min(100, score))}%` }} />
      </div>
    </div>
  );
}

function MetaItem({ label, value }: { label: string; value: string }) {
  return (
    <span className={styles.metaItem}>
      <span className={styles.metaKey}>{label}</span>
      <span>{value}</span>
    </span>
  );
}

export function SessionDetailPage() {
  const { dumpId } = useParams<{ dumpId: string }>();
  const [searchParams] = useSearchParams();
  const [detail, setDetail] = useState<SessionDetailResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedPid, setSelectedPid] = useState('');
  const [highlighted, setHighlighted] = useState(false);
  const [dumpUrl, setDumpUrl] = useState<string | null>(null);
  const evidenceRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!dumpId) return;
    let cancelled = false;
    setDetail(null);
    setError(null);

    fetchSessionDetail(Number(dumpId))
      .then((result) => {
        if (cancelled) return;
        setDetail(result);
        return getBasePath();
      })
      .then((base) => {
        if (cancelled) return;
        const prefix = base === '/' ? '' : base;
        setDumpUrl(`${prefix}/api/sessions/${dumpId}/dump`);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });

    return () => {
      cancelled = true;
    };
  }, [dumpId]);

  // The raw dump is the only source of timestamps and time series: observations carry
  // firstSeenAt: null from every rule, and the features_* tree has no time dimension.
  const dump = useDumpData(dumpId ? Number(dumpId) : null, detail?.dump.status ?? 'missing');

  useEffect(() => {
    if (dump.status !== 'ready') return;
    const ids = dump.result.connectionIds;
    if (ids.length > 0 && !ids.includes(selectedPid)) setSelectedPid(ids[0]);
  }, [dump, selectedPid]);

  const backSearch = searchParams.toString();
  const backTo = { pathname: '/', search: backSearch ? `?${backSearch}` : '' };

  function showEvidence() {
    evidenceRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    setHighlighted(true);
    setTimeout(() => setHighlighted(false), 1400);
  }

  function showConnectionCharts(pcId: string) {
    // Only connections with stats are chartable; the others keep the current selection.
    if (dump.status === 'ready' && dump.result.connectionIds.includes(pcId)) setSelectedPid(pcId);
    showEvidence();
  }

  if (error) {
    return (
      <>
        <Link to={backTo} className={styles.back}>← Back to calls</Link>
        <div className={styles.card}>
          <div className={`${styles.state} ${styles.stateError}`}>
            <p>Could not load this call</p>
            <p>{error}</p>
          </div>
        </div>
      </>
    );
  }

  if (!detail) {
    return (
      <>
        <Link to={backTo} className={styles.back}>← Back to calls</Link>
        <div className={styles.card}>
          <div className={styles.state}>Loading call…</div>
        </div>
      </>
    );
  }

  // `dumpFile` is the object-storage metadata; `dump` above is the decoded dump.
  const { analysis, observations, features, dump: dumpFile } = detail;
  const connections = features?.connections ?? [];
  const client = features?.client;

  return (
    <>
      <Link to={backTo} className={styles.back}>← Back to calls</Link>

      {analysis.status !== 'ok' && (
        <div className={styles.banner}>
          {analysis.status === 'insufficient_data'
            ? 'This dump did not contain enough data to score. The evidence below may be incomplete.'
            : `Analysis failed: ${analysis.error ?? 'unknown error'}`}
        </div>
      )}

      <section className={`${styles.card} ${styles.header}`}>
        <ScoreRing score={analysis.experienceScore} worstSeverity={analysis.worstSeverity as Severity} />

        <div className={styles.identity}>
          <h1 className={styles.title}>{analysis.rtcstatsUser ?? `Session ${analysis.dumpId}`}</h1>
          <div className={styles.meta}>
            <MetaItem label="Conference" value={analysis.rtcstatsConference ?? '—'} />
            <MetaItem label="Started" value={formatDateTime(analysis.sessionStart)} />
            <MetaItem label="Duration" value={formatDuration(analysis.duration)} />
            <MetaItem label="Dump" value={String(analysis.dumpId)} />
          </div>
          <div className={styles.subScores}>
            <SubScore label="Audio" score={analysis.audioScore} />
            <SubScore label="Video" score={analysis.videoScore} />
            <SubScore label="Connectivity" score={analysis.connectivityScore} />
          </div>
          <div className={styles.mosRow}>
            <span className={styles.metaKey}>Received MOS</span>
            <MosBadge label="Audio" mos={analysis.audioMos} />
            <MosBadge label="Video" mos={analysis.videoMos} />
          </div>
        </div>

        <div className={styles.aside}>
          {client && (
            <>
              <span>{client.operatingSystem ?? 'Unknown OS'}</span>
              <span>
                {client.hardwareConcurrency ?? '—'} cores · {client.deviceMemory ?? '—'} GB
              </span>
            </>
          )}
          {features?.metadata?.useragent && <span title={features.metadata.useragent}>{features.metadata.useragent.slice(0, 48)}…</span>}
          <span>
            {dumpFile.status === 'available' ? `Raw dump · ${formatBytes(dumpFile.sizeBytes)}` : 'Raw dump no longer in storage'}
          </span>
          {dumpFile.status === 'available' && (
            <a className={styles.download} href={dumpUrl || ''}>
              Download dump
            </a>
          )}
        </div>
      </section>

      <div className={styles.columns}>
        <section className={`${styles.card} ${styles.panel}`}>
          <h2 className={styles.panelTitle}>Verdict</h2>
          <VerdictList observations={observations} onShowEvidence={showEvidence} />
        </section>

        <section className={`${styles.card} ${styles.panel}`}>
          <EventTimeline dump={dump} />
        </section>
      </div>

      <section className={`${styles.card} ${styles.panel} ${styles.connections}`}>
        <h2 className={styles.panelTitle}>Peer connections</h2>
        <ConnectionTimelines dump={dump} onShowCharts={showConnectionCharts} />
      </section>

      <section
        ref={evidenceRef}
        className={`${styles.card} ${styles.panel} ${highlighted ? styles.highlight : ''}`}
      >
        <div className={styles.evidenceHead}>
          <h2 className={styles.panelTitle}>Evidence</h2>
          <PeerConnectionSelector
            connectionIds={dump.status === 'ready' ? dump.result.connectionIds : []}
            connections={connections}
            selectedPid={selectedPid}
            onSelect={setSelectedPid}
          />
        </div>
        <EvidenceCharts dump={dump} selectedPid={selectedPid} />
      </section>
    </>
  );
}
