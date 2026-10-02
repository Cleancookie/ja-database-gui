/**
 * The command registry.
 *
 * Everything the app can do is a Command, and the palette is the primary way
 * to reach any of it. The list is rebuilt from state on every open, so it is
 * context-aware: tables only appear once a database is selected, "Disconnect"
 * only when connected.
 */

import type { Candidate } from './fuzzy'
import { effectiveIsolation, isolationChoices } from './isolation'
import { perf } from './perf'
import { reportText } from './startup'
import { objectBias, orderByRecency, refKey } from './recency'
import { rectOf, rectSize } from './selection'
import { runSqlFromEditor } from './sqlEditorRun'
import { FONT_SIZE_DEFAULT, FONT_SIZE_MAX, FONT_SIZE_MIN, PAGE_SIZES, type useStore } from './store'
import { storageWarning } from './secrets'
import { tabTitle } from './tabs'
import { THEMES } from './themes'
import type { ObjectType, SchemaObject } from './types'

type Store = ReturnType<typeof useStore.getState>

export interface Command {
  id: string
  title: string
  subtitle?: string
  group: string
  shortcut?: string
  /** How this entry is matched and ranked. */
  candidate: Candidate
  run: () => void | Promise<void>
}

export const OBJECT_ICON: Record<ObjectType, string> = {
  table: '▤',
  view: '◫',
  function: 'ƒ',
  procedure: '⚙',
}

/**
 * `recentIndex` is the object's position in the recently opened list, or -1.
 * With an empty query a candidate's score *is* its bias (see matchCandidate),
 * so this is what produces most-recent-first when the palette opens.
 */
export function objectCandidate(o: SchemaObject, recentIndex = -1): Candidate {
  return {
    name: o.name,
    qualifier: o.schema || undefined,
    keywords: o.type,
    bias: objectBias(o.schema, o.type, recentIndex),
  }
}

export function qualifiedName(o: { schema: string; name: string }): string {
  return o.schema ? `${o.schema}.${o.name}` : o.name
}

/**
 * What kind of object is on screen, looked up in the tree.
 *
 * ObjectRef carries no type — it is only an address — and the difference matters
 * to the schema commands: a view has no rows to empty, and its DROP names a
 * different keyword. null when nothing is open, or when the tree has not been
 * loaded and the answer is not known.
 */
function activeType(s: Store): ObjectType | null {
  if (!s.activeRef) return null
  const ref = s.activeRef
  return s.objects.find((o) => o.name === ref.name && o.schema === ref.schema)?.type ?? null
}

/**
 * The navigation palette (Ctrl+P): places to go.
 *
 * Tables, views, databases and connections — the things a person means when
 * they know *what* they want to look at. Nothing here changes settings or
 * app state beyond moving somewhere.
 */
