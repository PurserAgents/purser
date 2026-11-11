import { formatDay, usd, usdNumber } from "@/lib/format";
import { IconChart } from "./Icons";
import { EmptyState } from "./ui";

/** Income and spend per day (dollar strings from the engine's P&L) as paired columns. Heights are display math only. */
export function DayChart({ series }: { series: { day: string; incomeUsd: string; spendUsd: string }[] }) {
  if (series.length === 0) return <EmptyState size="sm" icon={IconChart} title="No activity in this period yet" text="Income and spend appear here per day once the agent pays or gets paid." />;
  const values = series.flatMap((p) => [usdNumber(p.incomeUsd), usdNumber(p.spendUsd)]);
  const max = Math.max(...values, 1);
  return (
    <figure className="chart">
      <div className="legend">
        <span>
          <i />
          Income
        </span>
        <span>
          <i className="b" />
          Spend
        </span>
      </div>
      <div className="chart__plot" role="img" aria-label={`Income and spend per day, ${series.length} days`}>
        {series.map((point) => (
          <div className="chart__col" key={point.day} title={`${formatDay(point.day)}: income ${usd(point.incomeUsd)}, spend ${usd(point.spendUsd)}`}>
            <span className="chart__bar" style={{ height: `${(usdNumber(point.incomeUsd) / max) * 100}%` }} />
            <span className="chart__bar chart__bar--b" style={{ height: `${(usdNumber(point.spendUsd) / max) * 100}%` }} />
          </div>
        ))}
      </div>
      <figcaption className="chart__axis">
        <span>{formatDay(series[0].day)}</span>
        <span>{formatDay(series[Math.floor(series.length / 2)].day)}</span>
        <span>{formatDay(series[series.length - 1].day)}</span>
      </figcaption>
    </figure>
  );
}
