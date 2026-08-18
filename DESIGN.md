<!-- impeccable:design-system built 2026-08-18 · world: precision-instrument · seed 07154ecd -->

# Artha Leaderboard — Design System

## 1. Overview

The world is **Precision Instrument / Calibration Report** (seed `07154ecd`, direction roll index 5). The DIRECTION CONTRACT thesis, quoted verbatim: *"A model-eval leaderboard read like a calibration bench, not a GitHub-dark dashboard. Ground truth is the reference standard; a run is a measurement; support is sample size. Refuses the generic dark-panel-with-blue-accent default and the neon-terminal cliché alike."* The OWN-WORLD: *"Cool graphite ground (#14171c) under a faint engineering grid; instrument panels with hairline rules and corner tick marks; ONE calibrated teal signal (#3fb6b0) for the active/winning measurement; muted sea-green/amber/rust status colors. JetBrains Mono for every readout, Libre Franklin small-caps for panel labels. No neon, no rounded candy, no gradients-as-decoration."* Operating mode: **Operate** — a dense internal data tool for a single operator (or small team) doing fast, calm, unambiguous model-config comparison. Not a marketing surface; not a consumer product.

---

## 2. Color tokens

All custom properties are declared in `:root` in `public/style.css`.

### Grounds and panels

| Token | Value | Role |
|---|---|---|
| `--ground` | `#14171c` | Page background; the graphite floor everything sits on |
| `--panel` | `#1b1f26` | Instrument panel fill (header, nav, table body, stats strip, cards) |
| `--panel-lift` | `#21262f` | Hover state lift for table rows and buttons |

### Hairlines

| Token | Value | Role |
|---|---|---|
| `--hairline` | `#2b313b` | Default rule / border weight |
| `--hairline-2` | `#333b47` | Slightly brighter rule for secondary dividers, select borders, focused states |

### Text

| Token | Value | Role |
|---|---|---|
| `--fg` | `#e6e9ef` | Primary text |
| `--mut` | `#8b93a3` | Muted text (secondary labels, idle nav, button text) |
| `--dim` | `#5a6373` | Dim text (column headers, section labels, hints) |

### Teal signal and its dim/bg variants

| Token | Value | Role |
|---|---|---|
| `--signal` | `#3fb6b0` | The ONE calibrated accent: active tab underline, leader tick, corner ticks, focused border, winning readout values |
| `--signal-dim` | `rgba(63,182,176,.12)` | Diagonal glow in confusion matrix; message LED glow; `.tg.on` background |
| `--signal-bg` | `rgba(63,182,176,.07)` | Leader row background tint; active nav tab background |

### Status colors and dim variants

| Token | Value | Role |
|---|---|---|
| `--good` | `#3fa66a` | Good/pass status (full coverage badge, ok GT indicator, chip.good) |
| `--good-dim` | `rgba(63,166,106,.15)` | Good badge/chip background fill |
| `--amber` | `#d1a24a` | Warning/partial status (partial coverage badge, chip.ok) |
| `--amber-dim` | `rgba(209,162,74,.15)` | Amber badge/chip background fill |
| `--bad` | `#c26b5e` | Error/miss/rust status (off-diagonal confusion cells, error messages, chip.bad) |
| `--bad-dim` | `rgba(194,107,94,.15)` | Bad badge/chip/drawer background fill |

### Legacy aliases (back-compat only; do not use in new rules)

| Token | Resolves to |
|---|---|
| `--bg` | `var(--ground)` |
| `--line` | `var(--hairline)` |
| `--acc` | `var(--signal)` |

### Themeable surfaces (flip between dark/light)

| Token | Dark | Light | Role |
|---|---|---|---|
| `--drawer-bg` | `#111418` | `#f6f8fa` | Analysis drawer ground (a shade off the panels) |
| `--signal-hover` | `#45c4be` | `#0a5f5a` | Primary-button hover |
| `--shadow` | `rgba(0,0,0,.5)` | `rgba(20,30,40,.14)` | Settings-menu drop shadow |
| `--grid-line` | `rgba(43,49,59,.30)` | `rgba(90,110,130,.10)` | The fixed engineering/graph-paper grid |

### Theme: dark (default) + light

The world ships in **two renditions**, switched by `<html data-theme="dark|light">` and persisted in
`localStorage['artha_theme']` (default `dark`). A tiny inline `<head>` script in `index.html` and
`login.html` applies the saved theme before first paint (no flash); a Dark/Light `.seg-toggle` in the
settings menu (`#themeToggle`, wired in `app.js`) switches it live. **The whole surface is
token-driven**, so light mode is nothing but a `:root`-token override block plus a few header-strip
overlay lightenings — no per-component light styles.

- **Dark** = the calibration bench: cool graphite ground, bright teal signal, night-lab feel.
- **Light** = the *same instrument as cool engineering paper / graph-paper*, NOT a warm-cream flip:
  ground `#eef1f4`, white panels, a faint cool graph-paper grid, and a **deepened** teal
  `--signal #0a6b66` (≥4.5:1 on white) with darker status inks (`--good #1c7a45`, `--amber #8a5a0c`,
  `--bad #a83c28`). Cream/parchment grounds are banned in both themes.

