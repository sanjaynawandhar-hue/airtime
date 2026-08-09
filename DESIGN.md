# Airtime — visual identity

**Product:** Airtime · *What the world is playing, right now.* · @professorSK

## The idea

The subject is live culture: charts move, positions rise and fall, things are hot
*right now*. So the design is built on a **broadcast scoreboard**, not a
magazine. Departure boards, chart rundowns, the lower-third of a live show. The
page should feel like it is *reporting* rather than *displaying*.

## Tokens

Six named values. Two of them are semantic, not decorative — that is the point.

**Ember** — warm, cinematic, plum-brown ground.

| Token | Hex | Role |
|---|---|---|
| `--ink` | `#1A1216` | Page ground. Deep **plum-brown**, not near-black — it carries real chroma so the page reads as a colour, not a void. |
| `--surface` | `#2E1F26` | Raised panel. Visibly warmer than `--ink`, flat — no blur, no translucency. |
| `--flare` | `#FF6B35` | **Rising.** Climbing rank, hot right now, theatrical rail. |
| `--cool` | `#4CC9F0` | **Falling.** Dropping rank, cooling off, OTT rail. |
| `--gold` | `#FFD166` | Ratings, stars, the Top Rated destination. |
| `--paper` | `#F7F0EA` | Type and light surfaces. Warm white. |

Every foreground/background pair in use clears WCAG AA (4.5:1), measured — the
tightest is `--flare` on `--ink` at 6.49:1, and `--muted` (`#B9A49A`) holds
7.74:1 on the ground and 6.60:1 on a raised panel.

The warmth is the point: burnt orange against a plum ground reads as a cinema
foyer rather than a dashboard, which suits a product that is half about films.
The ice blue is the one cold note, and it is reserved entirely for streaming and
falling ranks — so the page's temperature *is* its meaning.

`--flare` and `--cool` are never used as decoration. If something is orange it
is going up or it is in a cinema; if something is blue it is going down or it is
on a streaming service. That is the whole system, and it means a user can read
the board's temperature before reading a single word.

**Two accents, deliberately.** The current AI-design default is a near-black
page with one acid accent. A hot/cold pair on a chromatic warm ground reads
differently, and it earns its keep semantically.

## Type

- **Display — Archivo**, variable, pushed to the wide end of its `wdth` axis at
  700–800, uppercase, tight leading. Reads as broadcast/scoreboard. Restricted
  to short labels, section heads and rank chrome — **never** body copy and never
  a title longer than about four words, because expanded uppercase punishes
  reading on mobile.
- **Body — Instrument Sans.** Humanist, a bit characterful, good small. Not
  Inter, which is the default everyone lands on.
- **Numerals are tabular everywhere.** Chart positions that jitter as they
  update are the fastest way to make live data look untrustworthy.

Two families, both variable. That is the whole font budget.

## Layout — "The Board"

Full-bleed horizontal rails that scroll, stacked as sections. Each row carries
its **rank number set huge and bled off the left edge of the card**, so the
numbers form their own column down the page and cards read as positions in a
standing rather than as tiles in a grid. A sticky mode switcher stays visible.

## Signature element — the Movement Bar

Every card in the product carries the same small component: a **hard-edged
stepped strip** showing rank change since the last snapshot, `--flare` when
climbing, `--cool` when falling, with the delta in tabular figures. Stepped, not
a smooth sparkline — the data is discrete positions, and drawing it as a smooth
curve would be a small lie about what we know.

It does one more job. **When the data behind a card is stale, the same strip
renders hatched instead of solid.** Freshness is therefore visible in the same
component that shows movement, on every card, without a separate badge. Honesty
about live data becomes a visual primitive rather than a disclaimer.

## Brand texture — the tick strip

A repeating hard-edged tick pattern used for section dividers and the share
card: reads as a broadcast leader and as film perforations at once, which is
exactly the two halves of this product. Pure CSS gradient, no image, no cost.

## Explicitly not doing

- No glassmorphism, no `backdrop-filter`, anywhere.
- No cream + serif + terracotta.
- No near-black page with a single acid accent.
- No hairline-ruled broadsheet grid.
- No decorative motion. Things move when the underlying data moved.
