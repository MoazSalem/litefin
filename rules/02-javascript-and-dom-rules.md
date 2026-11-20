# Litefin JavaScript & DOM Performance Rules (WebKit 538.1 to Chromium 130)

## 1. Runtime Compatibility Boundaries
Litefin runs across browser engines spanning 12+ years of web evolution:
- **Ultra-Legacy:** `AppleWebKit/538.1` (Tizen 2.3/2.4, webOS 1.0–2.x, Chrome 26–38 equivalents)
- **Mid-Legacy:** `Chromium 53–79` (Tizen 3.0–5.5, webOS 3.5–5.0)
- **Modern:** `Chromium 84–130+` (Tizen 6.0+, webOS 6.0+, Desktop Tauri, Android)

### Language Syntax & Transpilation Rules
- Write modern, clean ES6 syntax (classes, `const`/`let`, arrow functions, template literals, destructuring). Babel transpiles down to ES5 for normal, legacy, and ultra-legacy builds.
- **NEVER use unsupported ES2018+ syntax features** in client code without confirming Babel/core-js polyfills:
  - NO Regex lookbehind `(?<=...)` or `(?<!...)` (crashes WebKit 538.1 parser at boot time).
  - NO Regex named capture groups `(?<name>...)`.
  - NO optional chaining `?.` or nullish coalescing `??` inside non-transpiled scripts (such as `early-polyfills.js` or `logger.js`).

### Banned Runtime Browser APIs
The following browser APIs are non-existent or catastrophically slow on Tier 1 and Tier 2 engines:
- **BANNED without explicit polyfill:** `ResizeObserver`, `MutationObserver`, `AbortController`, `IntersectionObserver`.
- **BANNED on DOM collections:** `NodeList.prototype.forEach()`, `HTMLCollection.prototype.forEach()`. Always use standard `for (let i = 0; i < list.length; i++)` or `Array.from()`.
- **BANNED DOM methods:** `Element.prototype.closest()`, `Element.prototype.matches()` (unless using Litefin's `DomPolyfills.js` wrappers).
- **Feature-gated only:** `img.decode()` must always be wrapped in `if (typeof img.decode === 'function')`.
- **Event Listener Options:** Never pass `{ passive: true }` or `{ once: true }` directly to `addEventListener` without feature-detecting option support; WebKit 538.1 interprets the options object as `useCapture = true`.

---

## 2. DOM Virtualization & The Staged Migration Strategy

### The Current Reality vs The Future Standard
- **Current Baseline:** [`CardRenderer.js`](src/utils/CardRenderer.js) generates HTML strings (`imageInnerHtml`, template literals). Components currently inject cards via `innerHTML` or `tempDiv.firstElementChild`.
- **The Problem:** String parsing inside active scrolling causes rapid allocation and triggers garbage collection (GC) pauses on single-core ARM Cortex-A53 TVs, resulting in jerky 15–25 FPS scrolling.
- **The Future Standard:** True Zero-Allocation DOM Node Pooling (`CardDOMPool`), where DOM elements are created once via `document.createElement()` and continuously updated via direct property mutation.

### Staged Migration Execution Rules
To prevent breaking existing pages during the monolith refactoring:
1. **Phase 1 (Monolith Splitting - Safe Baseline):**
   - When extracting controllers from `LibraryPage` or `DetailsPage`, retain the existing `CardRenderer.renderCard()` interface.
   - Do NOT attempt to rewrite the entire card generation pipeline simultaneously with structural file splitting.
2. **Phase 2 (Virtualization Upgrade - New Controllers Only):**
   - When creating or upgrading `*GridController.js` or `*RowController.js`, implement a fixed pool of DOM nodes:
   ```javascript
   // Pre-allocate fixed pool of visible cards + 2 buffers
   const poolSize = visibleColumns * (visibleRows + 2);
   const domPool = [];
   for (let i = 0; i < poolSize; i++) {
       domPool.push(CardDOMPool.createCardSlot());
   }
   ```
3. **Phase 3 (Zero innerHTML during Scroll):**
   - During horizontal or vertical scroll transitions, NEVER set `.innerHTML = ...` or call `insertAdjacentHTML`.
   - Update cards strictly by mutating cached element references:
   ```javascript
   // Direct reference update (Zero GC pressure)
   cardSlot.img.src = itemImageUrl;
   cardSlot.title.textContent = item.Name;
   cardSlot.subtitle.textContent = item.ProductionYear || '';
   cardSlot.root.style.transform = `translate3d(${x}px, ${y}px, 0)`;
   cardSlot.root.style.webkitTransform = `translate3d(${x}px, ${y}px, 0)`;
   ```

### Image Loading & Pagination vs. Virtualization Thresholds
1. **Paginated Mode (<= 70 items):** Bypass `VirtualGrid` and `LazyLoader` completely. Render cards directly and stagger `img.src` assignment in chunks of 10–14 per frame so initial D-pad input is never blocked and scrolling is 100% native GPU compositing.
2. **Virtual / Infinite Mode (> 70 items):** Maintain an `isNavigating` lock during active D-pad key repeats. NEVER assign `img.src` or trigger `LazyLoader` mutations while `isNavigating === true`. Flush pending `img.src` updates 150ms after the last `keydown` event stops.

---

## 3. High-Frequency TV Performance Hazards

### 1. Memory Leaks & Zombie Listeners
Smart TVs execute for days without browser refreshes. Every uncleaned listener accumulates memory:
- Always pair `addEventListener` with `removeEventListener` in `.destroy()`.
- When attaching window/document listeners for global key events, store bound function references:
  ```javascript
  // CORRECT: Stored reference for exact cleanup
  this._boundOnKeyDown = this._onKeyDown.bind(this);
  window.addEventListener('keydown', this._boundOnKeyDown);

  // In destroy():
  window.removeEventListener('keydown', this._boundOnKeyDown);
  this._boundOnKeyDown = null;
  ```

### 2. V8 Hidden Class Transitions
Do not add or delete properties dynamically on high-frequency state objects (items, grid coordinates, card models).
- Initialize all object fields in constructor or factory functions to ensure stable V8/JavaScriptCore hidden classes.
- Use `null` instead of `delete obj.property`.

### 3. Layout Thrashing (Forced Synchronous Layouts)
Never interleave DOM reads (`offsetWidth`, `getBoundingClientRect()`, `scrollTop`) with DOM writes (`style.width`, `classList.add()`, `style.transform`).
- Batch all geometry queries first.
- Batch all style and transform writes in the next animation frame or tick.
- Prefer pre-calculated static layout constants (such as fixed card widths and row margins) over live DOM measurements.

### 4. Async & Promise Trapping
Legacy WebKit runtimes fail silently on unhandled promise rejections.
- Every `async` method invoked from an event handler, timer, or lifecycle hook MUST be enclosed in a `try/catch` block.
- Log failures through [`Logger.create('ModuleName')`](src/utils/Logger.js).
