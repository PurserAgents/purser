/**
 * @purseragents/langchain: give a LangChain or LangGraph agent its own Purser account.
 *
 *   import { createAgent } from "langchain";
 *   import { purserTools } from "@purseragents/langchain";
 *
 *   const agent = createAgent({ model: "anthropic:claude-sonnet-5-5", tools: purserTools({ apiKey: process.env.PURSER_API_KEY }) });
 *   await agent.invoke({ messages: [{ role: "user", content: "Pay the data vendor 2.50 USDG for today's report." }] });
 *
 * The tools work anywhere LangChain tools do: createAgent, LangGraph's ToolNode, or model.bindTools(...).
 * Every payment goes through the owner's rules and Purser's firewall first. A blocked payment comes back to the
 * model as a plain answer with the reasons ("Blocked. ... Nothing was paid."), never as a thrown error.
 */
import { tool, type StructuredToolInterface } from "@langchain/core/tools";
import { Purser, purserFromSettings, purserTools as coreTools, runPurserTool, type PurserTool } from "@purseragents/sdk";

export interface PurserLangChainOptions {
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
  fetch?: typeof fetch;
}

const env = (k: string) => (typeof process !== "undefined" ? process.env?.[k] : undefined);

function client(o: PurserLangChainOptions): Purser {
  return o.client ?? purserFromSettings({ apiKey: o.apiKey ?? env("PURSER_API_KEY"), baseUrl: o.baseUrl ?? env("PURSER_ENGINE_URL"), fetch: o.fetch });
}

function wrap(t: PurserTool): StructuredToolInterface {
  return tool(async (input: Record<string, unknown>) => runPurserTool(t, input), {
    name: t.name,
    description: t.description,
    schema: t.parameters as unknown as Record<string, unknown>,
    metadata: { purser: true, movesMoney: t.movesMoney },
  }) as unknown as StructuredToolInterface;
}

/** Purser's tools as LangChain tools: purser_account, purser_pay, purser_check_payment and the rest. */
export function purserTools(options: PurserLangChainOptions = {}): StructuredToolInterface[] {
  return coreTools(client(options), { only: options.only, readOnly: options.readOnly }).map(wrap);
}

/** The same tools as a toolkit object, for code that expects `toolkit.getTools()`. */
export class PurserToolkit {
  tools: StructuredToolInterface[];
  constructor(options: PurserLangChainOptions = {}) {
    this.tools = purserTools(options);
  }
  getTools() {
    return this.tools;
  }
}

export { Purser, PURSER_DEFAULT_URL } from "@purseragents/sdk";
