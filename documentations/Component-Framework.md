# Component Framework API

Litefin uses a custom, lightweight component framework instead of a mainstream library like React or Vue. This document serves as a complete reference for the framework's classes, lifecycle, patterns, and best practices.

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Component (Base Class)](#component-base-class)
3. [Page (Base Class for Pages)](#page-base-class-for-pages)
4. [EventBus (Event System)](#eventbus-event-system)
5. [StateManager (State Management)](#statemanager-state-management)
6. [Router (Navigation)](#router-navigation)
7. [NavigationState (History State)](#navigationstate-history-state)
8. [Real-World Examples](#real-world-examples)
9. [Best Practices & Patterns](#best-practices--patterns)

---

## Architecture Overview

The framework consists of five core modules that work together:

```
┌─────────────────────────────────────────────────────────┐
│                        App.js                           │
│           Bootstraps everything, coordinates state       │
└──────┬──────────┬─────────┬──────────┬─────────────────┘
       │          │         │          │
       ▼          ▼         ▼          ▼
┌──────────┐ ┌────────┐ ┌────────┐ ┌──────────────┐
│ Component │ │ EventBus │ │ State  │ │   Router     │
│ (Base)   │ │ (Pub/Sub)│ │Manager │ │ (Hash-based) │
│          │ │         │ │(Obsrv.)│ │              │
├──────────┤ ├────────┤ ├────────┤ ├──────────────┤
│  Page    │ │  .on()  │ │ .get() │ │ .register()  │
│  (extends│ │  .emit()│ │ .set() │ │ .navigate()  │
│  Compon.)│ │  .once()│ │ .subs- │ │ .back()      │
│          │ │  .off() │ │ cribe()│ │ .reset()     │
└──────────┘ └────────┘ └────────┘ └──────────────┘
```

**Design Philosophy:**

- **No virtual DOM** — Components use direct DOM manipulation with string-based HTML rendering. This keeps the bundle tiny and avoids framework churn.
- **Singleton services** — `eventBus`, `state`, `router` are global singletons for decoupled communication.
- **Lifecycle-driven** — Components follow a predictable lifecycle: `constructor → render → mount → [updates] → destroy`.
- **Tizen-compatible** — No modern APIs that would break on Tizen 4's Chromium 56 engine.

---

## Component (Base Class)

**File:** `src/core/Component.js`

The base class for all UI elements. Every visual element — buttons, modals, grids, sidebars — extends `Component`.

### Constructor

```js
constructor((options = {}));
```

| Option      | Type          | Description                           |
| ----------- | ------------- | ------------------------------------- |
| `container` | `HTMLElement` | Parent element to mount into          |
| `props`     | `Object`      | Initial props (immutable from parent) |

**Properties set by constructor:**

| Property              | Type          | Description                          |
| --------------------- | ------------- | ------------------------------------ |
| `this.el`             | `HTMLElement` | Root DOM element of the component    |
| `this.container`      | `HTMLElement` | Parent element for mounting          |
| `this.props`          | `Object`      | Immutable props from parent          |
| `this._state`         | `Object`      | Internal mutable state               |
| `this._subscriptions` | `Array`       | Event subscriptions for auto-cleanup |
| `this._children`      | `Array`       | Child components for auto-cleanup    |
| `this._boundMethods`  | `Map`         | Cache of bound method references     |
| `this._isMounted`     | `boolean`     | Tracks mounted state                 |

### Lifecycle

```
new Component()
      │
      ▼
  render()   ← Override to return HTML string or HTMLElement
      │
      ▼
  mount()    ← Appends to DOM, sets this.el
      │
      ▼
 onMounted() ← Lifecycle hook — bind events, register focus, fetch data
      │
      ▼
  [updates via update() or setState()]
      │
      ▼
 onUpdated() ← Lifecycle hook — react to DOM changes
      │
      ▼
 destroy()   ← Cleans up subscriptions, children, DOM
      │
      ▼
onBeforeDestroy() ← Lifecycle hook — save state, release resources
      │
      ▼
 onDestroyed() ← Lifecycle hook — final cleanup
```

### Methods

#### `render()`

```js
render();
// @returns {string|HTMLElement}
```

Override this to return the component's HTML. Can return either:

- A **string** of HTML (most common)
- An **`HTMLElement`** node

```js
class Greeting extends Component {
    render() {
        return `<div class="greeting">Hello, ${this.props.name}!</div>`;
    }
}
```

#### `mount(container)`

```js
mount(container);
// @param {HTMLElement} [container] - Optional override for constructor's container
```

Mounts the component into the DOM:

1. Calls `render()` to get HTML
2. Parses string HTML into DOM nodes
3. Appends to `container`
4. Sets `this._isMounted = true`
5. Calls `onMounted()`

#### `update(newProps)`

```js
update((newProps = {}));
// @param {Object} [newProps] - Props to merge into this.props
```

Re-renders the component's inner HTML if mounted. Merges `newProps` into `this.props`, then calls `render()` and sets `this.el.innerHTML` to the result.

> **⚠️ Important Limitation:** `update()` only handles **string** returns from `render()`. If `render()` returns an `HTMLElement`, the `update()` method is effectively a no-op (the element won't be replaced). For full re-renders that need to replace `this.el` itself, destroy and re-mount instead.

> **Note:** `update()` only replaces inner HTML of `this.el`. For full re-renders (replacing `this.el` itself), destroy and re-mount.

#### `setState(newState)`

```js
setState(newState);
// @param {Object} newState - State to merge into this._state
```

Merges `newState` into `this._state` and calls `update()`. This is the primary way to trigger reactivity.

```js
class Counter extends Component {
    constructor() {
        super();
        this._state = { count: 0 };
    }
    render() {
        return `<button class="counter">${this._state.count}</button>`;
    }
    onMounted() {
        this.el.onclick = () => this.setState({ count: this._state.count + 1 });
    }
}
```

#### `destroy()`

```js
destroy();
```

Cleans up the component:

1. Calls `onBeforeDestroy()` lifecycle hook
2. Destroys all child components
3. Unsubscribes all event subscriptions
4. Removes `this.el` from DOM
5. Nullifies `this.el`
6. Calls `onDestroyed()` lifecycle hook

### Lifecycle Hooks

Override these in subclasses:

| Hook                | When It's Called                    | Common Use                                                                 |
| ------------------- | ----------------------------------- | -------------------------------------------------------------------------- |
| `onMounted()`       | After element is in DOM             | Bind DOM events, register focus sections, start observers, load async data |
| `onUpdated()`       | After `update()` replaces innerHTML | Re-bind event listeners lost during innerHTML replacement                  |
| `onBeforeDestroy()` | Start of `destroy()`                | Save state to localStorage, release resources                              |
| `onDestroyed()`     | End of `destroy()`                  | Final cleanup, emit events                                                 |

### Helper Methods

#### `$(selector)`

```js
$(selector);
// @param {string} selector - CSS selector
// @returns {HTMLElement|null}
```

Shorthand for `this.el.querySelector(selector)`. Queries within the component's root element.

```js
onMounted() {
    const title = this.$('.item-title');
    const buttons = this.$$('.action-btn');
}
```

#### `$$(selector)`

```js
$$(selector);
// @param {string} selector - CSS selector
// @returns {NodeList}
```

Shorthand for `this.el.querySelectorAll(selector)`.

#### `on(event, handler)`

```js
on(event, handler);
// @param {string} event - EventBus event name
// @param {Function} handler - Event handler
// @returns {Function} Unsubscribe function (also stored for auto-cleanup)
```

Subscribe to an EventBus event with **automatic cleanup on destroy**. This is preferred over `eventBus.on()` directly because it prevents memory leaks.

```js
onMounted() {
    // Auto-unsubscribed when component is destroyed
    this.on('user:login', (user) => {
        this.setState({ loggedIn: true });
    });
}
```

#### `emit(event, ...args)`

```js
emit(event, ...args);
// @param {string} event - EventBus event name
// @param {...any} args - Arguments to pass to handlers
```

Emit an event on the global EventBus.

```js
this.emit('player:play', { item: currentItem });
```

#### `addChild(child)`

```js
addChild(child);
// @param {Component} child - Child component to track for cleanup
```

Registers a child component so it is automatically destroyed when the parent is destroyed.

```js
onMounted() {
    const favBtn = new FavoriteButton({ itemId: this.props.id });
    favBtn.mount(this.$('.actions-container'));
    this.addChild(favBtn);
}
```

#### `bound(methodName)`

```js
bound(methodName);
// @param {string} methodName - Name of method to bind
// @returns {Function} Bound method (cached)
```

Returns a cached bound version of a method. Useful for event listeners that need to be added and removed.

```js
constructor() {
    super();
    // Cache the bound handler once
    this._onClick = this.bound('_onClick');
}
onMounted() {
    this.el.addEventListener('click', this._onClick);
}
```

### Full Component Example

```js
import Component from '../core/Component.js';
import { api } from '../api/index.js';
import { logger } from '../utils/Logger.js';

const log = logger.create('MovieCard');

class MovieCard extends Component {
    constructor(config = {}) {
        super(config);

        // Instance properties (not state — don't trigger re-render)
        this.itemId = config.itemId;
        this.title = config.title || '';
        this.year = config.year || '';

        // Internal state (triggers re-render via setState)
        this._state = { isFavorite: false };
    }

    // ── Lifecycle: Render ──────────────────────────────────────────────
    render() {
        const favClass = this._state.isFavorite ? 'active' : '';
        return `
            <div class="movie-card" data-item-id="${this.itemId}">
                <div class="card-poster">
                    <img src="${api.getImageUrl(this.itemId, 'Primary')}" alt="${this.title}" />
                </div>
                <div class="card-info">
                    <h3 class="card-title">${this.title}</h3>
                    <span class="card-year">${this.year}</span>
                    <button class="fav-btn ${favClass}" data-action="favorite">
                        ★
                    </button>
                </div>
            </div>
        `;
    }

    // ── Lifecycle: After Mount ─────────────────────────────────────────
    onMounted() {
        // Bind DOM events directly
        this.el.onclick = (e) => {
            const favBtn = e.target.closest('[data-action="favorite"]');
            if (favBtn) this._toggleFavorite();
        };

        // Subscribe to global events (auto-cleaned)
        this.on('user:logout', () => this.setState({ isFavorite: false }));

        // Query within component
        log.debug('Mounted:', this.$('.card-title')?.textContent);
    }

    // ── Lifecycle: After Update ────────────────────────────────────────
    onUpdated() {
        // Re-bind any listeners lost during innerHTML replacement
        log.debug('Re-rendered');
    }

    // ── Lifecycle: Cleanup ─────────────────────────────────────────────
    onBeforeDestroy() {
        log.debug('Cleaning up movie card:', this.title);
    }

    // ── Custom Methods ─────────────────────────────────────────────────
    async _toggleFavorite() {
        this.setState({ isFavorite: !this._state.isFavorite });
        // Additional API call logic...
    }
}

export default MovieCard;
```

---

## Page (Base Class for Pages)

**File:** `src/pages/Page.js`

`Page` extends `Component` and adds features specific to full-page views: route parameters, focus section management, back navigation, and navigation state persistence.

### Additional Properties

| Property              | Type      | Description                                                 |
| --------------------- | --------- | ----------------------------------------------------------- |
| `this.params`         | `Object`  | Route parameters (e.g., `{ id: '123' }` for `/details/:id`) |
| `this.title`          | `string`  | Page title (set in `document.title`)                        |
| `this._focusSections` | `Array`   | Registered focus section names (auto-cleaned)               |
| `this.ready`          | `Promise` | Resolves when page is fully loaded and rendered             |
| `this._routePattern`  | `string`  | The route pattern that matched (set by Router)              |

### Lifecycle for Pages

```
Page constructor
      │
      ▼
  init(params)   ← Called by Router
      │
      ├─ Mount page into container
      ├─ Restore page state (filters, sort) from navigation history
      ├─ Call onInit() ← Override for page-specific initialization
      │
      ▼
 markReady()     ← Call when async data is loaded
      │
      ▼
 [User interacts, navigation happens]
      │
      ▼
 destroy()       ← Unregisters focus sections, cleans up
```

### Key Differences from Component

| Feature          | Component | Page                                                |
| ---------------- | --------- | --------------------------------------------------- |
| Navigation state | ❌        | ✅ — `getNavigationState()`, `setNavigationState()` |
| Focus sections   | ❌        | ✅ — `registerFocusSection()`                       |
| Route params     | ❌        | ✅ — `this.params`                                  |
| Back navigation  | ❌        | ✅ — `onBack()`                                     |
| Loading state    | ❌        | ✅ — `setLoading()`                                 |
| Ready promise    | ❌        | ✅ — `this.ready`, `markReady()`                    |

### Methods

#### `init(params)`

```js
init((params = {}));
// @param {Object} params - Route parameters
```

Called by the Router after constructing the page. This is NOT overridden directly — instead, override `onInit()`. The `init` method:

1. Sets `this.params`
2. Finds and stores `this.container` (`#page-container` or `#app`)
3. Calls `this.mount()`
4. Restores navigation state (filters, scroll, focus) if coming from back navigation
5. Sets `document.title`
6. Calls `this.onInit()`
7. Restores scroll/focus for synchronous pages

#### `onInit()`

```js
onInit();
```

Override this for page-specific initialization logic. This is where you fetch data and render content.

```js
class HomePage extends Page {
    async onInit() {
        this.setLoading(true);
        try {
            const data = await api.getHomeSections();
            this.setState({ sections: data });
        } catch (err) {
            this.showError('Failed to load home page');
        } finally {
            this.setLoading(false);
            this.markReady();
        }
    }
}
```

#### `onBack()`

```js
onBack();
// @returns {boolean} True if handled, false for default router back
```

Override to handle the back button press. Return `true` if you handled it (prevents default behavior).

```js
class PlayerPage extends Page {
    onBack() {
        this.confirmExit();
        return true; // Prevent default back navigation
    }
}
```

#### `markReady()`

```js
markReady();
```

Call when the page's async data is fully loaded. This:

1. Resolves `this.ready` Promise
2. Emits `app:hideSplash` to remove the initial splash screen

```js
async onInit() {
    await this._loadData();
    this.markReady(); // Signals to NavigationState that state can be restored
}
```

#### `registerFocusSection(name, container, options)`

```js
registerFocusSection(name, container, options);
// @param {string} name - Section name
// @param {HTMLElement} container - Section container element
// @param {Object} options - FocusManager options
```

Registers a TV remote focus section with the `FocusManager`. Automatically cleaned up on page destroy.

```js
onMounted() {
    this.registerFocusSection('home-hero', this.$('.hero-section'), {
        orientation: 'horizontal',
        selector: '.hero-item'
    });
    this.registerFocusSection('home-grid', this.$('.content-grid'), {
        orientation: 'vertical'
    });
}
```

#### `setActiveSection(...args)`

```js
setActiveSection(...args);
```

Shorthand for `focusManager.setActiveSection(...)`.

#### `setLoading(show)`

```js
setLoading(show);
// @param {boolean} show - Whether to show loading state
```

Shows or hides a loading spinner inside the page. Creates a `.page-loading` element if needed.

#### `showError(message)` / `hideError()`

```js
showError(message);
// @param {string} message - Error message

hideError();
```

Show or hide an error message in the `.page-error` element.

#### `getNavigationState()` / `setNavigationState(state)`

```js
// Override to save page-specific state (filters, sort, scroll)
getNavigationState();
// @returns {Object|null}

// Override to restore page-specific state
setNavigationState(state);
// @param {Object} state - Previously captured state
```

These are called by `NavigationState` during page transitions. Override them to preserve UI state.

```js
class LibraryPage extends Page {
    getNavigationState() {
        return {
            sortBy: this._sortBy,
            sortOrder: this._sortOrder,
            filters: this._activeFilters
        };
    }

    setNavigationState(state) {
        this._sortBy = state.sortBy || 'SortName';
        this._sortOrder = state.sortOrder || 'Ascending';
        this._activeFilters = state.filters || {};
    }
}
```

#### `_renderMediaCard(item, isLandscape, type, contextType)`

```js
_renderMediaCard(item, (isLandscape = false), (type = 'poster'), (contextType = null));
```

Renders a standardized media card using `CardRenderer`. Convenience method available in all pages.

#### `restoreScrollFocusWhenReady()`

```js
restoreScrollFocusWhenReady();
```

Call from async pages after content is fully loaded to trigger scroll/focus restoration.

```js
async onInit() {
    await this._loadData();
    this.renderItems();
    this.markReady();
    this.restoreScrollFocusWhenReady(); // Restore scroll/focus now that DOM is ready
}
```

### Full Page Example

```js
import Page from './Page.js';
import { api } from '../api/index.js';
import { focusManager } from '../ui/FocusManager.js';

class LibraryPage extends Page {
    constructor() {
        super();
        this.title = 'Library'; // Sets document.title
    }

    // ── Lifecycle: Init ──────────────────────────────────────────────
    onInit() {
        const libraryId = this.params.id;
        this.setLoading(true);
        this._loadLibrary(libraryId);
    }

    // ── Render ────────────────────────────────────────────────────────
    render() {
        const items = this._state.items || [];
        return `
            <div class="library-page">
                <h1>${this._state.libraryName || 'Library'}</h1>
                <div class="library-grid" id="lib-grid">
                    ${items
                        .map(
                            (item) => `
                        <div class="media-card" data-item-id="${item.Id}">
                            ${item.Name}
                        </div>
                    `
                        )
                        .join('')}
                </div>
            </div>
        `;
    }

    // ── After Mount ──────────────────────────────────────────────────
    onMounted() {
        this.registerFocusSection('library-grid', this.$('#lib-grid'), {
            orientation: 'vertical'
        });
        this.setActiveSection('library-grid');
    }

    // ── Navigation State ─────────────────────────────────────────────
    getNavigationState() {
        return { sortBy: this._sortBy };
    }

    setNavigationState(state) {
        this._sortBy = state.sortBy || 'SortName';
    }

    // ── Back Handler ─────────────────────────────────────────────────
    onBack() {
        // Custom logic before going back
        return false; // Let router handle default behavior
    }

    // ── Private Methods ──────────────────────────────────────────────
    async _loadLibrary(id) {
        try {
            const data = await api.getLibrary(id, { sortBy: this._sortBy });
            this.setState({ items: data.Items, libraryName: data.Name });
            this.markReady();
            this.restoreScrollFocusWhenReady();
        } catch (err) {
            this.showError('Failed to load library');
        } finally {
            this.setLoading(false);
        }
    }
}

export default LibraryPage;
```

---

## EventBus (Event System)

**File:** `src/core/EventBus.js`

A global publish/subscribe event system for decoupled communication between components.

### Singleton

```js
import { eventBus } from './EventBus.js';

// Or import Component class and use this.on() / this.emit()
```

### API

#### `eventBus.on(event, callback)`

```js
const unsubscribe = eventBus.on('user:login', (user) => {
    console.log('Logged in:', user);
});
// @returns {Function} Unsubscribe function
```

Subscribe to an event. **Naming convention:** `namespace:action` (e.g., `player:play`, `auth:logout`).

> **Prefer `this.on(event, handler)` in Component subclasses** — it auto-unsubscribes on destroy.

#### `eventBus.once(event, callback)`

```js
eventBus.once('app:ready', () => {
    console.log('App initialized (fires only once)');
});
// @returns {Function} Unsubscribe function
```

Subscribe to an event that fires only once, then auto-removes.

#### `eventBus.off(event, callback)`

```js
eventBus.off('user:login', myHandler);
```

Remove a specific handler from an event.

#### `eventBus.emit(event, ...args)`

```js
eventBus.emit('player:play', { item: movie, resume: false });
```

Emit an event to all subscribers with optional arguments.

#### `eventBus.clear(event)`

```js
eventBus.clear('user:login'); // Remove all handlers for one event
eventBus.clear(); // Remove ALL handlers for ALL events
```

#### `eventBus.listenerCount(event)`

```js
const count = eventBus.listenerCount('player:play');
// @returns {number}
```

### Common Events (Reference)

| Event                                    | Payload                                       | Emitted By                           |
| ---------------------------------------- | --------------------------------------------- | ------------------------------------ |
| `app:ready`                              | —                                             | `App.js`                             |
| `app:hideSplash`                         | —                                             | `Page.markReady()`                   |
| `app:hidden` / `app:visible`             | —                                             | `App.js` (visibility change)         |
| `app:exitRequested`                      | —                                             | `App.js` (back with no history)      |
| `app:beforeExit`                         | —                                             | `App.js` (close/background)          |
| `auth:login`                             | —                                             | AuthManager                          |
| `auth:logout`                            | —                                             | AuthManager                          |
| `auth:expired`                           | —                                             | AuthManager                          |
| `auth:switchToProfiles`                  | —                                             | AuthManager                          |
| `router:navigate`                        | `{ path, params }`                            | Router                               |
| `router:notFound`                        | `{ path }`                                    | Router                               |
| `player:play`                            | `{ item, resume, mediaSourceId, ... }`        | App.js                               |
| `key:back`                               | —                                             | App.js / Platform Adapters           |
| `focus:changed`                          | Element                                       | FocusManager                         |
| `state:{key}`                            | `newValue, oldValue`                          | StateManager (for each state change) |
| `remote:playnow`                         | `{ itemIds, startIndex, startPositionTicks }` | WebSocketHandler                     |
| `syncplay:enabled` / `syncplay:disabled` | —                                             | SyncPlayManager                      |
| `prefChanged:{key}`                      | New value                                     | Settings pages                       |

---

## StateManager (State Management)

**File:** `src/core/StateManager.js`

A simple observable state container. Components can subscribe to changes and reactively update.

### Singleton

```js
import { state } from './StateManager.js';
```

### API

#### `state.get(key, defaultValue)`

```js
state.get('user:authenticated'); // false
state.get('user:data'); // { Name: 'John', ... }
state.get('server:url'); // 'http://192.168.1.100:8096'
state.get('nonexistent', 'fallback'); // 'fallback'
```

#### `state.set(key, value, silent)`

```js
state.set('app:layout', 'modern');
state.set('user:authenticated', true);
state.set('user:data', { Name: 'Jane' }, true); // silent — no subscriber notification
```

#### `state.update(key, updater)`

```js
state.update('player:position', (oldPos) => oldPos + 1);
```

#### `state.delete(key)`

```js
state.delete('temp:cache');
```

#### `state.has(key)`

```js
if (state.has('user:data')) { ... }
```

#### `state.subscribe(key, callback)`

```js
const unsubscribe = state.subscribe('app:layout', (newVal, oldVal) => {
    console.log(`Layout changed from ${oldVal} to ${newVal}`);
});
```

#### `state.unsubscribe(key, callback)`

#### `state.getAll()`

```js
console.log(state.getAll()); // { 'app:layout': 'modern', 'user:authenticated': true, ... }
```

#### `state.clear()`

### Common State Keys (Reference)

| Key                    | Type                      | Description                   |
| ---------------------- | ------------------------- | ----------------------------- |
| `app:layout`           | `'classic'` or `'modern'` | Current layout mode           |
| `user:authenticated`   | `boolean`                 | Whether user is logged in     |
| `user:data`            | `Object`                  | Current user object           |
| `user:sessionCount`    | `number`                  | Number of stored sessions     |
| `server:url`           | `string`                  | Server base URL               |
| `server:connected`     | `boolean`                 | Server connection status      |
| `server:offline`       | `boolean`                 | Whether server is unreachable |
| `router:currentPath`   | `string`                  | Current route path            |
| `router:currentParams` | `Object`                  | Current route params          |
| `player:contextType`   | `string`                  | Playback context type         |
| `player:contextId`     | `string`                  | Playback context ID           |

### State Change Events

Every `state.set()` call also emits an event on the EventBus:

```js
state.set('app:layout', 'modern');
// Also emits: eventBus.emit('state:app:layout', 'modern', 'classic')
```

---

## Router (Navigation)

**File:** `src/core/Router.js`

A hash-based router for single-page navigation. Does NOT require the History API, making it compatible with older TV browsers.

### Singleton

```js
import { router } from './core/Router.js';
```

### API

#### `router.register(pattern, PageClass)`

```js
router.register('/home', HomePage);
router.register('/library/:id', LibraryPage);
router.register('/details/:id', DetailsPage);
router.register('/player/:id/:resume', PlayerPage);

// Can also register plain objects (for redirects):
router.register('/', {
    init: () => {
        router.navigate('/home', { replace: true });
    }
});
```

Route patterns use `:param` syntax for dynamic segments.

#### `router.navigate(path, options)`

```js
// Standard navigation (adds to history)
router.navigate('/details/movie-123');

// Replace current entry (no back-stack entry)
router.navigate('/home', { replace: true });

// Pass state to the new page
router.navigate('/library/movies', { state: { filter: 'genre:action' } });
```

| Option    | Type      | Default | Description                              |
| --------- | --------- | ------- | ---------------------------------------- |
| `replace` | `boolean` | `false` | Replace current history entry            |
| `state`   | `Object`  | `null`  | Additional state for the new page        |
| `isBack`  | `boolean` | `false` | Flag as back navigation (restores state) |

#### `router.back()`

```js
const couldGoBack = router.back(); // @returns {boolean}
```

Navigates to the previous page in history. Returns `false` if there's no history.

#### `router.reset(path)`

```js
router.reset('/home');
```

Clears all history and navigates to a path (with `replace: true`).

#### `router.getCurrentPath()`

```js
const path = router.getCurrentPath();
// @returns {string} e.g., '/details/movie-123'
```

#### `router.getCurrentPage()`

```js
const page = router.getCurrentPage();
// @returns {Page|null}
```

#### `router.canGoBack()`

```js
if (router.canGoBack()) { ... }
// @returns {boolean}
```

#### `router.reload()`

```js
router.reload();
```

Reloads the current page in-place, preserving focus and scroll state.

### History Management

The Router maintains an internal history stack (max 20 entries). When navigating to a path already in the stack, it truncates to that entry and restores its saved state (preventing duplicate entries).

Navigation state (scroll position, focus, filters) is captured by `NavigationState` and stored alongside each history entry.

---

## NavigationState (History State)

**File:** `src/core/NavigationState.js`

Captures and restores page state during navigation — scroll position, focus element, and page-specific state (filters, sort, pagination).

### Singleton

```js
import { navigationState } from './core/NavigationState.js';
```

This is primarily used internally by `Router` and `Page`, but can be leveraged for advanced state management.

### Key Methods

#### `captureState(pageInstance)`

Called by Router before destroying the current page. Captures:

- Scroll position
- Focus section and element (by index, selector, or data attributes)
- Page-specific state via `pageInstance.getNavigationState()`

#### `restorePageState(pageInstance, state)`

Restores page-specific state (filters, sort) via `pageInstance.setNavigationState()`.

#### `restoreScrollFocus(pageInstance, state)`

Restores scroll position and focus after the page's `ready` Promise resolves.

#### `restoreState(pageInstance, state, callback)`

Legacy method that calls both `restorePageState` and `restoreScrollFocus`.

### Focus Restoration Strategy

The state restoration is prioritized:

1. **Section `onRestoreIndex` hook** — For virtualized lists, uses a custom callback to find the item
2. **CSS Selector** — `[data-item-id="xxx"]`, `[data-episode-id="xxx"]`, `#element-id`
3. **Section + Index** — Falls back to index position within section
4. **Section auto-focus** — FocusManager sets default focus

---

## Real-World Examples

### Example 1: FavoriteButton (Stateless Component with Props)

**File:** `src/components/FavoriteButton.js`

A simple toggle button that uses props for configuration and direct DOM updates (no string re-rendering).

```js
import Component from '../core/Component.js';
import { api } from '../api/index.js';

class FavoriteButton extends Component {
    constructor(config = {}) {
        super(config);
        this.itemId = config.itemId;
        this.isFavorite = !!config.initialState;
        this.onChange = config.onChange || (() => {});
    }

    render() {
        const activeClass = this.isFavorite ? 'active' : '';
        return `<button class="fav-btn ${activeClass}" tabindex="0">${this._getIcon()}</button>`;
    }

    onMounted() {
        this.el.onclick = () => this.toggle();
    }

    async toggle() {
        // API call...
        this.isFavorite = !this.isFavorite;

        // Direct DOM manipulation (more performant than full re-render for small changes)
        this.el.classList.toggle('active');
        this.el.innerHTML = this._getIcon();

        this.onChange(this.isFavorite);
    }
}
```

**Pattern:** Uses direct DOM manipulation (classList, innerHTML) instead of full re-render for performance.

### Example 2: Sidebar (Complex Component with Multiple Concerns)

**File:** `src/components/Sidebar.js`

Demonstrates complex patterns: async data loading, event subscriptions, FocusManager integration, and multiple lifecycle hooks.

**Key patterns demonstrated:**

- **Delegated event binding** via `_bindItem()` to handle Magic Remote quirks
- **MutationObserver** to track focus changes for auto-expand/collapse
- **Dynamic children** — library items fetched async and inserted into DOM
- **Layout customization** — hot-reloads sidebar order from user preferences
- **Focus integration** — registers a `sidebar` focus section with custom `onMove` handler
- **Multiple subscriptions** — auth events, route changes, preference changes
- **Clean cleanup** — `onDestroyed()` unregisters everything

### Example 3: MediaGrid (Reusable Grid Component)

**File:** `src/components/MediaGrid.js`

A reusable grid component for displaying media items with "See More" functionality.

**Key patterns demonstrated:**

- **Generic component** — accepts config with `id`, `title`, `items`, `limit`, callbacks
- **Event delegation** — single click/mousedown listener on the grid container handles all card clicks
- **Lazy loading** — integrates with `LazyLoader` for image lazy loading
- **Focus cache invalidation** — calls `focusManager.invalidateCache()` after dynamic content changes

### Example 4: Toast (Utility — Not a Component)

**File:** `src/ui/Toast.js`

The Toast notification system does NOT extend `Component`. It's a plain class that manages its own DOM.

**Why?** The Toast is a singleton overlay (not a page or reusable component). It's always present and manages its own container and styles.

**Pattern:** Not every UI element needs to extend `Component`. Use plain classes for: singletons, overlays, managers, and utilities.

### Example 5: HeroCarousel (Plain Class with Focus Integration)

**File:** `src/ui/HeroCarousel.js`

A complex UI element implemented as a plain class (not extending `Component`).

**Key patterns:**

- **Render then init pattern** — `render()` produces HTML, `init()` wires up events after DOM insertion
- **FocusManager integration** — registers a focus section with directional movement (prev/next slide)
- **EventBus subscriptions** — listens for `focus:changed` to pause/resume auto-scroll
- **Timer management** — auto-scroll with pause-on-blur, restart-on-focus
- **CSS animation sync** — carefully manages animation frames to avoid layout thrashing on Tizen

### Example 6: BaseMenu (Abstract OSD Menu)

**File:** `src/player/osd/BaseMenu.js`

An abstract base class for OSD menus. Extend this to create overlay menus used during playback.

```js
class ChaptersModal extends BaseMenu {
    constructor(osdController) {
        super(osdController);
        this.isModal = true; // Full-screen overlay
    }

    show() {
        this._render();
        super.show();
    }

    handleKey(key) {
        if (key === 'Back') {
            this.hide();
            return true;
        }
        return false;
    }
}
```

---

## Best Practices & Patterns

### 1. Component vs. Plain Class

| Use `Component`                          | Use a Plain Class                 |
| ---------------------------------------- | --------------------------------- |
| Reusable UI element (button, card, grid) | Singleton utility (Toast, Logger) |
| Part of a page's hierarchy               | Backend service (API, Storage)    |
| Has lifecycle events                     | Manager class (FocusManager)      |
| Needs auto-cleanup                       | Always-present overlay            |

### 2. State Management

| Approach                            | When to Use                                        |
| ----------------------------------- | -------------------------------------------------- |
| `this._state` + `setState()`        | Component-local state (form inputs, toggle states) |
| `state.set()` / `state.get()`       | App-wide state (auth, layout, server info)         |
| `this.props`                        | Immutable values passed from parent                |
| DOM directly (classList, innerHTML) | Simple visual toggles without full re-render       |

### 3. Event Patterns

- **Use `this.on()` in components** for automatic cleanup on destroy
- **Name events consistently:** `namespace:action` (e.g., `player:play`, `auth:logout`)
- **Emit events for significant state changes** — not for every minor update
- **Use `eventBus.once()` for one-time initialization** (e.g., `app:ready`)

### 4. DOM Event Binding

- **Use event delegation** for lists/grids (single listener on container)
- **`onmousedown` + `onclick`** for TV compatibility (Magic Remote sends both)
- **40ms debounce** (`KEY_DEBOUNCE_MS` in FocusManager) to prevent double-activation on WebOS
- **Attach listeners in `onMounted()`** after DOM is inserted

### 5. Focus Management (TV Remote)

- **Register sections in `onMounted()`** — unregistered automatically in `Page.destroy()`
- **Use `orientation: 'horizontal' | 'vertical'`** to constrain D-pad navigation
- **Implement `onMove`** for custom directional behavior (e.g., carousel prev/next)
- **Call `focusManager.invalidateCache()`** after dynamic DOM changes
- **Use `data-item-id` attributes** for stable focus restoration

### 6. Performance Considerations

- **Direct DOM manipulation** is faster than full re-renders for small changes
- **Avoid forced reflows** — split remove/add across animation frames on Tizen
- **Lazy load images** via `LazyLoader.observe()`
- **Limit history stack** to 20 entries (Router default)
- **Use inline styles with `!important`** for critical UI (Toast) on Tizen

### 7. Async Patterns

- **`setLoading(true)`** before async operations
- **`markReady()`** after data is loaded
- **`restoreScrollFocusWhenReady()`** for pages that load data asynchronously
- **Handle errors** with `showError()` / `hideError()`
- **Wrap async calls in try/catch** — unhandled rejections crash the app on Tizen

### 8. Cleanup Checklist

Always clean up in `destroy()` / `onDestroyed()`:

- [ ] Unregister FocusManager sections
- [ ] Remove event listeners from DOM elements
- [ ] Disconnect MutationObservers / IntersectionObservers
- [ ] Clear timers and intervals
- [ ] Destroy child components
- [ ] Unsubscribe from EventBus (auto if using `this.on()`)

---

## Quick Reference

| Need             | Import                                                         |
| ---------------- | -------------------------------------------------------------- |
| Base class       | `import Component from '../core/Component.js'`                 |
| Base page        | `import Page from '../pages/Page.js'`                          |
| Events           | `import { eventBus } from '../core/EventBus.js'`               |
| State            | `import { state } from '../core/StateManager.js'`              |
| Router           | `import { router } from '../core/Router.js'`                   |
| Navigation state | `import { navigationState } from '../core/NavigationState.js'` |
| Logger           | `import { logger } from '../utils/Logger.js'`                  |
| Focus manager    | `import { focusManager } from '../ui/FocusManager.js'`         |
| Card rendering   | `import CardRenderer from '../utils/CardRenderer.js'`          |
| API              | `import { api, auth } from '../api/index.js'`                  |

---

## File Locations

| File                          | Purpose                    |
| ----------------------------- | -------------------------- |
| `src/core/Component.js`       | Base component class       |
| `src/core/EventBus.js`        | Global event system        |
| `src/core/StateManager.js`    | Observable state           |
| `src/core/Router.js`          | Hash-based router          |
| `src/core/NavigationState.js` | Navigation history state   |
| `src/pages/Page.js`           | Base page class            |
| `src/utils/Logger.js`         | Logging utility            |
| `src/ui/FocusManager.js`      | TV remote focus management |
| `src/utils/CardRenderer.js`   | Media card HTML generation |
| `src/ui/LayoutManager.js`     | App layout management      |
