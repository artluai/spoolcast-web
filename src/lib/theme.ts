export const DEFAULT_THEME_ID = 'spoolcast-dark' as const
export const THEME_STORAGE_KEY = 'spoolcast:theme'

export type ThemeDefinition = {
  id: string
  name: string
  description: string
  status: 'current' | 'candidate'
}

// Register launch-theme candidates here only after their complete token block
// exists in styles/themes.css. The gallery reads this list directly.
export const THEMES: ThemeDefinition[] = [
  {
    id: DEFAULT_THEME_ID,
    name: 'Spoolcast Dark',
    description: 'The current editor skin: near-black surfaces, blue actions, purple Autopilot, mono system labels.',
    status: 'current',
  },
]

export function isThemeId(value: string | null): value is string {
  return !!value && THEMES.some((theme) => theme.id === value)
}

export function applyTheme(themeId: string): string {
  const next = isThemeId(themeId) ? themeId : DEFAULT_THEME_ID
  document.documentElement.dataset.theme = next
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, next)
  } catch {
    // Private browsing or embedded surfaces may not expose storage.
  }
  return next
}

export function initializeTheme(): string {
  let stored: string | null = null
  try {
    stored = window.localStorage.getItem(THEME_STORAGE_KEY)
  } catch {
    // Use the default theme when storage is unavailable.
  }
  return applyTheme(stored || DEFAULT_THEME_ID)
}
