import { useEffect, useRef, useState } from 'react'
import type { Settings } from '../types'
import { useStore } from '../store'

/**
 * Draggable panel edges, for the sidebar's width and the tray's height.
 *
 * One implementation for both because the fiddly parts — pointer capture, not
 * writing to disk per pixel, keeping the keyboard working — are identical, and
 * only the axis differs. The sign convention is the one thing that is not
 * symmetric: dragging the sidebar's right edge rightwards makes it *wider*,
 * while dragging the tray's top edge upwards makes it *taller*, so the tray
 * inverts the delta.
 */

const KEY_STEP = 16

/** Limits per panel. Mirrored in Settings.clamp() in Go, which rejects the rest. */
export const LIMITS = {
  sidebar: { min: 180, max: 560, default: 256 },
  tray: { min: 96, max: 720, default: 260 },
  sqlEditor: { min: 64, max: 720, default: 160 },
  openList: { min: 48, max: 720, default: 160 },
} as const

export type Axis = 'x' | 'y'

export interface Resizable {
  size: number
  dragging: boolean
  setDragging: (on: boolean) => void
  setSize: (px: number) => void
  commit: (px: number) => void
  min: number
  max: number
  defaultSize: number
}

/**
 * Tracks one panel's size against a settings field.
 *
 * The size lives in React state during a drag and is written to settings only
 * on release: persisting per pointer event would be a disk write and an IPC
 * round trip per pixel of travel.
 */
export function useResizable(
  field: 'sidebarWidthPx' | 'trayHeightPx' | 'sqlEditorHeightPx' | 'openListHeightPx',
  limits: { min: number; max: number; default: number },
): Resizable {
  const saved = useStore((s) => s.settings[field])
  const settings = useStore((s) => s.settings)
  const saveSettings = useStore((s) => s.saveSettings)

  const [dragging, setDragging] = useState(false)
  const [size, setSize] = useState(saved)

  const clamp = (px: number) => Math.round(Math.min(limits.max, Math.max(limits.min, px)))

  // Follows the saved value unless a drag is in progress, so loading settings
  // at startup — or changing them elsewhere — moves the edge, while a drag is
  // never yanked out from under the pointer.
  useEffect(() => {
    if (!dragging) setSize(saved)
  }, [saved, dragging])

  const commit = (px: number) => {
    const next = clamp(px)
    setSize(next)
    if (next !== saved) void saveSettings({ ...settings, [field]: next } as Settings)
  }

  return {
    size: clamp(size),
    dragging,
    setDragging,
    setSize,
    commit,
    min: limits.min,
    max: limits.max,
    defaultSize: limits.default,
  }
}

export interface ResizerProps extends Resizable {
  axis: Axis
  /** True when dragging *against* the axis direction grows the panel. */
  invert?: boolean
  label: string
  /** Position on the panel's edge — the caller knows which edge that is. */
  className?: string
}

/**
 * The drag handle.
 *
 * Absolutely positioned by the caller onto the panel's own edge rather than
 * being a flex sibling: a divider in the layout would mean wrapping the panel
 * and re-indenting all of it, and an overlay cannot shift anything inside.
 *
 * Pointer capture rather than window listeners: the pointer stays targeted at
 * this element even after it leaves it, so a fast drag across the grid does not
 * lose the gesture, and no listener can outlive the unmount.
 */
export function Resizer({
  axis,
  invert = false,
  size,
  min,
  max,
  defaultSize,
  dragging,
  setDragging,
  setSize,
  commit,
  label,
  className = '',
}: ResizerProps) {
  const start = useRef(0)
  const startSize = useRef(size)

  const position = (e: React.PointerEvent) => (axis === 'x' ? e.clientX : e.clientY)
  const sizeFrom = (pos: number) => {
    const delta = pos - start.current
    return startSize.current + (invert ? -delta : delta)
  }

  // The arrow that moves the handle the way a drag that grows the panel does.
  const [forward, backward] = axis === 'x' ? ['ArrowRight', 'ArrowLeft'] : ['ArrowDown', 'ArrowUp']
  const grow = invert ? backward : forward
  const shrink = invert ? forward : backward

  // Pointer capture keeps the gesture, not the text selection: without this a
  // drag over the editor or grid paints a selection across it.
  useEffect(() => {
    if (!dragging) return
    const body = document.body
    const prev = body.style.userSelect
    body.style.userSelect = 'none'
    return () => {
      body.style.userSelect = prev
    }
  }, [dragging])

  return (
    <div
      role="separator"
      // A separator's orientation is its own, not that of the movement: the
      // tray's handle is a horizontal line separating vertically stacked areas.
      aria-orientation={axis === 'x' ? 'vertical' : 'horizontal'}
      aria-label={label}
      aria-valuenow={size}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      onPointerDown={(e) => {
        // Only the primary button; a right-click here should do nothing.
        if (e.button !== 0) return
        e.currentTarget.setPointerCapture(e.pointerId)
        start.current = position(e)
        startSize.current = size
        setDragging(true)
      }}
      onPointerMove={(e) => {
        if (!dragging) return
        setSize(sizeFrom(position(e)))
      }}
      onPointerUp={(e) => {
        if (!dragging) return
        e.currentTarget.releasePointerCapture(e.pointerId)
        setDragging(false)
        commit(sizeFrom(position(e)))
      }}
      // Cancel — a browser gesture takeover, or the window losing the pointer —
      // keeps the size reached rather than snapping back.
      onPointerCancel={() => {
        if (!dragging) return
        setDragging(false)
        commit(size)
      }}
      // The app is driven from the keyboard, so the handle is focusable and the
      // arrows move it. Home resets to the default.
      onKeyDown={(e) => {
        if (e.key === grow) {
          e.preventDefault()
          commit(size + KEY_STEP)
        } else if (e.key === shrink) {
          e.preventDefault()
          commit(size - KEY_STEP)
        } else if (e.key === 'Home') {
          e.preventDefault()
          commit(defaultSize)
        }
      }}
      onDoubleClick={() => commit(defaultSize)}
      title="Drag to resize · double-click to reset"
      className={`absolute z-10 rounded-full transition-colors duration-150 hover:bg-[var(--color-accent)] focus-visible:bg-[var(--color-accent)] focus-visible:outline-none ${
        axis === 'x' ? 'inset-y-0 w-1.5 cursor-col-resize' : 'inset-x-0 h-1.5 cursor-row-resize'
      } ${dragging ? 'bg-[var(--color-accent)]' : ''} ${className}`}
    />
  )
}
