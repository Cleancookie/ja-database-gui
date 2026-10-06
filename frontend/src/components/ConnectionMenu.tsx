import { useStore } from '../store'
import { ContextMenu, Dialog, dialogButton, type MenuItem } from '../ui'
import type { Connection } from '../types'

/**
 * Wraps a connection row in its right-click menu.
 *
 * The menu owns its own open state inside the adapter layer, so nothing about
 * mouse position or menu visibility lives in the store.
 */
export function ConnectionMenu({
  connection,
  children,
}: {
  connection: Connection
  children: React.ReactNode
}) {
  const connectedIds = useStore((s) => s.connectedIds)
  const openWorkspace = useStore((s) => s.openWorkspace)
  const disconnect = useStore((s) => s.disconnect)
  const removeConnection = useStore((s) => s.removeConnection)
  const setDialog = useStore((s) => s.setDialog)

  const isConnected = connectedIds.includes(connection.id)

  const items: MenuItem[] = [
    {
      label: isConnected ? 'Switch to this connection' : 'Connect',
      onSelect: () => void openWorkspace(connection.id),
    },
    {
      label: 'Disconnect',
      onSelect: () => void disconnect(connection.id),
      disabled: !isConnected,
    },
    {
      label: 'Edit…',
      onSelect: () => setDialog({ kind: 'connection', connection }),
    },
    {
      label: 'Remove',
      danger: true,
      onSelect: () => removeConnection(connection),
    },
  ]

  return (
    <ContextMenu items={items} heading={connection.name}>
      {children}
    </ContextMenu>
  )
}

/** Confirmation for removing a connection. */
export function ConfirmDeleteDialog({ name, id }: { name: string; id: string }) {
  const setDialog = useStore((s) => s.setDialog)
  const deleteConnection = useStore((s) => s.deleteConnection)
  const close = () => setDialog({ kind: 'none' })

  return (
    <Dialog
      open
      onClose={close}
      title={`Remove “${name}”?`}
      widthClass="w-[min(26rem,92vw)]"
      footer={
        <>
          <button onClick={close} className={`ml-auto ${dialogButton.ghost}`}>
            Cancel
          </button>
          <button onClick={() => void deleteConnection(id)} className={dialogButton.dangerFilled}>
            Remove
          </button>
        </>
      }
    >
      <p className="px-4 py-4 leading-relaxed text-[var(--color-muted)]">
        The saved connection and its stored password will be deleted. The database itself is not
        touched.
      </p>
    </Dialog>
  )
}
