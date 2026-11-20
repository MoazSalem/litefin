# Litefin State, Navigation & Focus Rules

## 1. The Root Cause of Navigation Spaghetti
In the current codebase, hundreds of lines in [`LibraryPage.js`](src/pages/LibraryPage.js), [`DetailsPage.js`](src/pages/DetailsPage.js), and [`PlayerPage.js`](src/pages/PlayerPage.js) are dedicated to manual `keydown` listener boilerplate:
- Checking `e.keyCode === 38` (Up), `40` (Down), `37` (Left), `39` (Right), `13` (Enter), `10009` (Tizen Return).
- Manually calculating which DOM node to focus next.
- Manually tracking and storing `lastFocusedElement` or `focusSectionId`.
- Manually adding and removing `.focused` classes.

This ad-hoc approach bloats page controllers, causes focus traps, and creates inconsistencies across pages.

---

## 2. Spatial Navigation Architecture
Litefin provides centralized spatial navigation via [`FocusManager`](src/ui/FocusManager.js) and [`SpatialNavigator`](src/ui/SpatialNavigator.js).

### The Four Navigation Laws
1. **Never write manual Arrow Up/Down/Left/Right switches in Page classes.**
   Pages must declare navigable **Sections** and let `FocusManager` resolve 2D geometric navigation between elements.
2. **Use Focusable Attributes:**
   Navigable items must be marked with `tabindex="-1"` and class `focusable`. Do NOT use `tabindex="0"` on TV runtimes as it interferes with platform spatial navigators.
3. **Register Boundaries via Sections:**
   Each logical UI area (e.g., `header-tabs`, `sidebar-nav`, `media-grid`, `action-buttons`) must register with a distinct section ID.
   ```javascript
   // Register a section with FocusManager
   focusManager.addSection('media-grid', {
       selector: '.card.focusable',
       defaultElement: '.card:first-child',
       leaveUp: 'header-tabs',
       leaveLeft: 'sidebar-nav',
       enterTo: 'last-focused'
   });
   ```
4. **Clean Section Teardown:**
   When a page, modal, or tab is destroyed, it MUST call `focusManager.removeSection(sectionId)` to avoid ghost navigation targets.

### Exception for Grids & Carousels (`*GridController` / `*RowController`)
Inside uniform 2D grids (`LibraryGridController`) and horizontal rows, do NOT use geometric DOM bounding-box queries (`getBoundingClientRect()`) to find the next card. Use pure index math (`nextIndex = currentIndex + columns` for Down, `- columns` for Up, `+- 1` for Left/Right). Only delegate to `FocusManager` when focus leaves the grid boundary (e.g., moving Up from Row 0 into `header-tabs` or Left from Column 0 into `sidebar-nav`).

---

## 3. Modal Dialog & Focus Trap Protocol
When opening any modal dialog (Settings selection, Filter modal, Sort modal, Subtitle picker):
1. **Save Calling Focus:**
   The modal controller must record `document.activeElement` before taking focus.
2. **Trap Focus within Modal Container:**
   Register a dedicated modal section or call `focusManager.trap(modalContainer)`. All D-pad navigation must cycle or clamp strictly within the modal.
3. **Escape / Back Navigation:**
   Pressing Back / Return / Escape must dismiss the modal and automatically restore focus to the previously saved calling element.
4. **Never Leave Focus in Void:**
   If a focused item is deleted or scrolled out of view, focus must gracefully fall back to a sibling or parent container.

---

## 4. State Management Separation

### 1. Ephemeral Page State
- Owned exclusively by the active page's `DataController`.
- Contains current page index, active filter ID, search query, or scroll coordinates.
- Destroyed immediately when navigating away. Never stored in global singletons.

### 2. Persistent User Preferences
- Managed through [`StorageService`](src/utils/StorageService.js) (`storage.getItem`, `storage.setItem`).
- Used for app settings, display scaling, audio passthrough flags, and credentials.
- Must provide safe fallbacks if `localStorage` is unavailable or full.

### 3. Reactive App State & Events
- Managed through [`StateManager`](src/core/StateManager.js) and [`EventBus`](src/core/EventBus.js).
- Used for cross-cutting application state: current authenticated user, active playback session, network connectivity status, server discovery.
- Subscriptions MUST be unregistered in `.destroy()`.
