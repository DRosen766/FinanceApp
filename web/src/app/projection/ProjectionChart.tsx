// Server-rendered SVG line chart. No client JS: hover is CSS-only (a per-month hit column
// reveals a hairline and point markers) plus a native <title> tooltip with every series' value.
import { money } from "@/lib/format";

/** `label` is shown in the legend and tooltip; `shortLabel` (optional) at the line end. */
export type ChartSeries = { key: string; label: string; shortLabel?: string; values: number[]; slot: 1 | 2 };

const W = 720;
const H = 300;
const M = { top: 16, right: 150, bottom: 32, left: 72 };
const PW = W - M.left - M.right;
const PH = H - M.top - M.bottom;

/** Compact axis money: $950, $12.3k, $1.25M. */
function axisMoney(v: number): string {
  const sign = v < 0 ? "−" : "";
  const a = Math.abs(v);
  if (a >= 1e6) return `${sign}$${+(a / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `${sign}$${+(a / 1e3).toFixed(1)}k`;
  return `${sign}$${Math.round(a)}`;
}

/** ~5 "nice" ticks covering [lo, hi]. */
function niceTicks(lo: number, hi: number): number[] {
  if (lo === hi) {
    const pad = Math.max(1, Math.abs(lo) * 0.1);
    lo -= pad;
    hi += pad;
  }
  const raw = (hi - lo) / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((f) => f * mag).find((s) => s >= raw) ?? 10 * mag;
  const ticks: number[] = [];
  for (let t = Math.floor(lo / step) * step; t <= hi + step * 1e-9; t += step) ticks.push(t);
  if (ticks[ticks.length - 1] < hi) ticks.push(ticks[ticks.length - 1] + step);
  return ticks;
}

/** "Feb 2027": a 2-digit year ("Feb 27") reads like a day of the month. */
function monthLabel(today: Date, m: number): string {
  const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + m, 1));
  return d.toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
}

export function ProjectionChart({
  series,
  months,
  today,
}: {
  series: ChartSeries[];
  months: number;
  today: Date;
}) {
  const all = series.flatMap((s) => s.values);
  const ticks = niceTicks(Math.min(...all), Math.max(...all));
  const yMin = ticks[0];
  const yMax = ticks[ticks.length - 1];
  const x = (m: number) => M.left + (m / months) * PW;
  const y = (v: number) => M.top + (1 - (v - yMin) / (yMax - yMin)) * PH;
  const labelEvery = months <= 12 ? 3 : months <= 24 ? 6 : 12;
  const step = PW / months;

  // Direct end labels; nudge apart when they would collide.
  const ends = series.map((s) => ({ s, ly: y(s.values[months]) }));
  if (ends.length === 2 && Math.abs(ends[0].ly - ends[1].ly) < 16) {
    const [hiE, loE] = ends[0].ly < ends[1].ly ? [ends[0], ends[1]] : [ends[1], ends[0]];
    const mid = (hiE.ly + loE.ly) / 2;
    hiE.ly = mid - 8;
    loE.ly = mid + 8;
  }

  return (
    <figure className="chart">
      {series.length > 1 && (
        <figcaption className="legend">
          {series.map((s) => (
            <span key={s.key}>
              <svg width="18" height="10" aria-hidden="true">
                <line x1="1" y1="5" x2="17" y2="5" className={`series-${s.slot}`} strokeWidth="2" strokeLinecap="round" />
              </svg>
              {s.label}
            </span>
          ))}
        </figcaption>
      )}
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`Projected value over ${months} months: ${series.map((s) => s.label).join(", ")}. Values are listed in the table below.`}
      >
        {ticks.map((t) => (
          <g key={t}>
            <line x1={M.left} x2={M.left + PW} y1={y(t)} y2={y(t)} className={t === 0 ? "zero" : "grid"} />
            <text x={M.left - 8} y={y(t)} dy="0.32em" textAnchor="end" className="axis">
              {axisMoney(t)}
            </text>
          </g>
        ))}
        {Array.from({ length: months + 1 }, (_, m) => m)
          .filter((m) => m % labelEvery === 0)
          .map((m) => (
            <text key={m} x={x(m)} y={H - 10} textAnchor="middle" className="axis">
              {m === 0 ? "Today" : monthLabel(today, m)}
            </text>
          ))}

        {series.map((s) => (
          <polyline
            key={s.key}
            points={s.values.map((v, m) => `${x(m)},${y(v)}`).join(" ")}
            className={`line series-${s.slot}`}
          />
        ))}
        {ends.map(({ s, ly }) => (
          <g key={s.key}>
            <circle cx={x(months)} cy={y(s.values[months])} r="4" className={`dot series-${s.slot}`} />
            <text x={x(months) + 10} y={ly} dy="0.32em" className="end-label">
              {(() => {
                const t = s.shortLabel ?? s.label;
                return t.length > 22 ? `${t.slice(0, 21)}…` : t;
              })()}
            </text>
          </g>
        ))}

        {/* Hover layer: one hit column per month, wider than the marks. */}
        {Array.from({ length: months + 1 }, (_, m) => (
          <g key={m} className="hit">
            <title>
              {`${m === 0 ? "Today" : monthLabel(today, m)}\n` +
                series.map((s) => `${s.label}: ${money(s.values[m])}`).join("\n")}
            </title>
            <rect x={x(m) - step / 2} y={M.top} width={step} height={PH} className="hit-area" />
            <line x1={x(m)} x2={x(m)} y1={M.top} y2={M.top + PH} className="hover hairline" />
            {series.map((s) => (
              <circle key={s.key} cx={x(m)} cy={y(s.values[m])} r="4.5" className={`hover dot series-${s.slot}`} />
            ))}
          </g>
        ))}
      </svg>
    </figure>
  );
}
