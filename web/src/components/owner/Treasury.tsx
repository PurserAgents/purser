"use client";

import { useState } from "react";
import { api } from "@/lib/client";
import { formatMoney, money, parseUnits, sameAddress, shortAddress } from "@/lib/format";
import type { Page, PreparedSafeTx, Treasury as TreasuryView, TreasuryVault } from "@/lib/types";
import { IconVault } from "../Icons";
import { useEngine } from "../Live";
import { Card, EmptyState, Loading } from "../ui";
import { ActionStatus, useAction } from "./Action";
import { OwnerFrame, useOwner } from "./Frame";
import { useMany } from "./hooks";
import { AgentPicker } from "./Picker";

export function Treasury() {
  return (
    <OwnerFrame title="Idle money, put to work." lead="An agent can move idle USDG from its own Safe into a vault you allow, and back. The shares stay in the Safe, a floor you set always stays liquid, and none of it counts as spending.">
      <Body />
    </OwnerFrame>
  );
}

function Body() {
  const owner = useOwner();
  const vaults = useEngine<Page<TreasuryVault>>("/v1/treasury/vaults");
  const views = useMany<TreasuryView>(owner.accounts.map((a) => a.safe), (s) => `/v1/accounts/${s}/treasury`, ["receipt", "account"]);
  const usdg = owner.engine.tokens.find((t) => t.symbol === "USDG") ?? { symbol: "USDG", decimals: 6, address: "0x0000000000000000000000000000000000000000" as const };
  const all = Object.values(views.data);
  const liquid = all.reduce((n, v) => n + BigInt(v.liquid.find((m) => m.token.symbol === "USDG")?.amount ?? "0"), 0n);
  const invested = all.reduce((n, v) => n + v.positions.reduce((m, p) => m + BigInt(p.assets.amount), 0n), 0n);
  const positions = all.flatMap((v) => v.positions.filter((p) => BigInt(p.shares) > 0n).map((p) => ({ safe: v.safe, p })));

  return (
    <div className="dash">
      <dl className="cells cells--3">
        <div className="cell">
          <dt className="stat__label">Liquid</dt>
          <dd className="stat__value">{formatMoney(liquid, usdg)}</dd>
          <dd className="stat__note">USDG ready to pay with</dd>
        </div>
        <div className="cell">
          <dt className="stat__label">In vaults</dt>
          <dd className="stat__value">{formatMoney(invested, usdg)}</dd>
          <dd className="stat__note">Valued at what the vault would pay back now</dd>
        </div>
        <div className="cell">
          <dt className="stat__label">Vaults available</dt>
          <dd className="stat__value num">{vaults.data?.items.length ?? 0}</dd>
          <dd className="stat__note">ERC-4626 vaults on {owner.engine.chainId === 4663 ? "Robinhood Chain" : "this chain"}</dd>
        </div>
      </dl>

      <div className="cols-main">
        <Card title="Positions" flush>
          {views.loading ? (
            <Loading />
          ) : positions.length === 0 ? (
            <EmptyState icon={IconVault} title="Nothing in a vault yet" text="Allow a vault for an agent here. The agent then moves idle money in and out with the SDK (purser.treasury.deposit, withdraw or sweep)." />
          ) : (
            <div className="table-wrap">
              <table className="table table--stack">
                <thead>
                  <tr>
                    <th scope="col">Agent</th>
                    <th scope="col">Vault</th>
                    <th scope="col" className="right">
                      Shares
                    </th>
                    <th scope="col" className="right">
                      Worth now
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {positions.map(({ safe, p }) => (
                    <tr key={safe + p.vault.address}>
                      <td className="table__primary">{owner.names[safe.toLowerCase()]}</td>
                      <td data-label="Vault">
                        <div>{p.vault.name}</div>
                        <div className="table__secondary mono">{shortAddress(p.vault.address)}</div>
                      </td>
                      <td className="right num" data-label="Shares">
                        {formatMoney(p.shares, { symbol: "shares", decimals: p.vault.asset.decimals }, 2)}
                      </td>
                      <td className="right num table__primary" data-label="Worth now">
                        {money(p.assets)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
        <Card title="Vaults" flush>
          {!vaults.data ? (
            <Loading />
          ) : vaults.data.items.length === 0 ? (
            <EmptyState size="sm" title="No vaults known" text="The engine lists the ERC-4626 vaults it can use here." />
          ) : (
            <div className="rows">
              {vaults.data!.items.map((v) => (
                <div className="rowi" key={v.address}>
                  <span className="rowi__icon">
                    <IconVault size={15} />
                  </span>
                  <div className="rowi__main">
                    <span className="rowi__title">{v.name}</span>
                    <span className="rowi__meta mono">{shortAddress(v.address)}</span>
                  </div>
                  <div className="rowi__side">
                    <span className="small num">{money(v.totalAssets, 0)}</span>
                    <span className="micro muted">in the vault</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
      <Settings vaults={vaults.data?.items ?? []} views={views.data} reload={views.reload} />
    </div>
  );
}

function Settings({ vaults, views, reload }: { vaults: TreasuryVault[]; views: Record<string, TreasuryView>; reload(): void }) {
  const owner = useOwner();
  // Start on an agent that already uses a vault, once the positions have loaded.
  const [picked, setSafe] = useState<string | null>(null);
  const safe = picked ?? Object.values(views).find((v) => v.allowedVaults.length > 0)?.safe ?? owner.accounts[0]?.safe ?? "";
  const view = Object.entries(views).find(([k]) => k.toLowerCase() === safe.toLowerCase())?.[1];
  const floor = view?.keepLiquid.find((k) => k.token.symbol === "USDG");
  const [keep, setKeep] = useState("");
  const action = useAction();
  const allowed = (v: string) => view?.allowedVaults.some((a) => sameAddress(a, v)) ?? false;
  const change = (body: Record<string, unknown>, message: string) =>
    action.run(async () => {
      const tx = await api<PreparedSafeTx>(`/v1/accounts/${safe}/treasury/prepare`, { body });
      await owner.signer.execSafeTx(tx);
      reload();
      setKeep("");
      return message;
    });
  return (
    <Card title="Treasury rules" action={<AgentPicker accounts={owner.accounts} value={safe} onChange={setSafe} />}>
      <div className="grid-2">
        <div className="form">
          <span className="field__label">Vaults this agent may use</span>
          {vaults.length === 0 ? <span className="small muted">No vaults known.</span> : null}
          {vaults.map((v) => (
            <label className="switch" key={v.address}>
              <input type="checkbox" checked={allowed(v.address)} disabled={!view || action.busy} onChange={(e) => void change(e.target.checked ? { vaults: [v.address] } : { removeVaults: [v.address] }, e.target.checked ? `${v.name} allowed.` : `${v.name} removed.`)} />
              <span>{v.name}</span>
            </label>
          ))}
        </div>
        <form
          className="form"
          onSubmit={(e) => {
            e.preventDefault();
            if (keep) void change({ keepLiquid: parseUnits(keep, 6).toString() }, "The floor is set.");
          }}
        >
          <label className="field">
            <span className="field__label">Always keep liquid</span>
            <span className="input-affix">
              <input className="input" inputMode="decimal" value={keep} placeholder={floor ? formatMoney(floor.amount, floor.token).replace("$", "") : "0"} onChange={(e) => setKeep(e.target.value.replace(/[^0-9.]/g, ""))} />
              <span className="input-affix__unit">USDG</span>
            </span>
            <span className="field__hint">Now {floor ? formatMoney(floor.amount, floor.token) : "$0.00"}. The agent can never move this part into a vault.</span>
          </label>
          <div className="row">
            <button type="submit" className="btn btn--secondary" disabled={!keep || action.busy}>
              Set the floor
            </button>
          </div>
        </form>
      </div>
      <ActionStatus state={action.state} />
    </Card>
  );
}
