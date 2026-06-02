import { useState } from 'react';
import { Moon, Sun } from 'lucide-react';
import { setTheme } from '../../theme';
import { cn } from '../../lib/cn';

function effective(): 'light' | 'dark' {
  if (typeof document === 'undefined') return 'light';
  return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
}

export function ThemeToggle({ className }: { className?: string }) {
  const [t, setT] = useState<'light' | 'dark'>(effective());
  const next = t === 'dark' ? 'light' : 'dark';
  return (
    <button
      type="button"
      aria-label={`Switch to ${next} theme`}
      onClick={() => { setTheme(next); setT(next); }}
      className={cn(
        'inline-flex h-8 w-8 items-center justify-center rounded-md',
        'text-text-secondary hover:text-text hover:bg-fill transition-colors duration-fast',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
        className,
      )}
    >
      {t === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
    </button>
  );
}
