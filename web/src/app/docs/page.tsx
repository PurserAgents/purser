import type { Metadata } from "next";
import type { ReactNode } from "react";
import { CodeTabs } from "@/components/CodeTabs";
import { IconChevronDown } from "@/components/Icons";
import { PageHead } from "@/components/ui";
import { docs } from "@/lib/docs";

export const metadata: Metadata = {
  title: "Docs",
  description: "Purser documentation: accounts, rules, payments, safety, treasury, teams, the SDK, the MCP server, the CLI and the API.",
};

/** Turns `code` between backticks into inline code. */
function inline(text: string): ReactNode[] {
  return text.split("`").map((part, index) =>
    index % 2 === 1 ? (
      <code key={index} className="inline-code">
        {part}
      </code>
    ) : (
      part
    ),
  );
}

export default function DocsPage() {
  return (
    <>
      <PageHead
        eyebrow="Docs"
        title="Everything a Purser account does."
        lead="One section per feature, from opening an account to the SDK, the MCP server, the CLI and the API."
      />
      <div className="container page-body">
        <div className="docs">
          <div className="docs__main">
            <details className="docs__toc-mobile">
              <summary>
                On this page
                <IconChevronDown size={16} />
              </summary>
              <nav aria-label="On this page">
                {docs.flatMap((group) =>
                  group.sections.map((section) => (
                    <a key={section.id} href={`#${section.id}`}>
                      {section.title}
                    </a>
                  )),
                )}
              </nav>
            </details>

            {docs.map((group) => (
              <section className="docs__group" key={group.id} id={group.id} aria-labelledby={`${group.id}-title`}>
                <div className="docs__group-head">
                  <span className="eyebrow">{group.intro}</span>
                  <h2 className="h2" id={`${group.id}-title`}>
                    {group.title}
                  </h2>
                </div>
                {group.sections.map((section) => (
                  <article className="docs__section" key={section.id} id={section.id}>
                    <h3 className="h3">{section.title}</h3>
                    <div className="prose">
                      {section.body.map((paragraph) => (
                        <p key={paragraph}>{inline(paragraph)}</p>
                      ))}
                      {section.bullets ? (
                        <ul>
                          {section.bullets.map((item) => (
                            <li key={item}>{inline(item)}</li>
                          ))}
                        </ul>
                      ) : null}
                    </div>
                    {section.code ? <CodeTabs samples={section.code} title={section.title} /> : null}
                  </article>
                ))}
              </section>
            ))}
          </div>

          <nav className="docs__toc" aria-label="On this page">
            {docs.map((group) => (
              <div className="docs__toc-group" key={group.id}>
                <a href={`#${group.id}`} className="footer__title" style={{ marginBottom: 2 }}>
                  {group.title}
                </a>
                {group.sections.map((section) => (
                  <a key={section.id} href={`#${section.id}`}>
                    {section.title}
                  </a>
                ))}
              </div>
            ))}
          </nav>
        </div>
      </div>
    </>
  );
}
