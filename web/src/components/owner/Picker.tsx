"use client";

import type { AccountSummary } from "@/lib/types";

/** Chooses one of the owner's agents, or all of them when `all` is set. */
export function AgentPicker({ accounts, value, onChange, all, label = "Agent" }: { accounts: AccountSummary[]; value: string; onChange(safe: string): void; all?: boolean; label?: string }) {
  return (
    <label className="picker">
      <span className="field__label">{label}</span>
      <select className="select" value={value} onChange={(e) => onChange(e.target.value)}>
        {all ? <option value="">All agents</option> : null}
        {accounts.map((a) => (
          <option key={a.safe} value={a.safe}>
            {a.name}
          </option>
        ))}
      </select>
    </label>
  );
}
