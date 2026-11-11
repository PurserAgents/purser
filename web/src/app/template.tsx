import type { ReactNode } from "react";

/** Re-mounts on every navigation, so each page fades in (globals.css: .page-fade). */
export default function Template({ children }: { children: ReactNode }) {
  return <div className="page-fade">{children}</div>;
}
