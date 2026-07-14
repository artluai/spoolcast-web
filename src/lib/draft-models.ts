// THE model catalog for every "AI suggest/draft" button (the picker component
// lives in views/workflow/ModelPicker.tsx). One list — a button that spends
// text-model credits sends the chosen id (plus draftReasoning(id)) to the
// engine. Ids are OpenRouter ids; pricing tiers hang off this list when the
// credit system lands. `reasoning` overrides the engine default where it
// saves money (Opus bills its thinking tokens at full output rate — medium is
// the sweet spot).
export type DraftModel = { id: string; label: string; cost: string; desc: string; reasoning?: string }

export const PRIMARY_MODELS: DraftModel[] = [
  { id: 'qwen/qwen3.7-plus', label: 'Qwen 3.7 fast', cost: 'Standard cost', desc: 'best value — the default' },
  { id: 'deepseek/deepseek-v4-flash', label: 'DeepSeek v4 flash', cost: 'Budget cost', desc: 'quick drafts' },
  { id: 'z-ai/glm-5.2', label: 'GLM 5.2', cost: 'Standard cost', desc: 'strong open-weights writer' },
  { id: 'anthropic/claude-opus-4.8', label: 'Claude Opus 4.8', cost: 'Premium cost', desc: 'best writing, highest spend', reasoning: 'medium' },
]
export const MORE_MODELS: DraftModel[] = [
  { id: 'deepseek/deepseek-v4-pro', label: 'DeepSeek v4 pro', cost: 'Budget cost', desc: 'stronger drafts without a big spend' },
  { id: 'openai/gpt-5-mini', label: 'GPT-5 mini', cost: 'Standard cost', desc: 'balanced all-rounder' },
  { id: 'qwen/qwen3.7-max', label: 'Qwen 3.7 max', cost: 'Premium cost', desc: 'stronger Qwen, more expensive' },
  { id: 'anthropic/claude-haiku-4.5', label: 'Claude Haiku 4.5', cost: 'Standard cost', desc: 'high quality, moderate spend' },
]
export const ALL_MODELS = [...PRIMARY_MODELS, ...MORE_MODELS]
export const DEFAULT_MODEL_ID = PRIMARY_MODELS[0].id

/** The reasoning override to send with a draft call, if the model has one. */
export const draftReasoning = (modelId: string): string | undefined =>
  ALL_MODELS.find((m) => m.id === modelId)?.reasoning
