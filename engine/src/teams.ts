import type { Hono } from "hono";
import type { Address } from "viem";
import { z } from "zod";
import type { Department, OrgChartNode, Team, TeamMember } from "../../packages/sdk/src/schema.ts";
import { accountRow, prepareSafeTx, readChainAccount, ruleChangeCalls } from "./accounts.ts";
import { registerRoutes } from "./api/registry.ts";
import { agent, body, owner, param, safeOwner, send, zAddr, zAmount } from "./api/http.ts";
import { requireDep, type Ctx } from "./ctx.ts";
import { submitIntent } from "./intents.ts";
import { fail, id, lower, now, sameAddress } from "./util.ts";

interface TeamRow {
  id: string;
  name: string;
  treasury: string;
  owner: string;
  created_at: number;
}
interface DeptRow {
  id: string;
  team_id: string;
  name: string;
  daily_budget: string | null;
  token: string;
}
interface MemberRow {
  team_id: string;
  safe: string;
  department_id: string | null;
  role: string;
  daily_budget: string | null;
}

const dayStart = (t: number) => t - (t % 86400);

/** What the team treasury sent to a member (or to every member of a department) today. */
function fundedToday(ctx: Ctx, treasury: string, members: string[], token: string): bigint {
  if (!members.length) return 0n;
  const rows = ctx.db
    .prepare(`SELECT COALESCE(SUM(CAST(amount AS INTEGER)),0) AS total FROM receipts WHERE safe = ? AND direction = 'out' AND status = 'executed' AND token = ? AND created_at >= ? AND counterparty IN (${members.map(() => "?").join(",")})`)
    .get(lower(treasury), lower(token), dayStart(now()), ...members.map(lower)) as { total: number };
  return BigInt(rows.total);
}

function spentToday(ctx: Ctx, safe: string, token: string): bigint {
  const r = ctx.db.prepare("SELECT COALESCE(SUM(CAST(amount AS INTEGER)),0) AS total FROM receipts WHERE safe = ? AND direction = 'out' AND status = 'executed' AND token = ? AND created_at >= ?").get(lower(safe), lower(token), dayStart(now())) as { total: number };
  return BigInt(r.total);
}

export function getTeam(ctx: Ctx, tid: string): Team {
  const dep = requireDep(ctx);
  const t = (ctx.db.prepare("SELECT * FROM teams WHERE id = ?").get(tid) as TeamRow | undefined) ?? fail(404, "not_found", "No such team.");
  const depts = ctx.db.prepare("SELECT * FROM departments WHERE team_id = ? ORDER BY name").all(tid) as DeptRow[];
  const members = ctx.db.prepare("SELECT * FROM team_members WHERE team_id = ? ORDER BY role, safe").all(tid) as MemberRow[];
  const departments: Department[] = depts.map((d) => {
    const ms = members.filter((m) => m.department_id === d.id).map((m) => m.safe);
    return {
      id: d.id,
      name: d.name,
      dailyBudget: d.daily_budget ? ctx.tokens.money(d.token, BigInt(d.daily_budget)) : null,
      spentToday: ctx.tokens.money(d.token, ms.reduce((s, m) => s + spentToday(ctx, m, d.token), 0n)),
    };
  });
  const teamMembers: TeamMember[] = members.map((m) => ({
    safe: m.safe as Address,
    name: accountRow(ctx, m.safe)?.name ?? `Agent ${m.safe.slice(2, 6)}`,
    departmentId: m.department_id,
    role: m.role,
    dailyBudget: m.daily_budget ? ctx.tokens.money(dep.usdg, BigInt(m.daily_budget)) : null,
    spentToday: ctx.tokens.money(dep.usdg, spentToday(ctx, m.safe, dep.usdg)),
  }));
  return { id: t.id, name: t.name, treasury: t.treasury as Address, owner: t.owner as Address, departments, members: teamMembers, createdAt: t.created_at };
}

export function orgChart(ctx: Ctx, tid: string): OrgChartNode {
  const t = getTeam(ctx, tid);
  const agentNode = (m: TeamMember): OrgChartNode => ({ id: m.safe, label: `${m.name} (${m.role})`, kind: "agent", safe: m.safe, children: [] });
  return {
    id: t.id,
    label: t.name,
    kind: "team",
    safe: t.treasury,
    children: [
      ...t.departments.map((d) => ({ id: d.id, label: d.name, kind: "department" as const, safe: null, children: t.members.filter((m) => m.departmentId === d.id).map(agentNode) })),
      ...t.members.filter((m) => !m.departmentId).map(agentNode),
    ],
  };
}