When adding a color, add a token (with a light override if it's a surface/ink), never a raw hex in a
rule — that is what keeps the two themes in sync from one override block.

---

## 3. Typography

**Two faces only**, loaded via Google Fonts (`preconnect` + stylesheet link in `<head>`):

| Face | Weights loaded | Assignment |
|---|---|---|
| **JetBrains Mono** | 300, 400, 500, 600 | All data readouts: table cell values, metric numbers, code, selects, inputs, the doc-editor textarea, inline `<code>`, `.expand` run buttons |
| **Libre Franklin** | 300, 400, 500, 600, 700 | All chrome labels: body base, column headers, section summaries, nav tabs, control bar labels, badge text, stats strip labels, `.sub` subtitle |

Fallback stacks: `--mono` falls back to `ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`; `--sans` falls back to `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`.

**Label convention:** chrome labels are consistently uppercase with `letter-spacing` in the `.08em`–`.18em` range, small sizes (9px–11px), weight 500–600. Examples: column headers `600 10px, letter-spacing:.14em`; section summaries `600 9px, letter-spacing:.18em`; nav tabs `500 11px, letter-spacing:.1em`; control bar labels `600 9px, letter-spacing:.14em`.

**Numbers:** all numeric table cells carry `font-variant-numeric: tabular-nums` via `.num` and `text-align: right`. Stats strip headline values: `500 18px/1 var(--mono), tabular-nums`. Confusion matrix cells: `tabular-nums` on `.matrix table`.

---

## 4. Materials and motifs

### Engineering grid

`body::before` renders a fixed, `pointer-events:none` grid at `40px × 40px` using two `linear-gradient` hairlines at `rgba(43,49,59,.30)` — faint enough to recede behind every solid `--panel` surface. Justified: this IS a measurement surface; the grid is a calibration paper background, not decoration. It is never visible through the panels themselves.

### Instrument panels

Three elements share the instrument-panel treatment: the **board table** (`#board`), **collapsible analysis sections** (`.sec`), and the **login card** (`.login-card`). All use `background: var(--panel)` + `border: 1px solid var(--hairline)` + `border-radius: 3px–4px`.

**Corner tick pseudo-elements** are the defining motif:
- `#board::before/::after` and `.login-card::before/::after`: 8px–10px L-brackets, `border: 1px solid var(--signal)`, `opacity:.5–.6`, placed at diagonally opposite corners (top-left + bottom-right). Teal signal used here as a precision-instrument tick mark, not a fill color.
- `.sec::before`: a smaller 6px corner tick using `var(--hairline-2)` (not teal) — sub-panels are at a lower register.

### Teal signal — reserved use only

The signal appears as: active tab underline + bg tint, leader row background + vertical 2px left-side tick, corner ticks on major panels, focused `border-color` on inputs/selects, `.primary` button fill, diagonal cells in the confusion matrix, open-section chevron color, stats strip headline values, `.expand` hover color. It does **not** appear as a generic accent on arbitrary elements.

Header gradient accent: `header::after` renders a 2px bottom line as `linear-gradient(90deg, var(--signal) 0%, transparent 55%)` at `opacity:.4` — a calibration sweep, not a neon glow.

### Status LED dot pattern

Messages (`#msg .box`) use a 6px circular `::before` pseudo-element (not a left-border side-tab). Default = `--signal`; `.err` = `--bad`; `.ok` = `--good`. Same LED convention is used by `.badge::before` (5px dot in the coverage chips). This keeps status communication consistent as a point signal, never a colored sidebar stripe.

---

## 5. Components

**Masthead (`header`):** `--panel` bg, 1px `--hairline` bottom border, 52px min-height, flex with `flex-wrap`. Brand: `h1` in `600 15px var(--mono)` uppercase with `--signal`-colored accentword in `<span>`. Subtitle `.sub` in `300 11px var(--sans)` with a 1px `--hairline-2` left rule. Settings `⚙` button is a ghost 30px square, `border-radius:3px`. Dropdown `.menu` is a `--panel` card with `box-shadow:0 12px 40px rgba(0,0,0,.5)`.

**Tab bench (`nav`):** flat buttons, no background, active tab gets `color:var(--signal)`, `border-bottom:2px solid var(--signal)`, `background:var(--signal-bg)`. All tabs: `500 11px/1 var(--sans)`, uppercase, `letter-spacing:.1em`.

**Control bar (`.bar`):** flex row, `flex-wrap`, `gap:10px`, `padding:16px 24px`. Labels are `600 9px var(--sans)` uppercase, `letter-spacing:.14em`, stacked above their control via `flex-direction:column`.

**Buttons:** default is ghost — `transparent` bg, `--hairline-2` border, `--mut` color, `border-radius:3px`, `500 11px var(--sans)` uppercase. Hover lifts to `--panel-lift`. `.primary` fills with `--signal`, text in `--ground` (dark-on-teal), weight 600. Hover lightens to `#45c4be`.

**Select:** custom `appearance:none` chevron SVG (`stroke:#8b93a3`) inlined as data URI. `400 12px/1.4 var(--mono)`, `--hairline-2` border. Focus border switches to `--signal`.

**Board table (`#board`):** instrument panel with teal corner ticks (see §4). `thead` on `--ground`; `th` are `600 10px/1.2 var(--sans)`, uppercase, `--dim` color, `letter-spacing:.14em`, separated by 1px `--hairline` right borders. `td` are `12px var(--mono)`. Numeric cells (`.num`) right-aligned with `tabular-nums`. Leader row (`tr[data-grow]:first-of-type`): `--signal-bg` row fill + 2px `--signal` left-edge tick in `td:first-child::before` + `.expand` button colored `--signal`.

**Coverage badges (`.badge`):** inline-flex chip, `500 10px/1 var(--mono)`, `border-radius:2px`, LED dot `::before`. States: `.full` = `--good` color + `--good-dim` bg; `.partial` = `--amber` + `--amber-dim` bg; `.manual` = `--mut` (no color change).

**Analysis drawer (`.drawer`):** `background:#111418` (darker than `--ground`), `font-size:12.5px`. Top 2px gradient sweep in `--signal` at `opacity:.3`. `.stats` readout strip: flex row of labeled cells, each `--panel` bg, `600 9px var(--sans)` uppercase label, `500 18px var(--mono)` value in `--signal` (`.bad b` switches to `--bad`). `.sec` modules: instrument sub-panels with `--hairline-2` corner ticks (not teal). `.matrix` confusion grid: `tabular-nums`, diagonal `td.diag` = `--signal-dim` bg + `--signal` text, off-diagonal errors `td.off` = `--bad` text. Totals column (`th.tot/td.tot`) separated by `2px solid --hairline-2`.

**Coverage chips (`.chip`):** `500 10px/1.3 var(--mono)`, `border-radius:2px`. States: `.good` = good-dim bg + green; `.ok` = amber-dim + amber; `.bad` = bad-dim + rust; `.decl` = transparent bg + dashed border + `--dim`; `.none` = muted + `opacity:.6`.

**Run list (`.runlist`):** nested inside the drawer. `background:--ground`. Inner table has `min-width:0` (does not inherit board width). Run name buttons are `500 12px/1 var(--mono)`, hover to `--signal`.

**Home editor (`#home`):** full-width `<textarea>` in `--panel` bg, `13px/1.65 var(--mono)`, focus border `--signal`. Section heading `600 12px var(--sans)` uppercase.

**Taxonomy viewer (`#taxonomy`):** `.covbucket` expandable sections (`.covbar` 4px progress bar filled in `--signal`). Class chips rendered via the `.chip` system.

**Login card (`.login-card`):** centered in viewport via `.login-wrap` flex. `--panel` bg, `--hairline` border, `border-radius:4px`, teal corner ticks (10px, `opacity:.6`). Same `h1` + `.sub` treatment as masthead. Labels `600 9px var(--sans)` uppercase; inputs `400 14px var(--mono)` on `--ground` bg, focus → `--signal` border. Error text `--bad var(--sans) 12.5px`.

---

## 6. Rules and bans

- **Teal (`--signal`) is reserved for exactly one meaning: active / winning / selected / focused.** Do not use it as a generic accent, decorative tint, or hover fill on arbitrary elements.
- **No neon or candy colors.** Status is communicated via the three muted naturals: `--good` (sea-green), `--amber`, `--bad` (rust).
- **No pill shapes.** All `border-radius` values are 2px–4px (chip, badge, button, panel). Nothing exceeds 4px.
- **No gradients as decoration.** The two gradients in use (header bottom sweep, drawer top sweep) are calibration-sweep accents at low opacity — both reference `--signal`. No rainbow, no decorative gradient fills.
- **Status via LED dot, not side-tab border.** Message boxes and badges use a circular `::before` pseudo-element. Do not introduce left-border colored side-tabs for status.
- **Analysis/nested tables use `min-width:0`.** Only `#board` (the main measurement table) enforces `min-width:640px` and wide horizontal scroll. All inner tables (`.misses`, `.secbody`, `.runlist`, `.matrix`) set `min-width:0` so they don't blow out the drawer layout.
- **Numbers always use JetBrains Mono + tabular-nums + right-align** (`td.num`). Never render a metric in a proportional face.
- **Dark-first.** There is no light-mode path. All tokens are defined for dark ground.

---

## 7. Responsive

**Chrome (header, nav, control bar):** all use `flex-wrap`, so items reflow to a second line on narrow viewports. The masthead `min-height:52px` holds its ground; `.brand` wraps internally. Tab buttons wrap naturally.

**Board:** `<main>` has `overflow-x:auto`; `<table>` has `min-width:640px`. The board scrolls horizontally inside its container — the body never scrolls sideways. This is the only wide-scroll container at page level.

**Drawers and inner tables:** `white-space:normal` on `.secbody th/td` (so cell text wraps); `white-space:nowrap` restored on `.secbody td.num` only. `.matrix` has its own `overflow-x:auto` wrapper for very wide confusion grids.

**Login:** `.login-wrap` is a full-viewport flex center; `.login-card` has `max-width:344px` and `width:100%` so it shrinks on small screens.
