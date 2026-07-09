# Development

Litefin uses a modern web development stack optimized for generating highly compatible TV bundles.

## Build Pipeline

The project uses **Webpack** (6 config targets) for bundling and **Gulp** for task orchestration and packaging.

### Key Commands

| Command                | Description                                                                               |
| ---------------------- | ----------------------------------------------------------------------------------------- |
| `npm run build`        | Build all 6 webpack variants (modern, normal, legacy, ultra-legacy, debug, normal-oblong) |
| `npm run build:modern` | Tizen 6.5+ / webOS 6.0+ (pure ES6+, no transpilation)                                     |
| `npm run build:normal` | Tizen 5.0+ (Chromium 63, partial transpilation)                                           |
| `npm run build:legacy` | Tizen 3.0+ (Chromium 47, full ES5 transpilation)                                          |
| `npm run build:debug`  | Modern variant + source maps for on-device debugging                                      |
| `npm run dev`          | Watch mode (Normal variant)                                                               |
| `npm run serve`        | Webpack dev server (Debug variant)                                                        |
| `npm run clean`        | Removes `dist/`, `*.wgt`, `*.ipk`                                                         |
| `npm run lint`         | ESLint check on `src/`                                                                    |
| `npm run lint:fix`     | ESLint auto-fix                                                                           |
| `npm run format`       | Prettier write on `src/`                                                                  |
| `npm run format:check` | Prettier check only                                                                       |

### Package Commands

| Command                              | Output                                  |
| ------------------------------------ | --------------------------------------- |
| `npm run package`                    | All 8 variants (4 WGT + 4 IPK)          |
| `npm run package:tizen-modern`       | Tizen WGT (Modern)                      |
| `npm run package:tizen-normal`       | Tizen WGT (Normal)                      |
| `npm run package:tizen-test`         | Litefin-Tizen-Test.wgt (Normal variant) |
| `npm run package:tizen-debug`        | Tizen WGT with debug symbols            |
| `npm run package:webos-normal`       | webOS IPK (Normal)                      |
| `npm run package:webos-modern`       | webOS IPK (Modern)                      |
| `npm run package:webos-legacy`       | webOS IPK (Legacy)                      |
| `npm run package:webos-ultra-legacy` | webOS IPK (Ultra Legacy)                |

### Locale Commands

| Command                 | Description                                             |
| ----------------------- | ------------------------------------------------------- |
| `npm run locale:check`  | Validate locale JSON files match `en-us.json` reference |
| `npm run locale:sync`   | Sync all locales to match `en-us.json` structure        |
| `npm run locale:status` | Show translation coverage report                        |
| `npm run locale:update` | Update `languages.js` with latest coverage percentages  |

## Targeted Build Variants

The build system outputs 8 distinct variants to cover the compatibility matrix:

| Variant          | Tizen | webOS | Engine Compliance                                         |
| ---------------- | ----- | ----- | --------------------------------------------------------- |
| **Modern**       | 6.5+  | 6.0+  | Pure ES6+, no transpilation                               |
| **Normal**       | 5.0+  | 4.0+  | Chromium 63, partial transpilation                        |
| **Legacy**       | 3.0+  | —     | Chromium 47, ES5 transpilation                            |
| **Ultra Legacy** | 2.3+  | —     | Chromium 32, heavy polyfills, style-loader, backup-logger |

Babel transpilation is configured inline in `webpack.config.cjs` (no `.babelrc`). Ultra-legacy builds use `style-loader` instead of `MiniCssExtractPlugin` because file:// protocol on older Tizen blocks CSS file loading.

## Development Guidelines

- **Modules**: Always use ES6 modules (`import`/`export`) with `.js` extension.
- **Naming**: PascalCase for classes/files, camelCase for functions/variables/methods.
- **Private members**: Underscore prefix (`this._state`, `this._load()`).
- **Strictness**: Strict equality (`===`), `const`/`let` (no `var`), and no literal throws enforced via ESLint.
- **Logging**: Use the `logger` utility at module level (`const log = logger.create('ModuleName')`); never use `console.log` in production code.
- **Async**: Use `async/await` with `try/catch` for all async operations.

## Code Conventions

- **Prettier**: Single quotes, semicolons required, 4-space indent, 120 print width, no trailing commas, always arrow parens.
- **ESLint rules**: `no-var` (error), `eqeqeq` (error, null-ignore), `no-throw-literal` (error), `no-duplicate-imports` (error), `prefer-const` (warn), `no-unused-vars` (warn, args:none).

## Deployment

### Certificates

To create signed packages, you must place your Tizen certificates in the `.sign/` directory. This is required for the `package` tasks to produce valid `.wgt` bundles.

### Sideloading

1. **Packaging**: Run the relevant npm script (`npm run package:tizen-*` or `npm run package:webos-*`) to produce the `.wgt` or `.ipk` bundle.
2. **Installation**:
    - **Recommended (Tizen)**: Use [**Apps2Samsung**](https://github.com/Apps2Samsung/Apps2Samsung) for a streamlined sideloading process.
    - **Manual**: Use Tizen Studio's Device Manager or the webOS CLI (`ares-install`) to push the bundle directly to the TV.
