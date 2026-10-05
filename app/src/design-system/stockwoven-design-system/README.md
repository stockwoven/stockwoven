# Stockwoven

One stock. One token.

Stockwoven is infrastructure on Solana. The same stock is tokenized by several issuers, and each version trades in its own pool. Stockwoven's vault takes every issuer's version in and gives back one yield-bearing token per stock, with all the liquidity in one place. The brand is built from that idea: separate threads woven into one fabric.

**Who it is for.** Stockwoven is offered mainly to neobanks and fintechs that want to give their customers tokenized stocks. The neobank owns the customer and the app; Stockwoven is the layer underneath. So the brand has two jobs:

1. **Sell to partners** (website, docs, pitch decks, events, LinkedIn): here Stockwoven leads, with the full identity.
2. **Live inside partner products**: here the partner's brand leads, and Stockwoven appears only as a "Powered by" badge and in the `sw` tickers.

This system holds the symbol, the colors, the type, the woven pattern, the co-branding rules and a few components. Start here, then use the tokens (`tokens.json`) and the assets by name.

## Brand idea

- **Many issuers. One thread.** Every visual comes back to weaving: strands that cross, pass over and under, and end up as one surface.
- **Print, not screen.** Black and ivory feel like paper and ink. Purple is the only color, used like a highlighter.
- **Precise.** Diagonals at 45°, square ends, figures in a monospaced face. Nothing soft or decorative.

## Content fundamentals

Copy for partners is in English by default and in Portuguese for Brazilian neobanks. Write to the person deciding at the partner: a product lead, a CTO, a head of investments.

- **Voice:** direct, calm, specific, like infrastructure. Say what the vault does for the partner and its customers, in numbers when possible: liquidity, integration time, assets covered.
- **Talk about the partner's customer as "your customers"**, never as "our users". Stockwoven has no end users of its own.
- **Short headlines in pairs.** Two short sentences with the same rhythm: "One stock. One token." · "Many issuers. One thread." · "Real markets. New threads."
- **Tickers carry the brand.** Every unified asset is the stock ticker with the `sw` prefix: `swAAPL`, `swNVDA`, `swTSLA`. Write the prefix in lowercase, the ticker in caps, no space. Set tickers in JetBrains Mono, with the prefix in `accent-text`.
- **Numbers are monospaced** and always carry their unit: `1,450.55 swAAPL`, `$2.8B`, `23%`.
- **Avoid:** hype ("revolutionary", "to the moon"), promises of returns, emoji.

| Say | Avoid |
| --- | --- |
| Give your customers one token per stock, with all the liquidity in one pool. | The ultimate DeFi experience. |
| swAAPL earns yield from [source]. | Guaranteed passive income. |
| One integration. Every issuer. | Unlock the future of finance. |

## The symbol

A 3×3 basket weave cut to a square with four serrated corners. Use the asset files (`assets/Logos/`); never redraw it.

- **Construction:** strands at 45°, 23 units wide, gaps of 6 units, in a 100-unit box (88-unit square, 6-unit margin). Every cut is at 45° or 90°. The four corner cuts are equal.
- **Versions:** ivory on black or purple, black on ivory, purple on ivory or black.
- **Lockup:** symbol + the wordmark "Stockwoven" in Bricolage Grotesque Bold, tracking −0.045em. Symbol height ≈ the wordmark's font size; gap = 20% of the symbol's width; both vertically centered.
- **Clear space:** 25% of the symbol's width on every side.
- **Minimum size:** 24 px on screen, 8 mm in print. The weave detail closes up below that; at 16 px (favicon) use it on a solid purple or black tile so the outline still reads.
- **Don't:** rotate it, add gradients or shadows, outline it, change the gaps, set it in more than one color, or put it on the pattern without a solid tile behind it.

## Color

| Token | Hex | Role |
| --- | --- | --- |
| `brand-ink` | #101010 | Base, text, dark grounds |
| `brand-ivory` | #F4F0E5 | Light grounds, logo on dark |
| `brand-purple` | #9945FF | The one accent: action, the token, highlights |
| `brand-gray` | #A6AAA5 | Lines, secondary diagram strands |

Rules:

