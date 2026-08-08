# Spoolcast UI system

This is the source of truth for Spoolcast interface work. Before building or
changing visible UI, inspect the live gallery at `/design-system`, find the
closest existing component, and reuse its behavior and visual language.

## Source-of-truth order

1. The real component running at `/design-system`.
2. Its implementation in the web app.
3. Theme tokens in `src/styles/themes.css`.
4. This guide.
5. A screenshot or design mockup. Screenshots describe an approved result but
   may become stale; the running component is authoritative.

## Current theme

`spoolcast-dark` is the current product skin and the launch baseline. It owns
colors, typefaces, control geometry, effects, and semantic state colors.

A future skin must:

- define the complete token set in `src/styles/themes.css`;
- be registered in `src/lib/theme.ts`;
- pass every example and state on `/design-system`;
- change appearance only, never component behavior or wording;
- keep accessible focus, contrast, disabled, loading, success, and error states.

Do not add theme-specific conditions inside workflow components.

## Interface laws

- Reuse an existing control or extend its canonical component before creating a
  new pattern.
- `✦` marks every AI action. Do not substitute a pencil or a new magic icon.
- Normal AI actions use the blue `--ai` token. Purple `--autopilot` is reserved
  for Autopilot and must not be used for model pickers or ordinary AI actions.
- Use the split AI action when notes and model choice are optional. The main
  button must work without opening the options.
- When the simple default completes both planning and media, put a lower-cost
  text-only mode inside the split panel and label it `Text only`.
  The closed main button must keep running the complete default.
- Split actions use the same horizontal padding as regular buttons. Model
  pickers use the regular neutral button treatment; the action that runs the
  model uses the normal blue primary treatment.
- Dropdown triggers use the regular neutral button geometry. Menus portal above
  clipped panels, stay within the viewport, and flip upward near the bottom
  edge. Selection is visible in the trigger and selected menu row.
- Quiet optional sections use the established uppercase mono disclosure.
- Selection uses one accent ring. Unselected choices stay visually quiet.
- Controls sharing a row use `--control-height`, `--control-radius`,
  `--control-font-size`, and `--control-pad-x`.
- Long, paid, or external work uses the engine job system. Show `.spin`, honest
  status text, `opacity: .4`, and disabled pointer interactions on the affected
  module only. The state must survive navigation and refresh.
- Never show fake progress percentages. Use actual queue/provider progress or a
  truthful activity label.
- Preserve existing work on failure and explain the next available action.
- Use the existing glyph set: `✦`, `▾`, `⋯`, `✓`, `↻`, `↓`, `▶`, `⤢`.
  Do not introduce an icon font.

## Thumbnails and mixed aspect ratios

Spoolcast is visual-first. Make thumbnails as large as the available space
allows. The default presentation must preserve the source aspect ratio with no
stretching or cropping. Cropping is allowed only in a surface explicitly
designed and labelled for a deliberate crop.

Different ratios should carry approximately equal visual area rather than equal
width or equal height:

```text
A = (available container area - gaps) / visible item count
width_i  = sqrt(A * aspect_ratio_i)
height_i = sqrt(A / aspect_ratio_i)
```

Treat `A` as the target, not a rigid pixel promise. Pack the resulting
rectangles to minimize unused container space, preserve reading order, and
scale the full group uniformly when it does not fit. The layout objective is:

```text
minimize unused_space + variance(item_area / target_area)
```

Practical rules:

- Preserve every asset's intrinsic ratio.
- Prefer `object-fit: contain`; do not silently crop with `cover`.
- Keep visible thumbnail areas similar, even when their widths and heights
  differ.
- Use dense/justified packing to reduce empty space, but never reorder items in
  a way that changes their meaning.
- Increase the target area when space exists. Media should dominate supporting
  labels and controls.
- Keep captions and badges outside the important image area when possible; if
  overlaid, use a small legible scrim.

## Brand assets

- `/public/favicon.svg` is the navigation lightning mark and favicon.
- SVG is appropriate for logos, icons, illustrations, and other reusable
  artwork.
- Buttons, dropdowns, loading states, forms, and cards must remain real HTML and
  CSS. Do not use an SVG mockup as an implementation.

## Visual verification

For a visible UI change:

1. Compare it to the matching live gallery example.
2. Verify default, hover/focus, selected, disabled, loading, success, and error
   states that apply.
3. Check desktop and narrow/mobile widths.
4. Run `npm run build`.
5. Capture a live screenshot when the approved appearance changes. Screenshots
   should be generated from `/design-system` so they stay reproducible.

## Adding a component

Only add a new component when no current pattern can express the interaction.
Add its full state matrix to `/design-system` in the same change, document any
new tokens here, and use it in the product rather than leaving a gallery-only
mockup.
