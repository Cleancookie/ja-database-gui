/**
 * The animation scale. Every duration in index.css is multiplied by `--motion`,
 * so one number speeds up, slows down or switches off all of them.
 *
 * An unset scale follows the OS: reduced motion means 0, otherwise 1. A user
 * who has reduced motion on can still turn it up here.
 */
export function motionScale(setting: number | null): number {
  if (setting != null) return setting
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 0 : 1
}

export function applyMotion(setting: number | null) {
  const k = motionScale(setting)
  const root = document.documentElement
  root.style.setProperty('--motion', String(k))
  root.dataset.motion = k === 0 ? 'off' : 'on'
}

/** Whether animations are off — for motion driven from script, like a smooth scroll. */
export function motionOff(): boolean {
  return document.documentElement.dataset.motion === 'off'
}
