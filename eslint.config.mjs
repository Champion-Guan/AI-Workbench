import parser from '@typescript-eslint/parser';

// Deliberately incremental: no formatting rewrite or new unused-variable
// policy for existing modules. Type errors remain the separate tsc gate.
export default [
  { ignores: ['**/node_modules/**', '**/dist/**', 'output/**', 'public/**', 'archive/**'] },
  { files: ['**/*.mjs', '**/*.js', '**/*.ts', '**/*.tsx'],
    linterOptions: { noInlineConfig: true },
    languageOptions: { parser, ecmaVersion: 'latest', sourceType: 'module', parserOptions: { ecmaFeatures: { jsx: true } } },
    rules: { 'no-dupe-args': 'error', 'no-dupe-else-if': 'error', 'no-constant-binary-expression': 'error',
      'no-unreachable': 'error', 'no-unsafe-finally': 'error', 'valid-typeof': 'error' } },
];
