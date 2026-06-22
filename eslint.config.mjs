import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import globals from 'globals';
import prettier from 'eslint-config-prettier';

export default [
  {
    ignores: ['dist/', '__tests__/', 'eslint.config.*']
  },
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      ecmaVersion: 'latest',
      parser: tsParser,
      parserOptions: {
        impliedStrict: true,
        project: './tsconfig.json',
        sourceType: 'module'
      },
      globals: {
        ...globals.node,
        ...globals.es2022
      }
    },
    plugins: {
      '@typescript-eslint': tsPlugin
    },
    rules: {
      '@typescript-eslint/explicit-function-return-type': 'error',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        {
          prefer: 'type-imports'
        }
      ],
      curly: ['error', 'all'],
      eqeqeq: 'error',
      'no-var': 'error',
      'prefer-const': 'error',
      semi: ['error', 'always'],
      quotes: ['error', 'single'],
      'comma-dangle': 'error',
      'no-trailing-spaces': 'error',
      'eol-last': 'error'
    }
  },
  prettier
];
