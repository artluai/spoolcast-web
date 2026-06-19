# AGENTS.md — spoolcast-web

Guidance for AI agents (Codex, Claude, etc.) working in this repo.

`spoolcast-web` is the React Web UI for the Spoolcast AI video-generation
pipeline (login → onboarding → projects picker → workflow → Library). It began
as a prototype, but the workflow now talks to the local Spoolcast engine API at
`http://localhost:8000/api` (`/Users/ralphxu/Documents/Projects/spoolcast/local_api.py`).

## Hard constraints

- **Engine API boundary.** The Web UI may call the local engine API, but should
  not duplicate engine/protocol logic in React. Engine behavior belongs in
  `/Users/ralphxu/Documents/Projects/spoolcast`.
- **Cross-repo changes are allowed only when requested.** If a UI change needs an
  engine change, make that explicit and keep the edits scoped.
- **Stack:** Vite + React 19 + TypeScript + React Router. The whole app lives in
  `src/App.tsx`; styles in `src/index.css` (design tokens are CSS custom
  properties on `:root`).
- After code changes, run `npm run build`. Run `npm run lint` when the change
  touches lint-sensitive code, but note the repo may contain pre-existing lint
  debt; report unrelated lint failures instead of rewriting unrelated files.
- **Scope changes to exactly what was asked.** Don't change desktop styling when
  asked for a mobile fix (or vice versa).

## Stage processes and jobs

Long-running, paid, or external work must be modeled as a stage process.

- Use `/api/jobs` for long work instead of holding one long `/api/action`
  request open.
- Store running process state outside component-local state so it survives step
  navigation and refresh-like remounts.
- Key process state by engine stage id, not by visible step number, so the same
  behavior works across format templates.
- Reuse the existing loading UI: `span className="spin"`, greyed-out content
  (`opacity: 0.4`), and disabled pointer interactions. Do not invent new loading
  symbols or animation styles.
- If a process is running for a step, the main step content should visibly show
  that state and should not allow conflicting edits.
- Normal typing, menu opens, tab switches, hover highlights, and local view
  changes are not stage processes.

Current worker-backed examples:

- `visual_pacing` drafts via `/api/jobs`.
- `shot_list_json` builds the storyboard via `/api/jobs`.

Future long-running steps should follow the same pattern: screenplay drafting or
review when long, narration audio, visual generation, final render, captions,
cover art, vertical cut, export, and publish/upload work.

## Domain model — do NOT conflate these

Two separate axes that both casually get called "template":

- **Visual style** = the *look*. Lives in the World Kit **Style Anchor**
  subsection and is **owned by Step 01 (Project setup)** — read-only elsewhere.
  In code: `castByShow[show].style` (e.g. `wojak-gpt2`).
- **Format template** = the *whole-series pipeline/format* (e.g.
  **Remotion illustration**, **Anime news bot**). This is the contract-level
  format — **not** the visual style.

### World Kit

Workflow **step 05**, between *Structure outline* and *Screenplay*. It is the
visual-reference planning stage. Subsections: **Style Anchor, Cast,
Environments, Props / Objects, Documents / Screens, Motion / Camera References,
Beat-Specific References**. Cast is just one subsection.

Each item has a **Share** scope — narrow → wide:

```
Episode  <  Show / subtemplate  <  Format template
```

No fixed ref recipe (do not imply "1 character + 1 environment") — each beat
uses whatever references it needs.

- Source-of-truth artifact: `working/world-kit.md`.
- `cast.txt` = the **Cast subsection** manifest (recurring characters only).
- Standalone route: `/p/:id/world-kit` (the old `/cast` route is gone).

## Assets

Real content is mirrored from the `spoolcast-content` repo into
`public/content/` and referenced via `asset()` → `/content/<path>` (so it ships
with the static build; the old `/@fs/…` dev path did not). Any video must stay
under Cloudflare's **25 MB/file** limit — transcode with ffmpeg if needed.

## Deploy

Cloudflare Pages, git-connected to `artluai/spoolcast-web`. Push to `main` →
auto build (`npm run build` → `dist`) → https://spoolcast-web.pages.dev. Node is
pinned via `.nvmrc`; `public/_redirects` handles SPA routing.
