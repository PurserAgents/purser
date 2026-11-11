import Link from "next/link";
import { footerNav, site } from "@/lib/site";
import { IconGitHub, IconXLogo } from "./Icons";
import { Logo } from "./Logo";

export function Footer() {
  return (
    <footer className="footer">
      <div className="container">
        <div className="footer__top">
          <div className="footer__about">
            <Link href="/" className="brand" aria-label="Purser, home">
              <Logo />
              <span>{site.name}</span>
            </Link>
            <p className="small muted">{site.tagline} Money, rules and a receipt for every dollar, on {site.chain.name}.</p>
            <div className="row" style={{ gap: 2, marginLeft: -9 }}>
              <a className="icon-btn" href={site.github} target="_blank" rel="noreferrer" aria-label="Purser on GitHub">
                <IconGitHub />
              </a>
              <a className="icon-btn" href={site.x} target="_blank" rel="noreferrer" aria-label="Purser on X">
                <IconXLogo />
              </a>
            </div>
          </div>
          {footerNav.map((column) => (
            <nav className="footer__col" key={column.title} aria-label={column.title}>
              <span className="footer__title">{column.title}</span>
              {column.items.map((item) => (
                <Link key={item.href} href={item.href} className="footer__link">
                  {item.label}
                </Link>
              ))}
            </nav>
          ))}
        </div>
        <div className="footer__bottom">
          <p className="footer__risk">
            Purser is software, not a bank. It never holds your funds and gives no advice. Use at your own risk.{" "}
            <Link href="/own-risk" className="link">
              Read more
            </Link>
          </p>
          <span className="num">
            {site.name} {new Date().getUTCFullYear()}
          </span>
        </div>
      </div>
    </footer>
  );
}