registerRoutes((app: Hono, ctx: Ctx) => {
  app.post("/v1/teams", async (c) => {
    const who = owner(ctx, c);
    const b = await body(c, z.object({ name: z.string().min(1).max(60), treasury: zAddr }));
    await safeOwner(ctx, c, b.treasury);
    if (!(await readChainAccount(ctx, b.treasury)).initialized) fail(400, "not_account", "The treasury must be a Purser account.");
    const tid = id("team");
    ctx.db.prepare("INSERT INTO teams (id, name, treasury, owner, created_at) VALUES (?, ?, ?, ?, ?)").run(tid, b.name, b.treasury, lower(who), now());
    ctx.db.prepare("UPDATE accounts SET team_id = ?, role = 'treasury' WHERE safe = ?").run(tid, b.treasury);
    await ctx.audit.append(`owner:${lower(who)}`, "team.created", b.treasury, { team: tid, name: b.name });
    return send(c, getTeam(ctx, tid), 201);
  });
  app.get("/v1/teams", (c) => {
    const o = c.req.query("owner");
    const rows = (o ? ctx.db.prepare("SELECT id FROM teams WHERE owner = ? ORDER BY created_at DESC").all(lower(o)) : ctx.db.prepare("SELECT id FROM teams ORDER BY created_at DESC").all()) as { id: string }[];
    return send(c, { items: rows.map((r) => getTeam(ctx, r.id)), next: null });
  });
  app.get("/v1/teams/:id", (c) => send(c, getTeam(ctx, param(c, "id"))));
  app.get("/v1/teams/:id/org", (c) => send(c, orgChart(ctx, param(c, "id"))));

  app.post("/v1/teams/:id/departments", async (c) => {
    const t = getTeam(ctx, param(c, "id"));
    await safeOwner(ctx, c, t.treasury);
    const b = await body(c, z.object({ name: z.string().min(1).max(60), dailyBudget: zAmount.nullable().default(null) }));
    const did = id("dept");
    ctx.db.prepare("INSERT INTO departments (id, team_id, name, daily_budget, token) VALUES (?, ?, ?, ?, ?)").run(did, t.id, b.name, b.dailyBudget, lower(requireDep(ctx).usdg));
    return send(c, getTeam(ctx, t.id), 201);
  });

  /** Adds an agent to the team. Returns the treasury Safe transaction that allows it and caps its daily top-ups. */
  app.post("/v1/teams/:id/members", async (c) => {
    const t = getTeam(ctx, param(c, "id"));
    await safeOwner(ctx, c, t.treasury);
    const b = await body(c, z.object({ safe: zAddr, departmentId: z.string().nullable().default(null), role: z.string().min(1).max(40).default("agent"), dailyBudget: zAmount.nullable().default(null) }));
    if (sameAddress(b.safe, t.treasury)) fail(400, "bad_request", "The treasury is not a member.");
    if (b.departmentId && !t.departments.some((d) => d.id === b.departmentId)) fail(400, "bad_request", "No such department in this team.");
    ctx.db
      .prepare("INSERT INTO team_members (team_id, safe, department_id, role, daily_budget) VALUES (?, ?, ?, ?, ?) ON CONFLICT(team_id, safe) DO UPDATE SET department_id = excluded.department_id, role = excluded.role, daily_budget = excluded.daily_budget")
      .run(t.id, b.safe, b.departmentId, b.role, b.dailyBudget);
    ctx.db.prepare("UPDATE accounts SET team_id = ?, department_id = ?, role = ? WHERE safe = ?").run(t.id, b.departmentId, b.role, b.safe);
    const prepared = await prepareSafeTx(
      ctx,
      t.treasury,
      ruleChangeCalls(ctx, {
        allow: [b.safe],
        ...(b.dailyBudget ? { counterpartyLimits: [{ token: requireDep(ctx).usdg, counterparty: b.safe, limit: b.dailyBudget }] } : {}),
      }),
      `Let the team treasury fund this agent${b.dailyBudget ? " up to its daily budget" : ""}.`,
    );
    return send(c, { team: getTeam(ctx, t.id), treasuryTx: prepared }, 201);
  });

  /**
   * The treasury's agent tops up a member: an internal payment through the treasury's rules (the member's daily
   * budget is a per-payee limit on chain), after the department's daily budget is checked here.
   */
  app.post("/v1/teams/:id/topups", async (c) => {
    const t = getTeam(ctx, param(c, "id"));
    const auth = agent(ctx, c, "pay");
    if (!sameAddress(auth.safe, t.treasury)) fail(403, "not_treasury", "Only the team treasury's key can top up members.");
    const b = await body(c, z.object({ member: zAddr, amount: zAmount, memo: z.string().max(200).optional() }));
    const m = t.members.find((x) => sameAddress(x.safe, b.member)) ?? fail(404, "not_member", "This agent is not in the team.");
    const dep = requireDep(ctx);
    if (m.departmentId) {
      const d = t.departments.find((x) => x.id === m.departmentId)!;
      if (d.dailyBudget) {
        const peers = t.members.filter((x) => x.departmentId === d.id).map((x) => x.safe);
        const used = fundedToday(ctx, t.treasury, peers, dep.usdg);
        if (used + BigInt(b.amount) > BigInt(d.dailyBudget.amount))
          return send(c, { error: { code: "department_budget", message: `The ${d.name} department has ${ctx.tokens.money(dep.usdg, BigInt(d.dailyBudget.amount) - used).display} left today.` } }, 422);
      }
    }
    const res = await submitIntent(ctx, {
      safe: t.treasury,
      spec: { kind: "pay", pay: { token: dep.usdg, to: m.safe, amount: BigInt(b.amount), service: `team:${t.id}` } },
      category: "internal",
      signer: auth.session,
      meta: { memo: b.memo ?? `Top-up for ${m.name}` },
    });
    return send(c, res, res.intent.status === "blocked" ? 422 : 200);
  });
});
