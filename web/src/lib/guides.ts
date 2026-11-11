/**
 * Framework guides, read at build time from packages/sdk/guides (the same Markdown that ships with the SDK).
 */
import "server-only";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface Guide {
  slug: string;
  title: string;
  summary: string;
  markdown: string;
}

const DIR = join(process.cwd(), "..", "packages", "sdk", "guides");

export const guideOrder = [
  { slug: "claude-agent-sdk", name: "Claude Agent SDK", summary: "The MCP server next to your agent, with the tools allowed by name." },
  { slug: "openai-agents-sdk", name: "OpenAI Agents SDK", summary: "Purser as MCP tools, and model calls paid from the same account." },
  { slug: "langchain", name: "LangChain", summary: "Pay and x402 fetch as LangChain tools, or the MCP server." },
  { slug: "elizaos", name: "ElizaOS", summary: "A pay action in a plugin, with the whole message read by the firewall." },
];

function read(name: string): string | null {
  const file = join(DIR, `${name}.md`);
  return existsSync(file) ? readFileSync(file, "utf8") : null;
}

/** Lines that point into the repository are left out on the site. */
function clean(md: string): string {
  return md
    .split("\n")
    .filter((l) => !/^The full file is `packages\//.test(l))
    .join("\n")
    .trim();
}

export function getGuide(slug: string): Guide | null {
  const meta = guideOrder.find((g) => g.slug === slug);
  const md = meta ? read(slug) : null;
  if (!meta || !md) return null;
  const body = clean(md);
  const title = body.match(/^# (.+)$/m)?.[1] ?? meta.name;
  return { slug, title, summary: meta.summary, markdown: body.replace(/^# .+\n+/, "") };
}

export function guidesIntro(): string | null {
  const md = read("README");
  return md ? clean(md).replace(/^# .+\n+/, "") : null;
}
