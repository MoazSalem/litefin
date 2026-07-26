# Litefin - Agentic Coding Guide

## Project Overview

Litefin is a Vanilla JS (ES6+) Jellyfin client for Samsung Tizen and LG webOS TVs. No frameworks. It uses Webpack + Gulp to produce 8 build variants (Modern + Normal + Legacy + Ultra-Legacy across Tizen/webOS).

## Build, Lint, Format & Package Commands

### Build

```bash
npm run build          # All variants (6 webpack configs)
npm run build:modern   # Tizen 6.5+ / webOS 6.0+ (no transpilation)
npm run build:normal   # Tizen 5.0+ (Chromium 63, partial transpilation)
npm run build:legacy   # Tizen 3.0+ (Chromium 47, full ES5 transpilation)
npm run build:debug    # Modern + source maps (on-device debugging)
npm run dev            # Watch mode (Normal variant)
npm run serve          # Webpack dev server (Debug variant)
npm run serve:modern   # Webpack dev server (Modern variant)
npm run serve:normal   # Webpack dev server (Normal variant)
npm run serve:legacy   # Webpack dev server (Legacy variant)
npm run serve:ultra-legacy # Webpack dev server (Ultra-Legacy variant)
```

### Lint & Format

```bash
npm run lint           # ESLint check (src/)
npm run lint:fix       # ESLint auto-fix
npm run format         # Prettier write (src/)
npm run format:check   # Prettier check only
```

### Package

```bash
npm run package                    # All 8 variants (WGT + IPK)
npm run package:modern             # Modern - Tizen WGT + webOS IPK
npm run package:normal             # Normal - Tizen WGT + webOS IPK
npm run package:legacy             # Legacy - Tizen WGT + webOS IPK
npm run package:ultra-legacy       # Ultra-Legacy - Tizen WGT + webOS IPK
npm run package:tizen-modern       # Tizen WGT (Modern)
npm run package:webos-normal       # webOS IPK (Normal)
npm run package:webos-modern       # webOS IPK (Modern)
npm run package:tizen-test         # Normal build as Litefin-Tizen-Test.wgt
```

### Clean

```bash
npm run clean          # Removes dist/, *.wgt, *.ipk
```

### Locale

```bash
npm run locale:check   # Validate locale JSON files match reference keys
npm run locale:sync    # Sync locale key structure
npm run locale:status  # Show translation coverage
npm run locale:update  # Update locale coverage report
```

### Tests

No test framework is configured. There are no test/spec files in the repository.

## Code Style Guidelines

### Imports & Exports

- **ES Modules only** — `import`/`export`, never CommonJS.
- Named exports for **singleton instances** (always lowercase): `export const logger = new Logger()`, `export const eventBus = new EventBus()`, `export const router = new Router()`, `export const state = new StateManager()`, `export const storage = new StorageService()`, `export const app = new App()`, `export const api = new ApiClient()`.
- Default exports for **classes** (PascalCase): `export default class Component`, `export default class LoginPage`.
- Named exports for stateless/utility classes: `export class ServerUnreachableError`, `export class ApiClient`.
- Import with `.js` extension always: `import { logger } from '../utils/Logger.js'`.
- Barrel exports via `src/api/index.js`, `src/pages/index.js` for aggregating module exports.
- Use `const log = logger.create('ModuleName');` at module level for logging.

### Naming Conventions

- **Classes** → PascalCase (`Component`, `ApiClient`, `LoginPage`, `ServerUnreachableError`)
- **Variables, functions, methods, members** → camelCase (`this._state`, `log.info`, `itemId`, `formatDate`)
- **Private members** → underscore prefix (`this._initialized`, `this._listeners`, `_loadJson()`)
- **Constants** → UPPER_SNAKE_CASE (`REQUEST_TIMEOUT`, `MAX_CONCURRENT`, `STATE`)
- **Event names** → colon-namespaced strings (`'user:login'`, `'logger:log'`, `'router:navigate'`, `'state:change'`)
- **Files** → PascalCase for classes/modules (`LoginPage.js`, `ApiClient.js`, `StorageService.js`, `TimeUtils.js`)
- **CSS classes** → kebab-case in templates (`.media-card`, `.sidebar-item`)

### Formatting (Prettier enforced)

```json
{
    "singleQuote": true, // single quotes for strings
    "semi": true, // semicolons required
    "tabWidth": 4, // 4-space indentation
    "printWidth": 120, // max 120 chars per line
    "trailingComma": "none", // no trailing commas
    "arrowParens": "always", // always wrap arrow params: (x) => x
    "endOfLine": "auto", // line endings (editorconfig enforces LF)
    "bracketSpacing": true // spaces in object literals: { foo: 1 }
}
```

### Linting Rules (ESLint enforced)

- `no-var` — error (use `const`/`let`)
- `prefer-const` — warn (with `destructuring: 'all'`)
- `no-unused-vars` — warn (with `args: 'none'`, `ignoreRestSiblings: true`)
- `no-duplicate-imports` — error
- `eqeqeq` — error, always (with `null: 'ignore'`) — always use `===`
- `no-throw-literal` — error (never throw strings/numbers)
- `no-self-compare` — error
- `no-template-curly-in-string` — warn
- `no-constant-condition` — error (with `checkLoops: false`)
- `no-empty` — error (with `allowEmptyCatch: true`)

### Error Handling

