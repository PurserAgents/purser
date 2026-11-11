import { categoryLabel, statusLabel } from "@/lib/labels";
import { formatMoney, formatTime, shortAddress } from "@/lib/format";
import type { Receipt } from "@/lib/types";
import { IconArrowIn, IconArrowOut, IconReceipt, IconShieldX } from "./Icons";
import { EmptyState } from "./ui";

function StatusBadge({ receipt }: { receipt: Receipt }) {
  switch (receipt.status) {
    case "blocked":
      return <span className="badge badge--stop">Blocked</span>;
    case "queued":
    case "needs_cosign":
      return <span className="badge badge--wait">{statusLabel[receipt.status]}</span>;
    case "failed":
    case "rejected":
      return <span className="badge">{statusLabel[receipt.status]}</span>;
    default:
      return <span className="badge">{categoryLabel[receipt.category] ?? receipt.category}</span>;
  }
}

/** Receipt rows from the engine. `names` maps Safe addresses to agent names; `compact` hides the agent column. */
export function ReceiptList({ receipts, names, compact, empty }: { receipts: Receipt[]; names?: Record<string, string>; compact?: boolean; empty?: string }) {
  if (receipts.length === 0) {
    return <EmptyState size="sm" icon={IconReceipt} title="No receipts yet" text={empty ?? "Every payment in or out of the account is listed here the moment it happens."} />;
  }
  return (
    <ul className={"receipts" + (compact ? " receipts--compact" : "")}>
      {receipts.map((receipt) => {
        const blocked = receipt.status === "blocked";
        const sign = receipt.direction === "in" ? "+" : "-";
        const who = receipt.counterpartyName ?? names?.[receipt.counterparty.toLowerCase()] ?? shortAddress(receipt.counterparty);
        return (
          <li key={receipt.id} className={"receipt" + (blocked ? " receipt--blocked" : "")}>
            <span className="receipt__dir">
              {blocked ? <IconShieldX size={14} /> : receipt.direction === "in" ? <IconArrowIn size={14} /> : <IconArrowOut size={14} />}
            </span>
            <div className="receipt__who">
              <div className="table__primary">{who}</div>
              <div className="table__secondary num">{formatTime(receipt.createdAt)} UTC</div>
            </div>
            <span className="receipt__memo">{receipt.memo ?? receipt.service ?? categoryLabel[receipt.category]}</span>
            <span className="receipt__agent">{names?.[receipt.safe.toLowerCase()] ?? shortAddress(receipt.safe)}</span>
            <span className={"receipt__amount" + (receipt.direction === "in" && !blocked ? " pos" : "")}>
              <span className="sr-only">{receipt.direction === "in" ? "Received " : "Paid "}</span>
              {sign}
              {formatMoney(receipt.money.amount, receipt.money.token)}
            </span>
            <span className="receipt__status">
              <StatusBadge receipt={receipt} />
            </span>
          </li>
        );
      })}
    </ul>
  );
}
