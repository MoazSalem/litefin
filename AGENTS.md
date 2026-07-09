# Litefin - Agentic Coding Guide

## Project Overview

Litefin is a Vanilla JS (ES6+) Jellyfin client for Samsung Tizen and LG webOS TVs. No frameworks. It uses Webpack + Gulp to produce 8 build variants across hardware generations.

## Build & Lint Commands

### Build

```bash
npm run build          # All variants (Modern + Normal + Legacy + Ultra-Legacy)
npm run build:modern   # Tizen 6.5+ / webOS 6.0+ (no transpilation)
npm run build:normal   # Tizen 5.0+ (Chromium 63, partial transpilation)
npm run build:legacy   # Tizen 3.0+ (Chromium 47, full ES5 transpilation)
npm run build:debug    # Modern + source maps (on-device debugging)
npm run dev            # Watch mode (Normal variant)
npm run serve          # Webpack dev server (Debug variant)
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
npm run package                    # All 8 variants (4 WGT + 4 IPK)
npm run package:tizen-modern       # Tizen WGT (Modern)
npm run package:webos-normal       # webOS IPK (Normal)
npm run package:webos-modern       # webOS IPK (Modern)
npm run package:tizen-test         # Normal build as Litefin-Tizen-Test.wgt
```

### Clean

```bash
npm run clean          # Removes dist/ *.wgt *.ipk
```

### Tests

No test framework is configured. There are no test/spec files in the repository.

## Code Style Guidelines

### Imports & Exports

- **ES Modules only** — `import`/`export`, never CommonJS.
- Named exports for **singleton instances** (lowercase): `export const logger = new Logger()`, `export const eventBus = new EventBus()`, `export const router = new Router()`, `export const state = new StateManager()`.
- Default exports for **classes** (PascalCase): `export default class Component`, `export default class LoginPage`.
- Named exports for stateless utility classes: `export class ServerUnreachableError`, `export class ApiClient`.
- Import with `.js` extension: `import { logger } from '../utils/Logger.js'`.
- Import singletons via named import: `import { logger } from '../utils/Logger.js'`.
- Import component/page classes via default import: `import LoginPage from '../pages/LoginPage.js'`.

### Naming Conventions

- **Classes** → PascalCase (`Component`, `ApiClient`, `LoginPage`)
- **Variables, functions, methods, members** → camelCase (`this._state`, `log.info`, `itemId`)
- **Private members** → underscore prefix (`this._initialized`, `this._listeners`, `_log()`)
- **Constants** → UPPER_SNAKE_CASE (`REQUEST_TIMEOUT`, `MAX_CONCURRENT`, `STATE`)
- **Event names** → colon-namespaced strings (`'user:login'`, `'logger:log'`, `'router:navigate'`)
- **Files** → PascalCase for classes (`LoginPage.js`, `ApiClient.js`, `StorageService.js`)

### Formatting (Prettier enforced)

- **Semicolons** — required
- **Quotes** — single quotes
- **Indentation** — 4 spaces (tabs converted to spaces)
- **Print width** — 120 characters
- **Trailing commas** — none
- **Arrow parens** — always
- **End of line** — auto (editorconfig enforces LF)

### Linting Rules (ESLint enforced)

- `no-var` — error (use `const`/`let`)
- `prefer-const` — warn (with `destructuring: 'all'`)
- `no-unused-vars` — warn (with `args: 'none'`, `ignoreRestSiblings: true`)
- `no-duplicate-imports` — error
- `eqeqeq` — error, always (with `null: 'ignore'`)
- `no-throw-literal` — error
- `no-self-compare` — error
- `no-template-curly-in-string` — warn
- `no-constant-condition` — error (with `checkLoops: false`)
- `no-empty` — error (with `allowEmptyCatch: true`)

### Error Handling

