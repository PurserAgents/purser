"use client";

import { useState } from "react";
import { api } from "@/lib/client";
import { money, parseUnits, percentOf, usd } from "@/lib/format";
import { withOwner } from "@/lib/owner";
import type { OrgChartNode, Page, Pnl, PreparedSafeTx, Team } from "@/lib/types";
import { IconPlus, IconUsers } from "../Icons";
import { useEngine } from "../Live";
import { Card, EmptyState, Loading, Meter } from "../ui";
import { ActionStatus, useAction } from "./Action";
import { OwnerFrame, useOwner } from "./Frame";

export function Teams() {
  return (
    <OwnerFrame title="Agents that work as a team." lead="A shared treasury (one of your agent accounts), departments with daily budgets, and members whose budgets are enforced on chain.">
      <Body />
    </OwnerFrame>
  );
}

function Body() {
  const owner = useOwner();
  const teams = useEngine<Page<Team>>(`/v1/teams?owner=${owner.address}`, { refreshOn: ["receipt", "account"] });
  const list = teams.data?.items ?? [];
  return (
    <div className="dash">
      {!teams.data ? (
        <Loading />
      ) : list.length === 0 ? (
        <EmptyState panel icon={IconUsers} title="No teams yet" text="Pick one of your agents as the team's treasury. Then add departments with daily budgets and the agents that work in them." />
      ) : (
        list.map((t) => <TeamView key={t.id} team={t} reload={teams.reload} />)
      )}
      <CreateTeam reload={teams.reload} />
    </div>
  );
}

