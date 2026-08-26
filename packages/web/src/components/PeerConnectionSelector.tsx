import { useState, useCallback } from 'react';
import type { FeatureConnection } from '../lib/api.js';

interface PeerConnectionSelectorProps {
  connections: FeatureConnection[];
  selectedPid: string;
  onSelect: (pid: string) => void;
}

export function PeerConnectionSelector({ connections, selectedPid, onSelect }: PeerConnectionSelectorProps) {
  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      onSelect(e.target.value);
    },
    [onSelect],
  );

  if (connections.length === 0) {
    return null;
  }

  return (
    <div className="peer-connection-selector">
      <label htmlFor="peer-connection-select">Peer Connection:</label>
      <select
        id="peer-connection-select"
        aria-label="Select peer connection"
        value={selectedPid}
        onChange={handleChange}
      >
        {connections.map((conn) => {
          const id = String(conn.id);
          const label = conn.connectionIdentifier
            ? `${conn.connectionIdentifier} (#${id})`
            : `#${id}`;
          const trackCount = conn.tracks?.length ?? 0;
          const tracks = trackCount > 0
            ? ` (${trackCount} ${trackCount === 1 ? 'track' : 'tracks'})`
            : '';
          return (
            <option key={id} value={id}>
              {label}{tracks}
            </option>
          );
        })}
      </select>
    </div>
  );
}
