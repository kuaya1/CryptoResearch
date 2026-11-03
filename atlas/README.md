# CryptoResearch — The Living System Atlas

A standalone visual litepaper and interactive architecture map of this repository, for Eric. It reads nothing from the desk, calls no network, stores nothing, and shares no code with `dashboard/`.

- `system.js`: the system as read from the code: components, connections, guided paths, chapters. Each claim carries its evidence, `[path, anchor]`.
- `build.mjs`: resolves every anchor to a line and writes `evidence.generated.js`, pinned to the newest commit the atlas cites. It fails, writing nothing, on any file or anchor it cannot find, or any connection to an unknown part.
- `index.html`, `atlas.css`, `atlas.js`: the page. No dependencies.

```bash
node atlas/build.mjs
```

```bash
node atlas/serve.mjs
```

Then open http://127.0.0.1:4799/. Opening `index.html` directly from disk also works.

`CryptoResearch-System-Atlas.pdf` is the same atlas as a document: the twelve chapters, the whole map on one landscape page, the six paths and a reference entry for every component with its source links. It is the page's `#/print` view, rendered by headless Chrome or Edge:

```bash
node atlas/pdf.mjs
```

When the code changes, update `system.js` from the code (never from a plan or a chat), then run the build again. A status of Operational means built on `main`, not deployed or operating; the One Sheet keeps those apart.
