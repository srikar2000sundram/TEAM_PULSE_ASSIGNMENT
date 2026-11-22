import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * Architecture rules (ADR-0002, ADR-0003) are enforced here, not only in review:
 * - the domain and application layers must not import frameworks, drivers or the AWS SDK;
 * - one service must never import another service's code or package.
 */
const infrastructureImports = [
  'fastify',
  'fastify/*',
  '@fastify/*',
  'pg',
  'pg/*',
  'postgres',
  '@aws-sdk/*',
  'aws-lambda',
  '**/adapters/**',
];

const crossServiceMessage =
  'Do not import another service. Share code via packages/* or integrate via events and APIs.';

// In source files, an import of a `src` or `dist` folder can only be leaving the current service
// (imports inside a service never contain those segments).
const serviceIsolationPattern = {
  group: ['**/src/**', '**/dist/**', '@teampulse/svc-*', '@teampulse/lambda-*'],
  message: crossServiceMessage,
};

// Tests legitimately import their own `../../src/...`, so the rule is positional instead: tests
// sit two folders below the service root (test/unit/x.ts), so three `../` leave the service.
const testIsolationPattern = {
  group: ['../../../**', '**/dist/**', '@teampulse/svc-*', '@teampulse/lambda-*'],
  message: crossServiceMessage,
};

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/coverage/**',
      '**/.svelte-kit/**',
      'tools/**',
      '*.config.*',
      '**/vite.config.ts',
      'apps/web/build/**',
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
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      eqeqeq: ['error', 'always'],
      'no-console': 'error', // use the structured logger
      'no-restricted-syntax': [
        'error',
        {
          selector: 'ExportDefaultDeclaration',
          message: 'Use named exports: they are refactor-safe and greppable.',
        },
      ],
    },
  },
  {
    // Services are isolated bounded contexts: share code only through packages/*.
    files: ['services/*/src/**/*.ts', 'lambdas/*/src/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [serviceIsolationPattern] }],
    },
  },
  {
    files: ['services/*/test/**/*.ts', 'lambdas/*/test/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [testIsolationPattern] }],
    },
  },
  {
    // Domain and application layers: pure, framework-free core.
    // Flat config replaces (does not merge) rule options, so this block repeats the isolation
    // pattern too. It must stay AFTER the isolation block above.
    files: [
      'services/*/src/domain/**/*.ts',
      'services/*/src/application/**/*.ts',
      'lambdas/*/src/domain/**/*.ts',
      'lambdas/*/src/application/**/*.ts',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            serviceIsolationPattern,
            {
              group: infrastructureImports,
              message:
                'The domain and application layers must not depend on infrastructure. Define a port in application/ and implement it in adapters/.',
            },
          ],
        },
      ],
    },
  },
  {
    // Tests may use console-free helpers but are otherwise held to the same rules.
    files: ['**/test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
    },
  },
);
