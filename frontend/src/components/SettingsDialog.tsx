import { useRef, useState } from 'react'
import { PAGE_SIZES, useStore } from '../store'
import { applyTheme, THEMES } from '../themes'
import { dialogButton, FormDialog } from '../ui'
import type { Settings } from '../types'

/**
 * Settings, reachable with Ctrl+, or from the palette.
 *
 * Changes to appearance apply live as they are adjusted — a font size you
 * cannot see the effect of until you hit Save is guesswork. Everything is
 * persisted on Save; Cancel restores what was there on open.
 */
export function SettingsDialog() {
  const saved = useStore((s) => s.settings)
  const saveSettings = useStore((s) => s.saveSettings)
  const setDialog = useStore((s) => s.setDialog)

  const [draft, setDraft] = useState<Settings>(saved)
  const [active, setActive] = useState<string>(SECTIONS[0])
  const body = useRef<HTMLDivElement>(null)

  const sections = () => [
    ...(body.current?.querySelectorAll<HTMLElement>('section[data-group]') ?? []),
  ]

  // Highlight the last section whose top has scrolled past the pane's top;
  // at the very bottom, the last one, since a short final section never reaches the top.
  const onScroll = () => {
    const el = body.current
    if (!el) return
    const all = sections()
    const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 2
    const current = atBottom
      ? all.at(-1)
      : all.filter((s) => s.offsetTop <= el.scrollTop + 8).at(-1)
    if (current?.dataset.group) setActive(current.dataset.group)
  }

  const jumpTo = (label: string) => {
    sections()
      .find((s) => s.dataset.group === label)
      ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  const patch = (p: Partial<Settings>) => {
    const next = { ...draft, ...p }
    setDraft(next)
    // Live preview for the settings whose effect is purely visual. Picking a
    // theme from a list of names and waiting for Save to see it is guesswork —
    // the whole question is what it looks like behind this dialog.
    if (p.fontSizePx != null) document.documentElement.style.fontSize = `${p.fontSizePx}px`
    if (p.theme != null) applyTheme(p.theme)
    if (p.drawerDurationMs != null) setDrawerDuration(p.drawerDurationMs)
  }

  const cancel = () => {
    document.documentElement.style.fontSize = `${saved.fontSizePx}px`
    applyTheme(saved.theme)
    setDrawerDuration(saved.drawerDurationMs)
    setDialog({ kind: 'none' })
  }

  return (
    <FormDialog
      open
      onClose={cancel}
      title="Settings"
      widthClass="w-[min(46rem,94vw)]"
      onSubmit={() => {
        void saveSettings(draft)
        setDialog({ kind: 'none' })
      }}
      footer={
        <>
          <button type="button" onClick={cancel} className={`ml-auto ${dialogButton.ghost}`}>
            Cancel
          </button>
          <button type="submit" className={dialogButton.primary}>
            Save
          </button>
        </>
      }
    >
      <div className="flex h-[min(32rem,65vh)]">
        <nav className="flex w-36 shrink-0 flex-col gap-0.5 border-r border-[var(--color-border)] bg-[var(--color-panel)] p-2">
          {SECTIONS.map((label) => (
            <button
              key={label}
              type="button"
              aria-current={active === label}
              onClick={() => jumpTo(label)}
              className={`rounded-lg px-2.5 py-1.5 text-left ${
                active === label
                  ? 'bg-[var(--color-accent-dim)]/40 font-semibold text-[var(--color-text)]'
                  : 'text-[var(--color-muted)] hover:bg-[var(--color-accent-dim)]/20'
              }`}
            >
              {label}
            </button>
          ))}
        </nav>
        <div ref={body} onScroll={onScroll} className="relative min-w-0 flex-1 overflow-y-auto">
          <Group label="Appearance">
            {/* Not a Row: a theme is chosen by looking, so this is a grid of
              swatches rather than a label with a select bolted to the right. */}
            <fieldset className="min-w-0">
              <legend className="mb-2">Theme</legend>
              {/* Three rows tall, then its own scrollbar, so adding themes never
                pushes the rest of the settings out of reach. */}
              <div className="grid max-h-[10.5rem] grid-cols-3 gap-2 overflow-y-auto p-0.5">
                {THEMES.map((t) => {
                  const active = draft.theme === t.id
                  return (
                    <button
                      key={t.id}
                      type="button"
                      aria-pressed={active}
                      onClick={() => patch({ theme: t.id })}
                      className={`flex items-center gap-2.5 rounded-xl border px-2.5 py-2 text-left ${
                        active
                          ? 'border-[var(--color-accent)] bg-[var(--color-accent-dim)]/40'
                          : 'border-[var(--color-border)] hover:bg-[var(--color-accent-dim)]/20'
                      }`}
                    >
                      {/* The literals here are the one honest exception to the
                        tokens-only rule: a swatch has to show a theme that is
                        not the one currently loaded. */}
                      <span
                        className="size-6 shrink-0 rounded-full border border-[var(--color-border-strong)]"
                        style={{
                          background: `linear-gradient(135deg, ${t.swatch.bg} 50%, ${t.swatch.accent} 50%)`,
                        }}
                      />
                      <span className="min-w-0">
                        <span className="block truncate font-semibold">{t.name}</span>
                        <span className="block truncate text-[var(--color-faint)]">{t.note}</span>
                      </span>
                    </button>
                  )
                })}
              </div>
            </fieldset>
            <Row
              label="Interface size"
              hint="Scales the whole interface, not just text"
              control={
                <div className="flex items-center gap-3">
                  <input
                    type="range"
                    min={12}
                    max={22}
                    step={1}
                    value={draft.fontSizePx}
                    onChange={(e) => patch({ fontSizePx: Number(e.target.value) })}
                    className="flex-1"
                    aria-label="Interface size"
                  />
                  <span className="w-12 shrink-0 text-right font-[var(--font-mono)] text-[var(--color-muted)]">
                    {draft.fontSizePx}px
                  </span>
                </div>
              }
            />
          </Group>

          <Group label="Behaviour">
            <Row
              label="Drawer animation"
              hint="Milliseconds the tab strip and the activity tray take to slide. 0 turns it off."
              control={
                <input
                  type="number"
                  min={0}
                  max={2000}
                  step="any"
                  value={draft.drawerDurationMs}
                  onChange={(e) => patch({ drawerDurationMs: Number(e.target.value) })}
                  className={`${selectClass} w-28 text-right`}
                />
              }
            />
          </Group>

          <Group label="Browsing">
            <Row
              label="Infinite scroll"
              hint="Load the next page below the last row as it scrolls into view, instead of paging. Only with pagination on."
              control={
                <input
                  type="checkbox"
                  checked={draft.infiniteScroll}
                  onChange={(e) => patch({ infiniteScroll: e.target.checked })}
                />
              }
            />
            <Row
              label="Paginate by default"
              hint="Newly opened tables start paged"
              control={
                <input
                  type="checkbox"
                  checked={draft.paginationEnabled}
                  onChange={(e) => patch({ paginationEnabled: e.target.checked })}
                />
              }
            />
            <Row
              label="Default page size"
              control={
                <select
                  value={draft.defaultPageSize}
                  onChange={(e) => patch({ defaultPageSize: Number(e.target.value) })}
                  className={selectClass}
                >
                  {PAGE_SIZES.map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
              }
            />
            <Row
              label="Count rows automatically"
              hint="Runs COUNT(*) after each page. Turn off on very large tables."
              control={
                <input
                  type="checkbox"
                  checked={draft.autoCount}
                  onChange={(e) => patch({ autoCount: e.target.checked })}
                />
              }
            />
            <Row
              label="Row cap"
              hint="Hard limit on any single result, including with pagination off"
              control={
                <input
                  type="number"
                  min={1}
                  max={1_000_000}
                  // step="any" disables HTML5 step validation. With a numeric
                  // step, any value not landing on a multiple silently blocks
                  // form submission — the whole dialog stops saving because one
                  // unrelated field is "invalid".
                  step="any"
                  value={draft.rowCap}
                  onChange={(e) => patch({ rowCap: Number(e.target.value) })}
                  className={`${selectClass} w-28 text-right`}
                />
              }
            />
            <Row
              label="Long value cap"
              hint="Characters kept from text, JSON and similar columns. Cut by the database, so the rest never crosses the wire; open a cell to read it in full. 0 turns the cap off."
              control={
                <input
                  type="number"
                  min={0}
                  max={1_000_000}
                  // As with the row cap: a numeric step would make any value off
                  // the multiple silently block the whole dialog from saving.
                  step="any"
                  value={draft.textCapChars}
                  onChange={(e) => patch({ textCapChars: Number(e.target.value) })}
                  className={`${selectClass} w-28 text-right`}
                />
              }
            />
          </Group>

          <Group label="Catalogue">
            <Row
              label="Show system objects"
              hint="Reveals server databases and schemas such as mysql, tempdb and pg_catalog"
              control={
                <input
                  type="checkbox"
                  checked={draft.showSystemObjects}
                  onChange={(e) => patch({ showSystemObjects: e.target.checked })}
                />
              }
            />
          </Group>

          <Group label="Safety">
            <Row
              label="Confirm before removing a connection"
              control={
                <input
                  type="checkbox"
                  checked={draft.confirmDestructive}
                  onChange={(e) => patch({ confirmDestructive: e.target.checked })}
                />
              }
            />
          </Group>
        </div>
      </div>
    </FormDialog>
  )
}

/** Applied live, like the font size, so the effect can be seen before Save. */
function setDrawerDuration(ms: number) {
  document.documentElement.style.setProperty('--drawer-duration', `${Math.max(0, ms || 0)}ms`)
}

const SECTIONS = ['Appearance', 'Behaviour', 'Browsing', 'Catalogue', 'Safety'] as const

const selectClass =
  'rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-panel)] px-2 py-1 outline-none'

function Group({
  label,
  children,
}: {
  label: (typeof SECTIONS)[number]
  children: React.ReactNode
}) {
  return (
    <section
      data-group={label}
      className="border-b border-[var(--color-border)] px-4 py-3 last:border-b-0"
    >
      <h3 className="mb-2 font-semibold tracking-wider text-[var(--color-faint)] uppercase">
        {label}
      </h3>
      <div className="flex flex-col gap-3">{children}</div>
    </section>
  )
}

function Row({ label, hint, control }: { label: string; hint?: string; control: React.ReactNode }) {
  return (
    <label className="flex items-start justify-between gap-4">
      <span className="min-w-0 flex-1">
        <span className="block">{label}</span>
        {hint && <span className="block leading-relaxed text-[var(--color-faint)]">{hint}</span>}
      </span>
      <span className="shrink-0 pt-0.5">{control}</span>
    </label>
  )
}
