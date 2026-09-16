import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

/**
 * ============================================================================
 * Focus Trap Enforcement Test Suite
 * ============================================================================
 * Verifies that when a modal focus trap (such as ExitDialog) is active:
 *   1. isTrapped() returns true.
 *   2. setActiveSection() rejects any attempt to switch away from '__trap__'.
 *   3. focusElement() rejects any attempt to focus elements outside the trap container.
 *   4. focusElement() permits navigation between elements inside the trap container.
 *   5. popTrap() releases the trap, restores previous focus/section, and emits focus:trapPopped.
 * ============================================================================
 */

// Load FocusManager source code directly with imports and exports stripped to run in VM
const fmSource = readFileSync(new URL('../src/ui/FocusManager.js', import.meta.url), 'utf8')
    .replace(/\r\n/g, '\n')
    .replace(/^import .*;\n/gm, '')
    .replace(/^export default .*;\n/gm, '')
    .replace(/^export const .*;\n/gm, '');

function createMockElement(tag = 'div', id = '', classes = []) {
    const classList = new Set(classes);
    const children = [];
    const attributes = {};
    const dataset = {};

    const el = {
        tagName: tag.toUpperCase(),
        id,
        dataset,
        style: {},
        matches: (selector) => {
            if (selector.startsWith('#') && el.id === selector.slice(1)) return true;
            if (selector.startsWith('.') && classList.has(selector.slice(1))) return true;
            if (selector.includes('button') && el.tagName === 'BUTTON') return true;
            return false;
        },
        classList: {
            add: (...cls) => cls.forEach((c) => classList.add(c)),
            remove: (...cls) => cls.forEach((c) => classList.delete(c)),
            contains: (c) => classList.has(c)
        },
        setAttribute: (k, v) => { attributes[k] = String(v); },
        getAttribute: (k) => attributes[k] || null,
        hasAttribute: (k) => k in attributes,
        blur: () => {},
        focus: () => {},
        click: () => {},
        appendChild: (child) => {
            children.push(child);
            child.parentNode = el;
            return child;
        },
        removeChild: (child) => {
            const idx = children.indexOf(child);
            if (idx !== -1) children.splice(idx, 1);
            child.parentNode = null;
            return child;
        },
        contains: (target) => {
            if (target === el) return true;
            return children.some((child) => child === target || (child.contains && child.contains(target)));
        },
        closest: (selector) => {
            if (typeof el.matches === 'function' && el.matches(selector)) return el;
            if (selector === '[data-fm-section]' && el.dataset.fmSection) return el;
            if (el.parentNode && typeof el.parentNode.closest === 'function') return el.parentNode.closest(selector);
            return null;
        },
        querySelectorAll: (selector) => {
            const results = [];
            for (const child of children) {
                if (child.matches && child.matches(selector)) {
                    results.push(child);
                }
                if (child.querySelectorAll) {
                    results.push(...child.querySelectorAll(selector));
                }
            }
            return results;
        },
        querySelector: (selector) => {
            const all = el.querySelectorAll(selector);
            return all.length > 0 ? all[0] : null;
        }
    };

    return el;
}

function setupTestEnvironment() {
    const eventListeners = new Map();
    const emittedEvents = [];

    const mockEventBus = {
        on: (ev, fn) => {
            if (!eventListeners.has(ev)) eventListeners.set(ev, []);
            eventListeners.get(ev).push(fn);
        },
        off: (ev, fn) => {
            if (eventListeners.has(ev)) {
                const list = eventListeners.get(ev).filter((cb) => cb !== fn);
                eventListeners.set(ev, list);
            }
        },
        emit: (ev, data) => {
            emittedEvents.push({ ev, data });
            const list = eventListeners.get(ev) || [];
            list.forEach((cb) => cb(data));
        }
    };

    const mockBody = createMockElement('body');
    const mockDoc = {
        dir: 'ltr',
        body: mockBody,
        contains: (target) => (target ? mockBody.contains(target) : false),
        addEventListener: () => {},
        removeEventListener: () => {},
        documentElement: { dir: 'ltr' }
    };

    const context = vm.createContext({
        eventBus: mockEventBus,
        logger: {
            create: () => ({
                info() {},
                debug() {},
                warn() {},
                error() {}
            })
        },
        spatialNavigator: {
            findNext: () => null,
            findClosest: () => null
        },
        scrollController: {
            scrollIntoView() {},
            smoothScrollTo() {},
            getScrollContainer: () => null,
            resetCache() {}
        },
        storage: {
            getItem: () => null,
            setItem: () => {},
            removeItem: () => {}
        },
        document: mockDoc,
        requestAnimationFrame: (cb) => cb(),
        Date,
        Math,
        Array,
        Set,
        Map
    });

    const script = `
        ${fmSource}
        new FocusManager();
    `;

    const fm = vm.runInContext(script, context);
    return { fm, emittedEvents, document: mockDoc };
}

