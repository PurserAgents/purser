/**
 * @purseragents/plugin-purser: give an ElizaOS agent its own Purser account.
 *
 *   import { purserPlugin } from "@purseragents/plugin-purser";
 *
 *   export const character = {
 *     name: "Ops",
 *     plugins: [purserPlugin],
 *     settings: { secrets: { PURSER_API_KEY: process.env.PURSER_API_KEY } },
 *   };
 *
 * The agent gets actions to read its account and rules, check and make payments, read receipts, fetch paid URLs
 * (x402), ask AI models at the provider's own price, pay invoices and read its profit. Every payment goes through the owner's rules and Purser's firewall
 * first; a blocked payment is answered with the reasons, and the agent is told not to try another way.
 */
import type { Action, ActionParameter, ActionResult, HandlerCallback, IAgentRuntime, Memory, Plugin } from "@elizaos/core";
import { Purser, purserFromSettings, purserTools, runPurserTool, type PurserTool } from "@purseragents/sdk";

const setting = (runtime: IAgentRuntime, key: string) => {
  const v = runtime.getSetting(key);
  return v === null || v === undefined || v === "" ? undefined : String(v);
};

/** One set of live tools per agent, made from that agent's settings, so each agent pays from its own account. */
const live = new WeakMap<IAgentRuntime, PurserTool[]>();
function toolFor(runtime: IAgentRuntime, name: string): PurserTool {
  let tools = live.get(runtime);
  if (!tools) {
    tools = purserTools(purserFromSettings({ apiKey: setting(runtime, "PURSER_API_KEY"), baseUrl: setting(runtime, "PURSER_ENGINE_URL") }));
    live.set(runtime, tools);
  }
  return tools.find((x) => x.name === name)!;
}

/** The tool definitions, read once; the client is made per agent from its settings. */
const SPECS = purserTools(new Purser({ baseUrl: "https://purseragents.fun", apiKey: "prs_spec" }));

const actionName = (t: PurserTool) => t.name.toUpperCase();

function parametersOf(t: PurserTool): ActionParameter[] {
  return Object.entries(t.parameters.properties).map(([name, p]) => ({
    name,
    description: p.description,
    required: t.parameters.required.includes(name),
    schema: { type: p.type, description: p.description, ...(p.enum ? { enum: p.enum } : {}), ...(p.default !== undefined ? { default: p.default } : {}), ...(p.minimum !== undefined ? { minimum: p.minimum } : {}), ...(p.maximum !== undefined ? { maximum: p.maximum } : {}) },
  }));
}

const SIMILES: Record<string, string[]> = {
  purser_account: ["CHECK_BALANCE", "MY_BALANCE", "WALLET_BALANCE"],
  purser_rules: ["SPENDING_LIMITS", "MY_BUDGET"],
  purser_check_payment: ["CHECK_PAYMENT", "IS_PAYMENT_SAFE"],
  purser_pay: ["PAY", "SEND_PAYMENT", "SEND_USDG", "TRANSFER"],
  purser_receipts: ["RECEIPTS", "PAYMENT_HISTORY", "TRANSACTIONS"],
  purser_paid_fetch: ["X402_FETCH", "PAID_FETCH", "BUY_API_CALL"],
  purser_ask_model: ["ASK_MODEL", "ASK_AI", "THINK_HARDER", "CALL_LLM"],
  purser_pay_invoice: ["PAY_INVOICE"],
  purser_profit: ["PROFIT_AND_LOSS", "PNL", "EARNINGS"],
};

const EXAMPLES: Record<string, { user: string; params?: Record<string, string> }> = {
  purser_account: { user: "How much money do you have left today?" },
  purser_pay: { user: "Pay 0x1111111111111111111111111111111111111111 2.50 USDG for the weather report", params: { to: "0x1111111111111111111111111111111111111111", amount: "2.50", memo: "weather report" } },
  purser_receipts: { user: "What did you pay for lately?" },
};

function toAction(t: PurserTool): Action {
  const name = actionName(t);
  const ex = EXAMPLES[t.name];
  return {
    name,
    similes: SIMILES[t.name] ?? [],
    description: `${t.description} (Purser)`,
    parameters: parametersOf(t),
    tags: t.movesMoney ? ["capability:send"] : [],
    ...(t.movesMoney ? { routingHint: `money out of the agent's own Purser account -> ${name}; the owner's rules and the firewall decide, never retry a block another way` } : {}),
    ...(ex ? { exampleCalls: [{ user: ex.user, actions: [name], ...(ex.params ? { params: { [name]: ex.params } } : {}) }] } : {}),
    validate: async (runtime: IAgentRuntime) => !!setting(runtime, "PURSER_API_KEY"),
    handler: async (runtime: IAgentRuntime, message: Memory, _state, options, callback?: HandlerCallback): Promise<ActionResult> => {
      const o = (options ?? {}) as { parameters?: Record<string, unknown>; parameterErrors?: string[] };
      const params: Record<string, unknown> = { ...(o.parameters ?? {}) };
      // The firewall reads what led to a payment, so a payment always carries the message that asked for it.
      if (t.parameters.properties.context && !params.context && message.content?.text) params.context = message.content.text;
      const missing = t.parameters.required.filter((k) => params[k] === undefined || params[k] === null || params[k] === "");
      if (missing.length) {
        const text = `To do that I need: ${missing.join(", ")}.`;
        await callback?.({ text, actions: [name] });
        return { success: false, text, error: text };
      }
      let text: string;
      try {
        text = await runPurserTool(toolFor(runtime, t.name), params);
      } catch (e) {
        text = `Purser could not do that: ${e instanceof Error ? e.message : String(e)}`;
      }
      const ok = !text.startsWith("Purser could not");
      await callback?.({ text, actions: [name] });
      return { success: ok, text, userFacingText: text, data: { tool: t.name, blocked: text.startsWith("Blocked.") }, ...(ok ? {} : { error: text }) };
    },
  };
}

export const purserActions: Action[] = SPECS.map(toAction);

export const purserPlugin: Plugin = {
  name: "purser",
  description: "A bank account for the agent: balances, spending rules, payments checked by a firewall, receipts, paid URLs (x402), AI models at cost, invoices and profit, on Purser.",
  config: { PURSER_API_KEY: null, PURSER_ENGINE_URL: null },
  init: async (_config: Record<string, string>, runtime: IAgentRuntime) => {
    if (!setting(runtime, "PURSER_API_KEY")) {
      runtime.logger?.warn?.("Purser: PURSER_API_KEY is not set, so the Purser actions stay off. The owner creates the key on purseragents.fun for one account.");
    }
  },
  actions: purserActions,
};

export default purserPlugin;
export { Purser, PURSER_DEFAULT_URL } from "@purseragents/sdk";
