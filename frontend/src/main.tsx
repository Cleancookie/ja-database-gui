import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './components/App'
import { Boundary, installCrashReporting } from './components/Boundary'
import { installObservers } from './perf'
import { installAppReload } from './reload'
import { mark } from './startup'
import './index.css'

// The first mark measures everything before this line: webview boot, asset
// serving and parsing the bundle. See startup.ts.
mark('script start')

// Before the first render, so the interactions during startup are measured too.
installObservers()

// Before the first render for the same reason: a throw while the tree is first
// mounting is exactly the crash that used to leave nothing behind.
installCrashReporting()

// Outside React on purpose — see reload.ts. The key has to outlive the tree it
// is there to rescue.
installAppReload()

const root = document.getElementById('root')
if (!root) throw new Error('#root is missing from index.html')

createRoot(root).render(
  <StrictMode>
    <Boundary>
      <App />
    </Boundary>
  </StrictMode>,
)

mark('react mount')
