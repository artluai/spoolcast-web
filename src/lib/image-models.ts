import type { DraftModel } from './draft-models'

// IMAGE-generation model catalog (kie.ai ids) — the picker for anything that
// spends image credits (World Kit reference generation). Deliberately a
// separate list from draft-models: different provider, different ids, and a
// text model can never generate a picture.
// maxChars = kie.ai's documented hard cap on the prompt parameter (2026-07).
export const IMAGE_MODELS: DraftModel[] = [
  { id: 'gpt-image-2-text-to-image', label: 'GPT Image 2', cost: 'Standard cost', desc: 'slow · top detail · strictest content filter — final refs', maxChars: 20000 },
  { id: 'nano-banana-pro', label: 'Nano Banana Pro', cost: 'Higher cost', desc: 'medium speed · top quality — composed scenes, many refs', maxChars: 10000 },
  { id: 'nano-banana-2', label: 'Nano Banana 2', cost: 'Standard cost', desc: 'fast · great quality — the all-rounder', maxChars: 20000 },
  { id: 'seedream/5-lite-text-to-image', label: 'Seedream 5 lite', cost: 'Budget cost', desc: 'fastest · decent quality — cheap drafts', maxChars: 3000 },
]
export const DEFAULT_IMAGE_MODEL_ID = IMAGE_MODELS[0].id
