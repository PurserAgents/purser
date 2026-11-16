// Example: Purser with ElizaOS. Install the packages named in guides/elizaos.md first.
// Not part of the SDK build.

import { purserPlugin } from "@purseragents/plugin-purser";

export const character = {
  name: "Ops",
  bio: ["Pays the team's vendors and keeps the books."],
  plugins: [purserPlugin],
  settings: { secrets: { PURSER_API_KEY: process.env.PURSER_API_KEY } },
};
