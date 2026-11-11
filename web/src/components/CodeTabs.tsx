"use client";

import { useId, useState } from "react";
import type { ReactNode } from "react";
import { IconCheck, IconCopy } from "./Icons";

export interface CodeSample {
  label: string;
  code: string;
}

const KEYWORDS = /\b(import|from|const|await|new|export|async|function|return)\b/g;

/** Very small highlighter: comments, strings and a few keywords. Monochrome on purpose. */
function highlight(line: string, key: number): ReactNode {
  const trimmed = line.trimStart();
  if (trimmed.startsWith("//") || trimmed.startsWith("#")) {
    return (
      <span key={key} className="tok-c">
        {line}
      </span>
    );
  }
  const parts: ReactNode[] = [];
  const pattern = /("[^"]*"|'[^']*'|`[^`]*`)/g;
  let last = 0;
  let match: RegExpExecArray | null;
  let i = 0;
  const pushPlain = (text: string) => {
    let from = 0;
    for (const m of text.matchAll(KEYWORDS)) {
      const at = m.index ?? 0;
      if (at > from) parts.push(text.slice(from, at));
      parts.push(
        <span key={`k${key}-${i++}`} className="tok-k">
          {m[0]}
        </span>,
      );
      from = at + m[0].length;
    }
    if (from < text.length) parts.push(text.slice(from));
  };
  while ((match = pattern.exec(line))) {
    if (match.index > last) pushPlain(line.slice(last, match.index));
    parts.push(
      <span key={`s${key}-${i++}`} className="tok-s">
        {match[0]}
      </span>,
    );
    last = match.index + match[0].length;
  }
  if (last < line.length) pushPlain(line.slice(last));
  return <span key={key}>{parts}</span>;
}

export function CodeTabs({ samples, title }: { samples: CodeSample[]; title?: string }) {
  const [active, setActive] = useState(0);
  const [copied, setCopied] = useState(false);
  const id = useId();
  const current = samples[active] ?? samples[0];
  const lines = current.code.split("\n");

  async function copy() {
    try {
      await navigator.clipboard.writeText(current.code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked */
    }
  }

  return (
    <div className="code">
      <div className="code__bar">
        {samples.length > 1 ? (
          <div className="code__tabs" role="tablist" aria-label={title ?? "Code samples"}>
            {samples.map((sample, index) => (
              <button
                key={sample.label}
                type="button"
                role="tab"
                id={`${id}-tab-${index}`}
                aria-selected={index === active}
                aria-controls={`${id}-panel`}
                className="code__tab"
                onClick={() => setActive(index)}
              >
                {sample.label}
              </button>
            ))}
          </div>
        ) : (
          <span className="code__title">{current.label}</span>
        )}
        <button type="button" className="icon-btn" onClick={() => void copy()} aria-label={copied ? "Copied" : "Copy code"}>
          {copied ? <IconCheck size={16} /> : <IconCopy size={16} />}
        </button>
      </div>
      <pre
        id={`${id}-panel`}
        role={samples.length > 1 ? "tabpanel" : undefined}
        aria-labelledby={samples.length > 1 ? `${id}-tab-${active}` : undefined}
        tabIndex={0}
      >
        <code>
          {lines.map((line, index) => (
            <span key={index}>
              {highlight(line, index)}
              {index < lines.length - 1 ? "\n" : ""}
            </span>
          ))}
        </code>
      </pre>
    </div>
  );
}
