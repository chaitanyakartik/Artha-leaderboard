# Design explorations — Artha Leaderboard redesign (2026-08-18)

Three visual directions explored for the leaderboard redesign, each a self-contained HTML mockup of
the **Classification** screen (board + expanded model→runs + a run's full analysis drawer) populated
with synthetic data. Open any file directly in a browser. Kept for future style reference.

| # | Direction | World | Palette | Type | Notes |
|---|---|---|---|---|---|
| A | [Statistical Almanac](A-statistical-almanac.html) | financial/sports results broadsheet | cool paper `#eef0f1`, ink, **oxblood** `#7a1f2b` accent | Spectral · Libre Franklin · Roboto Mono | quietest, most editorial; was the concept roll's assigned direction |
| **B** ✅ | [**Precision Instrument**](B-precision-instrument.html) | calibration lab / oscilloscope panel | graphite `#14171c`, **teal signal** `#3fb6b0` | JetBrains Mono · Libre Franklin | **chosen — being built into the app**; dark-first, calm, instrument-grade |
| C | [Departures Board](C-departures-board.html) | airport gate board + boarding-pass stubs | indigo `#0f1524`, **amber alert** `#f4a63a`, sky leader | Saira Condensed · JetBrains Mono | most kinetic; reranks configs, leader lit |

**Chosen: B · Precision Instrument.** The operator reads model runs the way a metrologist reads
instruments calibrated against a reference standard — ground truth *is* the reference, support
counts *are* sample sizes. Dark, calm, exact; density reads as an instrument panel, not a spreadsheet.
Deliberately not the neon-green/black coder look.

The live implementation replaces `public/style.css` + markup in `public/index.html` / `public/app.js`
(and `public/login.html`). These mockups are frozen snapshots and are not wired to the API.
