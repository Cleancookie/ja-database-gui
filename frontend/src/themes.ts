/**
 * The themes on offer.
 *
 * This is a list of names, not of colours — every colour lives in `index.css`
 * as a `:root[data-theme='…']` block, and the id here is that attribute value.
 * The two are kept in step by hand; `config.ThemeIDs` on the Go side is the
 * third copy, and exists so a hand-edited settings file cannot leave the app
 * with no palette at all.
 *
 * `swatch` is the pair the settings dialog shows next to each name: the page
 * background and the accent, which is enough to tell dark from light and warm
 * from cool without rendering the whole interface twice.
 */
export interface Theme {
  id: string
  name: string
  /** One line on the mood, shown under the name. */
  note: string
  swatch: { bg: string; accent: string }
}

export const THEMES: Theme[] = [
  {
    id: 'sherbet',
    name: 'Sherbet',
    note: 'Warm paper and pastels',
    swatch: { bg: '#fbfaff', accent: '#7a68e8' },
  },
  {
    id: 'gruvbox-dark',
    name: 'Gruvbox Dark',
    note: 'Retro groove, warm and dim',
    swatch: { bg: '#282828', accent: '#fabd2f' },
  },
  {
    id: 'gruvbox-light',
    name: 'Gruvbox Light',
    note: 'The same hues on cream',
    swatch: { bg: '#fbf1c7', accent: '#96600e' },
  },
  {
    id: 'one-dark',
    name: 'One Dark',
    note: 'Cool blue-grey, editor classic',
    swatch: { bg: '#282c34', accent: '#61afef' },
  },
  {
    id: 'catppuccin-latte',
    name: 'Catppuccin Latte',
    note: 'Soft lavender paper, the light flavour',
    swatch: { bg: '#eff1f5', accent: '#8839ef' },
  },
  {
    id: 'catppuccin-frappe',
    name: 'Catppuccin Frappé',
    note: 'Muted blue-grey, the gentle dark',
    swatch: { bg: '#303446', accent: '#ca9ee6' },
  },
  {
    id: 'catppuccin-macchiato',
    name: 'Catppuccin Macchiato',
    note: 'Deeper slate, a dim middle ground',
    swatch: { bg: '#24273a', accent: '#c6a0f6' },
  },
  {
    id: 'catppuccin-mocha',
    name: 'Catppuccin Mocha',
    note: 'The darkest flavour, mauve on charcoal',
    swatch: { bg: '#1e1e2e', accent: '#cba6f7' },
  },
]

export const DEFAULT_THEME = 'one-dark'

/** The theme written as the bare `:root` block, and so the one with no attribute. */
const BARE_THEME = 'sherbet'

export function themeName(id: string): string {
  return THEMES.find((t) => t.id === id)?.name ?? id
}

/**
 * Applies a theme by writing the attribute the CSS keys off. An unknown id
 * falls back to the default. index.html carries the default's attribute too,
 * so the first paint — before any settings have loaded — is already themed.
 */
export function applyTheme(id: string) {
  const root = document.documentElement
  const known = THEMES.some((t) => t.id === id) ? id : DEFAULT_THEME
  if (known === BARE_THEME) root.removeAttribute('data-theme')
  else root.setAttribute('data-theme', known)
}
