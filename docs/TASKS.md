# Spoolcast tasks — moved to the board

The roadmap lives on the live project board: **https://spoolcast-board.pages.dev**

The board is the single source of truth. This file is only a pointer; do not add tasks here.

- Credentials are in the repo-root `.env` (`BOARD_URL`, `BOARD_USERNAME`, `BOARD_PASSWORD`) of
  both repos.
- Agents read and update tasks through the board API — see `tools/board/README.md` for the
  endpoints.
- **Never run `tools/board/seed.mjs` again.** Seeding replaces the entire board and would wipe
  all statuses, ownership, and discussion added since the one-time seed on 2026-08-01.

**The launch goal the roadmap is built around:** a writer feeds Spoolcast their own writing, and
it produces a whole series (~20 episodes) from it, designs the characters and world, runs the
pipeline hands-off if the creator wants, and publishes the result as a streaming-style show on the
creator's public profile, watchable for credits. The same pipeline stays a general video workflow:
ad makers and client work use it privately, without the storefront. Publishing at launch means
Spoolcast profiles plus downloadable exports; YouTube publishing is post-launch.
