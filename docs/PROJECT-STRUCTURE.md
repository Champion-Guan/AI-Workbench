# Project structure and runtime boundaries

## Directory map

```text
guan-ai-workbench/
├── public/             # Live website files served by the local HTTP server
│   ├── assets/          # Workbench UI assets and local integrations
│   └── infinite-canvas/ # Embedded canvas page and its production bundles
├── src/
│   ├── canvas/           # Editable React/Vite source for the embedded canvas
│   ├── server/           # HTTP server, APIs, provider routing and proxy logic
│       ├── index.mjs     # Main HTTP server implementation
│       └── proxy-service.mjs # Built-in proxy lifecycle
│   └── shared/
│       └── data-contract/ # Shared browser/server data contract source
├── server.mjs           # Stable startup entry for npm and desktop launcher
├── config/              # Non-secret default configuration templates
├── scripts/             # Backup and maintenance commands
├── tests/               # Focused regression checks
└── docs/                # Architecture and operational notes
```

The key distinction is `src/canvas/` (editable source) versus `public/`
(the built files the running website serves). A source edit does not affect the
live page until the intended build is published into `public/infinite-canvas/`.

## Runtime flow

1. `npm run dev` starts `server.mjs` on `127.0.0.1:5174`.
2. The root page is `public/index.html`; its local application code and media live under `public/assets/`.
3. Embedded canvas routes (`/canvas/...`) are served from `public/infinite-canvas/`. Its HTML points to versioned files under `public/infinite-canvas/assets/`, and `server.mjs` injects the local bridge scripts when serving the canvas page.
4. `server.mjs` imports `src/server/index.mjs`; the public `/data-contract/` route maps to source files in `src/shared/data-contract/`.

`public/` is the active web root. Do not remove its pages, media, or hashed assets based only on filename age. The obsolete filename-specific canvas JavaScript patches have been removed; the CSS compatibility adjustment remains.

## Maintenance commands

```bash
npm test                      # Focused size and proxy regression tests
npm run build:canvas          # Build source into src/canvas/dist only
npm run verify:phase2         # Fixed local batch: types/tests/scans/build/package/isolated runtime
npm run publish:canvas        # Explicitly publish that build; preserve prior deployment
npm run audit:canvas-assets    # Read-only runtime asset reachability report
npm run clean:canvas-assets    # Move unreferenced bundles to the backup directory
```

Publishing and cleanup preserve previous files under the sibling
`guan-ai-workbench-backups/` directory. Source builds are not automatically published.
The asset audit follows bundle references, including dynamically loaded chunks;
it is deliberately conservative and retains files mentioned by runtime integration code.

### Current-source packages and private data

Vite writes `src/canvas/dist/CANVAS-BUILD.json`: root application version,
canvas source/builder fingerprint and exact SHA-256 file inventory. Changes
during the build fail the build. `node scripts/create-release.mjs --canvas-build`
refuses stale/unidentified builds and replaces the canvas subtree in the isolated
package only, not the live `public/`. Package verification checks both manifests.
The default packager still uses existing production assets for compatibility.
Both paths produce unsigned development packages, never auto-installable Stable Releases.

`npm run verify:phase2` records sanitized results in
`output/phase2/latest-verification.json`. It does not restart production, migrate
user data, publish or upload. Local success is not whole-phase acceptance.
The user-approved original phase-2 data-isolation acceptance, including historical
backup/restore and manual production handoff evidence, is recorded separately in
`docs/PHASE2-ACCEPTANCE.md`. The complete automatic-install inventory/coordinator
belongs to phase 5; automatic installation remains disabled before its acceptance.

Private file data uses `~/Library/Application Support/GuanAIWorkbench/`;
existing private files take precedence and missing legacy files are copied once,
retaining originals. After initialization, only the private `runtime.env` is loaded;
the old checkout's `.env.local` is never overlaid onto that existing file.
Explicit launcher environment overrides still take precedence.
Browser business data remains in IndexedDB/localForage/
localStorage under the original `http://127.0.0.1:5174` Origin. Filesystem
isolation does not migrate browser credentials to Keychain or prove all windows idle.

Failed/pending restore blocks overwriting the original record until a confirmed
read succeeds. Automatic orphan image/media cleanup currently retains candidates
because history, recycled products and concurrent writers lack a complete reference
inventory. Explicit user-selected deletion retains its scope. Cache usage may increase.

The embedded source still has upstream standalone routes in `src/canvas/router.tsx`.
They remain referenced by its navigation and are not yet removed. The local workbench
entry is `/`; the embedded product route is `/canvas/:id`, with `/canvas` used internally
for project management. Removing standalone source routes requires updating that
navigation together, not deleting shared prompt or settings components.

## Source and generated files

| Path | Purpose | Cleanup policy |
| --- | --- | --- |
| `src/canvas/` | Editable React/Vite canvas source and dependency lockfile | Keep source and lockfile. `dist/` is generated by its Vite build and is ignored by Git. |
| `public/` | Active workbench web root and canvas build served by the workbench | Keep the active HTML, bridge, and all versioned runtime assets together. |
| Settings panel | Native settings UI in the canvas source, with workbench-specific Fallback and proxy extensions injected by `src/server/index.mjs` | There is no separate Playground settings application in this project. |
| `src/shared/data-contract/` | Shared browser/server contract source | Served through the stable `/data-contract/` URL; keep. |
| `src/server/` | HTTP entry implementation, provider routing, and local proxy | Application server code; paths resolve from the project root. |
| `config/` | Non-secret default configuration templates | Keep templates only; never place credentials here. |
| `tests/`, `docs/`, `scripts/` | Regression checks, documentation, and maintenance scripts | Source and maintenance material; keep. |
| `output/`, `.playwright-cli/`, `node_modules/` | Local generated output, browser artifacts, and installed dependencies | Ignored local data; do not commit. |

## Safe maintenance rules

- Edit canvas features in `src/canvas/`, then explicitly publish the intended build output into `public/infinite-canvas/`; the main server does not serve `src/canvas/dist`.
- Treat hashed files under `public/infinite-canvas/assets/` as a coupled deployment set. Update the HTML references and preserve any assets needed by the server's compatibility handling when publishing a new build.
- The native settings UI is maintained in the canvas source; workbench-specific Fallback and proxy behavior is injected from `src/server/index.mjs`.
- Before deleting a file, confirm it is not referenced by the server, runtime HTML, dynamically imported bundles, or backup/restore tooling.
