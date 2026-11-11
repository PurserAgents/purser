import Link from "next/link";
import type { ReactNode } from "react";
import { CodeTabs } from "./CodeTabs";

/** Inline Markdown: `code`, **bold** and [links](url). Guide links (./x.md) go to the guide pages. */
function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const t = m[0];
    if (t.startsWith("`")) out.push(<code className="inline-code" key={i++}>{t.slice(1, -1)}</code>);
    else if (t.startsWith("**")) out.push(<strong key={i++}>{t.slice(2, -2)}</strong>);
    else {
      const [, label, href] = t.match(/\[([^\]]+)\]\(([^)]+)\)/)!;
      const local = href.match(/^\.\/([a-z-]+)\.md$/);
      out.push(
        local ? (
          <Link key={i++} href={`/developers/guides/${local[1]}`}>
            {label}
          </Link>
        ) : (
          <a key={i++} href={href} target="_blank" rel="noreferrer">
            {label}
          </a>
        ),
      );
    }
    last = m.index + t.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const LANG: Record<string, string> = { ts: "TypeScript", sh: "Terminal", json: "JSON", js: "JavaScript" };

/** A small Markdown renderer for the guides: headings, paragraphs, lists, tables and code blocks. */
export function Markdown({ source }: { source: string }) {
  const lines = source.split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;
  let key = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith("```")) {
      const lang = line.slice(3).trim();
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) code.push(lines[i++]);
      i++;
      blocks.push(<CodeTabs key={key++} samples={[{ label: LANG[lang] ?? (lang || "Code"), code: code.join("\n") }]} />);
    } else if (/^#{2,3} /.test(line)) {
      const level = line.startsWith("###") ? 3 : 2;
      const text = line.replace(/^#+ /, "");
      blocks.push(level === 2 ? <h2 key={key++}>{inline(text)}</h2> : <h3 key={key++}>{inline(text)}</h3>);
      i++;
    } else if (line.startsWith("|")) {
      const rows: string[][] = [];
      while (i < lines.length && lines[i].startsWith("|")) {
        if (!/^\|[\s|:-]+\|$/.test(lines[i])) rows.push(lines[i].slice(1, -1).split("|").map((c) => c.trim()));
        i++;
      }
      const [head, ...body] = rows;
      blocks.push(
        <div className="table-wrap card card--flush" key={key++}>
          <table className="table">
            <thead>
              <tr>
                {head.map((h, j) => (
                  <th scope="col" key={j}>
                    {inline(h)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {body.map((r, j) => (
                <tr key={j}>
                  {r.map((c, k) => (
                    <td key={k} className="small">
                      {inline(c)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
    } else if (/^(- |\d+\. )/.test(line)) {
      const ordered = /^\d+\. /.test(line);
      const items: string[] = [];
      while (i < lines.length && /^(- |\d+\. )/.test(lines[i])) items.push(lines[i++].replace(/^(- |\d+\. )/, ""));
      const children = items.map((t, j) => <li key={j}>{inline(t)}</li>);
      blocks.push(ordered ? <ol key={key++}>{children}</ol> : <ul key={key++}>{children}</ul>);
    } else if (line.trim() === "") {
      i++;
    } else {
      const para: string[] = [];
      while (i < lines.length && lines[i].trim() !== "" && !/^(```|#|\||- |\d+\. )/.test(lines[i])) para.push(lines[i++]);
      blocks.push(<p key={key++}>{inline(para.join(" "))}</p>);
    }
  }
  return <div className="md">{blocks}</div>;
}
