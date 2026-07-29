import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import tseslint from 'typescript-eslint';

// Formatting is Prettier's job and is not represented here at all. The rules
// below are limited to things a type checker and a formatter cannot catch.
//
// Support for .astro files is added in the same change that introduces the
// first .astro file, not before it.
export default defineConfig([
  globalIgnores([
    'originals/',
    'generated/',
    '**/dist/',
    '**/.astro/',
    '**/.wrangler/',
  ]),

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
        projectService: true,
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
