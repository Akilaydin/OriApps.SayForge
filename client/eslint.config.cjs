const eslint = require('@eslint/js')
const typescript = require('@typescript-eslint/eslint-plugin')
const prettier = require('eslint-config-prettier')

module.exports = [
  eslint.configs.recommended,
  ...typescript.configs['flat/recommended'],
  prettier,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2020,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn',
      'no-console': 'off',
    },
  },
]
