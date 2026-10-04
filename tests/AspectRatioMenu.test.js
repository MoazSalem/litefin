import assert from 'node:assert/strict';
import test from 'node:test';

// Setup environment mocks
globalThis.window = {
    innerWidth: 1920,
    innerHeight: 1080
};
globalThis.localStorage = {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {}
};
globalThis.document = {
    documentElement: { clientWidth: 1920, clientHeight: 1080 },
    createElement: () => ({
        classList: { add: () => {}, remove: () => {}, toggle: () => {} },
        addEventListener: () => {},
        querySelectorAll: () => [],
        appendChild: () => {},
        innerHTML: ''
    }),
    body: {
        appendChild: () => {}
    }
};

test('AspectRatioMenu: Omits Zoom option on Tizen and retains Auto and Stretch', async () => {
    // 1. Test Tizen platform detection
    globalThis.window.tizen = {};
    const { platformInfo } = await import('../src/utils/PlatformInfo.js');
    platformInfo._platform = 'tizen';

    const { default: AspectRatioMenu } = await import('../src/player/osd/AspectRatioMenu.js');

    const mockOsd = {
        player: {
            getAspectRatio: () => 'auto',
            setAspectRatio: () => {}
        },
        _getFocused: () => null,
        _currentFocusRow: 0,
        _currentFocusIndex: 0,
        _updateFocus: () => {}
    };

    const menu = new AspectRatioMenu(mockOsd);
    const optionsOnTizen = menu.options.map(opt => opt.id);

    assert.deepStrictEqual(
        optionsOnTizen,
        ['auto', 'stretch'],
        'On Tizen, AspectRatioMenu must only offer Auto and Stretch (Zoom must be hidden)'
    );
});

test('AspectRatioMenu: Retains Zoom option on non-Tizen platforms', async () => {
    // 2. Test non-Tizen platform
    delete globalThis.window.tizen;
    delete globalThis.window.webapis;

    const { platformInfo } = await import('../src/utils/PlatformInfo.js');
    platformInfo._platform = 'web';

    const { default: AspectRatioMenu } = await import('../src/player/osd/AspectRatioMenu.js');

    const mockOsd = {
        player: {
            getAspectRatio: () => 'auto',
            setAspectRatio: () => {}
        },
        _getFocused: () => null,
        _currentFocusRow: 0,
        _currentFocusIndex: 0,
        _updateFocus: () => {}
    };

    const menu = new AspectRatioMenu(mockOsd);
    const optionsOnWeb = menu.options.map(opt => opt.id);

    assert.deepStrictEqual(
        optionsOnWeb,
        ['auto', 'zoom', 'stretch'],
        'On non-Tizen platforms, AspectRatioMenu must retain Auto, Zoom, and Stretch'
    );
});
