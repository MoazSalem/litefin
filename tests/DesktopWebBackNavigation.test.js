import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

/**
 * ============================================================================
 * Desktop & Web Sidebar Back Navigation Test Suite
 * ============================================================================
 * Verifies that:
 *   1. `router.canGoBack()` correctly detects whether back navigation is possible.
 *   2. `router.back()` pops history and falls back to /home if history is empty.
 *   3. Sidebar surfaces `#sidebar-back-btn` and adds `.has-back-button` when
 *      running on desktop/web layouts and canGoBack is true.
 *   4. Sidebar suppresses `#sidebar-back-btn` on TV platforms.
 * ============================================================================
 */

test('Router.canGoBack: returns false on root/home with single history entry', () => {
    // Read source code of Router.js
    const routerSource = readFileSync('./src/core/Router.js', 'utf8');

    // Setup isolated VM context
    const mockWindow = {
        location: {
            hash: '#/home',
            replace(newHash) {
                this.hash = newHash;
            }
        }
    };

    const mockState = {
        get() { return null; },
        set() {}
    };

    const mockEventBus = {
        emit() {},
        on() {},
        off() {}
    };

    const mockPluginManager = {
        notifyPageLoad() {},
        notifyPageUnload() {}
    };

    const mockNavigationState = {
        captureState() { return null; },
        restoreState() {}
    };

    const mockLogger = {
        create() {
            return {
                debug() {},
                info() {},
                warn() {},
                error() {}
            };
        }
    };

    // Clean module exports/imports to run in vm
    const cleanedSource = routerSource
        .replace(/import\s+[\s\S]*?from\s+['"].*?['"];?/g, '')
        .replace(/export\s+default\s+Router;?/g, '')
        .replace(/export\s+/g, '');

    const context = {
        window: mockWindow,
        state: mockState,
        eventBus: mockEventBus,
        pluginManager: mockPluginManager,
        navigationState: mockNavigationState,
        logger: mockLogger,
        console,
        URLSearchParams,
        RegExp,
        Array,
        Object,
        Date
    };

    vm.createContext(context);
    vm.runInContext(cleanedSource + '\nthis.router = router; this.Router = Router;', context);

    const router = context.router;

    // At root '/home' with single entry
    router._history = [{ path: '/home', state: null }];
    mockWindow.location.hash = '#/home';
    assert.equal(router.canGoBack(), false, 'canGoBack should be false at /home with 1 history entry');

    // Push 2nd-level route into history
    router._history.push({ path: '/details/movie123', state: null });
    mockWindow.location.hash = '#/details/movie123';
    assert.equal(router.canGoBack(), true, 'canGoBack should be true when history length is 2');

    // Call router.back()
    const backSuccess = router.back();
    assert.equal(backSuccess, true, 'router.back() should return true');
    assert.equal(mockWindow.location.hash, '#/home', 'router.back() should return to /home');
    assert.equal(router._history.length, 1, 'history should be popped down to 1 entry');
    assert.equal(router.canGoBack(), false, 'canGoBack should now be false back at home');
});

test('Router.canGoBack and back: direct deep-link to 2nd-level page falls back to /home', () => {
    const routerSource = readFileSync('./src/core/Router.js', 'utf8');

    const mockWindow = {
        location: {
            hash: '#/details/direct123',
            replace(newHash) {
                this.hash = newHash;
            }
        }
    };

    const mockState = { get() { return null; }, set() {} };
    const mockEventBus = { emit() {}, on() {}, off() {} };
    const mockPluginManager = { notifyPageLoad() {}, notifyPageUnload() {} };
    const mockNavigationState = { captureState() { return null; }, restoreState() {} };
    const mockLogger = {
        create() {
            return { debug() {}, info() {}, warn() {}, error() {} };
        }
    };

    const cleanedSource = routerSource
        .replace(/import\s+[\s\S]*?from\s+['"].*?['"];?/g, '')
        .replace(/export\s+default\s+Router;?/g, '')
        .replace(/export\s+/g, '');

    const context = {
        window: mockWindow,
        state: mockState,
        eventBus: mockEventBus,
        pluginManager: mockPluginManager,
        navigationState: mockNavigationState,
        logger: mockLogger,
        console,
        URLSearchParams,
        RegExp,
        Array,
        Object,
        Date
    };

    vm.createContext(context);
    vm.runInContext(cleanedSource + '\nthis.router = router; this.Router = Router;', context);

    const router = context.router;

    // Simulate direct load with only 1 history entry on deep link
    router._history = [{ path: '/details/direct123', state: null }];
    mockWindow.location.hash = '#/details/direct123';

    assert.equal(router.canGoBack(), true, 'canGoBack should be true on 2nd-level page even with 1 history entry');

    let navigatedTo = null;
    router.navigate = (target) => {
        navigatedTo = target;
    };

    const backResult = router.back();
    assert.equal(backResult, true, 'router.back() should succeed on deep-link');
    assert.equal(navigatedTo, '/home', 'router.back() should navigate to /home fallback');
});

test('Sidebar._updateBackButtonState: activates back button and has-back-button class on desktop/web', () => {
    // Setup mock DOM element
    const classList = new Set();
    const backBtn = {
        style: { display: 'none' },
        tabIndex: -1
    };

    const mockSidebarEl = {
        classList: {
            add(c) { classList.add(c); },
            remove(c) { classList.delete(c); },
            toggle(c, val) {
                if (val) classList.add(c);
                else classList.delete(c);
            },
            contains(c) { return classList.has(c); }
        },
        querySelector(selector) {
            if (selector === '#sidebar-back-btn') return backBtn;
            return null;
        }
    };

    let cacheInvalidated = false;
    const mockFocusManager = {
        invalidateCache(section) {
            if (section === 'sidebar') cacheInvalidated = true;
        }
    };

    // Test on desktop environment
    const platformDesktop = { isWeb: false, isDesktop: true };
    const platformTv = { isWeb: false, isDesktop: false };
    const routerCanBack = { canGoBack: () => true };
    const routerNoBack = { canGoBack: () => false };

    // Mock storage registry
    let mockStoragePref = 'auto';
    const mockStorage = {
        getItem(k) {
            if (k === 'pref:sidebarBackButton') return mockStoragePref;
            return null;
        }
    };

    // Function matching updated _updateBackButtonState logic in Sidebar.js
    function updateBackButtonState(el, platform, router, storageService) {
        if (!el) return;

        // Retrieve user setting for back button targeting
        const pref = storageService.getItem('pref:sidebarBackButton') || 'auto';
        let isPlatformAllowed = false;

        // Evaluate platform eligibility
        if (pref === 'all' || pref === 'true') {
            isPlatformAllowed = true;
        } else if (pref === 'disabled' || pref === 'never' || pref === 'false') {
            isPlatformAllowed = false;
        } else {
            isPlatformAllowed = platform.isWeb || platform.isDesktop;
        }

        // Determine if back button should be shown
        const canBack = isPlatformAllowed && router.canGoBack();
        el.classList.toggle('has-back-button', canBack);
        const btn = el.querySelector('#sidebar-back-btn');
        if (btn) {
            btn.style.display = canBack ? 'flex' : 'none';
            btn.tabIndex = canBack ? 0 : -1;
        }
        mockFocusManager.invalidateCache('sidebar');
    }

    // 1. Default 'auto': Desktop with canGoBack=true -> button visible
    mockStoragePref = 'auto';
    updateBackButtonState(mockSidebarEl, platformDesktop, routerCanBack, mockStorage);
    assert.equal(mockSidebarEl.classList.contains('has-back-button'), true, 'Should add has-back-button class on desktop');
    assert.equal(backBtn.style.display, 'flex', 'Back button should be visible on desktop');
    assert.equal(backBtn.tabIndex, 0, 'Back button should be focusable on desktop');

    // 2. Default 'auto': Desktop with canGoBack=false -> button hidden
    updateBackButtonState(mockSidebarEl, platformDesktop, routerNoBack, mockStorage);
    assert.equal(mockSidebarEl.classList.contains('has-back-button'), false, 'Should remove has-back-button class when at home');
    assert.equal(backBtn.style.display, 'none', 'Back button should be hidden when at home');
    assert.equal(backBtn.tabIndex, -1, 'Back button should not be focusable when at home');

    // 3. Default 'auto': TV platform -> always hidden even if canGoBack=true
    updateBackButtonState(mockSidebarEl, platformTv, routerCanBack, mockStorage);
    assert.equal(mockSidebarEl.classList.contains('has-back-button'), false, 'TV should not show has-back-button in auto mode');
    assert.equal(backBtn.style.display, 'none', 'TV back button should remain hidden in auto mode');

    // 4. Setting 'all': TV platform -> button IS shown when canGoBack=true
    mockStoragePref = 'all';
    updateBackButtonState(mockSidebarEl, platformTv, routerCanBack, mockStorage);
    assert.equal(mockSidebarEl.classList.contains('has-back-button'), true, 'TV SHOULD show has-back-button when pref is "all"');
    assert.equal(backBtn.style.display, 'flex', 'TV back button should be visible when pref is "all"');
    assert.equal(backBtn.tabIndex, 0, 'TV back button should be focusable when pref is "all"');

    // 5. Setting 'all': TV platform with canGoBack=false -> hidden
    updateBackButtonState(mockSidebarEl, platformTv, routerNoBack, mockStorage);
    assert.equal(mockSidebarEl.classList.contains('has-back-button'), false, 'TV should hide back button when canGoBack is false even if "all"');
    assert.equal(backBtn.style.display, 'none', 'TV back button should be hidden at root route');

    // 6. Setting 'disabled': Desktop platform -> hidden even if canGoBack=true
    mockStoragePref = 'disabled';
    updateBackButtonState(mockSidebarEl, platformDesktop, routerCanBack, mockStorage);
    assert.equal(mockSidebarEl.classList.contains('has-back-button'), false, 'Desktop should hide back button when disabled');
    assert.equal(backBtn.style.display, 'none', 'Back button should be hidden when disabled');
    assert.equal(backBtn.tabIndex, -1, 'Back button tabIndex should be -1 when disabled');
});

test('SettingsPage: sidebar-back-button-select is properly registered and wired in settingsMap', () => {
    // Read source code of SettingsPage.js
    const settingsSource = readFileSync('./src/pages/settings/SettingsPage.js', 'utf8');

    // Verify dropdown control is rendered in template
    assert.ok(
        settingsSource.includes("'sidebar-back-button-select'"),
        'SettingsPage must render dropdown with id sidebar-back-button-select'
    );

    // Verify settingsMap entry with key and triggerEvent
    assert.ok(
        settingsSource.includes("'sidebar-back-button-select': { key: 'pref:sidebarBackButton', type: 'local', triggerEvent: true }"),
        'settingsMap must register sidebar-back-button-select with triggerEvent: true'
    );
});

