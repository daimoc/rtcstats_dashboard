import { useEffect, useRef, useState } from 'react';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import type { ChartSpec, ConnectionSeries } from '../lib/dumpSeries.js';
import { describeDumpState, type DumpState } from '../lib/useDumpData.js';
import styles from './EvidenceCharts.module.css';

export interface EvidenceChartsProps {
  dump: DumpState;
  /** Dump-side connection id (`PC_0`); charts follow the peer-connection selector. */
  selectedPid: string;
}

interface ChartPalette {
  series: string[];
  grid: string;
  axis: string;
}

/**
 * uPlot paints to a canvas, so it cannot inherit CSS. Read the current values of
 * the design tokens instead, and re-read them whenever the theme changes.
 */
function readPalette(): ChartPalette {
  const computed = getComputedStyle(document.documentElement);
  const token = (name: string, fallback: string) => computed.getPropertyValue(name).trim() || fallback;

  return {
    // Categorical tokens, never the status ones: a red line in a severity-coloured
    // dashboard reads as a fault rather than as "inbound video".
    series: [
      token('--series-1', '#3987e5'),
      token('--series-2', '#c98500'),
      token('--series-3', '#d55181'),
      token('--series-4', '#008300')
    ],
    grid: token('--border', '#262f3d'),
    axis: token('--text-faint', '#6b7787')
  };
}

/** Keeps large counters (bits/s) readable on a narrow axis. */
function formatCompact(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1e9) return `${(value / 1e9).toFixed(1)}G`;
  if (abs >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${(value / 1e3).toFixed(0)}k`;
  return String(Math.round(value * 100) / 100);
}

const AXIS_FONT = '11px system-ui, sans-serif';
/** Shared key so hovering one chart moves the cursor on all of them. */
const SYNC_KEY = 'rtcstats-evidence';

function buildOptions(spec: ChartSpec, palette: ChartPalette, width: number): uPlot.Options {
  return {
    width,
    height: 190,
    padding: [8, 8, 0, 8],
    legend: { show: true },
    cursor: { sync: { key: SYNC_KEY }, y: false },
    series: [
      {},
      ...spec.series.map((series) => ({
        label: series.label,
        stroke: palette.series[series.colorSlot % palette.series.length],
        width: 2,
        points: { show: false },
        spanGaps: true
      }))
    ],
    scales: {
      x: { time: false },
      // Always anchored at zero so magnitudes stay comparable, with a ceiling drawn from
      // the data: uPlot's default would give an all-zero series a 0-100 axis, which reads
      // as though 100 lost packets/s were the expected scale.
      y: {
        range: (_u: uPlot, _min: number, max: number): [number, number] =>
          spec.range ?? [0, Number.isFinite(max) && max > 0 ? max * 1.08 : 1]
      }
    },
    axes: [
      {
        scale: 'x',
        size: 34,
        label: 'Time (s)',
        font: AXIS_FONT,
        labelFont: AXIS_FONT,
        stroke: palette.axis,
        ticks: { show: false },
        grid: { show: true, stroke: palette.grid }
      },
      {
        scale: 'y',
        size: 62,
        label: spec.unit,
        font: AXIS_FONT,
        labelFont: AXIS_FONT,
        stroke: palette.axis,
        ticks: { show: true, size: 3, stroke: palette.grid },
        grid: { show: true, stroke: palette.grid },
        values: (_u: uPlot, splits: number[]) => splits.map(formatCompact)
      }
    ]
  };
}

function Chart({ spec, x, themeVersion }: { spec: ChartSpec; x: number[]; themeVersion: number }) {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const node = host.current;
    if (!node) return;

    const data = [x, ...spec.series.map((s) => s.values)] as unknown as uPlot.AlignedData;

    let chart: uPlot;
    try {
      chart = new uPlot(buildOptions(spec, readPalette(), node.clientWidth || 600), data, node);
    } catch {
      // A malformed dump should not take the rest of the page down with it.
      return;
    }

    const resize = new ResizeObserver((entries) => {
      const width = Math.floor(entries[0].contentRect.width);
      if (width > 0) chart.setSize({ width, height: 190 });
    });
    resize.observe(node);

    return () => {
      resize.disconnect();
      chart.destroy();
    };
  }, [spec, x, themeVersion]);

  return (
    <figure className={styles.figure}>
      <figcaption className={styles.chartTitle}>{spec.title}</figcaption>
      <div ref={host} className={styles.chart} />
    </figure>
  );
}

/**
 * Time-series evidence for the selected peer connection, read from the raw dump.
 *
 * The `features_*` tree the API returns holds only per-connection aggregates, so there is
 * nothing there to plot over time; every series here comes from the dump's `getStats`
 * reports, decoded and differentiated in the parse worker.
 */
export function EvidenceCharts({ dump, selectedPid }: EvidenceChartsProps) {
  const [themeVersion, setThemeVersion] = useState(0);

  // Both the explicit toggle (data-theme) and the OS preference change colours.
  useEffect(() => {
    const bump = () => setThemeVersion((v) => v + 1);

    const observer = new MutationObserver(bump);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

    const media = matchMedia('(prefers-color-scheme: light)');
    media.addEventListener('change', bump);

    return () => {
      observer.disconnect();
      media.removeEventListener('change', bump);
    };
  }, []);

  const notice = describeDumpState(dump);
  if (notice) return <p className={styles.empty}>{notice}</p>;

  const connections = dump.status === 'ready' ? dump.result.connections : {};
  const series: ConnectionSeries | undefined = connections[selectedPid];

  if (!series) {
    return <p className={styles.empty}>No stats were recorded for this peer connection.</p>;
  }

  return (
    <div className={styles.wrap}>
      {series.charts.map((spec) => (
        <Chart key={`${selectedPid}-${spec.key}`} spec={spec} x={series.x} themeVersion={themeVersion} />
      ))}
    </div>
  );
}
