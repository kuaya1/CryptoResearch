# CryptoResearch — The Living System Atlas

A standalone visual litepaper and interactive architecture map of this repository, for Eric. It reads nothing from the desk, calls no network, stores nothing, and shares no code with `dashboard/`.

- `system.js`: the system as read from the code: components, connections, guided paths, chapters. Each part carries its evidence, `[path, anchor]`, and the facts its words depend on (a default, a limit, a refusal) as `claims`, `[path, regex, what]`.
- `build.mjs`: reads every cited file as it is at the pinned commit (`git show`, never the working tree), resolves every anchor to a line, checks every claim against the code, and writes `evidence.generated.js`. The pin is the newest commit outside `atlas/`. It fails, writing nothing, on any missing file, anchor or claim, any connection to an unknown part, or any part of the five stages that belongs to none or to two. A matching claim proves the code says it, not that the system ran.
- `index.html`, `atlas.css`, `atlas.js`: the page. No dependencies.

```bash
node atlas/build.mjs
```

```bash
node atlas/serve.mjs
```

Then open http://127.0.0.1:4799/. Opening `index.html` directly from disk also works.

`CryptoResearch-System-Atlas.pdf` is the same atlas as a document: the thirteen chapters, the full map in three portrait pages (each with its own key), the six paths and a reference entry for every component with its source links. It is the page's `#/print` view, rendered by headless Chrome or Edge:

```bash
node atlas/pdf.mjs
```

When the code changes, update `system.js` from the code (never from a plan or a chat), then run the build again. Each part's status is four separate facts: Implemented (code at the baseline), Enabled (only the default in code; each desk's setting is UNKNOWN), Deployed and Operating proven (only where a repository receipt says so, else UNKNOWN). Automated is how a part runs, not proof that it ran. The atlas grants no authority.

**What this is not.** A static architectural and status map, not a live telemetry backend. It shows what the repository said when it was built. It says nothing about what any desk, timer or runner is doing now.

**Design tokens.** `design-tokens/` holds the canonical layer extracted from CryptoResearch Architecture v17, and `atlas.css` takes every colour from it. `Token Map.md` is a byte-exact copy (SHA-256 `81813d56b3cb4ea60c87e77dfaef68c92bed5775090dc3abefb4bfcc7ca2bf06`). `tokens.css` differs from the extract (SHA-256 `475bca926d3942956cbb5776dbb99d504aecd76f50edd605f7ed231b10836e0d`) by one line: its Google Fonts `@import` is removed, because the Atlas calls no network. Geist is used only where it is already installed; otherwise the page falls back to the system face. These tokens are the Atlas's own: the desk's are `dashboard/public/tokens.css`, and the seven canonical values match it.

**Keeping it true.** `dashboard/tests/atlas-status.test.js` fails when the assets, the tokens or the status words in chapter 13 leave repository truth, including when the PDF is older than the page (`pdf-source.json`). A pull request that changes one of the seven Stage 1.5 facts updates `stage15` in `system.js` itself, then runs `node atlas/build.mjs && node atlas/pdf.mjs`. The build pins to the newest commit outside `atlas/`, so commit changes outside `atlas/` first, then build, then commit `atlas/`.
