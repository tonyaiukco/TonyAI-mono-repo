import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import { importX } from 'eslint-plugin-import-x';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

/**
 * The repo had no linter at all until this file — every workspace's `lint`
 * script was `echo … && exit 0`.
 *
 * ONE ROOT CONFIG, not four. The rules worth having here are the ARCHITECTURE
 * rules in `CLAUDE.md`, and those are inherently cross-workspace ("`apps/web`
 * must not import `apps/api`"; "a feature module must not reach into
 * `reports/`"). Four per-workspace configs would make the rule this file exists
 * for inexpressible.
 *
 * SEVERITY WAS MEASURED, NOT GUESSED. Every rule below at `error` was run
 * against the codebase first and lands green or with a counted, fixed set of
 * violations. The stylistic and type-checked families that would produce
 * hundreds of findings (`no-unsafe-*`, `no-floating-promises`, `import/order`)
 * are deliberately deferred: a linter that ships red teaches everyone to ignore
 * it, and `import/order` alone would rewrite the import block of all 266 files.
 */

/** Mirrors `.gitignore` plus the generated trees no rule should read. */
const IGNORES = [
  '**/node_modules/**',
  '**/dist/**',
  '**/.next/**',
  '**/.turbo/**',
  '**/.claude/worktrees/**',
  '**/.codex/worktrees/**',
  '**/.worktrees/**',
  'worktrees/**',
  'packages/db/generated/**',
  'coverage/**',
  'playwright-report/**',
  'test-results/**',
  'apps/web/next-env.d.ts',
  'supabase/.branches/**',
  'supabase/.temp/**',
];

