# CryptoResearch — token map

Source: `CryptoResearch Architecture v17.dc.html`. Variables are in `tokens.css`.

## Titles & type

| Element | Font | Size / LH | Weight | Tracking | Color |
|---|---|---|---|---|---|
| Page headline | `--cr-font-sans` | `--cr-display-size` / `--cr-display-lh` | 300 (emphasis 600) | `--cr-display-ls` | `--cr-ink`, tail `--cr-ink-faint` |
| Page eyebrow (WEDNESDAY, OCT 28 · LIVE) | mono, uppercase | `--cr-eyebrow-page-size` | 400 | `--cr-eyebrow-page-ls` | `--cr-ink-muted` (projected: `--cr-agent-text`) |
| Section eyebrow (WHERE ERIC SEES THE ENGINE, CONSENT, ENGINE, BOUNDARY…) | mono, uppercase | `--cr-eyebrow-size` | 400 | `--cr-eyebrow-ls` | light `--cr-ink-muted` · dark `--cr-paper-muted` |
| Card title (Surfaces, Needs you, Signal path) | sans | `--cr-title-size` / `--cr-title-lh` | 300 | `--cr-title-ls` | `--cr-ink` / `--cr-paper` |
| Lens node name | sans | `--cr-title-lg-size` / 1 | 300 | `--cr-title-lg-ls` | `--cr-ink` |
| Decision title | sans | `--cr-title-sm-size` / `--cr-title-sm-lh` | 400 | `--cr-title-sm-ls` | `--cr-obsidian` |
| Page metric (92%) | sans, tabular | `--cr-metric-xl-size` / 1 | 300 | `--cr-metric-xl-ls` | `--cr-ink` / `--cr-ink-muted` |
| Card counter (4 IN QUEUE) | sans, tabular | `--cr-metric-size` / 1 | 100 | `--cr-metric-ls` | `--cr-paper` |
| Watermark | sans, tabular | `--cr-watermark-size` | 100 | `--cr-watermark-ls` | `--cr-watermark-color` |
| Body | sans | `--cr-body-lg-size` (Lens) or `--cr-body-size` | 400 | 0 | `--cr-ink-secondary` / `--cr-paper-body` |
| Tile name / note | sans | `--cr-item-size` 500 / `--cr-item-note-size` | — | 0 | `--cr-ink` / `--cr-ink-muted` |
| Card footer caption | sans | `--cr-caption-size` | 400 | 0 | `--cr-ink-faint` |

## Cards

| Card | Background | Border | Radius | Shadow | Padding |
|---|---|---|---|---|---|
| Light card (Envelope, Surfaces) | `--cr-surface` | `--cr-border-card` | `--cr-radius-card` | `--cr-shadow-card` | 28px 30px |
| Lens | `--cr-surface-warm` | `--cr-border-card` | `--cr-radius-card` | `--cr-shadow-card-lens` | 28px 30px |
| Dark card (Engine, Needs you) | `--cr-obsidian` | none | `--cr-radius-card` | `--cr-shadow-dark` | 28px 30px |
| Decision card (on dark) | `--cr-surface-ceramic` | none | `--cr-radius-inner` | `--cr-shadow-inner-card` | 22px |
| Tile (status block, 132px tall) | status color | none | `--cr-radius-tile` | none | 12px top |
| Only-Eric strip | `--cr-obsidian` | none | `--cr-radius-tile` | none | 16px 18px |
| Command bar | `--cr-surface-glass-hi` + `--cr-blur-glass` | `--cr-border-chip` | `--cr-radius-pill` | `--cr-shadow-float` | 8px 8px 8px 20px |
| Card gap / grid | — | — | — | — | 18px gap, `minmax(380px,1fr)` |

## Chips & controls

| Element | Background | Border | Text | Radius | Padding |
|---|---|---|---|---|---|
| Header chip (Eric · sovereign) | `--cr-surface-glass` | `--cr-border-chip` | sans 12.5px `--cr-ink` / `--cr-ink-secondary` | pill | 7px 14px |
| Scope chip (PAPER ONLY) | none | `--cr-border-outline` | mono `--cr-chip-mono-size`, `--cr-chip-mono-ls`, `--cr-ink-secondary` | pill | 3px 9px |
| Suggestion chip | `--cr-fill-subtle` → `--cr-fill-subtle-hover` | none | sans 12.5px `--cr-ink-secondary` | pill | 8px 12px |
| Segmented (dark) | track `--cr-dark-fill`; active `--cr-surface-ceramic` (projected `--cr-agent`) | none | sans 13px, idle `--cr-paper-body` | pill | 10px 16px |
| Later button | none | `--cr-border-outline` | 13px `--cr-ink-secondary` | pill | 13px 18px |
| Hold button | `--cr-obsidian`, fill `--cr-live` | none | 13px 500 `--cr-paper` | pill | 13px 18px |
| Outline pill on dark (Simulate) | none | `--cr-border-outline-dark` | 13px `--cr-paper-secondary` | pill | 13px 18px |

## Metadata badges & pips

| Status | Badge fg | Badge bg | Tile / pip | On dark |
|---|---|---|---|---|
| Live / Merged | `--cr-live-ink` | `--cr-live-bg` | `--cr-live` | `--cr-live-on-dark` |
| Read | — | — | `--cr-read` (`--cr-read-deep`) | `--cr-read-on-dark` |
| Tuning / Stabilizing / Open | `--cr-tuning-badge-fg` | `--cr-tuning-badge-bg` | `--cr-tuning-stripes`, text `--cr-tuning-ink` | `--cr-tuning-on-dark` |
| Critical | — | — | `--cr-critical` | `--cr-critical-on-dark` |
| Neutral / Not started | `--cr-neutral-badge-fg` | `--cr-neutral-badge-bg` | `--cr-neutral` | `--cr-paper` |
| Projected / Agent | `--cr-agent-text` | `--cr-agent-bg` | `--cr-agent` | `--cr-agent-on-dark` |

Badge spec: mono, uppercase, `--cr-badge-size`, `--cr-badge-ls`, pill, padding 4px 10px.
Row state: mono `--cr-state-size` / `--cr-state-ls` + `--cr-pip-sm` dot in the same color.
Tile tag (LIVE, READ, TUNING): mono `--cr-micro-size` / `--cr-micro-ls`, white (tuning: `--cr-tuning-ink`).
Pips: header 7px with `--cr-ring-pip`; labels 6px; rows 5px. Square pip (`border-radius:2px`) = human/sovereign.
