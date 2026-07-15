import type { DraftModel } from './draft-models'

// IMAGE-generation model catalog (kie.ai ids) — the picker for anything that
// spends image credits (World Kit reference generation). Deliberately a
// separate list from draft-models: different provider, different ids, and a
// text model can never generate a picture.
export const IMAGE_MODELS: DraftModel[] = [
  { id: 'gpt-image-2-text-to-image', label: 'GPT Image 2', cost: 'Standard cost', desc: 'best quality — the default' },
  { id: 'seedream/5-lite-text-to-image', label: 'Seedream 5 lite', cost: 'Budget cost', desc: 'fast, cheap drafts' },
]
export const DEFAULT_IMAGE_MODEL_ID = IMAGE_MODELS[0].id
