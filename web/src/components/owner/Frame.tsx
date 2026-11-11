"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { createContext, useContext, useMemo } from "react";
import type { ReactNode } from "react";
import type { OwnerSigner } from "@/lib/owner";
import { ownerNav } from "@/lib/site";
import type { AccountSummary, EngineConfig, Page } from "@/lib/types";
import { IconPlus, IconWallet } from "../Icons";
import { useEngine } from "../Live";
import { EmptyState, PageHead } from "../ui";
import { WalletButton, useWallet } from "../Wallet";

export interface OwnerView {
  address: string;
  signer: OwnerSigner;
  engine: EngineConfig;
  accounts: AccountSummary[];
  /** lowercase Safe address to agent name */
  names: Record<string, string>;
  reload(): void;
}

/** The agent with the most money moved today: a sensible first choice for a page that shows one agent. */
export function busiest(accounts: AccountSummary[]): string | undefined {
  const moved = (a: AccountSummary) => Number(a.spentTodayUsd) + Number(a.earnedTodayUsd);
  return [...accounts].sort((a, b) => moved(b) - moved(a))[0]?.safe;
}

const OwnerContext = createContext<OwnerView | null>(null);

export function useOwner(): OwnerView {
  const value = useContext(OwnerContext);
  if (!value) throw new Error("useOwner must be used inside OwnerFrame");
  return value;
}

function Tabs({ pending }: { pending: number }) {
  const pathname = usePathname();
  return (
    <nav className="tabs" aria-label="Dashboard">
      <div className="tabs__list">
        {ownerNav.map((item) => {
          const current = item.href === "/app" ? pathname === "/app" || pathname.startsWith("/app/agents") || pathname === "/app/open" : pathname.startsWith(item.href);
          return (
            <Link key={item.href} href={item.href} className="tabs__link" aria-current={current ? "page" : undefined}>
              {item.label}
              {item.href === "/app/approvals" && pending > 0 ? <span className="tabs__count">{pending}</span> : null}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}

/**
 * Every dashboard page: the heading, the dashboard tabs, and the gate. Children render only when the engine
 * answers, a wallet is connected and (unless `allowEmpty`) the wallet owns at least one agent account.
 */
export function OwnerFrame({
  eyebrow = "Dashboard",
  title,
  lead,
  aside,
  allowEmpty,
  children,
}: {
  eyebrow?: string;
  title: ReactNode;
  lead?: ReactNode;
  aside?: ReactNode;
  allowEmpty?: boolean;
  children: ReactNode | ((view: OwnerView) => ReactNode);
}) {
  const wallet = useWallet();
  const address = wallet.status === "connected" ? wallet.address : null;
  const accounts = useEngine<Page<AccountSummary>>(address ? `/v1/accounts?owner=${address}` : null, {
    refreshOn: ["account", "receipt", "approval", "intent"],
  });
  const items = accounts.data?.items;
  const view = useMemo<OwnerView | null>(() => {
    if (!address || !wallet.signer || !wallet.engine || !items) return null;
    const names: Record<string, string> = {};
    for (const a of items) names[a.safe.toLowerCase()] = a.name;
    return { address, signer: wallet.signer, engine: wallet.engine, accounts: items, names, reload: accounts.reload };
  }, [address, wallet.signer, wallet.engine, items, accounts.reload]);
  const pending = items?.reduce((n, a) => n + a.pendingApprovals, 0) ?? 0;

  let body: ReactNode;
  if (wallet.engineState === "unopened") {
    body = (
      <EmptyState panel icon={IconWallet} title="Agent accounts open soon" text="The Purser contracts are not live on Robinhood Chain yet. Once they are, you open an account here and your agents, balances, rules and receipts appear on this page.">
        <Link href="/how" className="btn btn--secondary">
          How it works
        </Link>
      </EmptyState>
    );
  } else if (wallet.engineState === "offline") {
    body = (
      <EmptyState panel icon={IconWallet} title="The engine is not reachable" text="This page shows your agents live from the Purser engine. It will fill in as soon as the engine answers again." />
    );
  } else if (wallet.engineState === "loading" || (address && accounts.loading && !items)) {
    body = <div className="empty" aria-busy="true" />;
  } else if (!address) {
    body = (
      <EmptyState panel icon={IconWallet} title="Connect your wallet to see your agents" text="Your agents, balances, rules and receipts appear here. The wallet that owns an agent's Safe is the only one that can change it.">
        <WalletButton size="md" />
        <Link href="/how" className="btn btn--secondary">
          How it works
        </Link>
      </EmptyState>
    );
  } else if (accounts.error && !items) {
    body = <EmptyState panel icon={IconWallet} title="Your accounts could not be loaded" text={accounts.error} />;
  } else if (view && view.accounts.length === 0 && !allowEmpty) {
    body = (
      <EmptyState panel icon={IconPlus} title="No agents yet. Open an account to start." text="An agent account is a Safe you own, with the rules your agent cannot break. It takes one transaction from your wallet.">
        <Link href="/app/open" className="btn btn--primary">
          <IconPlus size={16} />
          Open an agent account
        </Link>
      </EmptyState>
    );
  } else if (view) {
    body = typeof children === "function" ? children(view) : children;
  }

  return (
    <>
      <PageHead eyebrow={eyebrow} title={title} lead={lead} aside={aside} />
      <Tabs pending={pending} />
      <div className="container page-body">
        <OwnerContext.Provider value={view}>{body}</OwnerContext.Provider>
      </div>
    </>
  );
}
