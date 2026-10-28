import { useMemo, useState } from 'react'
import type { Command } from '../commands'
import { bindingsOf, display, isFixed, parseStep, stepsOf } from '../hotkeys'
import type { Settings } from '../types'

interface Key {
  id: string
  label: string
  /** Flex weight, so every row spans the same width. */
  w?: number
  /** The key name the browser reports when Shift is held. */
  shifted?: string
}

const MODS = ['Ctrl', 'Alt', 'Shift'] as const
type Mod = (typeof MODS)[number]

const k = (id: string, shifted?: string): Key => ({ id, label: id, shifted })

const ROWS: Key[][] = [
  [
    k('`'),
    ...'1234567890'.split('').map((d) => k(d)),
    k('-', '_'),
    k('=', 'Plus'),
    { id: 'Backspace', label: 'Backspace', w: 2 },
  ],
  [
    { id: 'Tab', label: 'Tab', w: 1.5 },
    ...'QWERTYUIOP'.split('').map((c) => k(c)),
    k('['),
    k(']'),
    { ...k('\\'), w: 1.5 },
  ],
  [
    { id: 'Caps', label: 'Caps', w: 1.75 },
    ...'ASDFGHJKL'.split('').map((c) => k(c)),
    k(';'),
    k("'"),
    { id: 'Enter', label: 'Enter', w: 2.25 },
  ],
  [
    { id: 'Shift', label: 'Shift', w: 2.25 },
    ...'ZXCVBNM'.split('').map((c) => k(c)),
    k(','),
    k('.'),
    k('/'),
    { id: 'Shift', label: 'Shift', w: 2.75 },
  ],
  [
    { id: 'Ctrl', label: 'Ctrl', w: 1.5 },
    { id: 'Alt', label: 'Alt', w: 1.5 },
    { id: 'Space', label: 'Space', w: 9 },
    { id: 'Alt', label: 'Alt', w: 1.5 },
    { id: 'Ctrl', label: 'Ctrl', w: 1.5 },
  ],
]

const NAV: Key[][] = [
  [
    { id: 'PageUp', label: 'PgUp' },
    { id: 'PageDown', label: 'PgDn' },
  ],
  [
    { id: 'ArrowLeft', label: '←' },
    { id: 'ArrowDown', label: '↓' },
    { id: 'ArrowRight', label: '→' },
  ],
]

const isMod = (id: string): id is Mod => (MODS as readonly string[]).includes(id)
const sameMods = (a: Set<string>, b: Set<Mod>) =>
  a.size === b.size && [...a].every((m) => b.has(m as Mod))

interface Entry {
  cmd: Command
  binding: string
  steps: string[]
}

/**
 * The bindings laid out on a QWERTY board. Modifiers are keys you press on it:
 * Ctrl lit shows what Ctrl+<key> runs. Dots in a corner count the bindings the
 * key has under other modifiers, so nothing is hidden by the layer you are on.
 * A chord's first key is marked ›; pick it under "After" to see its second keys.
 */
