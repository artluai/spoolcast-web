# AGENTS.md — spoolcast-web

Guidance for AI agents (Codex, Claude, etc.) working in this repo.

`spoolcast-web` is a **frontend-only React mockup** of the Spoolcast AI
video-generation pipeline (login → onboarding → projects picker → workflow →
Library). It is a design artifact, **not a working product** — there is no
backend; auth, generation, and data are all mocked locally.

## Hard constraints

- **Frontend only.** Never add a real backend.
- **Never modify the engine / protocol repo** at
  `/Users/ralphxu/Documents/Projects/spoolcast` — it is read-only and owned by
  Codex. The contracts under `src/contracts/` are local copies; changing the UI
  does not mean editing the engine.
- **Stack:** Vite + React 19 + TypeScript + React Router. The whole app lives in
  `src/App.tsx`; styles in `src/index.css` (design tokens are CSS custom
  properties on `:root`).
- After any change, run `npm run lint` **and** `npm run build` — both must pass
  clean before you're done.
- **Scope changes to exactly what was asked.** Don't change desktop styling when
  asked for a mobile fix (or vice versa).

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
