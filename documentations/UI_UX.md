# UI & UX

Litefin is designed with a focus on fluid interactions and high-end visual aesthetics tailored for the 10-foot TV experience.

## Design System

The application uses a custom-built design system that avoids generic browser defaults.

- **Theming System**: A CSS variable-based system (`src/themes/`) with 5 theme modes (Classic Dark, Classic Light, Black, Tinted, Ambient). Accent color customization with automatic variant computation. Sidebar colors, OSD button/focus/shape/color styles, badge styles, button styles, and focus border styles all configurable.
- **Blur & Glassmorphism**: Strategically used for overlays and menus to create depth without impacting performance on older hardware.
- **Rounded Aesthetics**: Consistent corner rounding across buttons and media cards, adjustable to user preference (global toggle).
- **Layout Manager** (`src/ui/LayoutManager.js`): Centralized theming engine that injects CSS variables into the DOM, manages theme mode, accent color, font overrides, text scaling, card label styles (titleOnly, titleOnly2Lines, hidden), low VRAM mode, blurhash toggle, and media rows layout.

## Component Architecture

- **Media Cards**: Reusable, customizable cards via `CardRenderer` (`src/utils/CardRenderer.js`) handling 13+ view modes (poster, landscape, square, episode, person, season, resume, banner, library, artist, thumb, and more). Supports quality badges (resolution/HDR/DV detection), BlurHash placeholders, deterministic gradient fallbacks, lazy loading, and modern expansion.
- **Modals & Menus**: A unified modal system that respects TV navigation rules (focus locking via `FocusManager.pushTrap`/`popTrap`, escape key handling).
- **Virtualization**: `VirtualCardRow` implements horizontal DOM recycling (sliding window) to handle thousands of card items with minimal memory footprint.
- **Grids**: `MediaGrid` component for generic grid layouts with "See More" expansion, and `EpgGrid` for Live TV electronic program guide.

## Animations & Fluidity

- **GPU Acceleration**: Animations are primarily CSS-driven (transform, opacity) and optimized for GPU execution to prevent frame drops on TV processors.
- **Fluid Transitions**: Global transitions between pages and within UI components (like sidebars and grids) to create a sense of continuity.
- **Scroll Handling**: Optimized scrolling rules that minimize layout thrashing via `ScrollController`. Maintains smooth focal points during D-pad movement with rapid navigation detection (instant scroll mode).

## Interactive Standards

- **Focus Restoration**: The app rigorously tracks focus states through `NavigationState`. Returning to a page restores focus to the exact element (by CSS selector `[data-item-id]`, `[data-episode-id]`, or section index). Async pages use `restoreScrollFocusWhenReady()` to delay restoration until content loads.
- **Debounced Inputs**: 40ms debounce in `FocusManager` for TV remote key events. RemoteButtonManager handles Red/Green/Yellow/Blue button actions on the remote.
- **Magic Remote Support**: Wheel events mapped to scrolling, slider (range input) special handling for left/right navigation, `onmousedown` + `onclick` event binding for Magic Remote pointer compatibility.
- **Focus Memory**: Section-based focus memory with virtual index support. Carousels pause auto-scroll when focus leaves and resume on focus return. Sidebar auto-expands/collapses based on focus using `MutationObserver`.
