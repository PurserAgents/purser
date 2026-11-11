"use client";

import { api } from "@/lib/client";
import { formatTime, money, sameAddress, shortAddress } from "@/lib/format";
import { passkeySupported, signWithPasskey, storedCredential } from "@/lib/passkey";
import type { Account, Page, PendingApproval } from "@/lib/types";
import { IconCheck, IconFingerprint, IconShield, IconX } from "../Icons";
import { useEngine } from "../Live";
import { Card, EmptyState, Loading } from "../ui";
import { ActionStatus, useAction } from "./Action";
import { OwnerFrame, useOwner } from "./Frame";
import { useMany } from "./hooks";

export function Approvals() {
  return (
    <OwnerFrame title="Payments waiting for you." lead="A payment above an agent's approval amount is queued on chain without moving any money. It runs the moment you approve it.">
      <Body />
    </OwnerFrame>
  );
}

function Body() {
  const owner = useOwner();
  const all = useEngine<Page<PendingApproval>>("/v1/approvals?all=1", { refreshOn: ["approval", "intent", "receipt"] });
  const mine = (all.data?.items ?? []).filter((a) => owner.names[a.safe.toLowerCase()]);
  const queued = mine.filter((a) => a.status === "queued");
  const decided = mine.filter((a) => a.status !== "queued").slice(0, 20);
  const safes = [...new Set(queued.map((a) => a.safe))];
  const accounts = useMany<Account>(safes, (s) => `/v1/accounts/${s}`);

  return (
    <div className="dash">
      <Card title="Waiting" action={queued.length ? <span className="badge badge--wait">{queued.length} to decide</span> : null} flush>
        {!all.data ? (
          <Loading />
        ) : queued.length === 0 ? (
          <EmptyState icon={IconShield} title="Nothing waits for you" text="When an agent wants to pay more than its approval amount, the payment waits here. Approve it with your wallet, or with a passkey if you added one." />
        ) : (
          <div className="rows">
            {queued.map((a) => (
              <Pending key={a.id} item={a} account={accounts.data[a.safe]} reload={all.reload} />
            ))}
          </div>
        )}
      </Card>
      <Card title="Decided" flush>
        {!all.data ? (
          <Loading />
        ) : decided.length === 0 ? (
          <EmptyState size="sm" title="No decisions yet" text="Approved and rejected payments are kept here." />
        ) : (
          <div className="rows">
            {decided.map((a) => (
              <div className="rowi" key={a.id}>
                <span className={"rowi__icon " + (a.status === "approved" ? "rowi__icon--ok" : "")}>{a.status === "approved" ? <IconCheck size={15} /> : <IconX size={15} />}</span>
                <div className="rowi__main">
                  <span className="rowi__title">{a.summary}</span>
                  <span className="rowi__meta">
                    {owner.names[a.safe.toLowerCase()]}, {formatTime(a.createdAt)} UTC
                  </span>
                </div>
                <div className="rowi__side">
                  <span className="num">{money(a.money)}</span>
                  <span className={"badge " + (a.status === "approved" ? "badge--ok" : "")}>{a.status === "approved" ? "Approved" : "Rejected"}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

function Pending({ item, account, reload }: { item: PendingApproval; account: Account | undefined; reload(): void }) {
  const owner = useOwner();
  const action = useAction();
  const passkey = account?.approver && sameAddress(account.approver, owner.engine.contracts.passkey) && passkeySupported() && storedCredential(item.safe);
  const decide = (decision: "approve" | "reject") =>
    action.run(async (status) => {
      await owner.signer.decide(item.id, decision);
      status(decision === "approve" ? "Approved on chain. Sending the payment..." : "Rejected.");
      await new Promise((r) => setTimeout(r, 1500));
      reload();
      owner.reload();
      return decision === "approve" ? "Approved. The payment runs through the firewall again and is sent." : "Rejected. Nothing was paid.";
    });
  const byPasskey = (decision: "approve" | "reject") =>
    action.run(async (status) => {
      const assertion = await signWithPasskey(item.safe, decision === "approve" ? item.digest : item.rejectChallenge);
      status("Checking the passkey on chain...");
      await api(`/v1/approvals/${item.id}/passkey`, { body: { decision, assertion } });
      reload();
      owner.reload();
      return decision === "approve" ? "Approved with your passkey. The payment is on its way." : "Rejected with your passkey.";
    }, "Use your passkey...");
  return (
    <div className="rowi" style={{ alignItems: "start" }}>
      <span className="rowi__icon rowi__icon--wait">
        <IconShield size={15} />
      </span>
      <div className="rowi__main">
        <span className="rowi__title">{item.summary}</span>
        <span className="rowi__meta">
          {owner.names[item.safe.toLowerCase()]}
          {item.to ? `, to ${shortAddress(item.to)}` : ""}, queued {formatTime(item.createdAt)} UTC
        </span>
      </div>
      <div className="rowi__side">
        <span className="h4 num">{money(item.money)}</span>
      </div>
      <div className="rowi__detail stack" style={{ gap: 10 }}>
        <div className="row">
          {passkey ? (
            <button type="button" className="btn btn--primary btn--sm" disabled={action.busy} onClick={() => void byPasskey("approve")}>
              <IconFingerprint size={14} />
              Approve with passkey
            </button>
          ) : null}
          <button type="button" className={"btn btn--sm " + (passkey ? "btn--secondary" : "btn--primary")} disabled={action.busy} onClick={() => void decide("approve")}>
            <IconCheck size={14} />
            Approve
          </button>
          <button type="button" className="btn btn--secondary btn--sm" disabled={action.busy} onClick={() => void decide("reject")}>
            <IconX size={14} />
            Reject
          </button>
        </div>
        <ActionStatus state={action.state} />
      </div>
    </div>
  );
}