- Never throw literals — always throw `new Error(...)` or custom error classes.
- Custom errors extend `Error` and set `this.name`: `class ServerUnreachableError extends Error`.
- Use `try/catch` around all platform-specific calls (Tizen/webOS APIs may throw on unsupported hardware).
- Wrap `console[method]` calls in `try/catch` on legacy Tizen (Chromium 32 host objects may throw).
- Catch promises with `.catch(err => log.warn(...))` for non-critical background operations.
- Use the `logger` utility for all error/warn output, never `console.error` directly.

### Logging

- **Never use `console.log` in production code.** Always use the logger utility.

```javascript
import { logger } from '../utils/Logger.js';
const log = logger.create('ModuleName');
log.error('message', detail); // Level 0
log.warn('message', detail); // Level 1
log.info('message'); // Level 2
log.debug('message'); // Level 3
log.verbose('message'); // Level 4
```

- Create the logger at module level: `const log = logger.create('ComponentName');`

### Comments & Structure

- File header blocks use `=`.
- Section separators use `=` or `-`.
- Inline comments use `//`.
- Block comments for complex logic use `/* ... */`.
- Use JSDoc for public methods and constructors (`@param`, `@returns`, `@type`).

### Component Architecture

- All UI components extend `Component` from `src/core/Component.js`.
- Lifecycle: `constructor()` → `render()` → `mount()` → `onMounted()` → `destroy()`.
- Pages extend `Page` (which extends `Component`) from `src/pages/Page.js`.
- Cleanup: always unsubscribe from EventBus and destroy children in `destroy()`.
- DOM references go through `this.el` (the component's root element).
- Props are passed via `this.props`, internal state via `this._state`.

### Patterns & Best Practices

- **State management**: Use `state.set(key, value)` / `state.get(key)` from `StateManager.js`.
- **Event communication**: Use `eventBus.emit(event, ...args)` / `eventBus.on(event, callback)` for decoupled communication.
- **Navigation**: Use `router.navigate(path)` and register routes with `router.register(pattern, PageClass)`.
- **Focus management**: Use `focusManager` for TV D-Pad navigation — every interactive element needs `tabindex="0"`.
- **Localization**: Use `i18n.t('key')` for all user-facing strings.
- **Storage**: Use `storage.getItem/setItem/removeItem` (in-memory cache over localStorage).
- **Player detection**: Branch on `platformInfo.isWebOS` / `platformInfo.isTizen` for platform-specific code.
- **CSS theming**: Use CSS variables (defined in themes/) — never hardcode colors.
- **Async patterns**: Use `async/await` for all async operations. Prefer `try/catch` over `.catch()`.
- **Singleton accessors**: Always use getters (`get serverUrl()`) for private field access.

### Tizen/webOS Compatibility Notes

- AbortController polyfill must run before any imports in `index.js`.
- Use XHR (not fetch) for local file loading on webOS (file:// protocol restriction).
- Never use `%c` CSS formatting in console.log — Chromium 32 (Tizen 2.x) throws on it.
- style-loader (not MiniCssExtractPlugin) for ultra-legacy builds (file:// CORS issue).
- ES5-safe patterns in files that go through Babel transpilation (no arrow functions in ultra-legacy entry polyfills).
- Always wrap native console interceptions in try/catch for Chromium 32 compatibility.

### Critical Files

- `src/index.js` — App entry point (polyfills + bootstrap)
- `src/core/App.js` — Application controller
- `src/core/Component.js` — Base UI component class
- `src/core/EventBus.js` — Pub/sub event system
- `src/core/Router.js` — Hash-based SPA router
- `src/core/StateManager.js` — Observable state container
- `src/api/ApiClient.js` — Jellyfin HTTP API client
- `src/utils/Logger.js` — Centralized logging
- `src/utils/StorageService.js` — localStorage cache layer
- `webpack.config.cjs` — Multi-target build config (5 variants)
- `gulpfile.mjs` — Build orchestration + packaging
- `config.xml` / `appinfo.json` — Platform manifests
