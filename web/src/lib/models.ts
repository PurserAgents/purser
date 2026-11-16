/**
 * The models Purser serves at cost, with the provider's own list prices (the same table the engine charges by).
 * Prices are dollars per million tokens.
 */
export interface AtCostModel {
  id: string;
  name: string;
  level: "fast" | "balanced" | "best";
  input: number;
  output: number;
  long?: { above: number; input: number; output: number };
  goodFor: string;
}

export const AT_COST_MODELS: AtCostModel[] = [
  { id: "claude-haiku-5-5", name: "Claude Haiku 5.5", level: "fast", input: 0.1, output: 0.5, long: { above: 100_000, input: 0.5, output: 2.5 }, goodFor: "Sorting, extracting, routing, short answers" },
  { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", level: "balanced", input: 2, output: 10, goodFor: "Writing, research, most agent work" },
  { id: "claude-opus-5-5", name: "Claude Opus 5.5", level: "best", input: 4, output: 20, goodFor: "Hard reasoning, long plans, code" },
];

export const SETTLE_AT_USD = 0.25;

/** Cost of one call in dollars at the provider's price. */
export function callCost(m: AtCostModel, inputTokens: number, outputTokens: number): number {
  const long = m.long && inputTokens > m.long.above;
  return (inputTokens * (long ? m.long!.input : m.input) + outputTokens * (long ? m.long!.output : m.output)) / 1_000_000;
}

export const levelLabel: Record<AtCostModel["level"], string> = { fast: "Fast", balanced: "Balanced", best: "Best" };
