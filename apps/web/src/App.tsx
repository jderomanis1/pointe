import { getTheme, setTheme, type ThemeChoice } from './theme';

export function App() {
  const current = getTheme();
  const next: ThemeChoice = current === 'dark' ? 'light' : 'dark';
  return (
    <main className="bg-bg min-h-screen p-12">
      <div className="bg-surface border-hairline border rounded-lg shadow-card max-w-xl mx-auto p-8">
        <h1 className="font-serif text-heading text-text">Pointe</h1>
        <p className="font-sans text-body text-text-muted mt-2">
          Planning poker that respects your team&apos;s time and judgment.
        </p>
        <p className="font-mono text-num text-accent mt-4">13</p>
        <button
          type="button"
          onClick={() => { setTheme(next); window.location.reload(); }}
          className="bg-accent text-accent-ink rounded-md px-4 py-2 mt-6 font-sans text-small"
        >
          Switch to {next}
        </button>
      </div>
    </main>
  );
}
