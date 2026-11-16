/**
 * @purseragents/ai-sdk: give an agent built with the Vercel AI SDK its own Purser account.
 *
 *   import { generateText } from "ai";
 *   import { purserTools } from "@purseragents/ai-sdk";
 *
 *   const { text } = await generateText({
 *     model,
 *     tools: purserTools({ apiKey: process.env.PURSER_API_KEY }),
 *     prompt: "Pay the data vendor 2.50 USDG for today's report.",
 *   });
 *
 * Every payment goes through the owner's rules and Purser's firewall first. A blocked payment comes back to the
 * model as a plain answer with the reasons ("Blocked. ... Nothing was paid."), never as a thrown error.
 */
import { jsonSchema, tool, type ToolSet } from "ai";
import { Purser, purserFromSettings, purserTools as coreTools, runPurserTool, type PurserTool } from "@purseragents/sdk";

export interface PurserAiSdkOptions {
  /** The agent's API key (prs_...). Default: process.env.PURSER_API_KEY */
  apiKey?: string;
  /** The Purser engine. Default: process.env.PURSER_ENGINE_URL, then https://purseragents.fun */
  baseUrl?: string;
  /** A Purser client you made yourself, instead of apiKey and baseUrl. */
  client?: Purser;
  /** Only these tools, by name (for example ["purser_account", "purser_pay"]). */
  only?: string[];
  /** Leave out every tool that can move money. */
  readOnly?: boolean;
  /**
   * Ask a human before a tool that moves money runs (the AI SDK's tool approval). Purser's own rules and owner
   * approvals apply either way; this adds a check in your app. Default: false.
   */
  needsApproval?: boolean;
  fetch?: typeof fetch;
}

const env = (k: string) => (typeof process !== "undefined" ? process.env?.[k] : undefined);

function client(o: PurserAiSdkOptions): Purser {
  return o.client ?? purserFromSettings({ apiKey: o.apiKey ?? env("PURSER_API_KEY"), baseUrl: o.baseUrl ?? env("PURSER_ENGINE_URL"), fetch: o.fetch });
}

function wrap(t: PurserTool, needsApproval: boolean) {
  return tool({
    title: t.title,
    description: t.description,
    inputSchema: jsonSchema<Record<string, unknown>>(t.parameters as unknown as Parameters<typeof jsonSchema>[0]),
    ...(needsApproval && t.movesMoney ? { needsApproval: true } : {}),
    execute: async (input: Record<string, unknown>) => runPurserTool(t, input),
  });
}

/** Purser's tools as an AI SDK ToolSet, keyed by name: purser_account, purser_pay, purser_check_payment and the rest. */
export function purserTools(options: PurserAiSdkOptions = {}): ToolSet {
  const set: ToolSet = {};
  for (const t of coreTools(client(options), { only: options.only, readOnly: options.readOnly })) set[t.name] = wrap(t, !!options.needsApproval);
  return set;
}

export { Purser, PURSER_DEFAULT_URL } from "@purseragents/sdk";
