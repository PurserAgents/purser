# Purser design

One direction. White and light gray, black type and accents, a charcoal dark mode. Private bank meets developer
tool: calm, precise, generous white space, 1px hairlines, big confident type, tabular numbers.

Everything below lives in `web/src/app/globals.css` (tokens at `:root`, dark overrides at `[data-theme="dark"]`).
Never hard-code a colour in a component: use a token.

## Colour tokens

| Token | Light | Dark | Use |
|---|---|---|---|
| `--bg` | `#ffffff` | `#0b0b0c` | page |
| `--bg-subtle` | `#f7f7f8` | `#101012` | alternate sections, table heads, footer |
| `--bg-muted` | `#efeff1` | `#19191c` | hover fills, meter tracks |
| `--surface` | `#ffffff` | `#131315` | cards, cells |
| `--surface-raised` | `#ffffff` | `#17171a` | floating cards, popovers |
| `--line` | `#e4e4e7` | `#26262a` | hairlines |
| `--line-strong` | `#cfcfd4` | `#3a3a40` | input and card outlines that need more weight |
| `--text` | `#0a0a0b` | `#f4f4f5` | headings, primary text |
| `--text-2` | `#45454d` | `#b6b6be` | body text |
| `--text-3` | `#686871` | `#92929c` | labels, captions |
| `--accent` / `--on-accent` | `#0a0a0b` / `#ffffff` | `#f4f4f5` / `#0b0b0c` | primary buttons, rank chips |
| `--ok` / `--ok-bg` | `#17794a` / `#edf6f1` | `#56c492` / `#12241b` | active, income |
| `--stop` / `--stop-bg` / `--stop-line` | `#b3261e` / `#fbeeed` / `#efc9c6` | `#ff8274` / `#2a1513` / `#55241f` | blocked, freeze, loss |
| `--wait` / `--wait-bg` | `#8a5a00` / `#f8f1e3` | `#e2ac45` / `#2a2010` | needs approval |

Status colours are used sparingly: a badge, an amount, the blocked payment. Never as decoration.

### Contrast (WCAG AA, 4.5:1 for text)

| Pair | Light | Dark |
|---|---|---|
| `--text` on `--bg` | 19.8 | 17.9 |
| `--text-2` on `--bg` / `--bg-subtle` | 9.5 / 8.9 | 9.8 / 9.4 |
| `--text-3` on `--bg` / `--bg-subtle` / `--bg-muted` | 5.5 / 5.2 / 4.8 | 6.4 / 6.2 / 5.7 |
| `--ok` on `--bg` / `--ok-bg` | 5.4 / 4.9 | 9.1 / 7.5 |
| `--stop` on `--bg` / `--stop-bg` | 6.5 / 5.8 | 8.2 / 7.2 |
| `--wait` on `--wait-bg` | 5.3 | 7.8 |

## Theme

Light is the default, always: every first visit opens light, whatever the system colour setting is. Dark only when
the visitor picks it with the header toggle, which switches `data-theme` on `<html>` and saves the choice in
`localStorage` under `purser-theme` (inside try/catch). The inline script in `<head>` reads that saved choice and
nothing else, before first paint, so there is no flash. No style or script follows `prefers-color-scheme`. The
toggle also repaints the `theme-color` meta tag (white, or the dark page colour).

## Backdrops

The pages are never a blank sheet. Pure CSS (layered gradients and one mask), grays from the palette only, the
same design in both themes through three tokens.

| Token | Light | Dark | Use |
|---|---|---|---|
| `--grid-dot` | `#d4d4d9` | `#2e2e33` | 1px dots of the dot grid |
| `--grid-line` | ink at 6% | white at 4.5% | hairlines of the ledger grid |
| `--wash` | ink at 3.5% | white at 4.5% | soft wash (a light glow in dark mode) |

| Where | What |
|---|---|
| Top of every page (`body::before`) | a fine ledger grid of 56px squares with a soft wash, fading out to the sides and down within the first 880px. It sits behind the page head, the dashboard tabs and the first cards |
| Landing hero (`.hero::before`, `.hero::after`) | a 24px dot grid that fades out around the flow visual, with a soft wash behind the account card. The grid drifts one tile in 96 seconds |
| Gray sections (`.section--subtle`) | the dot grid under the section head, fading out to the sides and down |
| White sections (`.section`) | a soft wash under the section rule |
| Closing call (`.section` that holds `.cta`) | the ledger grid again, centred behind the heading |

