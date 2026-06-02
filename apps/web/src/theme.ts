export type ThemeChoice = 'light' | 'dark' | 'system';
const STORAGE_KEY = 'pointe:theme';

function systemPrefersDark(): boolean {
  return typeof window !== 'undefined'
    && window.matchMedia('(prefers-color-scheme: dark)').matches;
}

function apply(choice: ThemeChoice): void {
  const effective = choice === 'system' ? (systemPrefersDark() ? 'dark' : 'light') : choice;
  document.documentElement.setAttribute('data-theme', effective);
}

export function getTheme(): ThemeChoice {
  const stored = localStorage.getItem(STORAGE_KEY) as ThemeChoice | null;
  return stored ?? 'system';
}

export function setTheme(choice: ThemeChoice): void {
  if (choice === 'system') localStorage.removeItem(STORAGE_KEY);
  else localStorage.setItem(STORAGE_KEY, choice);
  apply(choice);
}

export function initTheme(): void { apply(getTheme()); }
