import { useRef, useState } from 'react'
import { downloadText } from '../dom'
import { useStore } from '../store'
import {
  buildTransfer,
  parseTransfer,
  sectionsIn,
  SECTIONS,
  type Section,
  type Transfer,
} from '../transfer'
import { Dialog, dialogButton } from '../ui'

const LABEL: Record<Section, string> = {
  settings: 'Settings',
  hotkeys: 'Hotkeys',
  connections: 'Connections (no passwords)',
}

/** Export chosen parts of the configuration to a JSON file, or import one. */
export function TransferDialog() {
  const settings = useStore((s) => s.settings)
  const connections = useStore((s) => s.connections)
  const importTransfer = useStore((s) => s.importTransfer)
  const pushToast = useStore((s) => s.pushToast)
  const setDialog = useStore((s) => s.setDialog)
  const close = () => setDialog({ kind: 'none' })

  const [exporting, setExporting] = useState<Set<Section>>(new Set(SECTIONS))
  const [incoming, setIncoming] = useState<Transfer | null>(null)
  const [importing, setImporting] = useState<Set<Section>>(new Set())
  const [error, setError] = useState('')
  const file = useRef<HTMLInputElement>(null)

  const flip = (set: Set<Section>, put: (s: Set<Section>) => void, s: Section) => {
    const next = new Set(set)
    if (!next.delete(s)) next.add(s)
    put(next)
  }

  const doExport = () => {
    const t = buildTransfer(
      SECTIONS.filter((s) => exporting.has(s)),
      settings,
      connections,
    )
    downloadText('ja-db-export.json', JSON.stringify(t, null, 2), 'application/json')
    pushToast('info', 'Exported to ja-db-export.json — it contains no passwords')
  }

  const pick = async (f: File | undefined) => {
    if (!f) return
    try {
      const t = parseTransfer(await f.text(), settings)
      setIncoming(t)
      setImporting(new Set(sectionsIn(t)))
      setError('')
    } catch (e) {
      setIncoming(null)
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const doImport = async () => {
    if (!incoming) return
    const keep: Transfer = { app: 'ja-db', version: 1 }
    for (const s of importing) Object.assign(keep, { [s]: incoming[s] })
    pushToast('info', await importTransfer(keep))
    close()
  }

  const box = (s: Section, set: Set<Section>, put: (n: Set<Section>) => void, count?: string) => (
    <label key={s} className="flex items-center gap-2">
      <input type="checkbox" checked={set.has(s)} onChange={() => flip(set, put, s)} />
      {LABEL[s]}
      {count && <span className="text-[var(--color-faint)]">{count}</span>}
    </label>
  )

  const countOf = (s: Section) => {
    if (!incoming) return undefined
    if (s === 'connections') return `${incoming.connections?.length ?? 0}`
    if (s === 'hotkeys') return `${Object.keys(incoming.hotkeys ?? {}).length} changed`
    return `${Object.keys(incoming.settings ?? {}).length} values`
  }

  return (
    <Dialog
      open
      onClose={close}
      title="Export and import"
      widthClass="w-[min(30rem,92vw)]"
      footer={
        <button onClick={close} className={`ml-auto ${dialogButton.secondary}`}>
          Close
        </button>
      }
    >
      <div className="flex flex-col gap-5 p-4">
        <section className="flex flex-col gap-2">
          <h3 className="font-semibold tracking-wider text-[var(--color-faint)] uppercase">
            Export
          </h3>
          {SECTIONS.map((s) => box(s, exporting, setExporting))}
          <p className="text-[var(--color-faint)]">
            Saved passwords stay in the keyring. Imported connections ask for one on first connect.
          </p>
          <button
            onClick={doExport}
            disabled={exporting.size === 0}
            className={`self-start ${dialogButton.primary}`}
          >
            Export to file
          </button>
        </section>

        <section className="flex flex-col gap-2">
          <h3 className="font-semibold tracking-wider text-[var(--color-faint)] uppercase">
            Import
          </h3>
          <input
            ref={file}
            type="file"
            accept="application/json,.json"
            onChange={(e) => void pick(e.target.files?.[0])}
          />
          {error && <p className="text-[var(--color-danger,#e5484d)]">{error}</p>}
          {incoming && (
            <>
              {sectionsIn(incoming).map((s) => box(s, importing, setImporting, countOf(s)))}
              <p className="text-[var(--color-faint)]">
                Settings and hotkeys replace yours. Connections already present are skipped.
              </p>
              <button
                onClick={() => void doImport()}
                disabled={importing.size === 0}
                className={`self-start ${dialogButton.primary}`}
              >
                Import
              </button>
            </>
          )}
        </section>
      </div>
    </Dialog>
  )
}