export function buildNavigationCommands(s: Store): Command[] {
  const cmds: Command[] = []

  // Objects first: navigating to a table is by far the most common reason to
  // open this palette, so those entries lead when nothing has been typed.
  //
  // Recently opened ones lead within that, and are grouped separately so the
  // few tables being worked on right now are visually distinct from the whole
  // catalogue. Open tabs are offered further down; this list is what opens a
  // table in the *current* tab.
  if (s.activeConnectionId) {
    const recent = new Map(s.recentObjects.map((k, i) => [k, i]))
    // The object currently on screen is excluded from Recent: offering to
    // navigate to where you already are is noise at the top of the list.
    const lookup = (o: SchemaObject) =>
      s.activeRef?.name === o.name &&
      s.activeRef?.schema === o.schema &&
      s.activeRef?.database === s.activeDatabase
        ? -1
        : (recent.get(refKey(s.activeDatabase, o.schema, o.name)) ?? -1)
    // Resolved once per object rather than on every read of it: the sort below
    // wants it, and so does the command built from it.
    const position = new Map(s.objects.map((o) => [o, lookup(o)]))
    const indexOf = (o: SchemaObject) => position.get(o) ?? -1

    for (const o of orderByRecency(s.objects, indexOf)) {
      const i = indexOf(o)
      const qualified = qualifiedName(o)
      cmds.push({
        id: `object:${qualified}:${o.type}`,
        title: qualified,
        subtitle: o.type + (o.rowEstimate != null ? ` · ~${formatCount(o.rowEstimate)} rows` : ''),
        group: i >= 0 ? 'Recent' : 'Open',
        candidate: objectCandidate(o, i),
        run: () => s.openObject(o),
      })
    }
  }

  if (s.view !== 'data' || s.activeRef) {
    cmds.push({
      id: 'page:picker',
      title: 'Connections, databases and tables',
      subtitle: 'The picker page',
      group: 'Pages',
      candidate: { name: 'Picker', keywords: 'browse connections databases tables home server choose' },
      run: () => s.showPicker(),
    })
  }

  // Jump to a tab that is already open, rather than retargeting this one.
  const names = new Map(s.connections.map((c) => [c.id, c.name]))
  for (const t of s.tabs) {
    if (t.id === s.activeTabId || !t.saved) continue
    const title = tabTitle(t.saved)
    const where = [names.get(t.saved.activeConnectionId ?? ''), t.saved.activeDatabase]
      .filter(Boolean)
      .join(' · ')
    cmds.push({
      id: `tab:${t.id}`,
      title: `Tab: ${title}`,
      subtitle: where || undefined,
      group: 'Tabs',
      candidate: { name: title, keywords: `tab switch open ${where}`, bias: -0.1 },
      run: () => s.switchTab(t.id),
    })
  }

  if (s.capabilities?.serverHostsDatabases) {
    for (const db of s.databases) {
      if (db === s.activeDatabase) continue
      cmds.push({
        id: `database:${db}`,
        title: `Use database ${db}`,
        group: 'Databases',
        candidate: { name: db, keywords: 'use database switch catalog', bias: -0.05 },
        run: () => s.selectDatabase(db),
      })
    }
  }

  for (const c of s.connections) {
    const connected = s.connectedIds.includes(c.id)
    cmds.push({
      id: `connect:${c.id}`,
      title: connected ? `Switch to ${c.name}` : `Connect to ${c.name}`,
      subtitle: describeConnection(c.kind, c.host, c.file),
      group: 'Connections',
      candidate: {
        name: c.name,
        keywords: `connect connection ${c.kind} ${c.host ?? ''} ${c.file ?? ''}`,
      },
      run: () => s.connect(c.id),
    })
  }

  return cmds
}

/**
 * The action palette (Ctrl+Shift+P): things to do.
 *
 * Settings, the activity tray, pagination, managing connections. This is where
 * everything that used to live in the top bar went — the app is
 * palette-first, so a permanent strip of buttons for three actions was mostly
 * ornament.
 */
