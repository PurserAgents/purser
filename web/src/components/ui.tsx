import type { ComponentType, ReactNode } from "react";

/**
 * A view with nothing in it yet: what will appear here and how to get it. Every list and chart on the site uses
 * this instead of sample numbers.
 */
export function EmptyState({
  icon: Icon,
  title,
  text,
  children,
  size,
  panel,
}: {
  icon?: ComponentType<{ size?: number }>;
  title: ReactNode;
  text?: ReactNode;
  children?: ReactNode;
  size?: "sm";
  panel?: boolean;
}) {
  return (
    <div className={"empty" + (size === "sm" ? " empty--sm" : "") + (panel ? " empty--panel" : "")}>
      {Icon ? (
        <span className="empty__icon">
          <Icon size={20} />
        </span>
      ) : null}
      <p className="empty__title">{title}</p>
      {text ? <p className="empty__text">{text}</p> : null}
      {children ? <div className="empty__actions">{children}</div> : null}
    </div>
  );
}

export function SectionHead({
  eyebrow,
  title,
  lead,
  center,
  children,
}: {
  eyebrow: string;
  title: ReactNode;
  lead?: ReactNode;
  center?: boolean;
  children?: ReactNode;
}) {
  return (
    <div className={"section-head" + (center ? " section-head--center" : "")}>
      <span className="eyebrow">{eyebrow}</span>
      <h2 className="h2">{title}</h2>
      {lead ? <p className="lead">{lead}</p> : null}
      {children}
    </div>
  );
}

/** Top block of every inner page. `aside` sits to the right on wide screens. */
export function PageHead({
  eyebrow,
  title,
  lead,
  aside,
  children,
}: {
  eyebrow: ReactNode;
  title: ReactNode;
  lead?: ReactNode;
  aside?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className={"page-head" + (aside ? " page-head--row" : "")}>
      <div className="container">
        <div className="page-head__inner">
          <div className="page-head__main">
            <span className="eyebrow">{eyebrow}</span>
            <h1 className="h1">{title}</h1>
            {lead ? <p className="lead">{lead}</p> : null}
            {children}
          </div>
          {aside}
        </div>
      </div>
    </div>
  );
}

export function Card({
  title,
  action,
  children,
  flush,
  id,
}: {
  title: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  /** true when the body is a table or list that runs edge to edge */
  flush?: boolean;
  id?: string;
}) {
  return (
    <section className="card card--flush" id={id}>
      <header className="card__head">
        <h2 className="h4">{title}</h2>
        {action}
      </header>
      {flush ? children : <div className="card__body">{children}</div>}
    </section>
  );
}

export function Stat({
  label,
  value,
  note,
  children,
}: {
  label: ReactNode;
  value: ReactNode;
  note?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="stat">
      <span className="stat__label">{label}</span>
      <span className="stat__value">{value}</span>
      {children}
      {note ? <span className="stat__note">{note}</span> : null}
    </div>
  );
}

/** `limit` turns the bar red when it is full. Use it for budgets, not for plain comparisons. */
export function Meter({ percent, label, limit }: { percent: number; label: string; limit?: boolean }) {
  const clamped = Math.max(0, Math.min(100, percent));
  return (
    <div
      className={"meter" + (limit && percent >= 100 ? " meter--over" : "")}
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(clamped)}
    >
      <span className="meter__fill" style={{ width: `${clamped}%` }} />
    </div>
  );
}

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? "")
    .join("");
}

/** Shown while a view loads from the engine, so an empty state never flashes before the data. */
export function Loading({ label = "Loading" }: { label?: string }) {
  return (
    <div className="empty empty--sm loading" aria-busy="true" aria-label={label}>
      <span className="spinner" aria-hidden="true" />
    </div>
  );
}
