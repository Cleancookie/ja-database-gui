import { useStore } from "../store";

const KBD =
  "rounded-lg border border-[var(--color-border-strong)] px-1.5 font-normal";

/** What the main panel shows while a bound tab has no table open: where to go from here. */
export function EmptyPanel() {
  const sidebarHidden = useStore((s) => s.settings.tabStripHidden);
  const hints: [string, string][] = [
    ["Ctrl+L", "search the tables in the sidebar"],
    ["Ctrl+P", "jump to a table"],
    ["Ctrl+E", "write SQL"],
    ["Ctrl+T", "open another database in a new tab"],
  ];
  return (
    <div className="chrome flex h-full flex-col items-center justify-center gap-4 px-4 text-[var(--color-muted)]">
      <h1 className="font-bold text-[var(--color-text)]">
        Pick a table in the sidebar
      </h1>
      {sidebarHidden && (
        <p>
          The sidebar is hidden — <kbd className={KBD}>Ctrl+B</kbd> shows it
        </p>
      )}
      <ul className="flex flex-col gap-1.5">
        {hints.map(([key, what]) => (
          <li key={key} className="flex items-center gap-3">
            <kbd className={`${KBD} min-w-20 shrink-0 text-center`}>{key}</kbd>
            {what}
          </li>
        ))}
      </ul>
    </div>
  );
}
