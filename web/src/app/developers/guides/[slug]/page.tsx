import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { IconArrowRight } from "@/components/Icons";
import { Markdown } from "@/components/Markdown";
import { PageHead } from "@/components/ui";
import { getGuide, guideOrder } from "@/lib/guides";

export const dynamicParams = false;

export function generateStaticParams() {
  return guideOrder.map((g) => ({ slug: g.slug }));
}

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const guide = getGuide((await params).slug);
  return guide ? { title: guide.title, description: guide.summary } : { title: "Guide" };
}

export default async function GuidePage({ params }: Props) {
  const guide = getGuide((await params).slug);
  if (!guide) notFound();
  const others = guideOrder.filter((g) => g.slug !== guide.slug);
  return (
    <>
      <PageHead eyebrow="Framework guide" title={guide.title} lead={guide.summary} />
      <div className="container page-body">
        <div className="docs">
          <div className="docs__main">
            <Markdown source={guide.markdown} />
          </div>
          <aside className="docs__toc" aria-label="Other guides">
            <span className="docs__toc-group">Other guides</span>
            {others.map((g) => (
              <Link key={g.slug} href={`/developers/guides/${g.slug}`}>
                {g.name}
              </Link>
            ))}
            <Link href="/developers" className="link-arrow small" style={{ marginTop: 12 }}>
              SDK, MCP and CLI
              <IconArrowRight size={14} />
            </Link>
          </aside>
        </div>
      </div>
    </>
  );
}
