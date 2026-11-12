import { compareDecimals } from "@/shared/decimal/decimal";

// Phase 20 (policy 7): a plain inline SVG bar chart, no chart library. One series, so no
// legend: the heading names it. The data table stays below it for exact values and screen
// readers; each bar also carries a native tooltip. Values are decimal strings and are only
// converted to numbers for geometry, never for figures shown as text.

export type BarDatum = { label: string; value: string; display: string };

const WIDTH = 720;
const HEIGHT = 220;
const PAD = { top: 24, right: 8, bottom: 28, left: 8 };
const GAP = 2;

export function BarChart({ title, data }: { title: string; data: readonly BarDatum[] }) {
  if (data.length === 0) {
    return null;
  }

  const values = data.map((datum) => Math.max(0, Number(datum.value)));
  const max = Math.max(...values);
  const peakIndex = data.reduce(
    (best, datum, index) => (compareDecimals(datum.value, data[best]!.value) > 0 ? index : best),
    0,
  );
  const plotWidth = WIDTH - PAD.left - PAD.right;
  const plotHeight = HEIGHT - PAD.top - PAD.bottom;
  const slot = plotWidth / data.length;
  const barWidth = Math.max(1, slot - GAP);
  const summary =
    max > 0
      ? `${title}: highest at ${data[peakIndex]!.label}, ${data[peakIndex]!.display}.`
      : `${title}: nothing in this range.`;

  return (
    <figure className="mb-3 rounded-lg border border-neutral-200 bg-surface p-3 shadow-sm">
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        role="img"
        aria-label={summary}
        className="h-auto w-full"
        preserveAspectRatio="none"
      >
        <line
          x1={PAD.left}
          x2={WIDTH - PAD.right}
          y1={PAD.top + plotHeight}
          y2={PAD.top + plotHeight}
          className="stroke-neutral-300"
          strokeWidth={1}
        />
        {data.map((datum, index) => {
          const height = max > 0 ? (values[index]! / max) * plotHeight : 0;
          const x = PAD.left + index * slot + GAP / 2;
          const y = PAD.top + plotHeight - height;
          const radius = Math.min(4, barWidth / 2, height);

          return (
            <g key={datum.label}>
              {/* A full-height hit target, larger than the bar. */}
              <rect x={x} y={PAD.top} width={barWidth} height={plotHeight} fill="transparent">
                <title>{`${datum.label}: ${datum.display}`}</title>
              </rect>
              {height > 0 && (
                <path
                  d={`M${x},${y + height} V${y + radius} Q${x},${y} ${x + radius},${y} H${x + barWidth - radius} Q${x + barWidth},${y} ${x + barWidth},${y + radius} V${y + height} Z`}
                  className="pointer-events-none fill-brand-600"
                />
              )}
              {index % 3 === 0 && (
                <text
                  x={x + barWidth / 2}
                  y={HEIGHT - 8}
                  textAnchor="middle"
                  className="fill-neutral-600 text-[11px]"
                >
                  {datum.label}
                </text>
              )}
              {index === peakIndex && max > 0 && (
                <text
                  x={x + barWidth / 2}
                  y={y - 6}
                  textAnchor="middle"
                  className="fill-neutral-800 text-[11px] font-medium"
                >
                  {datum.display}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      <figcaption className="mt-1 text-xs text-neutral-600">{summary} Exact figures are in the table below.</figcaption>
    </figure>
  );
}
