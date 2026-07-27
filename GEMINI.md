🚀
# Litefin - GEMINI.md

## Project Overview
Litefin is a high-performance, native Jellyfin client specifically engineered for **Samsung Tizen** and **LG webOS** TVs. It is designed to provide a premium media browsing and playback experience, even on legacy hardware, through a highly optimized UI engine and a robust dual-backend player.

### Core Technologies
- **Vanilla JavaScript (ES6+)**: Core logic is written in modern JS with extensive transpilation for legacy compatibility.
- **Webpack & Gulp**: Manages the complex build pipeline for 8 distinct hardware variants.
- **CSS Variable-based Theming**: Supports dynamic skins and visual overrides.
- **Tizen AVPlay / webOS Adapters**: Platform-specific hardware acceleration for media playback.

---

## Architecture & Framework
Litefin follows a modular architecture centered around a custom component-based UI engine.

### Core Components
- **`src/core/Component.js`**: The base class for all UI elements. Follows a lifecycle: `constructor` -> `render` -> `mount` -> `onMounted` -> `destroy`.
- **`src/core/EventBus.js`**: Centralized pub/sub system for decoupled module communication.
- **`src/core/Router.js`**: Manages client-side navigation, history stacks, and state restoration.
- **`src/core/StateManager.js`**: Handles persistent and session-based application state.
- **`FocusManager`**: (Internal/Architecture) Manages D-Pad navigation, focus memory, and spatial navigation across grids and menus.

### UI Engine
- **Virtualization**: Uses `VirtualGrid` and `VirtualList` with DOM recycling to handle thousands of items with minimal memory footprint.
- **Animation**: CSS-driven and GPU-accelerated transitions to ensure 60fps on TV processors.

---

## Build & Development

### Commands
- **Install Dependencies**: `npm install`
- **Build All Variants**: `npm run build`
- **Watch Mode (Normal Variant)**: `npm run dev`
- **Linting**: `npm run lint` / `npm run lint:fix`
- **Formatting**: `npm run format`
- **Package All Targets**: `npm run package` (Generates all Tizen + webOS packages)
- **Package Tizen (`.wgt`)**: `npm run package:tizen` (Generates all Tizen packages)
- **Package webOS (`.ipk`)**: `npm run package:webos` (Generates all webOS packages)

### The 8x Build Strategy
Litefin generates 8 distinct bundles to optimize for different hardware generations:
- **Modern**: 2021+ Models (Native ES6+)
- **Normal**: 2019+ Models (Chromium 69+)
- **Legacy**: 2017+ Models (Chromium 47 / ES5)
- **Ultra Legacy**: Pre-2017 Models (Chromium 38 / Heavy Polyfills)
*Note: Both Tizen and webOS have variants across these tiers.*

---

## Development Conventions

### Coding Standards
- **ES Modules**: Always use `import`/`export`.
- **Naming**: 
  - `PascalCase` for Classes (`Component.js`, `ApiClient.js`).
  - `camelCase` for variables, functions, and members.
- **Logging**: **NEVER** use `console.log` directly. Use the `logger` utility from `src/utils/Logger.js`.
  ```javascript
  import { logger } from '../utils/Logger.js';
  const log = logger.create('MyModule');
  log.info('Message');
  ```
- **Equality**: Strict equality (`===`) is mandatory.
- **Component Lifecycle**: Always perform cleanup (unsubscribing from EventBus, destroying children) in the component's `destroy` method or similar cleanup hooks.

### UI & Styling
- **Apple-inspired Aesthetics**: Follow a sleek, modern, "Steve Jobs level" design with rounded corners, subtle glassmorphism, and fluid transitions.
- **CSS Variables**: Use global variables for colors and spacing to maintain theme compatibility.
- **Focus Management**: Every interactive element must be focusable and its focus state clearly defined. Ensure focus memory is respected when navigating back.

---

## Critical Files
- `src/index.js`: Main entry point.
- `src/core/App.js`: Core application controller.
- `src/api/ApiClient.js`: Main interface for Jellyfin server communication.
- `webpack.config.cjs`: Complex multi-target build configuration.
- `gulpfile.mjs`: Orchestration for packaging and deployment.
- `appinfo.json` / `config.xml`: Platform manifests for webOS and Tizen.

---

## Local Memory & Setup
- **Certificates**: Signed packages require certificates in the `.sign/` directory.
- **Deployment**: Sideloading typically uses `Jellyfin2Samsung` for Tizen or the Homebrew Channel for webOS.

---
*This file is a foundational instruction set. Adhere to these architectural patterns and conventions strictly.*