export function buildActionCommands(s: Store): Command[] {
  const cmds: Command[] = []

  cmds.push({
    id: 'tab:new',
    title: 'New tab',
    group: 'Tabs',
    shortcut: 'Ctrl+T',
    candidate: { name: 'New tab', keywords: 'open picker' },
    run: () => s.newTab(),
  })
  cmds.push({
    id: 'tab:close',
    title: 'Close tab',
    group: 'Tabs',
    shortcut: 'Ctrl+W',
    candidate: { name: 'Close tab', keywords: 'remove' },
    run: () => s.closeTab(),
  })
  cmds.push({
    id: 'tab:reopen',
    title: 'Reopen closed tab',
    group: 'Tabs',
    shortcut: 'Ctrl+Shift+T',
    candidate: { name: 'Reopen closed tab', keywords: 'restore undo close' },
    run: () => s.reopenTab(),
  })
  if (s.tabs.length > 1) {
    cmds.push({
      id: 'tab:next',
      title: 'Next tab',
      group: 'Tabs',
      shortcut: 'Ctrl+Tab',
      candidate: { name: 'Next tab', keywords: 'switch right down' },
      run: () => s.cycleTab(1),
    })
    cmds.push({
      id: 'tab:previous',
      title: 'Previous tab',
      group: 'Tabs',
      shortcut: 'Ctrl+Shift+Tab',
      candidate: { name: 'Previous tab', keywords: 'switch left up' },
      run: () => s.cycleTab(-1),
    })
  }
  cmds.push({
    id: 'page:back',
    title: 'Go back',
    subtitle: 'To the previous page in the main panel, across tabs',
    group: 'Pages',
    shortcut: 'Alt+←',
    candidate: { name: 'Go back', keywords: 'previous history page undo navigation route mouse' },
    run: () => s.stepHistory(-1),
  })
  cmds.push({
    id: 'page:forward',
    title: 'Go forward',
    subtitle: 'To the next page in the main panel, across tabs',
    group: 'Pages',
    shortcut: 'Alt+→',
    candidate: { name: 'Go forward', keywords: 'next history page redo navigation route mouse' },
    run: () => s.stepHistory(1),
  })

  cmds.push({
    id: 'connection:new',
    title: 'New connection…',
    group: 'Connections',
    candidate: {
      // Matches the title exactly so highlighting lines up — see alignToTitle.
      name: 'New connection…',
      keywords: 'add create database server mysql postgres mssql sqlite',
    },
    run: () => s.setDialog({ kind: 'connection', connection: null }),
  })

  cmds.push({
    id: 'connection:password-storage',
    title: 'Show where passwords are stored',
    subtitle: 'OS keyring, or plain text if none is available',
    group: 'Connections',
    candidate: {
      name: 'Where passwords are stored',
      keywords: 'password secret credential keyring plaintext security storage',
    },
    run: () => {
      const w = storageWarning(s.secretBackend)
      s.pushToast(
        w?.level === 'error' ? 'error' : 'info',
        w ? `${w.headline}. ${w.detail}` : 'Saved passwords are in the OS keyring.',
      )
    },
  })

  if (s.activeConnectionId) {
    const active = s.connections.find((c) => c.id === s.activeConnectionId)
    if (active) {
      cmds.push({
        id: 'connection:edit',
        title: `Edit connection “${active.name}”`,
        group: 'Connections',
        candidate: { name: `Edit ${active.name}`, keywords: 'connection settings modify' },
        run: () => s.setDialog({ kind: 'connection', connection: active }),
      })
      cmds.push({
        id: 'connection:disconnect',
        title: `Disconnect from ${active.name}`,
        group: 'Connections',
        candidate: { name: `Disconnect ${active.name}`, keywords: 'close drop' },
        run: () => s.disconnect(active.id),
      })
    }
  }

  cmds.push({
    id: 'sql:toggle',
    title: s.view === 'sql' ? 'Close SQL editor' : 'Open SQL editor',
    group: 'Query',
    shortcut: 'Ctrl+E',
    candidate: { name: 'SQL editor', keywords: 'query write execute run' },
    run: () => s.setView(s.view === 'sql' ? 'data' : 'sql'),
  })

  // Only offered in the editor: elsewhere there is nothing to run. The title
  // follows the selection so the palette says what Enter will do.
  if (s.view === 'sql') {
    cmds.push({
      id: 'sql:run',
      title: s.sqlHasSelection ? 'Run selection' : 'Run',
      subtitle: s.sqlHasSelection ? 'Only the selected text' : 'The whole editor',
      group: 'Query',
      shortcut: 'Ctrl+Enter',
      candidate: {
        name: s.sqlHasSelection ? 'Run selection' : 'Run query',
        keywords: 'execute query sql',
      },
      run: () => void runSqlFromEditor(),
    })
  }

  // One command per level, so the palette reaches it as readily as the
  // dropdown. Only in the editor and only where the dialect offers any; the
  // title says what Enter will do, and the subtitle carries the transaction
  // warning.
  if (s.view === 'sql' && s.capabilities && s.capabilities.isolationLevels.length > 0) {
    const current = effectiveIsolation(s.capabilities.isolationLevels, s.sqlIsolation)
    for (const c of isolationChoices(s.capabilities.isolationLevels)) {
      cmds.push({
        id: `sql:isolation:${c.value || 'default'}`,
        title: `Isolation level: ${c.label}${c.value === current ? ' (current)' : ''}`,
        subtitle: c.value ? 'Wraps each run in a transaction' : 'No transaction around a run',
        group: 'Query',
        candidate: {
          name: `Isolation level ${c.label}`,
          keywords: 'transaction isolation level read committed serializable snapshot repeatable uncommitted',
          bias: c.value === current ? -0.5 : 0,
        },
        run: () => s.setSqlIsolation(c.value),
      })
    }
  }

  // Offered only while something is running, in the editor or not: a run goes
  // on when the user changes tab, and the palette is how they stop it.
  if (s.sqlRun) {
    cmds.push(
      {
        id: 'sql:cancel',
        title: 'Cancel running query',
        subtitle: 'The SQL editor statement in flight',
        group: 'Query',
        shortcut: 'Ctrl+.',
        candidate: { name: 'Cancel running query', keywords: 'stop abort kill editor sql' },
        run: () => s.cancelSql(),
      },
      {
        id: 'sql:cancel-connection',
        title: 'Cancel all running queries on this connection',
        subtitle: 'The editor and anything else this app is running there',
        group: 'Query',
        candidate: {
          name: 'Cancel all running queries',
          keywords: 'stop abort kill everything connection activity',
        },
        run: () => s.cancelConnectionSql(),
      },
    )
  }

  // The dropdown is in the editor's header, so the command has to open the
  // editor before it can focus it — after the render that mounts it, the way
  // Ctrl+F waits for the filter bar.
  cmds.push({
    id: 'sql:pick-database',
    title: s.activeConnectionId ? 'Choose the database to query' : 'Choose a connection to query',
    subtitle: 'The dropdown in the SQL editor header',
    group: 'Query',
    candidate: {
      name: 'Choose the database',
      keywords: 'switch use catalog schema connection editor run against',
    },
    run: () => {
      s.setView('sql')
      requestAnimationFrame(focusDatabasePicker)
    },
  })

  cmds.push(
    ...paneCommands({
      id: 'left',
      label: 'left pane',
      what: 'tab strip',
      open: !s.settings.tabStripHidden,
      set: (open) => s.setTabStrip(open),
      shortcut: 'Ctrl+B / Ctrl+←',
      keywords: 'sidebar tabs vertical',
    }),
    ...paneCommands({
      id: 'bottom',
      label: 'bottom pane',
      what: 'activity tray',
      open: s.trayOpen,
      set: (open) => s.setTrayOpen(open),
      shortcut: 'Ctrl+` / Ctrl+↓',
      keywords: 'running queries monitor cancel kill progress loading elapsed history',
    }),
  )

  cmds.push({
    id: 'app:startup-timing',
    title: 'Show startup timing',
    subtitle: 'Where launch time went, this run',
    group: 'App',
    candidate: { name: 'Startup timing', keywords: 'slow launch boot performance profile' },
    // A toast rather than a console log: the Windows build is launched from
    // Explorer, where there is no console to read. Also logged, for when
    // devtools *is* open and the toast has already timed out.
    run: () => {
      console.info('startup:', reportText())
      s.pushToast('info', reportText())
    },
  })

  cmds.push({
    id: 'app:performance',
    title: 'Show performance report',
    subtitle: 'The slowest interactions since launch',
    group: 'App',
    candidate: { name: 'Performance report', keywords: 'slow lag timing profile jank' },
    // The worst individual events as well as the aggregate: an average hides
    // the one 400ms click that is the reason anyone went looking. Also written
    // to the log file periodically — see perf.ts — so quitting loses nothing.
    run: () => {
      const worst = perf
        .worst(5)
        .map((e) => `${e.name} ${e.ms}ms${e.detail ? ` (${e.detail})` : ''}`)
        .join(' · ')
      console.info('perf:', perf.reportText())
      if (worst) console.info('perf worst:', worst)
      s.pushToast('info', worst || perf.reportText())
    },
  })

  cmds.push({
    id: 'tray:clear',
    title: 'Clear the query log',
    subtitle: 'Drops finished queries from the tray; anything running stays',
    group: 'Query',
    candidate: { name: 'Clear query log', keywords: 'activity history tray reset empty' },
    run: () => s.clearQueryHistory(),
  })

  cmds.push({
    id: 'view:activity',
    title: 'Show open connections',
    subtitle: 'Connection pools per database, with disconnect',
    group: 'Query',
    shortcut: 'Ctrl+Shift+A',
    candidate: { name: 'Open connections', keywords: 'activity sessions processes pool disconnect' },
    run: () => s.setView('activity'),
  })

  if (s.selection) {
    const size = rectSize(rectOf(s.selection))
    cmds.push({
      id: 'grid:copy',
      title:
        size.cells === 1
          ? 'Copy the selected cell'
          : size.cols === 1
            ? `Copy ${size.rows} values as an IN list`
            : `Copy ${size.cells} cells as CSV`,
      subtitle: 'One cell is its value, one column is an IN list, wider is CSV',
      group: 'Query',
      shortcut: 'Ctrl+C',
      candidate: {
        name: 'Copy the selection',
        keywords: 'copy clipboard cells range in list csv values ids paste',
      },
      run: () => s.copySelection(),
    })
  }

  cmds.push(...buildEditCommands(s))

  // Only a batch that answered more than once has tabs to move between.
  if (s.sqlResults.length > 1) {
    const next = (s.sqlResultIndex + 1) % s.sqlResults.length
    cmds.push({
      id: 'sql:next-result',
      title: `Show result ${next + 1} of ${s.sqlResults.length}`,
      subtitle: 'The next result set this batch returned',
      group: 'Query',
      candidate: {
        name: 'Next result set',
        keywords: 'result set batch tab next switch multiple statements',
      },
      run: async () => s.selectSqlResult(next),
    })
  }

  // The grid on screen, as a file. Browse shows one page, so that is what it
  // exports — the page size control is how you ask for more.
  const exportable = s.view === 'sql' ? s.sqlResults[s.sqlResultIndex] : s.result
  if (exportable && exportable.columns.length > 0) {
    cmds.push({
      id: 'grid:export-csv',
      title: `Export ${exportable.rows.length} rows as CSV`,
      subtitle: s.view === 'sql' ? 'The result on screen' : 'The rows on this page',
      group: 'Query',
      candidate: {
        name: 'Export as CSV',
        keywords: 'export csv download save file spreadsheet excel rows result',
      },
      run: () => s.exportCsv(),
    })
  }

  cmds.push({
    id: 'grid:transpose',
    title: s.transposed ? 'Show rows across' : 'Transpose the grid',
    subtitle: s.transposed
      ? 'Back to one row per line'
      : 'Column names down the side, one record per column',
    group: 'Query',
    shortcut: 'Tab',
    candidate: {
      name: s.transposed ? 'Show rows across' : 'Transpose the grid',
      keywords: 'transpose flip rotate swap axes pivot sideways vertical record card',
    },
    run: () => s.toggleTransposed(),
  })

  if (s.activeConnectionId) {
    cmds.push({
      id: 'schema:new-table',
      title: 'New table…',
      subtitle: 'Name, columns, types — shows the CREATE before running it',
      group: 'Schema',
      candidate: {
        name: 'New table…',
        keywords: 'create add make table schema column ddl',
      },
      // The schema of whatever is open is the likeliest place to want the new
      // table, and the dialog lets it be changed anyway.
      run: () => s.newTable(s.activeRef?.schema),
    })
  }

  if (s.activeRef) {
    cmds.push({
      id: 'data:details',
      title: 'Show table details',
      subtitle: 'Columns, indexes, foreign keys, constraints, triggers',
      group: 'Query',
      candidate: {
        name: 'Show table details',
        keywords:
          'describe schema structure ddl columns indexes keys foreign constraints triggers size rows info metadata',
      },
      run: () => s.openDetails(s.activeRef!),
    })
    // The schema changes for the table on screen. The context menu in the
    // sidebar fires exactly these store actions against the object it is
    // attached to, so the confirmation and the refresh afterwards are the same
    // whichever route was taken.
    if (activeType(s) === 'table') {
      cmds.push({
        id: 'schema:truncate',
        title: `Empty ${qualifiedName(s.activeRef)}`,
        subtitle: s.capabilities?.truncateIsDelete
          ? 'Deletes every row — SQLite has no TRUNCATE'
          : 'TRUNCATE — deletes every row and cannot be undone',
        group: 'Schema',
        candidate: {
          name: `Empty ${s.activeRef.name}`,
          keywords: 'truncate empty clear delete all rows wipe',
          // Below the read-only entries: an irreversible statement should not
          // be what an empty palette offers first.
          bias: -0.4,
        },
        run: () => s.truncateTable(s.activeRef!),
      })
    }
    if (activeType(s) === 'table' || activeType(s) === 'view') {
      const type = activeType(s)!
      cmds.push({
        id: 'schema:drop',
        title: `Drop ${type} ${qualifiedName(s.activeRef)}`,
        subtitle: 'Removes the object and its data — cannot be undone',
        group: 'Schema',
        candidate: {
          name: `Drop ${s.activeRef.name}`,
          keywords: 'drop delete remove destroy table view',
          bias: -0.4,
        },
        run: () => s.dropObject(s.activeRef!, type),
      })
    }

    cmds.push({
      id: 'data:refresh',
      title: 'Refresh rows',
      group: 'Query',
      shortcut: 'Ctrl+R',
      candidate: { name: 'Refresh rows', keywords: 'reload requery' },
      run: () => s.reload(),
    })
    cmds.push({
      id: 'data:focus-filter',
      title: 'Filter rows (SQL after WHERE)',
      group: 'Query',
      shortcut: 'Ctrl+F',
      candidate: { name: 'Filter rows', keywords: 'where search find condition' },
      run: () => focusFilter(),
    })
    if (s.filter) {
      cmds.push({
        id: 'data:clear-filter',
        title: 'Clear filter',
        group: 'Query',
        candidate: { name: 'Clear filter', keywords: 'reset where' },
        run: () => s.applyFilter(''),
      })
    }
    if (s.orderBy.length > 0) {
      cmds.push({
        id: 'data:clear-sort',
        title: 'Clear sort',
        group: 'Query',
        candidate: { name: 'Clear sort', keywords: 'reset order by' },
        run: () => s.clearSort(),
      })
    }

    cmds.push({
      id: 'page:toggle',
      title: s.paginationEnabled ? 'Turn pagination off' : 'Turn pagination on',
      subtitle: s.paginationEnabled
        ? 'Load every matching row, up to the safety cap'
        : `Back to pages of ${s.pageSize}`,
      group: 'Pagination',
      candidate: { name: 'Pagination', keywords: 'paging limit all rows off on' },
      run: () => s.setPaginationEnabled(!s.paginationEnabled),
    })
    cmds.push({
      id: 'page:infinite',
      title: s.settings.infiniteScroll ? 'Turn infinite scroll off' : 'Turn infinite scroll on',
      subtitle: s.settings.infiniteScroll
        ? 'Back to page controls'
        : 'Load the next page below the last row as it scrolls into view',
      group: 'Pagination',
      candidate: { name: 'Infinite scroll', keywords: 'paging endless load more scroll append' },
      run: () => s.saveSettings({ ...s.settings, infiniteScroll: !s.settings.infiniteScroll }),
    })
    if (s.paginationEnabled) {
      for (const n of PAGE_SIZES) {
        if (n === s.pageSize) continue
        cmds.push({
          id: `page:size:${n}`,
          title: `Page size: ${n}`,
          group: 'Pagination',
          candidate: { name: `Page size ${n}`, keywords: 'rows per page limit', bias: -0.1 },
          run: () => s.setPageSize(n),
        })
      }
      if (!s.settings.infiniteScroll && s.page > 1) {
        cmds.push({
          id: 'page:prev',
          title: 'Previous page',
          group: 'Pagination',
          candidate: { name: 'Previous page', keywords: 'back' },
          run: () => s.setPage(s.page - 1),
        })
        cmds.push({
          id: 'page:first',
          title: 'First page',
          group: 'Pagination',
          candidate: { name: 'First page', keywords: 'start beginning' },
          run: () => s.setPage(1),
        })
      }
      if (!s.settings.infiniteScroll && s.hasMore) {
        cmds.push({
          id: 'page:next',
          title: 'Next page',
          group: 'Pagination',
          candidate: { name: 'Next page', keywords: 'forward' },
          run: () => s.setPage(s.page + 1),
        })
      }
    }
  }

  cmds.push({
    id: 'app:settings',
    title: 'Settings',
    group: 'App',
    shortcut: 'Ctrl+,',
    candidate: {
      name: 'Settings',
      // The cog in the top bar is gone, so this is the way in: worth matching
      // the names of the things inside the dialog too.
      keywords: 'preferences options config font size page cap confirm system theme',
    },
    run: () => s.setDialog({ kind: 'settings' }),
  })

  const fontKeywords = 'font size text zoom bigger smaller larger appearance'
  if (s.settings.fontSizePx < FONT_SIZE_MAX) {
    cmds.push({
      id: 'app:font:increase',
      title: 'Increase font size',
      group: 'App',
      shortcut: 'Ctrl+=',
      candidate: { name: 'Increase font size', keywords: fontKeywords },
      run: () => s.adjustFontSize(1),
    })
  }
  if (s.settings.fontSizePx > FONT_SIZE_MIN) {
    cmds.push({
      id: 'app:font:decrease',
      title: 'Decrease font size',
      group: 'App',
      shortcut: 'Ctrl+-',
      candidate: { name: 'Decrease font size', keywords: fontKeywords },
      run: () => s.adjustFontSize(-1),
    })
  }

  if (s.settings.fontSizePx !== FONT_SIZE_DEFAULT) {
    cmds.push({
      id: 'app:font:reset',
      title: 'Reset font size',
      group: 'App',
      shortcut: 'Ctrl+0',
      candidate: { name: 'Reset font size', keywords: fontKeywords },
      run: () => s.resetFontSize(),
    })
  }

  // One per theme rather than a "change theme" that opens the dialog. Switching
  // is the entire action, it is instant, and typing "gruv" should do it — going
  // by way of a modal to click a swatch is the slower path for the person who
  // already knows which one they want.
  for (const t of THEMES) {
    if (t.id === s.settings.theme) continue
    cmds.push({
      id: `app:theme:${t.id}`,
      title: `Theme: ${t.name}`,
      subtitle: t.note,
      group: 'App',
      candidate: { name: t.name, keywords: `theme colour color palette appearance ${t.id}` },
      run: () => void s.saveSettings({ ...s.settings, theme: t.id }),
    })
  }

  cmds.push({
    id: 'help:shortcuts',
    title: 'Keyboard shortcuts',
    group: 'App',
    candidate: { name: 'Keyboard shortcuts', keywords: 'keys bindings help' },
    run: () => s.setDialog({ kind: 'shortcuts' }),
  })

  // Unconditional, and last: reaching for this means something is already
  // wrong, and it should never be the thing that is missing.
  cmds.push({
    id: 'app:reload',
    title: 'Reload the app',
    subtitle: 'Keeps connections — they live in the Go process',
    group: 'App',
    shortcut: 'Ctrl+Shift+R',
    candidate: { name: 'Reload the app', keywords: 'restart refresh stuck frozen crash wedged' },
    run: () => window.location.reload(),
  })

  return cmds
}

