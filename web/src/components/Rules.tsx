import { formatMoney } from "@/lib/format";
import type { AccountConfig, TokenRule } from "@/lib/types";

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function limit(value: string | null, rule: TokenRule, never = "No cap") {
  return value === null ? never : formatMoney(value, rule.token);
}

/** "08:00 to 18:00 UTC" from a list of allowed hours. */
export function hoursText(hours: number[]): string {
  if (hours.length === 0 || hours.length === 24) return "Any time";
  const sorted = [...hours].sort((a, b) => a - b);
  const contiguous = sorted.every((h, i) => i === 0 || h === sorted[i - 1] + 1);
  const pad = (h: number) => String(h).padStart(2, "0") + ":00";
  return contiguous ? `${pad(sorted[0])} to ${pad(sorted[sorted.length - 1] + 1)} UTC` : `${sorted.length} hours a day (UTC)`;
}

export function daysText(days: number[]): string {
  if (days.length === 0 || days.length === 7) return "Every day";
  return [...days].sort((a, b) => a - b).map((d) => DAYS[d]).join(", ");
}

/** The rules of one token, plus the account-wide settings, as a list. */
export function RulesList({ rule, config }: { rule: TokenRule; config?: AccountConfig }) {
  const rows: [string, string][] = [
    ["Daily budget", limit(rule.daily, rule)],
    ["Weekly budget", limit(rule.weekly, rule)],
    ["Largest single payment", limit(rule.maxSingle, rule)],
    ["Per payee per day", limit(rule.perCounterpartyDaily, rule)],
    ["Ask me above", limit(rule.approvalAbove, rule, "Never")],
  ];
  if (rule.cosignAbove !== null) rows.push(["Second signer above", formatMoney(rule.cosignAbove, rule.token)]);
  if (config) {
    rows.push(["Payments per minute", config.maxPerMinute === null ? "No cap" : String(config.maxPerMinute)]);
    rows.push(["Active hours", hoursText(config.hoursUtc)]);
    rows.push(["Active days", daysText(config.weekdays)]);
    rows.push(["Who it may pay", config.payeeAllowlist ? "Allowlist only" : "Anyone the firewall allows"]);
    rows.push(["Firewall", config.firewall ? "On" : "Off"]);
  }
  return (
    <dl className="kv">
      {rows.map(([label, value]) => (
        <div className="kv__row" key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** The dollar rule of an account (USDG), or the first enabled one. */
export function dollarRule(rules: TokenRule[]): TokenRule | null {
  return rules.find((r) => r.token.symbol.toUpperCase() === "USDG") ?? rules.find((r) => r.enabled) ?? null;
}