function OrgChart({ node }: { node: OrgChartNode }) {
  return (
    <div className="org" role="tree" aria-label="Org chart">
      <div className="org__node org__node--team" role="treeitem" aria-selected="false">
        <span className="org__kind">Team</span>
        <span className="org__label">{node.label}</span>
      </div>
      {node.children.length ? (
        <div className="org__level" style={{ ["--org-left" as string]: `${50 / node.children.length}%`, ["--org-right" as string]: `${50 / node.children.length}%` }}>
          {node.children.map((c) => (
            <div className="org__branch" key={c.id}>
              <div className="org__node" role="treeitem" aria-selected="false">
                <span className="org__kind">{c.kind === "department" ? "Department" : "Agent"}</span>
                <span className="org__label">{c.label}</span>
              </div>
              {c.children.length ? (
                <div className="org__leaves">
                  {c.children.map((leaf) => (
                    <div className="org__node" key={leaf.id} role="treeitem" aria-selected="false">
                      <span className="org__kind">Agent</span>
                      <span className="org__label">{leaf.label}</span>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function TeamView({ team, reload }: { team: Team; reload(): void }) {
  const owner = useOwner();
  const org = useEngine<OrgChartNode>(`/v1/teams/${team.id}/org`, { refreshOn: ["account"] });
  const pnl = useEngine<Pnl>(`/v1/teams/${team.id}/pnl`, { refreshOn: ["receipt"] });
  const action = useAction();
  const [dept, setDept] = useState({ name: "", budget: "" });
  const [member, setMember] = useState({ safe: "", departmentId: "", role: "Agent", budget: "" });
  const candidates = owner.accounts.filter((a) => a.safe.toLowerCase() !== team.treasury.toLowerCase() && !team.members.some((m) => m.safe.toLowerCase() === a.safe.toLowerCase()));

  const addDept = () =>
    action.run(async () => {
      await withOwner(owner.signer, (token) => api(`/v1/teams/${team.id}/departments`, { token, body: { name: dept.name.trim(), dailyBudget: dept.budget ? parseUnits(dept.budget, 6).toString() : null } }));
      setDept({ name: "", budget: "" });
      reload();
      org.reload();
      return "Department added.";
    }, "Sign in with your wallet...");
  const addMember = () =>
    action.run(async (status) => {
      const r = await withOwner(owner.signer, (token) =>
        api<{ team: Team; treasuryTx: PreparedSafeTx }>(`/v1/teams/${team.id}/members`, {
          token,
          body: { safe: member.safe, departmentId: member.departmentId || null, role: member.role.trim() || "Agent", dailyBudget: member.budget ? parseUnits(member.budget, 6).toString() : null },
        }),
      );
      status("Set the member's budget on the treasury. Confirm in your wallet...");
      await owner.signer.execSafeTx(r.treasuryTx);
      setMember({ safe: "", departmentId: "", role: "Agent", budget: "" });
      reload();
      org.reload();
      return "Member added. Its daily budget is enforced on chain.";
    }, "Sign in with your wallet...");

  return (
    <section className="dash" aria-label={team.name}>
      <div className="section-label">
        <h2 className="h3">{team.name}</h2>
        <span className="small muted">Treasury: {owner.names[team.treasury.toLowerCase()] ?? team.treasury}</span>
      </div>
      <dl className="cells cells--4">
        <div className="cell">
          <dt className="stat__label">Members</dt>
          <dd className="stat__value num">{team.members.length}</dd>
        </div>
        <div className="cell">
          <dt className="stat__label">Departments</dt>
          <dd className="stat__value num">{team.departments.length}</dd>
        </div>
        <div className="cell">
          <dt className="stat__label">Team income, 30 days</dt>
          <dd className="stat__value">{pnl.data ? usd(pnl.data.incomeUsd) : "..."}</dd>
        </div>
        <div className="cell">
          <dt className="stat__label">Team spend, 30 days</dt>
          <dd className="stat__value">{pnl.data ? usd(pnl.data.spendUsd) : "..."}</dd>
          <dd className="stat__note">Payments inside the team cancel out</dd>
        </div>
      </dl>
      <Card title="Org chart">{org.data ? <OrgChart node={org.data} /> : <div className="empty empty--sm" />}</Card>
      <div className="grid-2">
        <Card title="Departments" flush>
          {team.departments.length === 0 ? (
            <EmptyState size="sm" title="No departments" text="Group members and give each group a daily budget." />
          ) : (
            <div className="rows">
              {team.departments.map((d) => (
                <div className="rowi" key={d.id} style={{ gridTemplateColumns: "minmax(0,1fr) auto" }}>
                  <div className="rowi__main">
                    <span className="rowi__title">{d.name}</span>
                    {d.dailyBudget ? <Meter percent={percentOf(d.spentToday.amount, d.dailyBudget.amount)} label={`${d.name} budget used`} limit /> : null}
                  </div>
                  <div className="rowi__side">
                    <span className="small num">{money(d.spentToday)}</span>
                    <span className="micro muted">{d.dailyBudget ? `of ${money(d.dailyBudget, 0)} today` : "no daily cap"}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
        <Card title="Members" flush>
          {team.members.length === 0 ? (
            <EmptyState size="sm" title="No members" text="Add your agents. The treasury tops them up as internal payments." />
          ) : (
            <div className="rows">
              {team.members.map((m) => (
                <div className="rowi" key={m.safe} style={{ gridTemplateColumns: "minmax(0,1fr) auto" }}>
                  <div className="rowi__main">
                    <span className="rowi__title">{m.name}</span>
                    <span className="rowi__meta">
                      {m.role}
                      {m.departmentId ? `, ${team.departments.find((d) => d.id === m.departmentId)?.name ?? ""}` : ""}
                    </span>
                  </div>
                  <div className="rowi__side">
                    <span className="small num">{money(m.spentToday)}</span>
                    <span className="micro muted">{m.dailyBudget ? `of ${money(m.dailyBudget, 0)} today` : "no daily cap"}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
      <Card title="Add to the team">
        <div className="grid-2">
          <form
            className="form"
            onSubmit={(e) => {
              e.preventDefault();
              if (dept.name.trim()) void addDept();
            }}
          >
            <span className="field__label">A department</span>
            <div className="form__row">
              <input className="input" aria-label="Department name" placeholder="Name" value={dept.name} maxLength={60} onChange={(e) => setDept({ ...dept, name: e.target.value })} />
              <span className="input-affix">
                <input className="input" aria-label="Daily budget" placeholder="Daily budget" inputMode="decimal" value={dept.budget} onChange={(e) => setDept({ ...dept, budget: e.target.value.replace(/[^0-9.]/g, "") })} />
                <span className="input-affix__unit">USDG</span>
              </span>
            </div>
            <div className="row">
              <button type="submit" className="btn btn--secondary btn--sm" disabled={!dept.name.trim() || action.busy}>
                <IconPlus size={14} />
                Add department
              </button>
            </div>
          </form>
          <form
            className="form"
            onSubmit={(e) => {
              e.preventDefault();
              if (member.safe) void addMember();
            }}
          >
            <span className="field__label">A member</span>
            <div className="form__row">
              <select className="select" aria-label="Agent" value={member.safe} onChange={(e) => setMember({ ...member, safe: e.target.value })}>
                <option value="">{candidates.length ? "Choose an agent" : "Every agent is in"}</option>
                {candidates.map((a) => (
                  <option key={a.safe} value={a.safe}>
                    {a.name}
                  </option>
                ))}
              </select>
              <select className="select" aria-label="Department" value={member.departmentId} onChange={(e) => setMember({ ...member, departmentId: e.target.value })}>
                <option value="">No department</option>
                {team.departments.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="form__row">
              <input className="input" aria-label="Role" placeholder="Role" value={member.role} maxLength={40} onChange={(e) => setMember({ ...member, role: e.target.value })} />
              <span className="input-affix">
                <input className="input" aria-label="Member daily budget" placeholder="Daily budget" inputMode="decimal" value={member.budget} onChange={(e) => setMember({ ...member, budget: e.target.value.replace(/[^0-9.]/g, "") })} />
                <span className="input-affix__unit">USDG</span>
              </span>
            </div>
            <div className="row">
              <button type="submit" className="btn btn--secondary btn--sm" disabled={!member.safe || action.busy}>
                <IconPlus size={14} />
                Add member
              </button>
            </div>
          </form>
        </div>
        <ActionStatus state={action.state} />
      </Card>
    </section>
  );
}

function CreateTeam({ reload }: { reload(): void }) {
  const owner = useOwner();
  const [name, setName] = useState("");
  const [treasury, setTreasury] = useState<string>(owner.accounts[0]?.safe ?? "");
  const action = useAction();
  const create = () =>
    action.run(async () => {
      await withOwner(owner.signer, (token) => api<Team>("/v1/teams", { token, body: { name: name.trim(), treasury } }));
      setName("");
      reload();
      return "Team created.";
    }, "Sign in with your wallet...");
  return (
    <Card title="New team">
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim() && treasury) void create();
        }}
      >
        <div className="form__row">
          <label className="field">
            <span className="field__label">Name</span>
            <input className="input" value={name} maxLength={60} placeholder="Research desk" onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="field">
            <span className="field__label">Treasury</span>
            <select className="select" value={treasury} onChange={(e) => setTreasury(e.target.value)}>
              {owner.accounts.map((a) => (
                <option key={a.safe} value={a.safe}>
                  {a.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <span className="field__hint">The treasury is one of your agent accounts. It pays the members, within the budgets you give them.</span>
        <div className="row">
          <button type="submit" className="btn btn--primary" disabled={!name.trim() || action.busy}>
            Create the team
          </button>
        </div>
        <ActionStatus state={action.state} />
      </form>
    </Card>
  );
}
