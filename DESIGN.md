# Airtime — visual identity

**Product:** Airtime · *What the world is playing, right now.* · @professorSK

## The idea

The subject is live culture: charts move, positions rise and fall, things are hot
*right now*. So the design is built on a **broadcast scoreboard**, not a
magazine. Departure boards, chart rundowns, the lower-third of a live show. The
page should feel like it is *reporting* rather than *displaying*.

## Tokens

Six named values. Two of them are semantic, not decorative — that is the point.

**Daylight** — a light theme. Pale lavender ground, white cards, deep pink against teal.

| Token | Hex | Role |
|---|---|---|
| `--ink` | `#F4F1FE` | Page ground. Pale lavender — chromatic, so the page reads as a colour rather than as plain white. |
| `--surface` | `#FFFFFF` | A raised card. Flat white — no blur, no translucency. |
| `--flare` | `#CC0D53` | **Rising.** Climbing rank, hot right now, theatrical rail. |
| `--cool` | `#077A77` | **Falling.** Dropping rank, cooling off, OTT rail. |
| `--gold` | `#945900` | Ratings, stars, the Top Rated destination. |
| `--paper` | `#1E1033` | Primary type. Deep violet. |

The token names describe ROLE, not literal lightness — `--ink` is the page,
`--paper` is the type — and those roles were unchanged by the flip to light.

The accents are deliberately deeper than a dark theme would use, and that was
measured rather than guessed: a bright #FF2E63 on this ground is only 4.12:1 and
fails AA for body text. Every value here clears 4.5:1 on the ground, on a white
card, AND with light type on top of it, so a filled chip works either way round.
The tightest pair in use is `--cool` on a white card at 4.65:1.

Light rather than dark, because the product is read in daylight on a phone and
most of its content is album art and posters — artwork reads better against a
pale ground than against a dark one, which tends to make every thumbnail glow.
Teal is the one cold note and is reserved entirely for streaming and falling
ranks — so the page's temperature *is* its meaning.

`--flare` and `--cool` are never used as decoration. If something is pink it
is going up or it is in a cinema; if something is teal it is going down or it is
on a streaming service. That is the whole system, and it means a user can read
the board's temperature before reading a single word.

**Two accents, deliberately.** The current AI-design default is a near-black
page with one acid accent. A hot/cold pair on a chromatic pale ground reads
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

**Shape changes with the screen, because a chart should.** A 290px track card on
a 375px phone fills the viewport, so you see one result and half of the next —
you scroll sideways a lot to read very little. Track and episode rails therefore
stack vertically below 640px (`.rail-list`) and become horizontal rails above it.
Poster rails stay horizontal at every size: a 2:3 poster is narrow enough that
two fit on a phone, which is the browsing behaviour you want there. Chip rows
scroll in a single line on phones instead of wrapping to three.

**Rails preview, pages complete.** A music rail shows the top five with a "see
all" link to `/chart/[slug]`, which lists the full twenty as a vertical list at
every size — that page exists because someone wants to read a chart top to
bottom, and a horizontal rail is the wrong shape for that on any screen. Both
are built by the same `chartBoard`, so the five and the twenty cannot disagree.

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
- No plain white: the ground is tinted, and cards sit on it as white.
- No hairline-ruled broadsheet grid.
- No decorative motion. Things move when the underlying data moved.
