import { useRef, useEffect, useCallback } from 'react';
import type { SessionDetailResponse } from '../lib/api.js';
import uPlot from 'uplot';

interface EvidenceChartsProps {
  dumpData: SessionDetailResponse | null;
}

type TimeSeriesPoint = [number, number];

function buildTimeSeriesData(
  features: SessionDetailResponse['features']
): [number[], number[], number[], number[]] {
  if (!features?.connections || features.connections.length === 0) {
    return [[], [], [], []];
  }

  const connBitrates: number[][] = [];
  const connPacketRates: number[][] = [];

  for (let i = 0; i < features.connections.length; i++) {
    connBitrates.push([]);
    connPacketRates.push([]);
  }

  const featuresList: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(features)) {
    if (key !== 'metadata' && key !== 'connections') {
      featuresList[key] = value;
    }
  }

  const featureNames = Object.keys(featuresList);

  for (const conn of features.connections) {
    const idx = features.connections.indexOf(conn);
    const connInfo = conn as Record<string, unknown>;
    const baseTime = connInfo.createdAt
      ? (typeof connInfo.createdAt === 'number' ? connInfo.createdAt : 0)
      : 0;

    const tracks = conn.tracks || [];
    for (const track of tracks) {
      const t = track as Record<string, unknown>;
      const trackTime = t.timestamp
        ? (typeof t.timestamp === 'number' ? t.timestamp : 0)
        : 0;
      const relativeTime = trackTime - baseTime;
      const bytesSent = t.bytesSent as number | undefined;
      const bytesReceived = t.bytesReceived as number | undefined;
      const packetsSent = t.packetsSent as number | undefined;
      const packetsReceived = t.packetsReceived as number | undefined;

      if (typeof relativeTime === 'number' && relativeTime >= 0) {
        const bitrate = typeof bytesSent === 'number' && typeof bytesReceived === 'number'
          ? (bytesSent + bytesReceived) * 8 / Math.max(relativeTime, 1) * 1000
          : NaN;
        connBitrates[idx].push(bitrate);

        const pktRate = typeof packetsSent === 'number' && typeof packetsReceived === 'number'
          ? (packetsSent + packetsReceived) / Math.max(relativeTime, 1) * 1000
          : NaN;
        connPacketRates[idx].push(pktRate);
      }
    }

    for (const fname of featureNames) {
      const fdata = featuresList[fname] as Record<string, unknown> | null | undefined;
      if (!fdata) continue;

      const entries = Object.entries(fdata) as [string, Record<string, unknown>][];
      for (const [ts, f] of entries) {
        const timestamp = Number(ts);
        if (isNaN(timestamp) || timestamp < 0) continue;

        const relativeTime = timestamp - baseTime;
        if (relativeTime < 0) continue;

        const fe = f as Record<string, unknown>;
        const bytesVal = fe.bytes as number | undefined;
        const packets = fe.packets as number | undefined;

        if (typeof bytesVal === 'number' && typeof packets === 'number') {
          connBitrates[idx].push(bytesVal * 8);
          connPacketRates[idx].push(packets);
        }
      }
    }
  }

  const bitrateData: TimeSeriesPoint[] = [];
  const packetData: TimeSeriesPoint[] = [];

  for (const series of connBitrates) {
    for (let i = 0; i < series.length; i++) {
      const t = i * 0.05;
      const b = series[i];
      if (!isNaN(b)) {
        const bi = Math.floor(t * 20) * 20;
        const existing = bitrateData.find(d => Math.abs(d[0] - bi) < 1);
        if (existing) {
          existing[1] += b;
        } else {
          bitrateData.push([bi, b]);
        }
      }
    }
  }

  for (const series of connPacketRates) {
    for (let i = 0; i < series.length; i++) {
      const t = i * 0.05;
      const p = series[i];
      if (!isNaN(p)) {
        const bi = Math.floor(t * 20) * 20;
        const existing = packetData.find(d => Math.abs(d[0] - bi) < 1);
        if (existing) {
          existing[1] += p;
        } else {
          packetData.push([bi, p]);
        }
      }
    }
  }

  bitrateData.sort((a, b) => a[0] - b[0]);
  packetData.sort((a, b) => a[0] - b[0]);

  const bitrateX = bitrateData.map(d => d[0]);
  const bitrateY = bitrateData.map(d => d[1]);
  const packetX = packetData.map(d => d[0]);
  const packetY = packetData.map(d => d[1]);

  return [bitrateX, bitrateY, packetX, packetY];
}

