"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/client";
import { AT_COST_MODELS } from "@/lib/models";
import { withOwner } from "@/lib/owner";
import { useEngine } from "../Live";
import { Card, Loading } from "../ui";
import { ActionStatus, useAction } from "./Action";
import { useOwner } from "./Frame";

interface Budget {
  model: string;
  dailyUsd: string | null;
  perTaskUsd: string | null;
}
interface Spend {
  today: { model: string; calls: number; usd: string }[];
  owedUsd: string;
}

const clean = (v: string | null) => (v === null ? "" : String(Number(v)));
const toNumber = (v: string) => (v.trim() === "" ? null : Number(v));

/** Models at cost for one agent: today's spend per model, what is still unpaid, and the owner's budgets. */
export function ModelBudgets({ safe }: { safe: string }) {
  const owner = useOwner();
  const budgets = useEngine<{ items: Budget[] }>(`/v1/accounts/${safe}/model-budgets`);
  const spend = useEngine<Spend>(`/v1/accounts/${safe}/model-spend`, { refreshOn: ["model", "receipt"] });
  const action = useAction();
  const [form, setForm] = useState<Record<string, { daily: string; task: string }>>({});

  useEffect(() => {
    if (!budgets.data) return;
    const next: Record<string, { daily: string; task: string }> = {};
    for (const m of AT_COST_MODELS) {
      const b = budgets.data.items.find((x) => x.model === m.id);
      next[m.id] = { daily: clean(b?.dailyUsd ?? null), task: clean(b?.perTaskUsd ?? null) };
    }
    setForm(next);
  }, [budgets.data]);

  const save = () =>
    action.run(async () => {
      await withOwner(owner.signer, async (token) => {
        for (const m of AT_COST_MODELS) {
          const f = form[m.id];
          if (!f) continue;
          await api(`/v1/accounts/${safe}/model-budgets`, { method: "PUT", token, body: { model: m.id, dailyUsd: toNumber(f.daily), perTaskUsd: toNumber(f.task) } });
        }
      });
      budgets.reload();
      return "Model budgets saved.";
    }, "Sign in with your wallet...");

  const today = (id: string) => spend.data?.today.find((x) => x.model === id);

  return (
    <Card title="Models at cost" action={spend.data ? <span className="small muted">Unpaid ${Number(spend.data.owedUsd).toFixed(4)}</span> : undefined}>
      {!budgets.data || !spend.data ? (
        <Loading />
      ) : (
        <form
          className="form"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Model</th>
                  <th scope="col" className="right">
                    Today
                  </th>
                  <th scope="col">Daily budget</th>
                  <th scope="col">Budget per task</th>
                </tr>
              </thead>
              <tbody>
                {AT_COST_MODELS.map((m) => {
                  const t = today(m.id);
                  const f = form[m.id] ?? { daily: "", task: "" };
                  return (
                    <tr key={m.id}>
                      <td>
                        <span className="table__primary">{m.name}</span>
                        <span className="table__secondary" style={{ display: "block" }}>
                          ${m.input.toFixed(2)} in, ${m.output.toFixed(2)} out per 1M tokens
                        </span>
                      </td>
                      <td className="right num nowrap">
                        ${Number(t?.usd ?? 0).toFixed(4)} <span className="muted micro">{t?.calls ?? 0}x</span>
                      </td>
                      <td>
                        <span className="input-affix">
                          <input className="input" aria-label={`${m.name} daily budget`} inputMode="decimal" placeholder="No cap" value={f.daily} onChange={(e) => setForm({ ...form, [m.id]: { ...f, daily: e.target.value.replace(/[^0-9.]/g, "") } })} />
                          <span className="input-affix__unit">USD</span>
                        </span>
                      </td>
                      <td>
                        <span className="input-affix">
                          <input className="input" aria-label={`${m.name} budget per task`} inputMode="decimal" placeholder="No cap" value={f.task} onChange={(e) => setForm({ ...form, [m.id]: { ...f, task: e.target.value.replace(/[^0-9.]/g, "") } })} />
                          <span className="input-affix__unit">USD</span>
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="small muted">The provider&apos;s own price, nothing added. When a model is over its budget, a request for a level moves on to the next model up.</p>
          <div className="row">
            <button type="submit" className="btn btn--primary" disabled={action.busy}>
              Save budgets
            </button>
          </div>
          <ActionStatus state={action.state} />
        </form>
      )}
    </Card>
  );
}
