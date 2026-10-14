import { useCallback } from 'react';
import type { FeatureConnection } from '../lib/api.js';
import styles from './PeerConnectionSelector.module.css';

interface PeerConnectionSelectorProps {
  /** Chartable connection ids from the dump (`PC_0`, ...), in dump order. */
  connectionIds: string[];
  /** Analysed connections, used only to enrich the labels. */
  connections: FeatureConnection[];
  selectedPid: string;
  onSelect: (pid: string) => void;
}

/**
 * Chooses which peer connection the evidence charts show.
 *
 * The options are keyed by the dump's own connection id rather than the numeric
 * `features_connection.id`, because that numeric id has no counterpart in the dump —
 * keying on it left the selector unable to address any chart. `connection_identifier`
 * is the column that holds the dump-side id, so it is what joins the two.
 */
export function PeerConnectionSelector({
  connectionIds,
  connections,
  selectedPid,
  onSelect
}: PeerConnectionSelectorProps) {
  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => onSelect(e.target.value),
    [onSelect]
  );

  if (connectionIds.length <= 1) return null;

  return (
    <div className={styles.wrap}>
      <label className={styles.label} htmlFor="peer-connection-select">Peer connection</label>
      <select
        id="peer-connection-select"
        className={styles.select}
        aria-label="Select peer connection"
        value={selectedPid}
        onChange={handleChange}
      >
        {connectionIds.map((pcId) => {
          const analysed = connections.find((c) => c.connectionIdentifier === pcId);
          const trackCount = analysed?.tracks?.length ?? 0;
          const tracks = trackCount > 0
            ? ` (${trackCount} ${trackCount === 1 ? 'track' : 'tracks'})`
            : '';
          return <option key={pcId} value={pcId}>{pcId}{tracks}</option>;
        })}
      </select>
    </div>
  );
}
