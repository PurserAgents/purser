import { formatTime, usd, usdNumber } from "@/lib/format";

/** Spend and earnings over time as two lines (dollar strings from the engine). Display math only. */
export function SeriesChart({ series, label }: { series: { t: number; spendUsd: string; earnUsd: string }[]; label: string }) {
  const w = 600;
  const h = 160;
  const max = Math.max(...series.flatMap((p) => [usdNumber(p.spendUsd), usdNumber(p.earnUsd)]), 0.01);
  const x = (i: number) => (series.length < 2 ? w / 2 : (i / (series.length - 1)) * w);
  const y = (v: number) => h - 6 - (v / max) * (h - 16);
  const path = (key: "spendUsd" | "earnUsd") => series.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(usdNumber(p[key])).toFixed(1)}`).join(" ");
  const area = `${path("spendUsd")} L${w} ${h} L0 ${h} Z`;
  return (
    <figure className="chart">
      <div className="legend">
        <span>
          <i />
          Paid by agents
        </span>
        <span>
          <i className="b" />
          Earned by agents
        </span>
      </div>
      <svg className="spark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" role="img" aria-label={label}>
        {[0.25, 0.5, 0.75].map((f) => (
          <line key={f} className="spark__grid" x1="0" x2={w} y1={h * f} y2={h * f} />
        ))}
        <path className="spark__area" d={area} />
        <path className="spark__line" d={path("spendUsd")} />
        <path className="spark__line spark__line--b" d={path("earnUsd")} />
      </svg>
      {series.length ? (
        <figcaption className="chart__axis">
          <span>{formatTime(series[0].t)}</span>
          <span>Peak {usd(String(max))}</span>
          <span>{formatTime(series[series.length - 1].t)}</span>
        </figcaption>
      ) : null}
    </figure>
  );
}
