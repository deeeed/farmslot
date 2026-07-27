import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const requireFromCommandCenter = createRequire(
  new URL('./apps/command-center/package.json', import.meta.url),
);
const tsconfigRootDir = dirname(fileURLToPath(import.meta.url));

const js = requireFromCommandCenter('@eslint/js');
const prettier = requireFromCommandCenter('eslint-config-prettier');
const simpleImportSort = requireFromCommandCenter('eslint-plugin-simple-import-sort');
const globals = requireFromCommandCenter('globals');
const tseslint = requireFromCommandCenter('typescript-eslint');

const sourceFiles = ['**/*.{js,mjs,cjs,ts,tsx}'];
const jsFiles = ['**/*.{js,mjs,cjs}'];
const tsFiles = ['**/*.{ts,tsx}'];
const unusedOptions = {
  argsIgnorePattern: '^_',
  caughtErrorsIgnorePattern: '^_',
  varsIgnorePattern: '^_',
};

export default [
  {
    ignores: [
      '**/.git/**',
      '.worktrees/**',
      // Agent-tool worktrees checked out inside the repo: their files are
      // other branches' code and must not feed the lint ratchet.
      '.claude/**',
      '.agent/**',
      '.artifact-cache/**',
      // Vendored clones of other repos (ensure-skills-local.sh caches the skills
      // CLI here inside worker repos). Their files belong to another project and
      // must never be autofixed: a `lint:fix` here rewrote three files in a
      // MetaMask/skills checkout.
      '.skills-cache/**',
      '**/.yarn/**',
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      '**/probes/**',
      'apps/command-center/ui/dist/**',
      'apps/docs/build/**',
      'apps/docs/.docusaurus/**',
      'apps/companion/.expo/**',
      'apps/companion/android/**',
      'apps/companion/ios/**',
      '.farm-cache/**',
      '.omc/**',
      '.omx/**',
      '.runs/**',
      '.sandbox/**',
      'projects/**',
      '~/**',
    ],
  },
  {
    ...js.configs.recommended,
    files: sourceFiles,
  },
  ...tseslint.configs.recommended.map((config) => ({
    ...config,
    files: tsFiles,
  })),
  {
    files: sourceFiles,
    languageOptions: {
      parserOptions: {
        ecmaFeatures: { jsx: true },
        sourceType: 'module',
        tsconfigRootDir,
      },
      globals: {
        ...globals.browser,
        ...globals.node,
        fetch: 'readonly',
        WebSocket: 'readonly',
      },
    },
    plugins: {
      '@typescript-eslint': tseslint.plugin,
      'simple-import-sort': simpleImportSort,
    },
    rules: {
      '@typescript-eslint/ban-ts-comment': 'off',
      '@typescript-eslint/no-empty-object-type': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-require-imports': 'off',
      '@typescript-eslint/no-unused-expressions': 'off',
      'no-control-regex': 'off',
      'no-empty': ['error', { allowEmptyCatch: false }],
      'no-useless-assignment': 'off',
      'no-useless-catch': 'error',
      'no-useless-escape': 'off',
      'prefer-const': 'off',
      'preserve-caught-error': 'off',
      'simple-import-sort/exports': 'error',
      'simple-import-sort/imports': [
        'error',
        {
          groups: [
            ['^node:'],
            ['^@?\\w'],
            ['^@farmslot/'],
            ['^\\u0000'],
            ['^\\.\\.(?!/?$)', '^\\.\\./?$'],
            ['^\\./(?=.*/)(?!/?$)', '^\\.(?!/?$)', '^\\./?$'],
          ],
        },
      ],
    },
  },
  {
    files: jsFiles,
    rules: {
      'no-unused-vars': ['error', unusedOptions],
    },
  },
  {
    files: tsFiles,
    rules: {
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': ['error', unusedOptions],
    },
  },
  {
    files: [
      'apps/companion/src/**/*.{js,mjs,cjs,ts,tsx}',
      'apps/docs/**/*.{js,mjs,cjs,ts,tsx}',
      'packages/*/src/**/*.{js,mjs,cjs,ts,tsx}',
      'scripts/**/*.{js,mjs,cjs,ts,tsx}',
      'services/*/src/**/*.{js,mjs,cjs,ts,tsx}',
    ],
    rules: {
      'no-duplicate-imports': [
        'error',
        {
          allowSeparateTypeImports: false,
        },
      ],
    },
  },
  prettier,
];
