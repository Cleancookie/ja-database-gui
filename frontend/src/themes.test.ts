import { describe, expect, it } from 'vitest'
// `?raw` rather than node:fs, which would mean pulling @types/node into a
// frontend that has no other need for it.
import goSettings from '../../internal/config/settings.go?raw'
import { DEFAULT_THEME, THEMES } from './themes'

/**
 * A theme id is written down in three places that cannot import each other: the
 * CSS block that defines the palette, the list the UI offers, and the Go
 * whitelist that decides whether a saved choice is allowed back off disk. Drift
 * is silent in the worst direction — a theme in the picker but not in Go is a
 * setting the user can select and never keep — so it is pinned by a test.
 *
 * This half is the TypeScript list against Go. The CSS half is
 * `TestEveryThemeHasAPalette` in internal/config, because vitest stubs CSS
 * imports out — `?raw` on a stylesheet arrives here as an empty string.
 */
describe('theme ids', () => {
  const ids = THEMES.map((t) => t.id)

  it('match the Go whitelist, in the same order', () => {
    const list = goSettings.match(/var ThemeIDs = \[\]string\{([^}]*)\}/)
    expect(list, 'ThemeIDs not found in settings.go').not.toBeNull()
    const goIDs = [...list![1].matchAll(/"([^"]+)"/g)].map((m) => m[1])
    expect(goIDs).toEqual(ids)
  })

  it('share a default with Go', () => {
    expect(goSettings).toContain(`const DefaultTheme = "${DEFAULT_THEME}"`)
  })

  it('are unique', () => {
    expect(new Set(ids).size).toBe(ids.length)
  })
})
