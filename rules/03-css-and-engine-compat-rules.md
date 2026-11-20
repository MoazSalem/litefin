# Litefin CSS & Browser Engine Compatibility Rules

## 1. Engine Tier Architecture & Real-World Baseline
Litefin supports a wide spectrum of television engines and mobile/desktop platforms:

| Tier | Engine Range | Target OS Examples | CSS Capabilities & Limits |
| :--- | :--- | :--- | :--- |
| **Tier 1 (Ultra-Legacy)** | `AppleWebKit/538.1` to `Chromium 47` | Tizen 2.3/2.4, webOS 1.x/2.x/3.0 | No CSS Grid, buggy Flex shrink, needs `-webkit-` prefixes, no native CSS variables. Relies on `css-vars-ponyfill` via `style-loader`. |
| **Tier 2 (Mid-Legacy)** | `Chromium 53` to `Chromium 79` | Tizen 3.0–5.5, webOS 3.5–5.0 | Basic native CSS variables, NO Flexbox `gap` (added in Chromium 84), weak GPU fill-rate (~64MB VRAM), no `backdrop-filter`. |
| **Tier 3 (Modern)** | `Chromium 84` to `Chromium 130+`, Tauri Desktop, Android | Tizen 6.0+, webOS 6.0+, Windows/Linux/macOS, Android | Full modern CSS, Flexbox `gap`, native CSS Grid, hardware-accelerated transforms, `backdrop-filter` (desktop only). |

---

## 2. Reconciling Existing CSS Debt vs Strict Compat Rules

### The CSS Custom Properties (`var(--)`) Policy
- **Existing Reality:** The Litefin codebase contains over 1,500 usages of `var(--...)`.
- **How It Works:** On legacy runtimes, [`CssVarsPolyfill.js`](src/utils/CssVarsPolyfill.js) parses stylesheets and applies values at runtime. In ultra-legacy builds, `webpack.config.cjs` uses `style-loader` to avoid `file://` CORS errors during ponyfill fetching.
- **Rule for Refactored & New Code:**
  - DO NOT execute a breaking mass-removal of CSS variables.
  - DO provide explicit static fallbacks for critical layout dimensions:
    ```css
    /* CORRECT: Static fallback ensures layout works even before ponyfill executes */
    padding: 20px;
    padding: var(--page-padding, 20px);
    ```
  - NEVER mutate root CSS variables on every frame (e.g., during active touch, wheel, or D-pad scroll). Reparsing CSS variables mid-scroll drops frame rate on low-end CPUs.

### Flexbox `gap` vs Margins
- **Existing Reality:** 144 occurrences of `gap` exist in the repository.
- **Engine Constraint:** Flexbox `gap` fails completely on Chromium < 84 (Tizen 3.0–5.5 and webOS 3.5–5.0 ignore `gap` entirely, rendering items jammed together with 0px spacing).
- **Rule:**
  - In core TV views ([`library.css`](src/styles/library.css), [`home.css`](src/styles/home.css), [`details.css`](src/styles/details.css)), ALWAYS use child margins (`margin-right` / `margin-bottom`) for spacing.
  - If `gap` is used in modern themes ([`src/styles/modern/`](src/styles/modern/)), ensure a fallback margin is declared for older tiers.

### `backdrop-filter` & Blur Effects
- **Existing Reality:** Used in modern desktop and glassmorphism themes.
- **Engine Constraint:** `backdrop-filter: blur(...)` drops TV frame rate to < 5 FPS or renders as opaque gray on TV GPUs.
- **Rule:**
  - Strictly BANNED on all TV card grids, horizontal media rows, and OSD playback overlays.
  - Only permitted inside desktop/modern-specific styles scoped under `.platform-desktop` or `.tier-modern`.
  - For TV overlays and dialogs, use solid semi-transparent background colors: `background-color: rgba(16, 16, 20, 0.92)`.

---

## 3. Stylesheet De-Monolithization Plan
Just as JS files exceed 5,000 lines, stylesheet files have become unmaintainable monoliths:
- [`src/styles/android-mobile.css`](src/styles/android-mobile.css) (3,244 lines)
- [`src/styles/settings.css`](src/styles/settings.css) (2,688 lines)
- [`src/styles/player-osd.css`](src/styles/player-osd.css) (2,430 lines)
- [`src/styles/base.css`](src/styles/base.css) (2,359 lines)

### Reorganization Structure
Split monolithic stylesheets into component-scoped files matching the JS module structure:
```
src/styles/
├── base/
│   ├── reset.css            # Base browser normalizations
│   ├── typography.css       # Typography, font families, base scales
│   └── tv-focus.css         # Global focus indicator definitions
├── pages/
│   ├── settings/            # Decomposed from settings.css (2.6k lines)
│   │   ├── settings-layout.css
│   │   ├── settings-tabs.css
│   │   └── settings-modals.css
│   ├── library/             # Decomposed from library.css (1.8k lines)
│   └── details/             # Decomposed from details.css (2.0k lines)
└── player/
    ├── osd-controls.css     # Decomposed from player-osd.css (2.4k lines)
    ├── osd-timeline.css
    └── osd-modals.css
```

---

## 4. Hardware-Safe GPU Acceleration Rules

### Dual-Prefixing Mandate
Older WebKit (`AppleWebKit/538.1`) ignores un-prefixed transforms and transitions:
```css
/* Always specify both prefixes in TV stylesheets */
-webkit-transform: translate3d(0, 0, 0);
transform: translate3d(0, 0, 0);

-webkit-transition: -webkit-transform 250ms cubic-bezier(0.2, 0, 0.2, 1);
transition: transform 250ms cubic-bezier(0.2, 0, 0.2, 1);
```

### No `calc()` Inside Transforms
Older WebKit parses `transform: translateX(calc(100% + 20px))` as invalid syntax and silently drops the transform.
- Compute coordinates in JavaScript and set explicit pixel values: `style.transform = 'translate3d(' + x + 'px, ' + y + 'px, 0)'`.

### GPU Layer Memory Budget (64MB–128MB TV VRAM)
- **NEVER** apply `will-change: transform` or `translateZ(0)` globally to `.card` or `.poster`. Promoting 100 cards simultaneously exhausts TV VRAM, causing black texture dropouts or instant browser crashes.
- **ONLY** apply `will-change: transform` to the single active scrolling container track or dynamically to the currently focused card.

### Zero-Layout-Shift Focus Animations
- Changing `border-width`, `margin`, `width`, `height`, `top`, or `left` on `:focus` forces the browser to recalculate the entire page layout on every D-pad press.
- **Focus Rule:** Focus highlights MUST only toggle `opacity` on a pre-rendered outline overlay or apply `transform: scale3d(1.05, 1.05, 1)`.