export function KeyboardView({
  cmds,
  overrides,
}: {
  cmds: Command[]
  overrides: Settings['hotkeys']
}) {
  const [mods, setMods] = useState<Set<Mod>>(new Set(['Ctrl']))
  const [prefix, setPrefix] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)

  const entries = useMemo<Entry[]>(
    () =>
      cmds.flatMap((cmd) =>
        bindingsOf(cmd, overrides).map((binding) => ({ cmd, binding, steps: stepsOf(binding) })),
      ),
    [cmds, overrides],
  )
  const prefixes = useMemo(
    () => [...new Set(entries.filter((e) => e.steps.length > 1).map((e) => e.steps[0]))],
    [entries],
  )

  // The step a layer is about: the only step, or the second one after a prefix.
  const stepOf = (e: Entry) =>
    prefix === null
      ? e.steps.length === 1
        ? e.steps[0]
        : null
      : e.steps[0] === prefix && e.steps.length === 2
        ? e.steps[1]
        : null

  const matches = (key: Key, name: string, shift: boolean) =>
    key.id === name || (shift && key.shifted === name)

  const inLayer = (key: Key) =>
    entries.filter((e) => {
      const step = stepOf(e)
      if (!step) return false
      const { mods: m, key: name } = parseStep(step)
      return sameMods(m, mods) && matches(key, name, mods.has('Shift'))
    })
  const elsewhere = (key: Key) =>
    entries.filter((e) => {
      const step = stepOf(e)
      if (!step) return false
      const { mods: m, key: name } = parseStep(step)
      return !sameMods(m, mods) && matches(key, name, m.has('Shift'))
    })
  const startsChord = (key: Key) =>
    prefix === null &&
    entries.some((e) => {
      if (e.steps.length < 2) return false
      const { mods: m, key: name } = parseStep(e.steps[0])
      return sameMods(m, mods) && matches(key, name, mods.has('Shift'))
    })

  const toggle = (m: Mod) =>
    setMods((cur) => {
      const next = new Set(cur)
      if (!next.delete(m)) next.add(m)
      return next
    })

  const renderKey = (key: Key, i: number) => {
    const mod = isMod(key.id)
    const here = mod ? [] : inLayer(key)
    const other = mod ? [] : elsewhere(key)
    const chord = !mod && startsChord(key)
    const clash = here.length > 1
    const lit = mod && mods.has(key.id as Mod)
    const id = `${key.id}-${i}`
    return (
      <button
        key={id}
        type="button"
        aria-pressed={mod ? lit : selected === key.id}
        title={here.map((e) => `${e.cmd.title} (${display(e.binding)})`).join('\n') || undefined}
        onClick={() => (mod ? toggle(key.id as Mod) : setSelected(key.id))}
        style={{ flex: `${key.w ?? 1} 1 0` }}
        className={`relative flex min-h-14 min-w-0 flex-col items-start justify-start gap-0.5 overflow-hidden rounded-md border p-1 text-left ${
          lit
            ? 'border-[var(--color-accent)] bg-[var(--color-accent)] text-[var(--color-bg,#000)]'
            : clash
              ? 'border-[var(--color-danger,#e5484d)] bg-[var(--color-elevated)]'
              : here.length > 0
                ? 'border-[var(--color-accent)] bg-[var(--color-elevated)]'
                : 'border-[var(--color-border-strong)] bg-[var(--color-panel)]'
        } ${selected === key.id ? 'ring-2 ring-[var(--color-accent)]' : ''}`}
      >
        <span className={here.length > 0 || lit ? 'font-semibold' : 'text-[var(--color-muted)]'}>
          {key.label}
        </span>
        {here.length > 0 && (
          <span
            className={`w-full text-[0.65rem] leading-tight ${
              isFixed(here[0].cmd.id) ? 'italic' : ''
            } ${clash ? 'text-[var(--color-danger,#e5484d)]' : 'text-[var(--color-accent)]'}`}
          >
            <span className="line-clamp-2">{here[0].cmd.title}</span>
            {here.length > 1 && <span> +{here.length - 1}</span>}
          </span>
        )}
        {chord && <span className="text-[var(--color-accent)]">›</span>}
        {other.length > 0 && (
          <span
            className="absolute right-1 bottom-1 flex gap-0.5"
            aria-label={`${other.length} more`}
          >
            {other.slice(0, 3).map((_, d) => (
              <span key={d} className="size-1.5 rounded-full bg-[var(--color-faint)]" />
            ))}
          </span>
        )}
      </button>
    )
  }

  const detail = selected
    ? entries.filter((e) =>
        e.steps.some((s) => {
          const { mods: m, key: name } = parseStep(s)
          return (
            name === selected ||
            (m.has('Shift') && ROWS.flat().some((r) => r.id === selected && r.shifted === name))
          )
        }),
      )
    : []

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-4">
      <div className="mb-3 flex flex-wrap items-center gap-2 text-[var(--color-muted)]">
        <span>
          Holding:{' '}
          <span className="font-[var(--font-mono)] text-[var(--color-accent)]">
            {mods.size > 0 ? MODS.filter((m) => mods.has(m)).join('+') : 'nothing'}
          </span>
        </span>
        <span className="text-[var(--color-faint)]">
          click Ctrl, Alt or Shift on the board to hold them
        </span>
        {prefixes.length > 0 && (
          <span className="ml-auto flex items-center gap-1.5">
            After chord:
            {[null, ...prefixes].map((p) => (
              <button
                key={p ?? 'none'}
                aria-pressed={prefix === p}
                onClick={() => setPrefix(p)}
                className={`rounded-md border px-1.5 font-[var(--font-mono)] ${
                  prefix === p
                    ? 'border-[var(--color-accent)] text-[var(--color-accent)]'
                    : 'border-[var(--color-border-strong)]'
                }`}
              >
                {p ? `${display(p)} …` : 'none'}
              </button>
            ))}
          </span>
        )}
      </div>

      <div className="flex gap-4">
        <div className="flex min-w-0 flex-[15] flex-col gap-1">
          {ROWS.map((row, r) => (
            <div key={r} className="flex gap-1">
              {row.map(renderKey)}
            </div>
          ))}
        </div>
        <div className="flex flex-[3.5] flex-col justify-end gap-1">
          {NAV.map((row, r) => (
            <div key={r} className="flex gap-1">
              {row.map(renderKey)}
            </div>
          ))}
        </div>
      </div>

      <p className="mt-3 text-[var(--color-faint)]">
        Outlined keys run something while holding {mods.size > 0 ? [...mods].join('+') : 'nothing'}.
        Grey dots: the key is also bound under other modifiers. Red: more than one command. Italic:
        fixed.
      </p>

      {selected && (
        <div className="mt-3 rounded-lg border border-[var(--color-border)] p-3">
          <div className="mb-1 font-semibold">{selected}</div>
          {detail.length === 0 ? (
            <div className="text-[var(--color-faint)]">Nothing is bound to this key.</div>
          ) : (
            <ul className="flex flex-col gap-1">
              {detail.map((e) => (
                <li key={`${e.cmd.id}-${e.binding}`} className="flex gap-3">
                  <span className="w-48 shrink-0 font-[var(--font-mono)] text-[var(--color-accent)]">
                    {display(e.binding)}
                  </span>
                  <span>{e.cmd.title}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