test('Focus trap blocks external setActiveSection and focusElement calls', () => {
    const { fm, emittedEvents, document } = setupTestEnvironment();

    // 1. Setup normal background page section (e.g. HomePage row)
    const homeRowContainer = createMockElement('div', 'home-row-0-items');
    const homeCard1 = createMockElement('div', 'card-1', ['media-card']);
    const homeCard2 = createMockElement('div', 'card-2', ['media-card']);
    homeRowContainer.appendChild(homeCard1);
    homeRowContainer.appendChild(homeCard2);
    document.body.appendChild(homeRowContainer);

    fm.register('home-row-0', homeRowContainer, {
        selector: '.media-card',
        orientation: 'horizontal'
    });

    // Focus initial card on home page
    fm.setActiveSection('home-row-0');
    fm.focusElement(homeCard1);

    assert.strictEqual(fm.getActiveSection(), 'home-row-0');
    assert.strictEqual(fm.getFocused(), homeCard1);
    assert.strictEqual(fm.isTrapped(), false);

    // 2. User presses Back rapidly -> ExitDialog opens and pushes focus trap
    const modalContainer = createMockElement('div', 'exit-dialog-actions');
    const btnCancel = createMockElement('button', 'exit-dialog-no');
    const btnYes = createMockElement('button', 'exit-dialog-yes');
    modalContainer.appendChild(btnCancel);
    modalContainer.appendChild(btnYes);
    document.body.appendChild(modalContainer);

    fm.pushTrap(modalContainer, {
        orientation: 'horizontal',
        enterTo: 'first'
    });

    assert.strictEqual(fm.isTrapped(), true, 'FocusManager should report isTrapped() === true');
    assert.strictEqual(fm.getActiveSection(), '__trap__', 'Active section must be __trap__');
    assert.strictEqual(fm.getFocused(), btnCancel, 'Cancel button in modal must receive focus');

    // 3. HomePage finishes loading asynchronously in background and attempts to steal focus
    fm.setActiveSection('home-row-0', false);
    assert.strictEqual(
        fm.getActiveSection(),
        '__trap__',
        'setActiveSection must be blocked from switching away from __trap__ while trapped'
    );

    fm.focusElement(homeCard2);
    assert.strictEqual(
        fm.getFocused(),
        btnCancel,
        'focusElement must block focusing external elements outside the trap'
    );

    // 4. Focus navigation INSIDE the modal is permitted
    fm.focusElement(btnYes);
    assert.strictEqual(
        fm.getFocused(),
        btnYes,
        'focusElement must allow switching focus to elements inside the trap container'
    );

    // 5. User cancels dialog -> popTrap() releases the trap
    fm.popTrap();

    assert.strictEqual(fm.isTrapped(), false, 'FocusManager should report isTrapped() === false after popTrap');
    assert.strictEqual(fm.getActiveSection(), 'home-row-0', 'Active section should restore to home-row-0');
    assert.strictEqual(fm.getFocused(), homeCard1, 'Focused element should restore to homeCard1');

    // Verify focus:trapPopped event was emitted
    const trapPoppedEvent = emittedEvents.find((e) => e.ev === 'focus:trapPopped');
    assert.ok(trapPoppedEvent, 'focus:trapPopped event must be emitted when popTrap is called');

    // 6. After popTrap, external sections can be focused again normally
    fm.focusElement(homeCard2);
    assert.strictEqual(fm.getFocused(), homeCard2, 'After popTrap, external elements can be focused');
});

test('popTrap falls back cleanly when previous element is detached or recycled', () => {
    const { fm, document } = setupTestEnvironment();

    const sidebarContainer = createMockElement('div', 'sidebar');
    const sidebarHome = createMockElement('button', 'sidebar-home');
    sidebarContainer.appendChild(sidebarHome);
    document.body.appendChild(sidebarContainer);
    fm.register('sidebar', sidebarContainer, { orientation: 'vertical' });

    const rowContainer = createMockElement('div', 'home-row-0');
    const card1 = createMockElement('div', 'card-1', ['media-card']);
    const card2 = createMockElement('div', 'card-2', ['media-card']);
    rowContainer.appendChild(card1);
    rowContainer.appendChild(card2);
    document.body.appendChild(rowContainer);
    fm.register('home-row-0', rowContainer, { orientation: 'horizontal' });

    // Focus card1
    fm.setActiveSection('home-row-0');
    fm.focusElement(card1);
    assert.strictEqual(fm.getFocused(), card1);

    // Push trap
    const modalContainer = createMockElement('div', 'exit-dialog');
    const btnCancel = createMockElement('button', 'btn-cancel');
    modalContainer.appendChild(btnCancel);
    document.body.appendChild(modalContainer);

    fm.pushTrap(modalContainer);
    assert.strictEqual(fm.isTrapped(), true);
    assert.strictEqual(fm.getFocused(), btnCancel);

    // Simulate card1 being detached / recycled by virtualization while dialog was visible
    rowContainer.removeChild(card1);

    // Pop trap
    fm.popTrap();

    // Verify trap was popped and focus was safely restored (did not throw or stay on detached element)
    assert.strictEqual(fm.isTrapped(), false);
    assert.ok(fm.getFocused() !== null, 'An element must be focused after popping trap');
    assert.strictEqual(document.contains(fm.getFocused()), true, 'Focused element must be in the document');
});

