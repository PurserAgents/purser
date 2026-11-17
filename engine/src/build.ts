import { execFileSync } from "node:child_process";
import { REPO_ROOT, VERSION } from "./config.ts";

// `git archive` (how the engine is deployed) writes the commit into this string (export-subst in .gitattributes).
const STAMPED = "$Format:%H$";

/** The commit this engine was built from: the archive's stamp, Railway's git variable, or the working copy's HEAD. */
function commit(): string | null {
  if (!STAMPED.startsWith("$Format")) return STAMPED;
  if (process.env.RAILWAY_GIT_COMMIT_SHA) return process.env.RAILWAY_GIT_COMMIT_SHA;
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, stdio: ["ignore", "pipe", "ignore"] }).toString().trim() || null;
  } catch {
    return null;
  }
}

export const BUILD_COMMIT = commit();
/** The version with the build: "0.1.0+3a30202" (or "0.1.0+unknown" when nothing tells). */
export const BUILD_VERSION = `${VERSION}+${BUILD_COMMIT ? BUILD_COMMIT.slice(0, 7) : "unknown"}`;
