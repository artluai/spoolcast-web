# The settings model: three kinds, six levels, one rule

*Reference for organizing everything configurable in Spoolcast. The engine's
`../spoolcast/docs/source-of-truth.md` is the authority for where each piece is
stored and resolved; this doc is the conceptual map above it, plus the UI plan.*

## Three kinds of configurable thing

| Kind | Examples | Resolution behavior |
|---|---|---|
| **Assets** | characters, environments, props, audio, reference images, templates-as-bundles | Referenced, never copied down (`_reference_registry`, World Kit sharing grants) |
| **Rules** | structured step rules, rulebooks, template AI direction | Layered merge by stable rule id — narrower overrides/disables/re-enables (`step_rules.resolve_rules()`) |
| **Settings** | format, budget, models, autopilot defaults, series style/voice/brand | Narrower value wins outright |

## Six levels, broadest → narrowest

1. **Global** — admin-published, everyone sees it (character library, global templates, `settings/rules-global.json`)
2. **User** — the account's own library and defaults ← **the missing level; unlocked by accounts, not built yet**
3. **Template** — carried into any project made from it
4. **Series/Show** — shared by all episodes of one show
5. **Project/Video** — this one session
6. **Step** — one step of one video (per-step rules, per-shot overrides)

**The one rule: narrower wins, and every narrower level can see everything
broader.** Nothing at a narrow level ever edits a parent implicitly (the
engine's `set_rule` guardrail).

The engine currently implements Global → Template → Series → Video for rules.
Adding the User level means one more layer file resolved between Global and
Template — same merge, same resolver, no redesign.

## Who controls what

- **Admin** (site-side role): publishes and retires **Global** anything, via
  `/admin` and the publish endpoints/scripts. Global is read-only to everyone else.
- **User**: owns everything at User level and below, for their own work.
- Ownership/visibility live site-side; the engine only ever reads resolved
  files (see `architecture-engine-vs-site.md`).

## The UI: seeing and controlling the chain

Two surfaces, one model:

1. **In-flow (exists, keeps growing):** while making a video you see the
   resolved result where you use it — the rules panel with layer controls,
   World Kit sharing, show settings. Edits here mutate a *named* layer.
2. **The chain manager (to build):** a separate area under the user's account
   — one page, three columns (Assets | Rules | Settings), a scope picker
   (user / template / series / project). Every row shows its value **plus a
   provenance label** ("from Global", "template override", "series, line 3
   disabled") and an edit link that jumps to the level that owns it. The admin
   sees the same page with the Global tier editable. `/library` is the Assets
   column at project scope; it grows into this rather than being replaced.

The confusion this kills: today the data layers correctly but nothing *shows*
the chain, so only the person who built each piece knows what relates to what.

## Cross-references

- `../spoolcast/docs/source-of-truth.md` — canonical storage + resolver per concept
- `docs/architecture-engine-vs-site.md` — the engine/site boundary rule
- `docs/business-model.md` — display/money layers, marketplace framing
