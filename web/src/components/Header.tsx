"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { navGroups, site, type NavGroup } from "@/lib/site";
import { IconArrowRight, IconChevronDown, IconGitHub, IconMenu, IconX, IconXLogo } from "./Icons";
import { Logo } from "./Logo";
import { ThemeToggle } from "./ThemeToggle";
import { WalletButton } from "./Wallet";

function isCurrent(pathname: string, href: string): boolean {
  if (href === "/app") return pathname === "/app" || pathname.startsWith("/app/agents") || pathname === "/app/open";
  return pathname === href || pathname.startsWith(href + "/");
}

function groupIsCurrent(pathname: string, group: NavGroup): boolean {
  return group.items.some((item) => isCurrent(pathname, item.href));
}

function Socials() {
  return (
    <>
      <a className="icon-btn social" href={site.github} target="_blank" rel="noreferrer" aria-label="Purser on GitHub">
        <IconGitHub />
      </a>
      <a className="icon-btn social" href={site.x} target="_blank" rel="noreferrer" aria-label="Purser on X">
        <IconXLogo />
      </a>
    </>
  );
}

/** One header menu: a button that opens a panel of links with a line of text each. */
function NavMenu({ group, pathname, open, onOpen, onClose }: { group: NavGroup; pathname: string; open: boolean; onOpen(): void; onClose(): void }) {
  const wide = group.items.length > 6;
  const id = `menu-${group.label.toLowerCase()}`;
  return (
    <div className={"nav__group" + (open ? " is-open" : "")} onMouseLeave={onClose}>
      <button
        type="button"
        className="nav__link nav__trigger"
        aria-expanded={open}
        aria-controls={id}
        aria-current={groupIsCurrent(pathname, group) ? "true" : undefined}
        onClick={() => (open ? onClose() : onOpen())}
        onMouseEnter={onOpen}
      >
        {group.label}
        <IconChevronDown size={14} />
      </button>
      <div className={"nav__panel" + (wide ? " nav__panel--wide" : "")} id={id} hidden={!open}>
        <ul className="nav__items">
          {group.items.map((item) => (
            <li key={item.href}>
              <Link href={item.href} className="nav__item" aria-current={isCurrent(pathname, item.href) ? "page" : undefined} onClick={onClose}>
                <span className="nav__item-label">{item.label}</span>
                {item.text ? <span className="nav__item-text">{item.text}</span> : null}
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

export function Header() {
  const pathname = usePathname();
  const [menuPath, setMenuPath] = useState<string | null>(null);
  const [openState, setOpenState] = useState<{ label: string; path: string } | null>(null);
  // A header menu belongs to the page it was opened on, so navigating closes it.
  const openGroup = openState?.path === pathname ? openState.label : null;
  const setOpenGroup = (update: string | null | ((g: string | null) => string | null)) =>
    setOpenState((cur) => {
      const current = cur?.path === pathname ? cur.label : null;
      const next = typeof update === "function" ? update(current) : update;
      return next ? { label: next, path: pathname } : null;
    });
  const navRef = useRef<HTMLElement>(null);
  // The mobile menu belongs to the page it was opened on, so navigating closes it.
  const open = menuPath === pathname;

  useEffect(() => {
    if (!openGroup) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpenState(null);
    };
    const onDown = (event: PointerEvent) => {
      if (navRef.current && !navRef.current.contains(event.target as Node)) setOpenState(null);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown);
    };
  }, [openGroup]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuPath(null);
    };
    const wide = window.matchMedia("(min-width: 1021px)");
    const onWide = () => {
      if (wide.matches) setMenuPath(null);
    };
    document.addEventListener("keydown", onKey);
    wide.addEventListener("change", onWide);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      wide.removeEventListener("change", onWide);
      document.body.style.overflow = "";
    };
  }, [open]);

  return (
    <>
      <header className="header">
        <div className="header__inner">
          <Link href="/" className="brand" aria-label="Purser, home">
            <Logo />
            <span>{site.name}</span>
          </Link>

          <nav className="nav" aria-label="Sections" ref={navRef}>
            {navGroups.map((group) => (
              <NavMenu
                key={group.label}
                group={group}
                pathname={pathname}
                open={openGroup === group.label}
                onOpen={() => setOpenGroup(group.label)}
                onClose={() => setOpenGroup((g) => (g === group.label ? null : g))}
              />
            ))}
          </nav>

          <div className="header__actions">
            <Socials />
            <ThemeToggle />
            <WalletButton />
            <button
              type="button"
              className="icon-btn header__menu-btn"
              aria-label={open ? "Close menu" : "Open menu"}
              aria-expanded={open}
              aria-controls="mobile-menu"
              onClick={() => setMenuPath(open ? null : pathname)}
            >
              {open ? <IconX size={20} /> : <IconMenu size={20} />}
            </button>
          </div>
        </div>
      </header>

      {open && (
        <div className="menu" id="mobile-menu">
          <nav className="menu__nav" aria-label="Sections">
            {navGroups.map((group) => (
              <div className="menu__group" key={group.label}>
                <span className="menu__title">{group.label}</span>
                {group.items.map((item) => (
                  <Link
                    key={item.href}
                    href={item.href}
                    className="menu__link"
                    aria-current={isCurrent(pathname, item.href) ? "page" : undefined}
                    onClick={() => setMenuPath(null)}
                  >
                    {item.label}
                    <IconArrowRight size={16} />
                  </Link>
                ))}
              </div>
            ))}
          </nav>
          <div className="menu__foot">
            <WalletButton size="md" />
            <div className="menu__social">
              <Socials />
            </div>
          </div>
        </div>
      )}
    </>
  );
}
