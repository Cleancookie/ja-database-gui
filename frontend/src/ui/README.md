# src/ui — the component adapter layer

**This directory is the only place in the app allowed to import a component
library.** Everything else imports from `@/ui` (or `../ui`) and sees our own
API, never the vendor's.

The point is that swapping libraries — or dropping back to hand-rolled — means
rewriting the files in this folder and touching nothing else. If a Radix type,
prop name or `asChild` idiom leaks into a component outside this directory,
that guarantee is gone.

## What is here

| File | Wraps | Why not hand-rolled |
| --- | --- | --- |
| `Dialog.tsx` | `@radix-ui/react-dialog` | Focus trap, focus restore on close, scroll lock, `aria-modal` wiring, Escape and outside-click handling. `Layer` lends the same to a hand-drawn overlay (the palette) so it stacks over a dialog |
| `Menu.tsx` | `@radix-ui/react-context-menu` | Arrow-key navigation, typeahead, collision-aware positioning, focus return to the trigger |
| `Editor.tsx` | `@codemirror/*` | A completion popup with its own keyboard handling and positioning, dialect-aware SQL tokenising, undo history, and room for error squiggles later |
| `CodeEditor.tsx` | `@codemirror/*` | Editing a value of several megabytes: the document stays in CodeMirror's state and is read once on stage, where a controlled `value` would copy it into React per keystroke. Line numbers, wrapping, JSON highlighting |

### Why CodeMirror and not Monaco

Monaco is the better-known answer and was rejected on cost. It is measured in
megabytes against a bundle that was 124 kB gzipped, and it wants a web worker,
which is awkward when assets are embedded in a Wails binary. CodeMirror 6 is
modular enough to pay only for what is imported, needs no worker, and ships
real per-dialect SQL support.

It is still the largest dependency in the app — **+120 kB gzipped** — which is
worth knowing before adding more of it.

It is therefore **loaded on demand**, via `LazyEditor.tsx`, and `ui/index.ts`
exports that wrapper rather than `Editor.tsx` itself. Importing the real one
from anywhere eager puts CodeMirror back in the startup bundle and undoes the
split. This matters more than it first appears: at launch *neither* surface
that uses the editor is mounted — the filter bar renders only once a table is
open, the SQL editor only on the SQL view — so eager loading made every launch
pay for something many sessions never touch. With the split, the startup chunk
is 126 kB gzipped against 124 kB before the editor existed.

The narrow API is `value`, `onChange`, `onSubmit`, `onCancel`, `singleLine`,
`dialect` and `completion` — no CodeMirror type is exported, and the app's
completion candidates (`src/completion.ts`) are plain data with no editor API
in them, so they are unit-tested without a DOM and would survive a swap.

## What is deliberately NOT here

- **The command palette.** Its ranking (`src/fuzzy.ts`) is the core of the app
  and is tuned against a real failure case. `cmdk` would replace it with its own
  matcher.
- **The data grid.** Virtualised and performance-critical.
- **The JSON tree** (`src/components/JsonView.tsx`). Hand-rolled,
  against tens of kilobytes and a theme to fight for any of the viewer
  libraries. There is no vendor API to quarantine, so there is nothing for this
  layer to do.
- **`<select>` and `<input type="checkbox">`.** Native elements are already
  keyboard-accessible and correct. Replacing them buys styling control we do
  not currently need, at the cost of a lot of JavaScript.

## Adding to this layer

Expose the smallest API the app actually needs, not the library's full surface.
`Dialog` takes `title`, `footer` and children — not a dozen Radix subcomponents —
because a narrow API is what makes the next swap cheap.
