"use client";

import { api } from "@/lib/client";
import { formatDate, formatDuration, formatMoney, formatTime, money, relativeTime, shortAddress } from "@/lib/format";
import type { Page, PreparedTx, Stream, Subscription } from "@/lib/types";
import { IconRepeat, IconStream } from "../Icons";
import { useNow } from "../Live";
import { Card, EmptyState, Loading } from "../ui";
import { ActionStatus, useAction } from "./Action";
import { OwnerFrame, useOwner } from "./Frame";
import { useMany } from "./hooks";

export function MoneyOut() {
  return (
    <OwnerFrame title="Streams and subscriptions." lead="Money that leaves on a schedule: pay per second while a service delivers, or a fixed amount every period. Both go through the agent's rules, and you can stop either at once.">
      <Body />
    </OwnerFrame>
  );
}

const statusBadge: Record<Stream["status"], string> = { active: "badge--ok", stalled: "badge--wait", stopped: "", ended: "" };
const statusText: Record<Stream["status"], string> = { active: "Streaming", stalled: "No heartbeat", stopped: "Stopped", ended: "Ended" };

function Body() {
  const owner = useOwner();
  const safes = owner.accounts.map((a) => a.safe);
  const streams = useMany<Page<Stream>>(safes, (s) => `/v1/accounts/${s}/streams`, ["stream", "receipt"]);
  const subs = useMany<Page<Subscription>>(safes, (s) => `/v1/accounts/${s}/subscriptions`, ["subscription", "receipt"]);
  const allStreams = Object.values(streams.data).flatMap((p) => p.items);
  const allSubs = Object.values(subs.data).flatMap((p) => p.items);
  const action = useAction();
  const now = useNow();
  const name = (addr: string) => owner.names[addr.toLowerCase()] ?? shortAddress(addr);

  const stop = (kind: "streams" | "subscriptions", id: string) =>
    action.run(async () => {
      const tx = await api<PreparedTx>(`/v1/${kind}/${id}/${kind === "streams" ? "stop" : "cancel"}/prepare`, { body: { by: owner.address } });
      await owner.signer.sendTx(tx);
      streams.reload();
      subs.reload();
      return kind === "streams" ? "The stream is stopped. What was earned so far is settled." : "The subscription is cancelled. No further charges.";
    });

  return (
    <div className="dash">
      <ActionStatus state={action.state} />
      <Card title="Streams" action={<span className="small muted">Paid per second, settled by the engine on a schedule</span>} flush>
        {streams.loading ? (
          <Loading />
        ) : allStreams.length === 0 ? (
          <EmptyState icon={IconStream} title="No streams yet" text="An agent opens a stream with the SDK (purser.streams.create). It pays per second and stops by itself when the payee stops sending heartbeats." />
        ) : (
          <div className="table-wrap">
            <table className="table table--stack">
              <thead>
                <tr>
                  <th scope="col">Agent and payee</th>
                  <th scope="col">Status</th>
                  <th scope="col" className="right">
                    Rate
                  </th>
                  <th scope="col" className="right">
                    Accrued
                  </th>
                  <th scope="col" className="right">
                    Paid
                  </th>
                  <th scope="col">Ends</th>
                  <th scope="col" className="right">
                    <span className="sr-only">Stop</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {allStreams.map((s) => (
                  <tr key={s.id}>
                    <td>
                      <div className="table__primary">{name(s.safe)}</div>
                      <div className="table__secondary">to {name(s.payee)}</div>
                    </td>
                    <td data-label="Status">
                      <span className={"badge " + statusBadge[s.status]}>{statusText[s.status]}</span>
                    </td>
                    <td className="right num nowrap" data-label="Rate">
                      {formatMoney(BigInt(s.ratePerSecond) * 3600n, s.token)} an hour
                    </td>
                    <td className="right num nowrap" data-label="Accrued">
                      {money(s.accrued, 4)}
                    </td>
                    <td className="right num nowrap" data-label="Paid">
                      {money(s.paid, 4)}
                    </td>
                    <td className="nowrap" data-label="Ends">
                      {s.status === "active" || s.status === "stalled" ? relativeTime(s.end, now) : formatTime(s.end)}
                    </td>
                    <td className="right">
                      {s.status === "active" || s.status === "stalled" ? (
                        <button type="button" className="btn btn--secondary btn--sm" disabled={action.busy} onClick={() => void stop("streams", s.id)}>
                          Stop
                        </button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title="Subscriptions" action={<span className="small muted">Charged when due, inside the rules</span>} flush>
        {subs.loading ? (
          <Loading />
        ) : allSubs.length === 0 ? (
          <EmptyState icon={IconRepeat} title="No subscriptions yet" text="An agent subscribes with the SDK (purser.subscriptions.create): a fixed amount every period, charged when due and counted against its budgets." />
        ) : (
          <div className="table-wrap">
            <table className="table table--stack">
              <thead>
                <tr>
                  <th scope="col">Agent and payee</th>
                  <th scope="col">Status</th>
                  <th scope="col" className="right">
                    Amount
                  </th>
                  <th scope="col">Next charge</th>
                  <th scope="col" className="right">
                    Charges
                  </th>
                  <th scope="col" className="right">
                    <span className="sr-only">Cancel</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {allSubs.map((s) => (
                  <tr key={s.id}>
                    <td>
                      <div className="table__primary">{name(s.safe)}</div>
                      <div className="table__secondary">to {name(s.payee)}</div>
                    </td>
                    <td data-label="Status">
                      <span className={"badge " + (s.active ? "badge--ok" : "")}>{s.active ? "Active" : "Cancelled"}</span>
                    </td>
                    <td className="right num nowrap" data-label="Amount">
                      {money(s.amount)} every {formatDuration(s.periodSeconds)}
                    </td>
                    <td className="nowrap" data-label="Next charge">
                      {s.active ? formatDate(s.nextDue) : "None"}
                    </td>
                    <td className="right num nowrap" data-label="Charges">
                      {s.charged} made, {s.chargesLeft} left
                    </td>
                    <td className="right">
                      {s.active ? (
                        <button type="button" className="btn btn--secondary btn--sm" disabled={action.busy} onClick={() => void stop("subscriptions", s.id)}>
                          Cancel
                        </button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