Rules: a backdrop never sits above content, never uses a status colour, and stays this faint. The wash changes
the page colour by less than `--bg-subtle` does, so every text pair in the contrast table above still holds.
Fades are a gradient to the section's own colour on top of the pattern (the mask is only used at the top of the
page), with the fade width in `--fade-x` (wider on phones).

## Type

Self-hosted woff2 in `web/public/fonts` (latin subsets, SIL Open Font License).

| Family | File | Use |
|---|---|---|
| Geist (variable) | `geist.woff2` | everything |
| Geist Mono (variable) | `geist-mono.woff2` | eyebrows, table heads, code, addresses |
| Instrument Serif Italic | `instrument-serif-italic.woff2` | one or two accent words in a display heading (`.serif`) |

| Class | Size | Weight | Tracking |
|---|---|---|---|
| `.display` | clamp(2.75rem, 1.6rem + 4.6vw, 5.25rem) | 500 | -0.045em |
| `.h1` | clamp(2.25rem, 1.6rem + 2.6vw, 3.75rem) | 500 | -0.04em |
| `.h2` | clamp(1.875rem, 1.4rem + 1.9vw, 3rem) | 500 | -0.035em |
| `.h3` | 1.25rem | 500 | -0.015em |
| `.h4` | 1rem | 500 | -0.005em |
| `.lead` | clamp(1.0625rem, 1rem + 0.3vw, 1.25rem) | 400 | 0 |
| body | 1rem / 1.6 | 400 | 0 |
| `.small` | 0.875rem | 400 | 0 |
| `.micro`, `.eyebrow` | 0.75rem (eyebrow: mono, uppercase, 0.08em) | 400 | |

Numbers that line up use `.num` (tabular figures). Money is formatted with `formatMoney` from `lib/format.ts`.

## Spacing, radii, shadows

- Spacing, 4px base: `--s-1` 4, `--s-2` 8, `--s-3` 12, `--s-4` 16, `--s-5` 24, `--s-6` 32, `--s-7` 48, `--s-8` 64,
  `--s-9` 96, `--s-10` 128.
- Page: `--page` 1200px, `--gutter` 24px (16px on phones), `--header-h` 64px (56px on phones),
  `--section-y` clamp(72px, 9vw, 128px).
- Radii: `--r-sm` 6, `--r-md` 10 (buttons, small boxes), `--r-lg` 16 (cards), `--r-pill`.
- Shadows: `--shadow-1` (a hint under chips and code), `--shadow-2` (the two floating cards: hero ledger and the
  blocked payment). Everything else is flat with a hairline.
- Breakpoints: 1020px (header collapses to the menu, hero stacks), 960px, 860px, 760px (tables stack), 640px.

## Chrome (fixed)

Full-width sticky header: logo and "Purser" top left, four section menus in the middle (Product, Dashboard,
Network, Developers; each opens a panel of links with one line of text), GitHub and X icons, theme toggle
and Connect wallet top right. Below 1020px the nav, socials and wallet move into the menu sheet. A footer with
three link columns and the own-risk line. There is no sidebar navigation anywhere. The docs page has an
"On this page" list on the right, which is a table of contents, not navigation.

Links, names and the nav live in `web/src/lib/site.ts`. The logo is drawn only in
`web/src/components/Logo.tsx` (the favicon and share image reuse its glyph).

## Components

React, in `web/src/components`:

| Component | What it is |
|---|---|
| `Logo` | placeholder monogram, the one file to swap |
| `Header`, `Footer` | site chrome, mobile menu included |
| `ThemeToggle` | light and dark switch, plus the no-flash script |
| `Wallet` | `WalletProvider`, `useWallet`, `WalletButton`: MetaMask through EIP-1193, chain switch to 4663, mobile deep link |
| `Icons` | inline SVG icons, 24px grid, 1.6 stroke |
| `ui` | `PageHead`, `SectionHead`, `Card`, `Stat`, `Meter`, `EmptyState`, `initials` |
| `Reveal` | fade in on scroll, visible without JavaScript |
| `CountUp` | number that counts when scrolled into view |
| `CodeTabs` | code block with tabs and copy |
| `HeroFlow` | hero visual: particle flows (canvas, `lib/flowCanvas.ts`) and the self-writing ledger |
| `Receipts` | `ReceiptList`, with blocked reasons |
| `Rules` | `RulesList` |
| `DayChart` | income and spend per day (from the P&L) |
| `SeriesChart` | spend and earnings over time (economy) |
| `Live` | `LiveProvider` (one SSE connection), `useEngine`, `useEngineEvents`, `useNow` |
| `FirewallRun` | the firewall scenario: steps, the page the agent read, the payment, checks, verdict, result |
| `PayBuilder` | the pay button builder with the real button from the engine |
| `Markdown` | renders the framework guides from `packages/sdk/guides` |
| `owner/*` | `OwnerFrame`, `useAction`/`ActionStatus`, `AgentPicker` and one component per dashboard page |

