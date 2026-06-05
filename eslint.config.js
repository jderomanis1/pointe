import js from '@eslint/js';
import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';

const baseGlobals = {
  console: 'readonly',
  process: 'readonly',
};

const workerGlobals = {
  ...baseGlobals,
  AbortController: 'readonly',
  AbortSignal: 'readonly',
  Request: 'readonly',
  RequestInit: 'readonly',
  Response: 'readonly',
  Headers: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
  fetch: 'readonly',
  crypto: 'readonly',
  caches: 'readonly',
  ExecutionContext: 'readonly',
  DurableObjectNamespace: 'readonly',
  DurableObjectState: 'readonly',
  MessageEvent: 'readonly',
  Promise: 'readonly',
  SqlStorage: 'readonly',
  WebSocket: 'readonly',
  WebSocketPair: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
};

const browserGlobals = {
  ...baseGlobals,
  window: 'readonly',
  document: 'readonly',
  navigator: 'readonly',
  localStorage: 'readonly',
  sessionStorage: 'readonly',
  crypto: 'readonly',
  WebSocket: 'readonly',
  fetch: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
  Request: 'readonly',
  Response: 'readonly',
  Headers: 'readonly',
  HTMLElement: 'readonly',
  HTMLInputElement: 'readonly',
  HTMLButtonElement: 'readonly',
  Element: 'readonly',
  Event: 'readonly',
  CustomEvent: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  requestAnimationFrame: 'readonly',
  cancelAnimationFrame: 'readonly',
};

export default [
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      // S10.i — wrangler dry-run prod bundle, playwright artifacts.
      '**/.dist-prod/**',
      '**/playwright-report/**',
      '**/test-results/**',
      '**/.wrangler/**',
      '**/.mf/**',
      'pnpm-lock.yaml',
      'spec/**',
    ],
  },
  js.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
        ecmaFeatures: { jsx: true },
      },
      globals: baseGlobals,
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
    },
    rules: {
      ...tsPlugin.configs.recommended.rules,
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
      }],
    },
  },
  {
    files: ['apps/worker/**/*.{ts,tsx}'],
    languageOptions: {
      globals: workerGlobals,
    },
  },
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    languageOptions: {
      globals: browserGlobals,
    },
  },
  // S10.i — Playwright E2E suite. Tests run in a Node + Chromium pair;
  // the spec files themselves are Node code that drives the browser,
  // so the Node globals (URL, console) plus Playwright's test/expect.
  // Browser globals (document, getComputedStyle, HTMLElement, …) are
  // allowed because `page.evaluate(() => { … })` runs its callback in
  // the page context — the reference is in source but the call site is
  // the browser. Tagged as readonly to keep lint signal on misuse.
  {
    files: ['e2e/**/*.ts'],
    languageOptions: {
      globals: {
        ...baseGlobals,
        URL: 'readonly',
        document: 'readonly',
        getComputedStyle: 'readonly',
        HTMLElement: 'readonly',
        HTMLInputElement: 'readonly',
        HTMLButtonElement: 'readonly',
      },
    },
  },
];
