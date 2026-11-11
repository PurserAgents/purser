import type { Metadata } from "next";
import Link from "next/link";
import { CodeTabs } from "@/components/CodeTabs";
import { IconArrowRight, IconBell, IconCpu, IconStore, IconTerminal } from "@/components/Icons";
import { PageHead } from "@/components/ui";
import { guideOrder } from "@/lib/guides";
import { apiSample, developerSamples, merchantSample, modelsSample, sellSample, testModeSample, webhookSample } from "@/lib/snippets";

export const metadata: Metadata = {
  title: "SDK, MCP and CLI",
  description: "Give an agent its Purser account in code: the TypeScript SDK, the MCP server, the CLI, the model proxy, signed webhooks and test mode.",
};

const tools = [
  ["purser_account", "Balances, today's spending and what is left"],
  ["purser_rules", "The rules the agent cannot break"],
  ["purser_pay", "Pay, with the text that led to it"],
  ["purser_check_payment", "Ask the firewall first"],
  ["purser_receipts", "Every payment in and out"],
  ["purser_x402_fetch", "Fetch a URL and pay its 402"],
  ["purser_sell", "Put a service on sale"],
  ["purser_services", "The agent's services"],
  ["purser_invoice", "Invoice another agent"],
  ["purser_pay_invoice", "Fund an invoice's escrow"],
  ["purser_pnl", "Profit and loss"],
];

export default function DevelopersPage() {
  return (
    <>
      <PageHead eyebrow="Developers" title="Give an agent its account in code." lead="A TypeScript SDK, an MCP server and a CLI on one engine API. The same rules and the same firewall apply whichever one the agent uses." />
      <div className="container page-body">
        <div className="dash" style={{ gap: 64 }}>
          <section className="split split--even" id="sdk">
            <div className="stack">
              <span className="eyebrow">Start</span>
              <h2 className="h3">One key, three ways in</h2>
              <p className="muted">The owner creates an agent key for one account in the dashboard. The agent uses it with the SDK, as MCP tools, or from the terminal. A refused payment is an answer with reasons, never an exception that slips through.</p>
              <code className="endpoint">npm install @purser/sdk</code>
            </div>
            <CodeTabs samples={developerSamples} title="Purser developer tools" />
          </section>

          <section className="dash" id="mcp" aria-labelledby="mcp-h">
            <div className="section-label">
              <h2 className="h3" id="mcp-h">
                MCP tools
              </h2>
              <span className="small muted">Eleven tools over stdio, amounts in whole units</span>
            </div>
            <ul className="cells cells--4">
              {tools.map(([name, text]) => (
                <li className="cell cell--pad-sm" key={name}>
                  <code className="mono small">{name}</code>
                  <span className="small muted">{text}</span>
                </li>
              ))}
              <li className="cell cell--pad-sm">
                <Link href="/developers/guides" className="link-arrow small">
                  Framework guides
                  <IconArrowRight size={14} />
                </Link>
                <span className="small muted">Claude Agent SDK, OpenAI Agents SDK, LangChain, ElizaOS</span>
              </li>
            </ul>
          </section>

          <section className="grid-2" id="models">
            <div className="stack">
              <div className="row">
                <IconCpu size={18} />
                <h2 className="h3">Models on the same account</h2>
              </div>
              <p className="muted">Any OpenAI-compatible client works. The owner adds the providers; every call is recorded with its tokens and cost, and tagged to a task if you send X-Purser-Task.</p>
            </div>
            <CodeTabs samples={[{ label: "models.ts", code: modelsSample }]} />
          </section>

          <section className="grid-2" id="sell">
            <div className="stack">
              <div className="row">
                <IconStore size={18} />
                <h2 className="h3">Sell over x402</h2>
              </div>
              <p className="muted">Let the engine run the paywall for an agent&apos;s service, or price an endpoint on your own server with the middleware. Either way the money lands in the agent&apos;s own Safe.</p>
              <Link href="/pay" className="link-arrow small">
                And the pay button
                <IconArrowRight size={14} />
              </Link>
            </div>
            <CodeTabs
              samples={[
                { label: "Engine paywall", code: sellSample },
                { label: "Own server", code: merchantSample },
              ]}
            />
          </section>

          <section className="grid-2" id="webhooks">
            <div className="stack">
              <div className="row">
                <IconBell size={18} />
                <h2 className="h3">Signed webhooks</h2>
              </div>
              <p className="muted">Subscribe a URL in the dashboard under Alerts. Each delivery is signed with HMAC-SHA256 and retried after 5 seconds, 30 seconds and 2 minutes.</p>
            </div>
            <CodeTabs samples={[{ label: "webhook.ts", code: webhookSample }]} />
          </section>

          <section className="grid-2" id="test-mode">
            <div className="stack">
              <div className="row">
                <IconTerminal size={18} />
                <h2 className="h3">Test mode and the API</h2>
              </div>
              <p className="muted">Run everything on a local copy of the chain with test money. The engine answers JSON and live events; the full reference lists every endpoint with a real answer.</p>
              <div className="row">
                {guideOrder.slice(0, 1).map((g) => (
                  <Link key={g.slug} href="/docs#api" className="link-arrow small">
                    API in the docs
                    <IconArrowRight size={14} />
                  </Link>
                ))}
              </div>
            </div>
            <CodeTabs
              samples={[
                { label: "Test mode", code: testModeSample },
                { label: "Routes", code: apiSample },
              ]}
            />
          </section>
        </div>
      </div>
    </>
  );
}
