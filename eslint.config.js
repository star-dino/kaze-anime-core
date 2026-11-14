// 仅正确性规则，无风格规则。
import globals from 'globals';

export default [
  { ignores: ['vendor/**', 'out/**', 'dist/**', 'node_modules/**', 'devdocs/**'] },
  {
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.browser, ...globals.node },
    },
    rules: {
      'no-unused-vars': ['error', { args: 'none', varsIgnorePattern: '^_', caughtErrors: 'none' }],
      'no-undef': 'error',
      'no-empty': ['error', { allowEmptyCatch: false }],
      'no-unreachable': 'error',
      'no-dupe-keys': 'error',
      'no-self-assign': 'error',
    },
  },
];
