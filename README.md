# Spoolcast Web UI

A React + TypeScript + Vite frontend for the Spoolcast AI video-generation pipeline.

**Current Status:** This is a design artifact and workflow controller. It is transitioning from a mocked UI to the strict orchestration layer that enforces the Spoolcast protocol.

## The Architecture: Demoting the Agent

Historically, AI agents with unrestricted filesystem access would bypass protocol gates, skip audits, and write files directly when context degraded. 

To solve this, the Web UI is being built as the **only** interface for the workflow. The backend (driven by `spoolcast_backend.py` in the engine repo) owns the state machine and enforces the rules. The AI agent is demoted to a stateless text generator with zero direct file-write access.

### How Enforcement Works
1. The UI displays the steps defined dynamically in the active format contract (e.g., `illustration-chunk-remotion.json`).
2. The AI proposes a payload (e.g., a new shot-list) for the *current active stage only*.
3. The backend receives the payload, writes it to a temporary location, and runs the deterministic audit script (e.g., `validate_shot_list.py`).
4. **If it passes (exit 0):** The backend commits the file, records the approval, and advances the state machine.
5. **If it fails:** The backend catches the exact error, returns it to the UI, and forces the AI to fix *only* those specific errors before it can try again.

## Workflow Steps & Enforcement Gates

The UI and backend are **format-agnostic**. They dynamically read the active format's contract to determine the workflow. While specific steps and scripts vary by template, every format enforces this universal pipeline:

| Universal Stage | Enforcement Mechanism |
|---|---|
| **Setup & Story** | Requires explicit human approval to lock core message and structure. |
| **World Kit & Screenplay** | Context gates force-feed style, character, and voice rules before AI drafting. |
| **Production Units** (e.g., Storyboard) | **Strict Audit Gate:** Backend runs the format-specific validator (e.g., `validate_shot_list.py`). If it fails, the backend rejects the payload and blocks progression. |
| **Asset Generation** | Backend verifies all required audio/visual files exist and passes format-specific audits (e.g., `audit_scenes.py`). |
| **Render & Package** | **Strict Audit Gate:** Must generate `working/render-audit.passed` before mobile variants or captions are processed. |
| **Publish** | Requires explicit human approval. Backend blocks external publish actions unless `allow_external=true` is passed. |

*The AI agent has zero direct file-write access. It can only propose payloads for the current stage, which the backend mechanically validates against the active contract before saving.*

## Stack
- Vite + React 19 + TypeScript
- React Router for navigation
- Design tokens via CSS custom properties on `:root` in `src/index.css`

## Constraints for AI Agents
If you are an AI agent working in this repo, you **MUST** adhere to these rules:
1. **Frontend only.** Never add a real backend or database.
2. **Never modify the engine repo** (`/Users/ralphxu/Documents/Projects/spoolcast`). The contracts under `src/contracts/` are local copies for UI rendering; changing the UI does not mean editing the engine.
3. **Scope changes strictly.** Do not change desktop styling when asked for a mobile fix, or vice versa.
4. **Lint and build.** After any change, run `npm run lint` and `npm run build`. Both must pass clean.

## Development

```bash
# Install dependencies
npm install

# Start dev server
npm run dev

# Lint
npm run lint

# Build for production
npm run build
```

## Assets
Real content is mirrored from the `spoolcast-content` repo into `public/content/` and referenced via `asset()` (e.g., `/content/styles/...`). This ensures assets ship with the static build. Any video assets must stay under Cloudflare Pages' **25 MB/file** limit.

## Deployment
Deployed to Cloudflare Pages, git-connected to `artluai/spoolcast-web`. 
Push to `main` → auto build (`npm run build` → `dist`) → https://spoolcast-web.pages.dev.
Node is pinned via `.nvmrc`; `public/_redirects` handles SPA routing.
