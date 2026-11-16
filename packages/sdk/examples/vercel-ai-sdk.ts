// Example: Purser with the Vercel AI SDK. Install the packages named in guides/vercel-ai-sdk.md first.
// Not part of the SDK build.

import { generateText, stepCountIs, type LanguageModel } from "ai";
import { purserTools } from "@purseragents/ai-sdk";

export async function payVendor(model: LanguageModel) {
  const { text } = await generateText({
    model,
    tools: purserTools({ apiKey: process.env.PURSER_API_KEY }),
    stopWhen: stepCountIs(5),
    prompt: "Check my rules, then pay the data vendor 0x1111111111111111111111111111111111111111 2.50 USDG for today's report.",
  });
  return text;
}
