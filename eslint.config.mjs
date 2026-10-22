// Official Obsidian plugin guidelines (https://github.com/obsidianmd/eslint-plugin).
// Not a dev dependency (keeps the release build offline-reproducible); run it with:
//   npm i --no-save eslint@9 eslint-plugin-obsidianmd typescript-eslint && npx eslint .
// CI runs it on every push: .github/workflows/audit.yml
import { defineConfig } from 'eslint/config';
import obsidianmd from 'eslint-plugin-obsidianmd';

export default defineConfig([
  {
    ignores: ['main.js', 'build/**', 'release/**', 'experiments/**', 'tests/**', 'scripts/**', 'vendor/**', 'local-assets/**', 'node_modules/**', 'docs/**', 'test-output/**', 'test-vault/**', 'src/**/*.generated.ts', 'src/**/*.mjs', 'package-lock.json'],
  },
  ...obsidianmd.configs.recommended,
  {
    languageOptions: {
      // build-time edition flag (esbuild define, scripts/edition.mjs; declared in src/edition/globals.d.ts)
      globals: { __HN_PRIVATE__: 'readonly' },
      parserOptions: {
        projectService: {
          allowDefaultProject: ['eslint.config.*'],
        },
      },
    },
  },
]);