export function EvidenceCharts({ dumpData }: EvidenceChartsProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<uPlot | null>(null);

  const renderCharts = useCallback(() => {
    if (!containerRef.current) return;

    if (chartRef.current) {
      chartRef.current.destroy();
      chartRef.current = null;
    }

    if (!dumpData?.features?.connections || dumpData.features.connections.length === 0) {
      const noDataEl = document.createElement('div');
      noDataEl.className = 'evidence-charts-empty';
      noDataEl.textContent = 'No connection data available for charting.';
      noDataEl.style.cssText = 'padding: 2rem; text-align: center; color: #6b7280; font-style: italic;';

      while (containerRef.current.firstChild) {
        containerRef.current.removeChild(containerRef.current.firstChild);
      }
      containerRef.current.appendChild(noDataEl);
      return;
    }

    const [bitrateX, bitrateY] = buildTimeSeriesData(dumpData.features);

    const seriesOptions: uPlot.Series[] = [
      { show: true },
      {
        label: 'Bitrate',
        scale: 'bits',
        stroke: '#6366f1',
        fill: '#6366f188',
        width: 2,
        points: { show: false },
        spanGaps: false,
      },
    ];

    const chartsDiv = document.createElement('div');
    chartsDiv.style.cssText = 'display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; width: 100%;';

    const leftChart = document.createElement('div');
    leftChart.className = 'evidence-chart';
    leftChart.style.cssText = 'height: 300px; border: 1px solid #e5e7eb; border-radius: 6px;';

    const rightChart = document.createElement('div');
    rightChart.className = 'evidence-chart';
    rightChart.style.cssText = 'height: 300px; border: 1px solid #e5e7eb; border-radius: 6px;';

    chartsDiv.appendChild(leftChart);
    chartsDiv.appendChild(rightChart);

    while (containerRef.current.firstChild) {
      containerRef.current.removeChild(containerRef.current.firstChild);
    }
    containerRef.current.appendChild(chartsDiv);

    const dataSets: uPlot.AlignedData = [bitrateX, bitrateY];

    const opts: uPlot.Options = {
      width: 600,
      height: 300,
      padding: [8, 8, 24, 8],
      legend: { show: true },
      series: seriesOptions,
      scales: {
        x: { time: false },
        bits: {
          range: [0, null],
        },
      },
      axes: [
        {
          scale: 'x',
          size: 40,
          label: 'Time (s)',
          font: '11px sans-serif',
          stroke: '#d1d5db',
          ticks: { show: false },
          grid: { show: true, stroke: '#f3f4f6' },
        },
        {
          scale: 'bits',
          size: 50,
          label: 'Bitrate (bits/s)',
          font: '11px sans-serif',
          stroke: '#d1d5db',
          ticks: { show: true, size: 3 },
          grid: { show: true, stroke: '#f3f4f6' },
        },
      ],
      hooks: {
        init: [(u: uPlot) => {
          const el = u.ctx?.canvas?.parentElement as HTMLElement;
          if (el) {
            el.style.width = '100%';
            el.style.height = '100%';
          }
        }],
      },
    };

    try {
      chartRef.current = new uPlot(opts, dataSets, leftChart);
    } catch {
      // Gracefully handle chart init failure
    }
  }, [dumpData]);

  useEffect(() => {
    renderCharts();
    return () => {
      if (chartRef.current) {
        chartRef.current.destroy();
        chartRef.current = null;
      }
    };
  }, [renderCharts]);

  return <div ref={containerRef} className="evidence-charts" />;
}