import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import prettier from 'eslint-config-prettier';

const LEDGER_WRITE_ALLOWLIST = [
  'src/actions/executor.ts',
  'src/storage/bootstrap.ts',
  'src/storage/ledger-writes.ts',
];

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'coverage/**',
      'node_modules/**',
      'playwright-report/**',
      'test-results/**',
      'fixtures/seed/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
      globals: { ...globals.browser, ...globals.node },
    },
  },
  {
    files: ['**/*.js', '**/*.mjs'],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    files: ['**/*.tsx', 'src/ui/**/*.ts'],
    ...reactHooks.configs.flat.recommended,
  },
  {
    files: ['src/ui/**/*.{ts,tsx}'],
    ...reactRefresh.configs.vite,
  },
  {
    // LED-3 / PRD Section 6: ledger tables may only be written by the action executor.
    files: ['src/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/storage/ledger-writes', '**/storage/ledger-writes.js', '**/ledger-writes'],
              message:
                'LED-3: only src/actions/executor.ts (ledger changes) and src/storage/bootstrap.ts (initial data load) may import the ledger write API.',
            },
          ],
        },
      ],
    },
  },
  {
    files: LEDGER_WRITE_ALLOWLIST,
    rules: { 'no-restricted-imports': 'off' },
  },
  {
    files: ['**/*.test.ts', '**/*.test.tsx', 'tests/**/*.ts', 'scripts/**/*.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
    },
  },
  prettier,
);
