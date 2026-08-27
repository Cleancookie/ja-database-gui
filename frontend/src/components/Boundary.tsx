import { Component, type ErrorInfo, type ReactNode } from 'react'
import { api } from '../api'
import { crashDetail, crashLogLine, type CrashDetail } from '../crash'

/**
 * The last line of defence.
 *
 * Without this a throw during render unmounts the tree to a white window: no
 * message, no log line, nothing to report. Wrapping the app means a crash
 * costs you the current view and not the session — the window still has the
 * error, the reload key and a way to copy the stack.
 *
 * A class because `getDerivedStateFromError` has no hook equivalent; it is the
 * one place in this codebase that needs one.
 */
export class Boundary extends Component<{ children: ReactNode }, { crash: CrashDetail | null }> {
  state: { crash: CrashDetail | null } = { crash: null }

  static getDerivedStateFromError(e: unknown) {
    return { crash: crashDetail(e, 'render') }
  }

  componentDidCatch(e: unknown, info: ErrorInfo) {
    reportCrash(crashDetail(e, 'render', info.componentStack ?? ''))
  }

  render() {
    if (!this.state.crash) return this.props.children
    return <CrashScreen crash={this.state.crash} />
  }
}

/**
 * Sends a crash to the Go log.
 *
 * Swallows its own failure: if the transport is what broke, a rejected log call
 * must not become a second crash on top of the one being reported.
 */
export function reportCrash(detail: CrashDetail) {
  void api.logClient(crashLogLine(detail)).catch(() => {})
}

/**
 * Installs the handlers for throws that never reach a component — an async
 * rejection, or an error from outside React. Called once from main.tsx.
 *
 * These only log. Tearing the UI down for a rejected fetch would be worse than
 * the toast the store already shows for one.
 */
export function installCrashReporting() {
  window.addEventListener('error', (e) => {
    reportCrash(crashDetail(e.error ?? e.message, 'unhandled error'))
  })
  window.addEventListener('unhandledrejection', (e) => {
    reportCrash(crashDetail(e.reason, 'unhandled rejection'))
  })
}

/**
 * What a crash looks like.
 *
 * Deliberately plain: it renders after something in the styled tree has
 * already failed, so it leans on the theme variables and nothing else — no
 * store read, no lazy import, nothing that could fail a second time.
 */
function CrashScreen({ crash }: { crash: CrashDetail }) {
  const full = [crash.message, crash.stack, crash.componentStack]
    .filter((s) => s.trim() !== '')
    .join('\n\n')

  return (
    <div className="flex h-screen flex-col items-center justify-center gap-4 bg-[var(--color-bg)] p-8 text-[var(--color-text)]">
      <h1 className="font-semibold text-[var(--color-danger)]">Something broke</h1>
      <p className="max-w-prose text-center text-[var(--color-muted)]">
        The view crashed rather than the app. Reloading keeps your connections and loses only
        what is on screen.
      </p>
      <pre className="max-h-64 w-full max-w-3xl overflow-auto rounded-2xl border border-[var(--color-border)] bg-[var(--color-elevated)] p-4 font-[var(--font-mono)] whitespace-pre-wrap text-[var(--color-muted)]">
        {full}
      </pre>
      <div className="flex items-center gap-2">
        <button
          onClick={() => window.location.reload()}
          className="rounded-full border border-[var(--color-border-strong)] bg-[var(--color-elevated)] px-3 py-0.5 font-semibold shadow-xs hover:border-[var(--color-accent)]"
        >
          Reload <span className="text-[var(--color-faint)]">Ctrl+Shift+R</span>
        </button>
        <button
          onClick={() => void navigator.clipboard?.writeText(full)}
          className="rounded-full border border-[var(--color-border-strong)] bg-[var(--color-elevated)] px-3 py-0.5 shadow-xs hover:border-[var(--color-accent)]"
        >
          Copy details
        </button>
      </div>
      <p className="text-[var(--color-faint)]">Also written to ja-db.log</p>
    </div>
  )
}
