import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { VerdictList } from '../components/VerdictList.js';
import { dumpDownloadUrl, fetchSessionDetail, type Observation, type SessionDetailResponse } from '../lib/api.js';

export function SessionDetailPage() {
  const { dumpId } = useParams<{ dumpId: string }>();
  const [detail, setDetail] = useState<SessionDetailResponse | null>(null);

  useEffect(() => {
    if (!dumpId) return;
    fetchSessionDetail(Number(dumpId)).then(setDetail);
  }, [dumpId]);

  if (!detail) return <p>Loading…</p>;

  const { analysis, observations, features, dump } = detail;

  function onShowEvidence(_observation: Observation) {
    // Wired to zoom the evidence charts in Task 26.
  }

  return (
    <div>
      <header>
        <h1>{analysis.rtcstatsUser ?? `Session ${analysis.dumpId}`}</h1>
        <p>Experience score: {analysis.experienceScore ?? '—'}</p>
        <p>Audio: {analysis.audioScore ?? '—'} · Video: {analysis.videoScore ?? '—'} · Connectivity: {analysis.connectivityScore ?? '—'}</p>
        {features?.client && (
          <p>
            {features.client.operatingSystem} · {features.client.hardwareConcurrency} cores · {features.client.deviceMemory}GB
          </p>
        )}
        <p>Dump: {dump.status === 'available' ? `${dump.sizeBytes} bytes` : 'no longer in storage'}</p>
        {dump.status === 'available' && <a href={dumpDownloadUrl(analysis.dumpId)}>Download raw dump</a>}
      </header>
      <VerdictList observations={observations} onShowEvidence={onShowEvidence} />
    </div>
  );
}