- **Purple is the accent.** Use `accent` for buttons, the highlighted card or the token itself. Never as a full-page background on the website or docs; full purple is for statement slides and the logo board.
- **Small purple text** uses `accent-text` (`purple-ink` on ivory, `purple-soft` on black). `brand-purple` as text only at 24 px and up.
- **Text on purple** is `on-purple` (white, 4.5:1). Ivory on purple only at 24 px and up.
- **Two grounds:** ivory (`light` theme) for reading and product, black (`dark` theme) for statements and covers. Alternate them across slides and sections.

## Typography

| Role | Family | Use |
| --- | --- | --- |
| Display | Bricolage Grotesque 700 | Wordmark, headlines, big numbers in marketing. Tight tracking, short lines. |
| Text | Instrument Sans 400 / 700 | Running text, buttons, navigation. |
| Data | JetBrains Mono 400 | Tickers, balances, addresses, sources, eyebrows in uppercase. |

- Headlines are sentence case and end with a period: "One stock. One token."
- Use the type styles in `tokens.json` (`display-xl` … `eyebrow`); don't invent sizes in between.
- The web build of Bricolage Grotesque goes up to 800; the font files here are 400 and 700. Use 700 for display.

## The woven pattern

Diagonal strands of ivory and purple (black and purple on ivory) in a plain weave: each strand passes over one crossing and under the next, separated by black gaps.

- **Purple is solid, the other set carries the gradient.** Purple strands are always flat color. The ivory strands (black on the light version) are solid where they ride over a crossing and break into halftone dots that shrink into the ground as they dive under the next purple strand. A raking light keeps one side of each span bright longer, so every span reads as a ribbon rising and dipping.
- **Dots are only for gradients**: where a strand goes under, and where the pattern fades into the page. Never as a flat texture inside a strand.
- **Fades are halftone too.** When text sits beside the pattern, fade it with the `fade` option, not with a soft CSS mask or a transparent overlay.
- It is generated, never drawn by hand: the `WeavePattern` component (`Stockwoven.weave(canvas, {seed, light, fade})`) or the files in `assets/Pattern/`.
- Use it full-bleed: hero art, poster, banner, the right half of a slide. Never under body text, never inside a partner's product.
- `light` mode (ivory ground) for the website and docs, dark mode for covers and social.

## Layout

- **Bento grids:** tiles of `radius-lg`, gaps of `space-3`, no shadows. One tile in a row may be `surface-inverse` or `accent` to carry the emphasis.
- **Cards:** `surface` on `bg`, 1px `line` border on ivory, no border on black.
- **Slides:** 128 px margins on a 1920×1080 canvas, an eyebrow in `eyebrow`, a title in `display-lg`, a 24 px mono footer row with the source and the page number.

## Co-branding with partners

Inside a neobank's app, the neobank's brand leads. Stockwoven stays small and consistent.

- **"Powered by Stockwoven" badge** (component `PoweredBy`): the symbol plus "Powered by Stockwoven" in `label`. Place it once per flow, at the bottom of the investment screen or in the asset detail, never in the app's header or tab bar.
- **Badge colors follow the partner's screen:** `ink` version on light screens, `ivory` version on dark screens. Never recolor the symbol to the partner's color; if the badge must disappear into the partner's palette, use the one-color gray version.
- **Tickers keep the `sw` prefix** in the partner app (`swAAPL`). The partner can style the chip in its own colors; the prefix and the monospaced face stay.
- **Partner first, Stockwoven second** in joint materials: "[Partner] × Stockwoven", the partner's logo on the left, a 1px `line` divider, Stockwoven's lockup on the right at the same height as the partner's logo.
- **Don't:** put the purple, the pattern or the full lockup inside a partner's product without their brand team's approval. The pattern is for Stockwoven's own channels.

## Iconography

There is no icon set. Product UI uses plain text labels and the symbol. When an icon is unavoidable, use a 2px-stroke outline set with square caps, in `text`, never in purple.

## Applications

- **Own channels** (website, docs, decks, events, LinkedIn, X): full identity, both grounds, the pattern.
- **Partner products:** the `PoweredBy` badge and `sw` tickers only (see Co-branding).
- **Avatars:** `assets/Social/` has five 1024 px avatars (black, purple, ivory, pattern, app icon), all safe in a circle crop.
- **Banners:** 1500×500 X headers, light and dark; the text sits right of the avatar overlap.
- **App icon:** ivory symbol on a purple tile with `radius-icon`.
