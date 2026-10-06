import { describe, expect, it } from 'vitest'

/**
 * Rules of hooks, as far as a source scan can check them: no component calls a
 * hook after a top-level early return. React error 300 ("rendered fewer hooks
 * than expected") was exactly this in DataGrid — a statement with no result set
 * returned early, the next render reused the instance, and a useMemo below the
 * return ran on one render and not the other.
 *
 * The frontend has no DOM tests and no lint step, so this reads the text. It
 * only looks at hooks called directly in a component body (two-space indent),
 * which is where a conditional return makes them unsafe.
 */

const sources = import.meta.glob<string>('./components/**/*.tsx', {
  query: '?raw',
  import: 'default',
  eager: true,
})

/** Bodies of top-level functions, as [name, lines]. */
function functionBodies(text: string): [string, string[]][] {
  const lines = text.split('\n')
  const out: [string, string[]][] = []
  for (let i = 0; i < lines.length; i++) {
    const m = /^(?:export )?(?:default )?(?:const \w+ = memo\()?function (\w+)\(/.exec(lines[i])
    if (!m) continue
    let j = i + 1
    while (j < lines.length && !/^}\)?$/.test(lines[j])) j++
    out.push([m[1], lines.slice(i + 1, j)])
    i = j
  }
  return out
}

/** Index of the first return that can skip the rest of the body, or -1. */
function firstEarlyReturn(body: string[]): number {
  for (let i = 0; i < body.length; i++) {
    if (/^ {2}return\b/.test(body[i])) return i
    if (/^ {2}if \(.*\) return\b/.test(body[i])) return i
    if (/^ {2}if \(.*\) \{$/.test(body[i])) {
      for (let j = i + 1; j < body.length && !/^ {2}\}/.test(body[j]); j++) {
        if (/^ {4}return\b/.test(body[j])) return i
      }
    }
  }
  return -1
}

describe('rules of hooks', () => {
  it('finds the component bodies it is meant to check', () => {
    const names = Object.values(sources).flatMap((t) => functionBodies(t).map(([n]) => n))
    expect(names).toContain('Grid')
    expect(names).toContain('App')
  })

  it('has no hook after an early return in any component', () => {
    const bad: string[] = []
    for (const [path, text] of Object.entries(sources)) {
      for (const [name, body] of functionBodies(text)) {
        const at = firstEarlyReturn(body)
        if (at < 0) continue
        body.slice(at + 1).forEach((line, k) => {
          if (/^ {2}(?! ).*\buse[A-Z]\w*(<[^>]*>)?\(/.test(line) && !/^ {2}\/\//.test(line)) {
            bad.push(
              `${path} ${name}: ${line.trim()} (after the return at body line ${at + 1 + k})`,
            )
          }
        })
      }
    }
    expect(bad).toEqual([])
  })
})
