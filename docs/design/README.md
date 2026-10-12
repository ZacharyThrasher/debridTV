# DebridTV design system: "Listings"

**Direction.** A printed TV-listings page brought to a screen:

- neutral black, with white type;
- one signal colour for what is live;
- hairline rules instead of boxes;
- one typeface doing the work.

The details come from television itself, not from startup landing pages. The signal is
tally red, the camera light that means "on air". The demo picture is a program slate,
with colour bars at the top. Titles are set bold and condensed, the way listings were.
Posters and stills bring the colour.

Why: DebridTV is a calm way to explore your own library through a schedule. The guide and
On Demand are the product. They get the hierarchy a printed guide had (time, channel,
title, a line of detail), and nothing competes with the artwork.

**What we avoid.** `docs/design/ai-tells.md` lists the patterns that make an interface read
as AI-made, with sources. Check every screen against it before a design PR.

## Tokens

All tokens live in `app/public/tokens.css`, which loads before `styles.css`. Themes change
only the colour tokens, and `theme.js` writes the same names for custom themes.

| Group | Tokens | Use |
| --- | --- | --- |
| Surfaces | `--bg` `--surface-1` `--surface-2` `--surface-3` `--scrim` | The room, sheets, raised things, hover and selected, over the picture |
| Type colour | `--ink` `--ink-2` `--ink-3` | Primary, secondary, tertiary (all at least 4.5:1 on `--surface-1`) |
| Rules | `--rule` `--rule-strong` | Hairlines. Structure comes from rules, not boxes |
| Signal | `--accent` `--accent-ink` `--accent-soft` | Tally red for "now": the now line, live, progress, the current row. Nothing else |
| Second accent | `--accent-2` | Favourites and stars only |
| Links | `--link` | Text links (always underlined) |
| Focus | `--focus` `--focus-ink` `--ring` | Focus inverts: black on white |
| Status | `--ok` `--warn` `--bad` | Account and file states |
| Type | `--font-ui` (Archivo) `--display-wght` `--display-wdth` `--cell-wdth` | One family. Titles at 700 and 78% width, guide cells at 88%, reading text at 100%. `--font-display` and `--font-mono` alias to it |
| Type scale | `--fs-xs` `--fs-sm` `--fs-md` `--fs-lg` `--fs-xl` `--fs-2xl` `--fs-3xl` `--fs-4xl` | All multiples of `--u` |
| Space | `--sp-1` to `--sp-8` | .25, .5, .75, 1, 1.5, 2, 3 and 4 units |
| Shape | `--r-1` `--r-2` `--r-3` | 2, 3 and 4 px. `--r-pill` is for dots and switch tracks only |
| Depth | `--shadow-1` `--shadow-2` | Only for things floating over the picture |
| Motion | `--ease` `--ease-in-out` `--dur-1` `--dur-2` `--dur-3` | Focus and hover, small moves, sheets |

`--u` is the unit: `clamp(12px, 1.05vw, 22px)`, and larger under `html.tv`. Size things in
units so they read on a phone, a laptop and a TV at 10 feet.

Older names (`--amber`, `--panel-solid`, `--dim`, `--line` and so on) are aliases at the
bottom of `:root`, so existing rules keep working. New code should use the names above.

## Rules of thumb

1. **One signal.** `--accent` means "this is live, or now". Primary buttons are white
   (`--ink` fill, `--bg` text), not red.
2. **Focus inverts.** A focused cell, card or button turns white with black text, or gets
   a white ring where inverting would hide artwork. It has to be visible from the couch,
   and never shown by colour alone.
3. **One face, three widths.** Titles are Archivo bold condensed. Interface text is
   normal width. Times and counts use the same face with tabular figures, never a
   monospace.
4. **Labels are sentence case,** and only where they earn their place. No tracked-caps
   eyebrows over headings. Small uppercase stays only on broadcast-style badges such as
   HD, CC and LIVE, and on rating cards.
5. **Rules, not boxes.** Prefer a hairline between rows to a bordered card per row.
6. **Flat colour.** No gradients on text, buttons or backgrounds. The only gradients
   allowed are scrims that keep text readable over a picture.
7. **Artwork first, drawn covers second.** A file with no art gets a drawn cover set like
   a tape label. Three layouts take turns down a shelf so a row doesn't read as one card
   repeated.
8. **Square corners.** 2 to 4 px. Nothing is a pill except a switch track.
9. **No decorative icons.** Buttons say what they do, and the key hint is the icon.

## Components (where they live in styles.css)

- Guide: `.guide`, `.guide-bar`, `.grid`, `.row-label`, `.cell` (focus is `.cell.focus`)
- Info banner: `.banner`
- On Demand: `.vod`, `.od-*`
- Settings sheet: `.panel`, `.tabs`, `.opt`, `.src`, `.btn`, `.input`, `.switch`
- Sheets and dialogs: `.ced` and `.ced-sheet` (channel editor, groups, theme editor, keep-off)
- Station cards: `.card`, `.brk-*` (off by default)

Buttons: `.btn` (quiet), `.btn.primary` (white) and `.btn.danger`. Chips: `.chip` and `.x-chip`.
