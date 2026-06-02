import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// Vitest globals are off; cleanup() is opt-in. Guarded so pure node tests
// (reducer, wsClient) where document doesn't exist still pass.
afterEach(() => {
  if (typeof document !== 'undefined') cleanup();
});
