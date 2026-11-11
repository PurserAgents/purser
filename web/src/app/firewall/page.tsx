import type { Metadata } from "next";
import Link from "next/link";
import { FirewallRun } from "@/components/FirewallRun";
import { IconArrowRight, IconEye, IconShield, IconSliders } from "@/components/Icons";
import { PageHead } from "@/components/ui";
import { getConfig, getFirewallRun } from "@/lib/data";

export const metadata: Metadata = {
  title: "Watch an attack get blocked",
  description: "An agent with real money reads a page with a hidden instruction to send everything away. The firewall simulates the payment, checks it and refuses it before it is signed.",
};

export const dynamic = "force-dynamic";

const layers = [
  { icon: IconSliders, title: "The rules", text: "Budgets and the largest single payment are checked by the module on chain. The full-balance payment breaks them." },
  { icon: IconShield, title: "The firewall", text: "Every payment is simulated before it is signed. A drain, an unknown contract or a payee planted in hidden text is refused." },
  { icon: IconEye, title: "The watchdog", text: "If something still looks wrong after a payment, the watchdog can freeze the account and tells the owner why." },
];

export default async function FirewallPage() {
  const [run, config] = await Promise.all([getFirewallRun(), getConfig()]);
  const initial = run && run.steps.length > 0 ? run : null;
  return (
    <>
      <PageHead
        eyebrow="Firewall"
        title="Watch an attack get blocked."
        lead="An agent with real money reads a web page with a hidden instruction to send everything away. Every payment is simulated and checked before it is signed. Here is what happens, step by step."
      />
      <div className="container page-body">
        <div className="dash">
          <FirewallRun initial={initial} config={config} />
          <ul className="cells cells--3">
            {layers.map((l) => (
              <li className="cell cell--pad-sm" key={l.title}>
                <div className="row">
                  <l.icon size={17} />
                  <h2 className="h4">{l.title}</h2>
                </div>
                <p className="small muted">{l.text}</p>
              </li>
            ))}
          </ul>
          <div className="row">
            <Link href="/docs#firewall" className="link-arrow">
              Every firewall check, in the docs
              <IconArrowRight size={15} />
            </Link>
          </div>
        </div>
      </div>
    </>
  );
}