/**
 * Row editing. Context-aware: the cell commands need an editable table with a
 * cell selected, and the change-set commands only exist while something is
 * staged. Accept and Preview are one action — both open the review — and only
 * the dialog's Run button writes.
 */
function buildEditCommands(s: Store): Command[] {
  const cmds: Command[] = []
  const add = (
    id: string,
    title: string,
    keywords: string,
    run: () => void | Promise<void>,
    shortcut?: string,
    subtitle?: string,
  ) =>
    cmds.push({
      id: `edit:${id}`,
      title,
      subtitle,
      group: 'Edit',
      shortcut,
      candidate: { name: title, keywords: `edit row cell change ${keywords}` },
      run,
    })

  const grid = s.view === 'data' && !!s.activeRef && !!s.result
  const editable = grid && !s.readOnlyReason && s.editKey.length > 0
  const cellSelected = editable && s.selection?.source === 'browse'

  if (cellSelected) {
    add(
      'cell',
      'Edit cell',
      'modify type value',
      () => s.startEdit(),
      'F2',
      'Stages the change; nothing is written until you accept',
    )
    add(
      'cell-large',
      'Edit cell in large editor',
      'big json document modal long text',
      () => s.startEdit(true),
      'Shift+F2',
      'Line numbers, wrapping and JSON tools, for a value too big for the cell',
    )
    add('null', 'Set to NULL', 'null clear empty', () => s.setSelectionNull(), 'Ctrl+Backspace')
    if (s.capabilities?.setToDefault) {
      add('default', 'Set to default', 'default reset', () => s.setSelectionDefault())
    }
  }
  if (editable) add('insert-row', 'Insert row', 'add new', () => s.insertRow())
  if (cellSelected) {
    const rows = rectSize(rectOf(s.selection!)).rows
    const title = rows === 1 ? 'Delete row' : `Delete ${rows} rows`
    add('delete-row', title, 'remove', () => s.deleteRows())
  }

  const staged = s.stagedSummary.total
  if (staged > 0) {
    if (s.staged.past.length > 0) {
      add('undo', 'Undo last staged edit', 'revert back', () => s.undoEdit(), 'Ctrl+Z')
    }
    const review = 'Builds the SQL and shows every statement — runs nothing until you press Run'
    const go = () => s.reviewChanges()
    add(
      'next-table',
      'Go to next changed table',
      'staged pending dirty jump',
      () => s.goToChangedTable(),
      undefined,
      `${s.stagedSummary.tables} table${s.stagedSummary.tables === 1 ? ' has' : 's have'} staged changes`,
    )
    add('accept', 'Accept changes', 'save commit apply write', go, 'Ctrl+S', review)
    add('preview', 'Preview changes', 'sql statements review show', go, undefined, review)
    add('discard', 'Discard changes', 'drop throw away cancel reset', () => s.discardChanges())
  }
  return cmds
}

