import js from '@eslint/js';
import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';

const baseGlobals = {
  console: 'readonly',
  process: 'readonly',
};

const workerGlobals = {
  ...baseGlobals,
  Request: 'readonly',
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
};

export default [
  {
    ignores: ['**/node_modules/**', '**/dist/**', '**/.wrangler/**', 'pnpm-lock.yaml'],
  },
  js.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
      },
      globals: baseGlobals,
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
    },
    rules: {
      ...tsPlugin.configs.recommended.rules,
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    files: ['apps/worker/**/*.{ts,tsx}'],
    languageOptions: {
      globals: workerGlobals,
    },
  },
];
