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
        contains: (target) => {
            if (target === el) return true;
            return children.some((child) => child === target || (child.contains && child.contains(target)));
        },
        closest: (selector) => {
            if (selector === '[data-fm-section]') {
                if (el.dataset.fmSection) return el;
                if (el.parentNode && el.parentNode.closest) return el.parentNode.closest(selector);
            }
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

    const mockDoc = {
        dir: 'ltr',
        contains: () => true,
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
    return { fm, emittedEvents };
}

test('Focus trap blocks external setActiveSection and focusElement calls', () => {
    const { fm, emittedEvents } = setupTestEnvironment();

    // 1. Setup normal background page section (e.g. HomePage row)
    const homeRowContainer = createMockElement('div', 'home-row-0-items');
    const homeCard1 = createMockElement('div', 'card-1', ['media-card']);
    const homeCard2 = createMockElement('div', 'card-2', ['media-card']);
    homeRowContainer.appendChild(homeCard1);
    homeRowContainer.appendChild(homeCard2);

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