/** The filter editor owns this id, for `aria` wiring and for tests. */
export const FILTER_INPUT_ID = 'row-filter-input'

/**
 * Focusing the filter goes through a registered callback rather than the DOM.
 *
 * The filter is a CodeMirror editor, not an `<input>`, so `el.focus()` on the
 * container would land on a div and `el.select()` does not exist. The editor
 * registers its own handle here on mount, and the hotkey and the palette both
 * call through it.
 */
let filterFocus: (() => void) | null = null

export function registerFilterFocus(fn: (() => void) | null) {
  filterFocus = fn
}

export function focusFilter() {
  filterFocus?.()
}

/** The editor's database picker owns this id — see components/DatabasePicker.tsx. */
export const DATABASE_PICKER_ID = 'database-picker'

/**
 * Unlike the filter, this one is a real `<select>`, so the DOM is enough and no
 * registration handle is needed.
 */
export function focusDatabasePicker() {
  document.getElementById(DATABASE_PICKER_ID)?.focus()
}

export function describeConnection(kind: string, host?: string, file?: string): string {
  if (kind === 'sqlite') return file ? shortenPath(file) : 'sqlite'
  return `${kind} · ${host || 'localhost'}`
}

function shortenPath(p: string): string {
  const parts = p.split(/[\\/]/)
  return parts.length <= 2 ? p : `…/${parts.slice(-2).join('/')}`
}

