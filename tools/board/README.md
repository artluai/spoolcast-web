# Spoolcast project board

A private, outcome-first view of completed, current, and upcoming work, ported from the AIDate
board. Larger product outcomes contain compact task rows, and each task drawer keeps a
plain-language summary next to the technical detail. It is a static Cloudflare Pages site with
Pages Functions and one Workers KV key named `board`. There is no build step and no dependency on
the rest of this repository's code.

## How the board behaves

- The fixed usernames are `ralph` and `agents`. Each password is a separate Cloudflare secret,
  and the API identifies the caller from the username.
- Every task write records `updatedBy` as Ralph or AI.
- Fable and Codex share the `agents` account. The **Working as Fable / Working as Codex** selector
  attributes comments, mentions, and claimed work to the right agent.
- Current work appears first. The roadmap is grouped into outcomes, in the order imported from
  `docs/TASKS.md` at the repository root — that file stays the engineering source of truth, and
  the board mirrors it for day-to-day updates.
- Ownership is shown only for active work to prevent duplicate effort.
- Task discussions are newest-first, support one-level replies, and recognize `@Ralph`, `@Fable`,
  and `@Codex`. Mentions appear in the recipient's inbox at the top of the board.
- The About copy and diagrams come from an authenticated API response; they are not in the public
  HTML. Mermaid is pinned and served from `public/vendor/`.

## Local development

Requirements: Node.js 22+.

```bash
cd tools/board
cp .dev.vars.example .dev.vars
```

Replace both example passwords in `.dev.vars`, then start Pages, Functions, and a local KV
simulation:

```bash
npx wrangler@4 pages dev public --kv=BOARD
```

Open `http://localhost:8788`. Local KV data is stored under `.wrangler/` and is ignored by Git.

Run the automated checks:

```bash
node --test tests/*.test.mjs
node seed.mjs --dry-run
```

## Cloudflare deployment

Run these commands from `tools/board/`.

1. Create the Pages project and the KV namespace:

   ```bash
   npx wrangler@4 pages project create spoolcast-board --production-branch main
   npx wrangler@4 kv namespace create SPOOLCAST_BOARD
   ```

2. Put the namespace id in `wrangler.jsonc` under the `BOARD` binding.

3. Set the two encrypted password secrets:

   ```bash
   npx wrangler@4 pages secret put BOARD_PASSWORD_RALPH --project-name spoolcast-board
   npx wrangler@4 pages secret put BOARD_PASSWORD_AGENTS --project-name spoolcast-board
   ```

4. Deploy (Wrangler uploads the sibling `functions/` folder automatically):

   ```bash
   npx wrangler@4 pages deploy public --project-name spoolcast-board --branch main
   ```

5. Seed the deployed board once from `docs/TASKS.md`:

   ```bash
   BOARD_URL=https://spoolcast-board.pages.dev \
   BOARD_USERNAME=agents \
   BOARD_PASSWORD=your-production-agent-password \
   node seed.mjs
   ```

   Warning: seeding replaces the whole `board` value. It is for first-time setup, not routine
   syncing.

After changing a Pages binding, variable, or secret, deploy again so the Functions receive it.

## Agent API

Read the board:

```bash
curl "$BOARD_URL/api/board" -u "$BOARD_USERNAME:$BOARD_PASSWORD"
```

Add a task:

```bash
curl -X POST "$BOARD_URL/api/tasks" \
  -u "$BOARD_USERNAME:$BOARD_PASSWORD" \
  -H "Content-Type: application/json" \
  -d '{"title":"Technical name","plainTitle":"Plain name","purpose":"Why it matters","goal":"cloud","owner":"Codex","tag":"codex","status":"todo"}'
```

Update a task (status, owner, note, and so on):

```bash
curl -X PATCH "$BOARD_URL/api/tasks/<task-id>" \
  -u "$BOARD_USERNAME:$BOARD_PASSWORD" \
  -H "Content-Type: application/json" \
  -d '{"status":"in_progress","owner":"Fable"}'
```

Comment as an agent (the shared account must name the author):

```bash
curl -X POST "$BOARD_URL/api/tasks/<task-id>/comments" \
  -u "$BOARD_USERNAME:$BOARD_PASSWORD" \
  -H "Content-Type: application/json" \
  -d '{"author":"Fable","body":"@Ralph this is ready for review."}'
```

Goals: `cloud`, `editor`, `ingest`, `autopilot`, `show`, `money`, `founder`. Tags: `fable`,
`codex`, `founder`. Owners: `Ralph`, `Fable`, `Codex`. Statuses: `todo`, `in_progress`, `done`.
