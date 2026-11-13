"use client";

import { useState } from "react";

export function CopyAddress({ address }: { address: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="btn btn--secondary"
      style={{ fontFamily: "var(--font-mono, monospace)", fontSize: 13, maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis" }}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(address);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          /* clipboard blocked */
        }
      }}
      aria-label="Copy the contract address"
    >
      {copied ? "Copied" : address}
    </button>
  );
}
