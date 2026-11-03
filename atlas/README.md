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

`CryptoResearch-System-Atlas.pdf` is the same atlas as a document: the twelve chapters, the full map in three portrait pages (each with its own key), the six paths and a reference entry for every component with its source links. It is the page's `#/print` view, rendered by headless Chrome or Edge:

```bash
node atlas/pdf.mjs
```

When the code changes, update `system.js` from the code (never from a plan or a chat), then run the build again. Each part's status is four separate facts: Implemented (code at the baseline), Enabled (only the default in code; each desk's setting is UNKNOWN), Deployed and Operating proven (only where a repository receipt says so, else UNKNOWN). Automated is how a part runs, not proof that it ran. The atlas grants no authority.
