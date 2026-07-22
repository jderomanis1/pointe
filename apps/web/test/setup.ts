import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// jsdom does not implement window.matchMedia — stub it so components that
// gate animation on prefers-reduced-motion don't crash in unit tests.
if (typeof window !== 'undefined' && !window.matchMedia) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

// Vitest globals are off; cleanup() is opt-in. Guarded so pure node tests
// (reducer, wsClient) where document doesn't exist still pass.
afterEach(() => {
  if (typeof document !== 'undefined') cleanup();
});