export default tseslint.config(
  { ignores: IGNORES },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    // `@tonyai/*` resolves through `packages/db`'s `main`, which points at
    // Prisma's generated client — so lint needs `^build` to have run, exactly
    // like typecheck does. That dependency is declared in `turbo.json`.
    plugins: { 'import-x': importX },
    settings: {
      'import-x/resolver': { typescript: true, node: true },
    },
    rules: {
      /**
       * THE PAYLOAD. A previous PR moved a CSV cell helper to
       * `apps/api/src/common/csv-cell.ts` specifically so that a future
       * bulk-upload module would not import from `apps/api/src/reports/` — and
       * until this rule existed, the only thing enforcing that was a comment.
       *
       * The repo had exactly one real cycle when this was measured
       * (`audit.service` <-> its DTO, a runtime value read inside a `@Max()`
       * decorator); it was broken in its own PR so this could land green.
       */
      'import-x/no-cycle': ['error', { maxDepth: Infinity, ignoreExternal: true }],

      // TypeScript already resolves identifiers, and `no-undef` in a TS file
      // reports on types it does not understand. Kept ON for the `.mjs`
      // scripts below, which have no compiler behind them.
      'no-undef': 'off',

      // Zero sites in TypeScript when measured, and the API has a real logger
      // convention (`observability/json-logger.ts`) this protects. The
      // operational `.mjs` scripts print to a terminal and are exempt below.
      'no-console': 'error',

      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          // `_`-prefixed identifiers are this repo's COMPILE-TIME ASSERTION
          // idiom, not dead code: `_numericParity` in `report-columns.ts` and
          // `_UpdateMirrorsCreate` in the subsidiary DTO spec are types whose
          // only job is to fail `tsc`. Reporting them would delete the checks.
          varsIgnorePattern: '^_',
          argsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],

      // Both real directives in the repo carry a description; this keeps that
      // true, and keeps `@ts-ignore` (zero sites) unusable.
      '@typescript-eslint/ban-ts-comment': [
        'error',
        { 'ts-expect-error': 'allow-with-description' },
      ],

      /**
       * A deliberate idiom, left alone. 103 sites, most of them the
       * `c.csv!.cell` pattern the report column vocabulary is built on, where
       * the predicate and the accessor are coupled by design. Turning this on
       * would be arguing with the architecture, not finding defects.
       */
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },

  // --- Architecture rules ----------------------------------------------------
  //
  // Every one of these was measured at ZERO violations before being written.
  // They lock in a state the repo already holds by discipline; none of them is
  // a migration.

  {
    files: ['apps/api/src/common/**/*.ts'],
    rules: {
      // `common/` is a leaf. It imports `@tonyai/db` and `@nestjs/common` and
      // nothing else in the app — anything reaching UP into a feature module
      // from here is the cycle this whole config exists to prevent.
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['../*', '..'],
              message:
                'apps/api/src/common is a leaf: it must not import from a feature module. Move the shared thing here instead.',
            },
          ],
        },
      ],
    },
  },

  {
    files: ['apps/api/src/**/*.ts'],
    ignores: ['apps/api/src/reports/**', 'apps/api/src/app.module.ts'],
    rules: {
      // `reports/` is a pure sink — only `app.module.ts` wires it. Bulk upload
      // (WP8) must reuse `common/csv-cell.ts`, NOT reach into the report
      // writer; this is the rule that says so.
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/reports/**', '*/reports', '../reports'],
              message:
                'apps/api/src/reports is a sink: nothing but app.module.ts may import it. Shared helpers belong in src/common.',
            },
          ],
        },
      ],
    },
  },

  {
    files: ['apps/web/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@tonyai/db', '@prisma/client', '**/apps/api/**'],
              message:
                'The frontend never touches the database or the API source. Go through apps/web/lib/api.ts.',
            },
          ],
        },
      ],
    },
  },

  {
    // The CLAUDE.md rule "frontend -> backend only through lib/api.ts", made
    // machine-checkable. `lib/` is exempt because the client itself lives
    // there; measured at zero violations outside it.
    files: ['apps/web/app/**/*.{ts,tsx}', 'apps/web/components/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.name='fetch']",
          message:
            'No raw fetch in a page or component — every call goes through apps/web/lib/api.ts.',
        },
        {
          selector: "Literal[value=/^https?:\\/\\//]",
          message:
            'No hardcoded URLs in a page or component — the API base URL lives in apps/web/lib/api.ts.',
        },
      ],
    },
  },

  {
    files: ['packages/shared-types/**/*.ts'],
    rules: {
      // The single source of truth is a LEAF: it imports nothing, which is what
      // lets both apps depend on it without either dragging the other in.
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@tonyai/*', '@prisma/*'],
              message:
                'shared-types is the leaf every other package depends on; it must not import one of them.',
            },
          ],
        },
      ],
    },
  },

  // --- React -----------------------------------------------------------------

  {
    files: ['apps/web/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      // Warn, matching React's own default. Nine sites carry a deliberate
      // suppression comment; those comments were inert before this plugin was
      // registered, and registering it is what makes them mean something again.
      'react-hooks/exhaustive-deps': 'warn',
    },
  },

  {
    // shadcn-generated primitives. Linted rather than ignored — they are 57 of
    // the web workspace's 122 files, and ignoring them would blind the
    // architecture rules across half the frontend — but held to a lower bar on
    // the stylistic rules, since they are vendored code we do not author.
    files: ['apps/web/components/ui/**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
      'react-hooks/exhaustive-deps': 'off',
      'no-restricted-syntax': 'off',
    },
  },

  // --- Tests -----------------------------------------------------------------

  {
    files: ['**/*.spec.ts', '**/*.spec.tsx', 'e2e/**/*.ts', 'playwright.config.ts'],
    rules: {
      // 59 of the repo's 61 `any` sites are mock objects in specs. Fighting
      // them buys nothing: a mock is a lie about a type on purpose.
      '@typescript-eslint/no-explicit-any': 'off',
      'no-restricted-syntax': 'off',
      'no-restricted-imports': 'off',
    },
  },

  {
    // `apps/api`'s vitest sets `globals: true`; `apps/web`'s does not, so its
    // specs import from `vitest` explicitly and need nothing here.
    files: ['apps/api/**/*.spec.ts', 'packages/**/*.spec.ts'],
    languageOptions: { globals: globals.node },
  },

  {
    // Mirrors `tsconfig.e2e.json`'s include exactly, so lint and typecheck
    // cover an identical set. Playwright's `page.evaluate` bodies run in a
    // browser, which is why the DOM globals are here.
    files: ['e2e/**/*.ts', 'playwright.config.ts'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },

  // --- Operational scripts ---------------------------------------------------

  {
    // The seed and the operational scripts are CLI programs — their terminal
    // output IS their interface, not a stray debug statement.
    files: ['packages/db/prisma/**/*.ts', 'packages/db/scripts/**/*.ts'],
    rules: { 'no-console': 'off' },
  },

  {
    // shadcn generates these two alongside `components/ui`, and ships
    // `use-toast.ts` twice (the copy under `components/ui` has no importer at
    // all). Same vendored status, same relaxed bar.
    files: ['apps/web/hooks/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
      'react-hooks/exhaustive-deps': 'off',
    },
  },

  {
    files: ['**/*.mjs'],
    languageOptions: { globals: globals.node, sourceType: 'module' },
    rules: {
      // These print to a terminal; that IS their interface.
      'no-console': 'off',
      'no-undef': 'error',
    },
  },
);