test('popTrap falls back to another registered section if active section has no items', () => {
    const { fm, document } = setupTestEnvironment();

    const sidebarContainer = createMockElement('div', 'sidebar');
    const sidebarHome = createMockElement('button', 'sidebar-home');
    sidebarContainer.appendChild(sidebarHome);
    document.body.appendChild(sidebarContainer);
    fm.register('sidebar', sidebarContainer, { orientation: 'vertical' });

    // Register an empty row
    const emptyRowContainer = createMockElement('div', 'empty-row');
    document.body.appendChild(emptyRowContainer);
    fm.register('empty-row', emptyRowContainer, { orientation: 'horizontal' });

    fm.setActiveSection('empty-row', false);

    // Push trap
    const modalContainer = createMockElement('div', 'exit-dialog');
    const btnCancel = createMockElement('button', 'btn-cancel');
    modalContainer.appendChild(btnCancel);
    document.body.appendChild(modalContainer);

    fm.pushTrap(modalContainer);
    assert.strictEqual(fm.isTrapped(), true);

    // Pop trap -> empty-row has no items, should fallback to sidebar
    fm.popTrap();

    assert.strictEqual(fm.isTrapped(), false);
    assert.strictEqual(fm.getActiveSection(), 'sidebar');
    assert.strictEqual(fm.getFocused(), sidebarHome);
});

test('_move self-heals when activeSection is missing or invalid', () => {
    const { fm, document } = setupTestEnvironment();

    const sidebarContainer = createMockElement('div', 'sidebar');
    const sidebarHome = createMockElement('button', 'sidebar-home');
    sidebarContainer.appendChild(sidebarHome);
    document.body.appendChild(sidebarContainer);
    fm.register('sidebar', sidebarContainer, { orientation: 'vertical' });

    // Forcibly clear activeSection and focusedElement to simulate corrupted state
    fm._activeSection = null;
    fm._focusedElement = null;

    // Trigger directional move
    fm._move('down');

    // Should self-heal by finding sidebar and focusing sidebarHome
    assert.strictEqual(fm.getActiveSection(), 'sidebar');
    assert.strictEqual(fm.getFocused(), sidebarHome);
});

test('HomePage onBack returns true and emits app:exitRequested', () => {
    const homePageSource = readFileSync(new URL('../src/pages/HomePage.js', import.meta.url), 'utf8');
    assert.match(
        homePageSource,
        /onBack\(\)\s*\{[^}]*eventBus\.emit\(['"]app:exitRequested['"]\)[^}]*return true;/,
        'HomePage.onBack() must emit app:exitRequested and return true to prevent App.js router.back fallback'
    );
});

test('pushTrap respects defaultFocusSelector to focus Exit button by default', () => {
    const { fm, document } = setupTestEnvironment();

    const modalContainer = createMockElement('div', 'exit-dialog-actions');
    const btnCancel = createMockElement('button', 'exit-dialog-no');
    const btnYes = createMockElement('button', 'exit-dialog-yes');
    modalContainer.appendChild(btnCancel);
    modalContainer.appendChild(btnYes);
    document.body.appendChild(modalContainer);

    fm.pushTrap(modalContainer, {
        orientation: 'horizontal',
        defaultFocusSelector: '#exit-dialog-yes'
    });

    assert.strictEqual(fm.isTrapped(), true);
    assert.strictEqual(fm.getFocused(), btnYes, 'Initial focus should land on Exit/Yes button');
});

test('_getFocusables does not lock empty array in cache when section becomes visible', () => {
    const { fm, document } = setupTestEnvironment();

    const sidebarContainer = createMockElement('div', 'sidebar');
    const sidebarHome = createMockElement('button', 'sidebar-home', ['sidebar-item']);
    sidebarContainer.appendChild(sidebarHome);
    document.body.appendChild(sidebarContainer);
    fm.register('sidebar', sidebarContainer, {
        orientation: 'vertical',
        selector: '.sidebar-item'
    });

    // 1. Simulate sidebar being hidden (e.g. while in player)
    sidebarContainer.classList.add('hidden');

    // Query focusables while hidden -> should return empty
    const hiddenItems = fm._getFocusables('sidebar', false);
    assert.strictEqual(hiddenItems.length, 0, 'Hidden sidebar should return 0 focusables');

    // 2. Unhide sidebar (e.g. player exited)
    sidebarContainer.classList.remove('hidden');

    // Query focusables again with forceRefresh = false -> must NOT return stale empty cache []
    const visibleItems = fm._getFocusables('sidebar', false);
    assert.strictEqual(visibleItems.length, 1, 'Unhidden sidebar must return available focusables without stale cache lock');
    assert.strictEqual(visibleItems[0], sidebarHome);
});