- Never throw literals — always throw `new Error(...)` or custom error classes.
- Custom errors extend `Error` and set `this.name`: `class ServerUnreachableError extends Error { constructor() { super('...'); this.name = 'ServerUnreachableError'; } }`.
- Use `try/catch` around all platform-specific calls (Tizen/webOS APIs may throw on unsupported hardware).
- Wrap native console interception in `try/catch` for Chromium 32 compatibility.
- Catch promises with `.catch(err => log.warn(...))` for non-critical background operations.
- Use the `logger` utility for all error/warn output, never `console.error` directly.

### Logging

- **Never use `console.log` in production code.** Always use the logger utility.

```javascript
import { logger } from '../utils/Logger.js';
const log = logger.create('ModuleName');
log.error('message', detail); // Level 0 — errors
log.warn('message', detail); // Level 1 — warnings
log.info('message'); // Level 2 — general info
log.debug('message'); // Level 3 — debug details
log.verbose('message'); // Level 4 — verbose trace
```

- Create the logger at module level: `const log = logger.create('ComponentName');`

### Comments & Structure

- File header blocks use `=`:

```javascript
/**
 * ============================================================================
 * Litefin Tizen - Module Description
 * ============================================================================
 */
```

- Section separators use `=` or `-`:

```javascript
// ========================================================================
// Request Methods
// ========================================================================
```

- Inline comments use `//`, block comments for complex logic use `/* ... */`.
- Use JSDoc for public methods and constructors (`@param`, `@returns`, `@type`).
- Use block comments (`/* ... */`) to explain non-obvious platform quirks (e.g., webOS file:// XHR vs fetch rationale).

### Component Architecture

- All UI components extend `Component` from `src/core/Component.js`.
- Lifecycle: `constructor()` → `render()` (returns HTML string) → `mount()` (DOM attach) → `onMounted()` (post-attach init) → `update()` (re-render) → `destroy()` (cleanup).
- Pages extend `Page` (which extends `Component`) from `src/pages/Page.js` — adds `onInit()`, focus section registration, navigation state save/restore, `markReady()`.
- Cleanup: always unsubscribe from EventBus and destroy children in `destroy()`.
- DOM references go through `this.el` (the component's root element, set during mount).
- Props are passed via `this.props`, internal state via `this._state`.
- Child components tracked in `this._children` for bulk destroy.
- Event subscriptions stored in `this._subscriptions` (return value of `eventBus.on()`) for auto-cleanup in `destroy()`.

### Patterns & Best Practices

- **State management**: Use `state.set(key, value)` / `state.get(key)` / `state.subscribe(key, fn)` from `src/core/StateManager.js`. State changes emit `'state:change'` events.
- **Event communication**: Use `eventBus.emit(event, ...args)` / `eventBus.on(event, callback)` for decoupled communication. `on()` returns an unsubscribe function. Also supports `once()` and `off()`.
- **Navigation**: Use `router.navigate(path)` and register routes with `router.register(pattern, PageClass)`. Hash-based SPA with param matching and history restoration.
- **Focus management**: Use `focusManager` for TV D-Pad navigation — every interactive element needs `tabindex="0"`.
- **Localization**: Use `i18n.t('key')` for all user-facing strings. Locale files in `src/locales/`.
- **Storage**: Use `storage.getItem/setItem/removeItem` (in-memory cache over localStorage, debounced flush).
- **Player detection**: Branch on `platformInfo.isWebOS` / `platformInfo.isTizen` / `platformInfo.isTv` for platform-specific code.
- **CSS theming**: Use CSS variables (defined in `src/themes/`) — never hardcode colors.
- **Async patterns**: Use `async/await` for all async operations. Prefer `try/catch` over `.catch()`.
- **Singleton accessors**: Always use getters (`get serverUrl()`) for private field access.

### Tizen/webOS Compatibility Notes

- AbortController polyfill must run before any imports in `src/index.js`.
- Use XHR (not fetch) for local file loading on webOS (file:// protocol restriction blocks fetch).
- Never use `%c` CSS formatting in console.log — Chromium 32 (Tizen 2.x) throws on it.
- style-loader (not MiniCssExtractPlugin) for ultra-legacy builds (file:// CORS issue with CSS files).
- ES5-safe patterns in files that go through Babel transpilation (no arrow functions in ultra-legacy entry polyfills in `src/index.ultra-legacy.html`).
- Always wrap native console interceptions in try/catch for Chromium 32 compatibility.
- Babel transpilation is configured inline in `webpack.config.cjs` (no `.babelrc`).

### Critical Files

- `src/index.js` — App entry point (polyfills + bootstrap)
- `src/index.ultra-legacy.html` — Ultra-legacy HTML entry with backup-logger
- `src/backup-logger.js` — Zero-dependency console monkeypatch for ultra-legacy Tizen 2.x
- `src/core/App.js` — Application controller (init, route registration, sidebar lifecycle)
- `src/core/Component.js` — Base UI component class
- `src/core/EventBus.js` — Pub/sub event system
- `src/core/Router.js` — Hash-based SPA router
- `src/core/StateManager.js` — Observable state container
- `src/api/ApiClient.js` — Jellyfin HTTP API client (server discovery, auth, WebSocket)
- `src/utils/Logger.js` — Centralized logging (console interception, log levels)
- `src/utils/StorageService.js` — localStorage cache layer with in-memory buffer
- `src/utils/PlatformInfo.js` — Tizen/webOS/device detection
- `webpack.config.cjs` — Multi-target build config (6 variants)
- `gulpfile.mjs` — Build orchestration + packaging (8 package variants)
- `config.xml` / `appinfo.json` — Tizen / webOS platform manifests