export function formatCount(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
  return `${(n / 1_000_000).toFixed(1)}m`
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const mins = Math.floor(ms / 60_000)
  return `${mins}m ${Math.round((ms % 60_000) / 1000)}s`
}

/**
 * Show, Hide and Toggle for one pane. Every pane gets the same three so the
 * palette answers "hide the left pane" the same way for each, and Show / Hide
 * only appear when they would do something. A pane with no content yet (there
 * is no right or top pane) gets none: a command that toggles nothing is noise.
 */
function paneCommands(p: {
  id: string
  label: string
  what: string
  open: boolean
  set: (open: boolean) => void
  shortcut: string
  keywords: string
}): Command[] {
  const keywords = `pane panel show hide toggle ${p.id} ${p.what} ${p.keywords}`
  const cmds: Command[] = [
    {
      id: `pane:${p.id}:toggle`,
      title: `Toggle ${p.label}`,
      subtitle: p.what,
      group: 'Panes',
      shortcut: p.shortcut,
      candidate: { name: `Toggle ${p.label}`, keywords },
      run: () => p.set(!p.open),
    },
  ]
  cmds.push(
    p.open
      ? {
          id: `pane:${p.id}:hide`,
          title: `Hide ${p.label}`,
          subtitle: p.what,
          group: 'Panes',
          candidate: { name: `Hide ${p.label}`, keywords },
          run: () => p.set(false),
        }
      : {
          id: `pane:${p.id}:show`,
          title: `Show ${p.label}`,
          subtitle: p.what,
          group: 'Panes',
          candidate: { name: `Show ${p.label}`, keywords },
          run: () => p.set(true),
        },
  )
  return cmds
}
