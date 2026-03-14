# Development

Litefin uses a modern web development stack optimized for generating highly compatible TV bundles.

## Build Pipeline

The project uses **Webpack** for bundling and **Gulp** for task orchestration.

### Gulp Tasks
- `npm run build`: Orchestrates the build of both the player sub-project and the main application across all target variants.
- `npm run package`: Generates signed `.wgt` (Tizen) or `.ipk` (web-OS) files ready for installation.
- `npm run dev`: Starts Webpack in watch mode for the "normal" build configuration.

## Targeted Build Variants

The build system outputs 8 distinct variants to cover the compatibility matrix:

| Variant | Target Hardware | Engine Compliance |
| :--- | :--- | :--- |
| **ES6** | 2021+ Models | Pure ES6+ / No Transpilation |
| **Normal** | 2019+ Models | Chromium 69+ |
| **Legacy** | 2017+ Models | Chromium 47 Core / ES5 |
| **Ultra Legacy** | Pre-2017 Models | Chromium 38 Core / Extensive Polyfills |

## Development Guidelines

- **Modules**: Always use ES6 modules (`import`/`export`).
- **Naming**: PascalCase for Classes, camelCase for functions/variables.
- **Strictness**: Strict equality and `const`/`let` are enforced via ESLint.
- **Logging**: Use the `logger` utility for all module logs; avoid direct `console.log` calls in production code.

## Deployment

### Certificates
To create signed packages, you must place your Tizen or web-OS certificates in the `.sign/` directory. This is required for the `package` tasks to produce valid bundles.

### Sideloading
1. **Packaging**: Run the relevant Gulp task (`npm run package`) to produce the `.wgt` or `.ipk` bundle.
2. **Installation**:
   - **Recommended (Tizen)**: Use [**Jellyfin2Samsung**](https://github.com/Jellyfin2Samsung/Samsung-Jellyfin-Installer) for a streamlined sideloading process.
   - **Manual**: Use Tizen Studio's Device Manager or the web-OS CLI to push the bundle directly to the TV.
