import type { Metadata } from "next";
import Link from "next/link";
import { IconArrowRight } from "@/components/Icons";
import { Markdown } from "@/components/Markdown";
import { PageHead } from "@/components/ui";
import { guideOrder, guidesIntro } from "@/lib/guides";

export const metadata: Metadata = {
  title: "Framework guides",
  description: "Plug Purser into the Claude Agent SDK, the OpenAI Agents SDK, LangChain or ElizaOS.",
};

export default function GuidesPage() {
  const intro = guidesIntro();
  return (
    <>
      <PageHead eyebrow="Developers" title="Plug Purser into your agent." lead="Every framework uses one of three ways in: the MCP server, the SDK or the model proxy. Pick yours." />
      <div className="container page-body">
        <div className="dash">
          <div className="grid-2">
            {guideOrder.map((g) => (
              <Link href={`/developers/guides/${g.slug}`} className="card" key={g.slug}>
                <h2 className="h4">{g.name}</h2>
                <p className="small muted">{g.summary}</p>
                <span className="link-arrow small">
                  Read the guide
                  <IconArrowRight size={14} />
                </span>
              </Link>
            ))}
          </div>
          {intro ? <Markdown source={intro.split("\nGuides:")[0]} /> : null}
        </div>
      </div>
    </>
  );
}
