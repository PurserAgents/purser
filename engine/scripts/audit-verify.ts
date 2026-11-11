/**
 * Verifies a Purser audit export offline: every hash, every link and every signature.
 *   npm run audit:verify -- purser-audit.jsonl [--signer 0xADDRESS]
 * Exit code 0 when the whole chain checks out, 1 otherwise.
 */
import { readFileSync } from "node:fs";
import { verifyAudit } from "../src/audit.ts";
import { parseExport } from "../src/auditApi.ts";

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
if (!file) {
  console.error("usage: audit-verify <export.jsonl> [--signer 0x...]");
  process.exit(2);
}
const signer = args.indexOf("--signer") >= 0 ? (args[args.indexOf("--signer") + 1] as `0x${string}`) : undefined;
const r = await verifyAudit(parseExport(readFileSync(file, "utf8")), signer);
if (r.ok) console.log(`OK: ${r.entries} entries, hash chain intact, all signed by ${r.signer}.`);
else console.log(`FAILED at entry ${r.brokenAt}: ${r.problem}.`);
process.exit(r.ok ? 0 : 1);