CSS building blocks (class names): `.container`, `.section` (`--subtle`, `--tight`), `.section-head`, `.grid--2/3/4`,
`.split`, `.stack`, `.row`, `.card` (`--flush` with `.card__head` and `.card__body`), `.cells--2/3/4` with `.cell`
(hairline grid), `.btn` (`--primary`, `--secondary`, `--ghost`, `--danger`, `--sm`, `--lg`), `.icon-btn`, `.badge`
(`--ok`, `--stop`, `--wait`, `--ink`), `.table` (`.table--stack` for phones, `.hide-sm`), `.kv`,
`.checks`, `.meter`, `.code`, `.notice`, `.pipeline`, `.lanes`, `.verdict`, `.chart`, `.prose`.

## Motion

- Hero: fine particles travel along hairline curves between nodes and the account card. Money in from the top,
  money out at the bottom, one stream stopped at a gate. The card's ledger writes a new line every 2.6 seconds and
  the balance eases to its new value. Canvas 2D, pixel ratio capped at 2, paused off screen and in hidden tabs.
- Hero backdrop: the dot grid drifts one 24px tile every 96 seconds (a transform, nothing repaints).
- Reduced motion: one still frame of the flow, a static ledger, a still backdrop, no reveals, no counting.
- Without JavaScript: the nodes, the card and all content are still there.
- Elsewhere: `Reveal` (700ms fade and 12px rise, once), `CountUp` (1.6s), the blocked payment's checks appear in
  order. Nothing loops outside the hero.

## Data

Public pages render on the server through `web/src/lib/data.ts`, which asks the engine at `PURSER_ENGINE_URL` and
returns the answer or `null` (unset, no answer in time, wrong shape). `null` means an empty state, never numbers made
up. Shapes are in `web/src/lib/types.ts`, a mirror of `packages/sdk/src/schema.ts`. Amounts are base units as strings;
dollar fields (`...Usd`) are formatted with `usd()`, token amounts with `formatMoney()` or `money()`.

The browser talks to the engine through the site's proxy at `/v1/*` (`app/v1/[...path]/route.ts`), with `api()` from
`lib/client.ts`. `useEngine(path, { refreshOn })` (`components/Live.tsx`) loads a path and reloads it when a live
event of those types arrives on the one shared SSE connection.

Owner actions: the engine prepares, the wallet signs. `lib/owner.ts` has two signers behind one interface: MetaMask
(EIP-1193: `eth_sendTransaction`, `eth_signTypedData_v4` then `execTransaction`, `personal_sign` for the owner session)
and, only when the engine is in test mode, the engine's test wallet. `useAction()` runs one action and shows a plain
status line (`ActionStatus`).

## Empty states

`EmptyState` (icon, title, one line of what will appear and how, optional action). `panel` for a whole page area,
`size="sm"` inside a card. Every list, chart and table uses it when there is nothing yet; nothing is ever labelled
sample, demo, example or illustration.

## Adding a page

1. Public page: create `web/src/app/<route>/page.tsx`, start with `<PageHead>`, wrap the body in `.container.page-body`,
   load data with a loader in `data.ts` and render an `EmptyState` for `null`.
2. Dashboard page: a server `page.tsx` with the metadata that renders a client component wrapped in `<OwnerFrame>`
   (`components/owner/Frame.tsx`): it adds the heading, the dashboard tabs, and the gates (engine reachable, wallet
   connected, at least one agent). Add the page to `ownerNav` in `site.ts`.
3. Add the link to `navGroups` or `footerNav` in `site.ts`.
4. Add the route to `web/test/smoke.test.mjs`, `app/sitemap.ts` and `web/test/shots.mjs`.

## Copy rules

No em dashes. No emoji or arrow characters (icons are inline SVG). Say what Purser does, nothing more. The token
page says "soon" and shows no numbers. No sample, demo, example or illustration labels anywhere.
