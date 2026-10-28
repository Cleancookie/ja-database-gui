import { useMemo, useState } from 'react'
import { buildActionCommands, type Command } from '../commands'
import { bindingsOf, chord, conflictsFor, display, isFixed } from '../hotkeys'
import { useStore } from '../store'

/** Ids that change with the data (history entries), so a key cannot be kept for them. */
const UNSTABLE = /^page:visit:/

interface Clash {
  id: string
  c: string
  others: Command[]
}

/**
 * Every palette command and the keys that run it, VS Code style. Commands
 * can have several keys or none. Edits save as they are made: a remap you must
 * remember to confirm is one you lose when the page closes.
 */
export function HotkeysPage() {
  const settings = useStore((s) => s.settings)
  const saveSettings = useStore((s) => s.saveSettings)
  const setView = useStore((s) => s.setView)
  const overrides = settings.hotkeys ?? {}

  // A snapshot: the list is the point of the page, and it should not shuffle
  // while a key is being recorded.
  const [cmds] = useState(() =>
    buildActionCommands(useStore.getState()).filter((c) => !UNSTABLE.test(c.id)),
  )
  const [query, setQuery] = useState('')
  const [onlyClashes, setOnlyClashes] = useState(false)
  const [recording, setRecording] = useState<string | null>(null)
  const [clash, setClash] = useState<Clash | null>(null)
  const [note, setNote] = useState('')

  const save = (next: Record<string, string[]>) => void saveSettings({ ...settings, hotkeys: next })
  const setKeys = (id: string, keys: string[]) => save({ ...overrides, [id]: keys })

  const clashing = useMemo(() => {
    const seen = new Map<string, number>()
    for (const cmd of cmds)
      for (const c of bindingsOf(cmd, overrides)) seen.set(c, (seen.get(c) ?? 0) + 1)
    return new Set([...seen].filter(([, n]) => n > 1).map(([c]) => c))
  }, [cmds, overrides])

  const rows = cmds.filter((cmd) => {
    const keys = bindingsOf(cmd, overrides)
    if (onlyClashes && !keys.some((k) => clashing.has(k))) return false
    const q = query.trim().toLowerCase()
    return (
      !q ||
      `${cmd.title} ${cmd.group}`.toLowerCase().includes(q) ||
      keys.some((k) => display(k).toLowerCase().includes(q))
    )
  })

  const record = (cmd: Command, e: React.KeyboardEvent) => {
    e.preventDefault()
    // The window handler would otherwise run whatever the pressed chord is bound to.
    e.stopPropagation()
    if (e.key === 'Escape') {
      setRecording(null)
      setNote('')
      return
    }
    const c = chord(e.nativeEvent)
    if (!c) return
    if (!e.ctrlKey && !e.metaKey && !e.altKey) {
      setNote('Include Ctrl or Alt so the key still works while typing.')
      return
    }
    const others = conflictsFor(cmds, overrides, cmd.id, c)
    if (others.length > 0) {
      setClash({ id: cmd.id, c, others })
      setNote('')
      return
    }
    setKeys(cmd.id, [...bindingsOf(cmd, overrides), c])
    stop()
  }

  const stop = () => {
    setRecording(null)
    setClash(null)
    setNote('')
  }

  const replace = ({ id, c, others }: Clash) => {
    const next = { ...overrides }
    for (const o of others) next[o.id] = bindingsOf(o, overrides).filter((k) => k !== c)
    next[id] = [
      ...bindingsOf(
        cmds.find((x) => x.id === id)!,
        overrides,
      ),
      c,
    ]
    save(next)
    stop()
  }

  return (
    <div className="flex h-full flex-col">
      <div className="chrome flex items-center gap-3 border-b border-[var(--color-border)] bg-[var(--color-panel)] px-3 py-2">
        <span className="font-semibold tracking-wider text-[var(--color-faint)] uppercase">
          Hotkeys
        </span>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter commands or keys"
          className="min-w-0 flex-1 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-panel)] px-2 py-1 outline-none"
        />
        <label className="flex items-center gap-1.5 text-[var(--color-muted)]">
          <input
            type="checkbox"
            checked={onlyClashes}
            onChange={(e) => setOnlyClashes(e.target.checked)}
          />
          Conflicts{clashing.size > 0 && ` (${clashing.size})`}
        </label>
        <button
          onClick={() => {
            save({})
            stop()
          }}
          className="text-[var(--color-muted)] hover:text-[var(--color-text)]"
        >
          Reset all
        </button>
        <button
          onClick={() => setView('data')}
          className="rounded-lg px-1.5 text-[var(--color-muted)] hover:bg-[var(--color-elevated)] hover:text-[var(--color-text)]"
          title="Close"
        >
          ✕
        </button>
      </div>

      <div
        className="min-h-6 border-b border-[var(--color-border)] px-3 py-1 text-[var(--color-faint)]"
        role="status"
      >
        {clash ? (
          <span className="text-[var(--color-text)]">
            {display(clash.c)} already runs {clash.others.map((o) => o.title).join(', ')}.{' '}
            {clash.others.some((o) => isFixed(o.id)) ? (
              'That key is fixed — pick another.'
            ) : (
              <button
                className="text-[var(--color-accent)] hover:underline"
                onClick={() => replace(clash)}
              >
                Replace it
              </button>
            )}{' '}
            <button className="text-[var(--color-muted)] hover:underline" onClick={stop}>
              Cancel
            </button>
          </span>
        ) : (
          note ||
          (recording
            ? 'Press the new key. Esc cancels.'
            : 'Click + on a command to add a key. A command can have several, or none.')
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <table className="w-full border-collapse text-left">
          <thead className="sticky top-0 bg-[var(--color-panel)] text-[var(--color-faint)]">
            <tr>
              <th className="border-b border-[var(--color-border)] px-3 py-1.5 font-normal">
                Command
              </th>
              <th className="border-b border-[var(--color-border)] px-3 py-1.5 font-normal">
                Hotkeys
              </th>
              <th className="border-b border-[var(--color-border)] px-3 py-1.5 font-normal" />
            </tr>
          </thead>
          <tbody>
            {rows.map((cmd) => {
              const keys = bindingsOf(cmd, overrides)
              const fixed = isFixed(cmd.id)
              return (
                <tr key={cmd.id} className="border-b border-[var(--color-border)]">
                  <td
                    className={`px-3 py-1.5 ${cmd.when === false ? 'text-[var(--color-faint)]' : ''}`}
                  >
                    <span className="mr-2 text-[var(--color-faint)]">{cmd.group}</span>
                    {cmd.title}
                    {cmd.when === false && (
                      <span className="ml-2 text-[var(--color-faint)]">(not available now)</span>
                    )}
                  </td>
                  <td className="px-3 py-1.5">
                    <div className="flex flex-wrap items-center gap-1.5">
                      {keys.map((k) => (
                        <span
                          key={k}
                          className={`flex items-center gap-1 rounded-md border px-1.5 font-[var(--font-mono)] ${
                            clashing.has(k)
                              ? 'border-[var(--color-danger,#e5484d)] text-[var(--color-danger,#e5484d)]'
                              : 'border-[var(--color-border-strong)] text-[var(--color-accent)]'
                          }`}
                          title={clashing.has(k) ? 'Also bound to another command' : undefined}
                        >
                          {clashing.has(k) && '⚠'}
                          {display(k)}
                          {!fixed && (
                            <button
                              aria-label={`Remove ${display(k)}`}
                              onClick={() =>
                                setKeys(
                                  cmd.id,
                                  keys.filter((x) => x !== k),
                                )
                              }
                              className="text-[var(--color-muted)] hover:text-[var(--color-text)]"
                            >
                              ×
                            </button>
                          )}
                        </span>
                      ))}
                      {fixed && <span className="text-[var(--color-faint)]">fixed</span>}
                      {!fixed &&
                        (recording === cmd.id ? (
                          <button
                            autoFocus
                            onKeyDown={(e) => record(cmd, e)}
                            onBlur={() => !clash && stop()}
                            className="rounded-md border border-[var(--color-accent)] px-1.5 text-[var(--color-accent)]"
                          >
                            Press keys…
                          </button>
                        ) : (
                          <button
                            aria-label={`Add a hotkey for ${cmd.title}`}
                            onClick={() => {
                              setRecording(cmd.id)
                              setClash(null)
                              setNote('')
                            }}
                            className="rounded-md px-1.5 text-[var(--color-muted)] hover:bg-[var(--color-elevated)]"
                          >
                            +
                          </button>
                        ))}
                    </div>
                  </td>
                  <td className="px-3 py-1.5 text-right">
                    {overrides[cmd.id] && (
                      <button
                        onClick={() => {
                          const { [cmd.id]: _, ...rest } = overrides
                          save(rest)
                        }}
                        className="text-[var(--color-muted)] hover:text-[var(--color-text)]"
                      >
                        Reset
                      </button>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
