# DebridTV design system: "Listings"

**Direction.** The printed TV-listings page, brought to a screen. Warm ink, paper-white
type, one signal colour for what is live, hairline rules instead of boxes, and the type
doing the work. No gradients, glows or glass in the interface; posters and stills bring
the colour. It should feel like a well-set timetable you want to browse, not a cable box
cosplay and not a generic dark dashboard.

Why: DebridTV is a calm way to explore your own library through a schedule. The guide and
On Demand are the product, so they get the hierarchy a printed guide had (time, channel,
title, a line of detail) and nothing competing with the artwork.

References studied (via seesaw.website): Linear and Dial (quiet near-black, one accent,
hairlines), Frank Chimero and Ghostty (mono for data), WØRKS and Cosmos (serif display set
large against restraint), Area (big type as the image).

## Tokens

All tokens live in `app/public/tokens.css`, loaded before `styles.css`. Themes change only
the colour tokens; `theme.js` writes the same names for custom themes.

| Group | Tokens | Use |
| --- | --- | --- |
| Surfaces | `--bg` `--surface-1` `--surface-2` `--surface-3` `--scrim` | Room, sheets, raised things, hover/selected, over the picture |
| Type colour | `--ink` `--ink-2` `--ink-3` | Primary, secondary, tertiary (all at least 4.5:1 on `--surface-1`) |
| Rules | `--rule` `--rule-strong` | Hairlines. Structure comes from rules, not boxes |
| Signal | `--accent` `--accent-ink` `--accent-soft` | "Now": the now line, live, progress, the current row. Nothing else |
| Second accent | `--accent-2` | Favourites and stars only |
| Links | `--link` | Text links (always underlined) |
| Focus | `--focus` `--focus-ink` `--ring` | Focus inverts: paper on ink |
| Status | `--ok` `--warn` `--bad` | Account and file states |
| Fonts | `--font-ui` (Inter) `--font-display` (Instrument Serif) `--font-mono` (IBM Plex Mono) | Interface / titles / times, numbers, counts |
| Type scale | `--fs-xs` `--fs-sm` `--fs-md` `--fs-lg` `--fs-xl` `--fs-2xl` `--fs-3xl` `--fs-4xl` | All multiples of `--u` |
| Space | `--sp-1` … `--sp-8` | .25, .5, .75, 1, 1.5, 2, 3, 4 units |
| Shape | `--r-1` `--r-2` `--r-3` `--r-pill` | Fields and chips, cards and buttons, sheets |
| Depth | `--shadow-1` `--shadow-2` | Only for things floating over the picture |
| Motion | `--ease` `--ease-in-out` `--dur-1` `--dur-2` `--dur-3` | Focus/hover, small moves, sheets |

`--u` is the unit (`clamp(12px, 1.05vw, 22px)`, larger under `html.tv`). Size things in
units so they read on a phone, a laptop and a TV at 10 feet.

Older names (`--amber`, `--panel-solid`, `--dim`, `--line`…) are aliases at the bottom of
`:root` so existing rules keep working. New code should use the names above.

## Rules of thumb

1. **One signal.** `--accent` means "this is live / now". Primary buttons are paper
   (`--ink` fill, `--bg` text), not orange.
2. **Focus inverts.** A focused cell, card or button turns paper with ink text, or gets a
   paper ring when inversion would hide artwork. Visible from the couch, never colour-only.
3. **Serif for titles, mono for numbers.** Program and show titles in the hero, banner and
   On Demand use `--font-display`. Times, channel numbers, counts and durations use
   `--font-mono` with tabular figures. Everything else is Inter.
4. **Caps labels are small and tracked** (`--fs-xs`, `--track-caps`, `--ink-3`), and there
   are few of them.
5. **Rules, not boxes.** Prefer a hairline between rows to a bordered card per row.
6. **Flat colour.** No gradients on text, buttons or badges. The only gradients allowed are
   scrims that keep text legible over a picture.
7. **Artwork first, drawn covers second.** A file with no art gets a flat, single-hue cover
   with its title set in the serif, like a book spine.

## Components (where they live in styles.css)

- Guide: `.guide`, `.guide-bar`, `.grid`, `.row-label`, `.cell` (focus = `.cell.focus`)
- Info banner: `.banner`
- On Demand: `.vod`, `.od-*`
- Settings sheet: `.panel`, `.tabs`, `.opt`, `.src`, `.btn`, `.input`, `.switch`
- Sheets and dialogs: `.ced`, `.ced-sheet` (channel editor, groups, theme editor, keep-off)
- Station cards: `.card`, `.brk-*` (off by default)

Buttons: `.btn` (quiet), `.btn.primary` (paper), `.btn.danger`. Chips: `.chip`, `.x-chip`.
