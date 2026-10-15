// ESLint 9 flat config. Intentionally permissive — flags real errors
// (undefined vars, parse errors) but doesn't enforce style; the codebase
// has been written without lint feedback and rewriting for style now
// would be churn. Use `npm run lint -- --fix` for trivial autofixes.

import js from '@eslint/js';

const browserGlobals = {
  window: 'readonly', document: 'readonly', localStorage: 'readonly',
  fetch: 'readonly', navigator: 'readonly', Image: 'readonly',
  HTMLCanvasElement: 'readonly', HTMLImageElement: 'readonly',
  HTMLElement: 'readonly', Element: 'readonly', URL: 'readonly',
  URLSearchParams: 'readonly', Headers: 'readonly', Response: 'readonly',
  Request: 'readonly', FormData: 'readonly', Blob: 'readonly',
  File: 'readonly', FileReader: 'readonly', requestAnimationFrame: 'readonly',
  cancelAnimationFrame: 'readonly', setTimeout: 'readonly', setInterval: 'readonly',
  clearTimeout: 'readonly', clearInterval: 'readonly', alert: 'readonly',
  confirm: 'readonly', performance: 'readonly', crypto: 'readonly',
  TextEncoder: 'readonly', TextDecoder: 'readonly', AbortController: 'readonly',
  ClipboardItem: 'readonly',
  btoa: 'readonly', atob: 'readonly', history: 'readonly',
  WebSocket: 'readonly', CustomEvent: 'readonly', EventTarget: 'readonly'
};

const nodeGlobals = {
  process: 'readonly', console: 'readonly', Buffer: 'readonly',
  __dirname: 'readonly', __filename: 'readonly', global: 'readonly',
  setImmediate: 'readonly', clearImmediate: 'readonly', module: 'readonly',
  require: 'readonly', exports: 'readonly', globalThis: 'readonly'
};

export default [
  { ignores: ['dist/**', 'node_modules/**', '.plans/**', 'public/**', 'scripts/**', '.github/**', 'scratchpad/**'] },
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: { ...browserGlobals, ...nodeGlobals }
    },
    rules: {
      // Real errors only — don't churn on style
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
      'no-empty':        ['warn', { allowEmptyCatch: true }],
      'no-undef':         'error',
      'no-cond-assign':  ['error', 'except-parens'],
      'no-control-regex': 'off',
      'no-prototype-builtins': 'off'
    }
  },
  // M64 T10 — portability guard. The combat engine closure must stay
  // importable by the Node server (and a worker) unchanged: no DOM-bound
  // modules, no animation layer, no main.js, no browser storage.
  {
    files: ['src/js/scene/**/*.js', 'src/js/scene/ai/**/*.js'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [
          { regex: '(^|/)anim/', message: 'M64 T10: the engine closure (src/js/scene/**) must not import the animation layer (src/js/anim/).' },
          { regex: '(^|/)main\\.js$', message: 'M64 T10: the engine closure must not import main.js (browser UI).' },
          { regex: '(^|/)scene-state\\.js$', message: 'M64 T10: the engine closure must not import scene-state.js (localStorage persistence).' },
          { regex: '(^|/)reaction-prompt\\.js$', message: 'M64 T10: the engine closure must not import reaction-prompt.js (DOM dialog).' }
        ]
      }]
    }
  }
];
