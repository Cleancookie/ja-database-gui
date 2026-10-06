import { describe, expect, it } from 'vitest'

/**
 * docs/REQUIREMENTS.md: "applyChanges has exactly one caller, behind the review
 * dialog". Read as text because the point is that no code path — not just no
 * tested one — can write rows without the user having seen the SQL.
 */

const raw = import.meta.glob<string>('./**/*.{ts,tsx}', {
  query: '?raw',
  import: 'default',
  eager: true,
})

const files = Object.entries(raw)
  .filter(([path]) => !/\.test\.tsx?$/.test(path))
  .map(([path, text]) => ({
    name: path.replace('./', ''),
    // Comments may name the function; only code counts.
    code: text.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ''),
  }))

const mentioning = (needle: RegExp) => files.filter((f) => needle.test(f.code)).map((f) => f.name)

describe('writing rows', () => {
  it('calls api.applyChanges from exactly one place', () => {
    expect(mentioning(/\.applyChanges\(/)).toEqual(['storeEdits.ts'])
    const slice = files.find((f) => f.name === 'storeEdits.ts')!.code
    expect(slice.match(/\.applyChanges\(/g)).toHaveLength(1)
  })

  it('reaches applyStaged only from the review dialog', () => {
    expect(mentioning(/\bapplyStaged\b/).sort()).toEqual([
      'components/ReviewChangesDialog.tsx',
      'storeEdits.ts',
    ])
  })

  it('does not let preview, accept or Ctrl+S reach applyStaged', () => {
    const slice = files.find((f) => f.name === 'storeEdits.ts')!.code
    const review = slice.slice(
      slice.indexOf('async reviewChanges()'),
      slice.indexOf('cancelReview()'),
    )
    expect(review.length).toBeGreaterThan(100)
    expect(review).not.toMatch(/applyStaged|applyChanges/)
  })
})

describe('the sidebar', () => {
  it('never subscribes to the grid selection, the rows or the staged edits', () => {
    // A click in the grid or a keystroke in a cell must not re-render the
    // always-mounted sidebar. Dirty dots go through boolean selectors instead.
    const sidebar = files.filter(
      (f) => f.name.startsWith('components/sidebar/') || f.name === 'components/TabStrip.tsx',
    )
    expect(sidebar.length).toBeGreaterThan(3)
    for (const f of sidebar) {
      expect(f.code, f.name).not.toMatch(/=>\s*s\.(selection|result|staged|stagedSummary|dirtyTables|editing)\b/)
    }
  })
})
