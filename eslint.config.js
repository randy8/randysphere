import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import tseslint from 'typescript-eslint';

// Formatting is Prettier's job and is not represented here at all. The rules
// below are limited to things a type checker and a formatter cannot catch.
//
// Support for .astro files is added in the same change that introduces the
// first .astro file, not before it.
export default defineConfig([
  globalIgnores(['originals/', 'generated/', '**/dist/', '**/.astro/', '**/.wrangler/']),

  {
    files: ['**/*.{js,mjs,ts}'],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
    },
    rules: {
      // Comparing against null with == is idiomatic and covers undefined too.
      // Everywhere else, loose equality hides bugs behind coercion.
      eqeqeq: ['error', 'always', { null: 'ignore' }],
    },
  },

  {
    files: ['**/*.ts'],
    extends: [tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: {
          // pipeline.config.ts sits at the repo root, outside every
          // directory a tsconfig.json lives in. tools/pipeline/tsconfig.json
          // already lists it under `include` (so `tsc -p tools/pipeline`
          // type-checks it), but the project service's directory-based
          // discovery never looks there — it needs the file named
          // explicitly here instead.
          allowDefaultProject: ['pipeline.config.ts'],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Node erases `import type` declarations without reading them. An import
      // that carries only types but is written as a value import survives
      // erasure and fails at runtime looking for a module that exports nothing.
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },

  {
    // node:test's test() returns a promise that resolves when the test
    // finishes, but the idiomatic pattern is a bare top-level call per test —
    // `node --test` itself drives completion and failure reporting, not the
    // return value. Awaiting each call would only serialize tests within a
    // file for no benefit.
    files: ['**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-floating-promises': 'off',
    },
  },

  {
    // The editor's frontend is plain, unbundled browser JS — no build step,
    // so no bundler-provided globals either. Listed by hand rather than
    // pulling in the `globals` package for a handful of DOM/fetch names (see
    // docs/dependencies.md's bar for adding a dependency).
    files: ['tools/pipeline/src/editor/static/**/*.js'],
    languageOptions: {
      globals: {
        document: 'readonly',
        window: 'readonly',
        fetch: 'readonly',
        confirm: 'readonly',
        CSS: 'readonly',
        getComputedStyle: 'readonly',
        setTimeout: 'readonly',
        console: 'readonly',
      },
    },
  },

  {
    files: ['tools/**/*.ts'],
    rules: {
      // The pipeline is supposed to survive the site being rewritten in
      // something other than Astro. That promise is worth nothing unless it is
      // enforced, and it will be broken by accident on a Tuesday otherwise.
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                'astro',
                'astro/*',
                'astro:*',
                '@astrojs/*',
                'vite',
                'vite/*',
                'tailwindcss',
                'tailwindcss/*',
              ],
              message:
                'tools/ must not depend on the website framework. Move this code into site/, or pass the value in as an argument.',
            },
          ],
        },
      ],
    },
  },
]);
