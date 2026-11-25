import assert from 'node:assert/strict';
import test from 'node:test';

// ============================================================================
// Environment Mock for ES Module Imports in Node.js
// ============================================================================
// Polyfill minimal browser/localStorage globals before importing BackupTab
// and its dependent singletons (StorageService, PlayerSettings, ImageService).
// ============================================================================
const diskStorage = new Map();

globalThis.localStorage = {
    get length() {
        return diskStorage.size;
    },
    key: (idx) => Array.from(diskStorage.keys())[idx] ?? null,
    getItem: (key) => (diskStorage.has(key) ? diskStorage.get(key) : null),
    setItem: (key, val) => diskStorage.set(key, String(val)),
    removeItem: (key) => diskStorage.delete(key),
    clear: () => diskStorage.clear()
};

globalThis.document = {
    addEventListener: () => {},
    createElement: () => ({ canPlayType: () => '' })
};

globalThis.screen = { width: 1920, height: 1080 };
globalThis.window = globalThis;
globalThis.window.location = { href: 'file:///index.html#/settings', protocol: 'file:', reload: () => {} };
globalThis.addEventListener = () => {};

try {
    Object.defineProperty(globalThis.navigator, 'userAgent', {
        value: 'Mozilla/5.0 (SmartHub; SMART-TV; U; Linux/Tizen)',
        configurable: true
    });
} catch (_) {
    // Ignore if navigator is non-configurable
}

// Import modules after polyfills are in place
const { storage } = await import('../src/utils/StorageService.js');
const { PlayerSettings } = await import('../src/utils/PlayerSettings.js');
const { imageService } = await import('../src/utils/ImageService.js');
const { api } = await import('../src/api/index.js');
const { BackupTab } = await import('../src/pages/settings/tabs/BackupTab.js');

/**
 * Helper to reset both in-memory StorageService cache and mock localStorage
 * between test cases so each scenario runs in complete isolation.
 */
function resetStorageState() {
    diskStorage.clear();
    storage._cache.clear();
    storage._dirtyKeys.clear();
    storage._removedKeys.clear();
    if (storage._flushTimer !== null) {
        clearTimeout(storage._flushTimer);
        storage._flushTimer = null;
    }
    storage._initialized = true;
}

test('BackupTab: backs up defaults (okShowOsdOnly, image quality) and excludes sensitive/cache keys', async () => {
    resetStorageState();

    // Seed auth/sensitive keys + transient caches that must be excluded
    storage.setItem('litefin:serverUrl', 'https://jf.example.com');
    storage.setItem('litefin:accessToken', 'secret-token');
    storage.setItem('litefin:activeUserId', 'user-1');
    storage.setItem('libThumb:abc', 'https://jf.example.com/thumb');
    storage.setItem('serverPlugin:available:mdblist-ratings', 'true');

    // Leave okShowOsdOnly and image quality at defaults, and set a custom home order
    storage.setItem('home:rowOrder', '["resume","latest"]');

    let postedPayload = null;
    const origPost = api.post;
    api.post = async (_url, body) => {
        postedPayload = body;
        return {};
    };

    try {
        const tab = new BackupTab({ _triggerHardReload: () => {} });
        await tab._sendBackup({ Name: 'Living Room TV' });

        assert.ok(postedPayload && postedPayload.Settings, 'Backup payload must contain Settings JSON');
        const parsed = JSON.parse(postedPayload.Settings);

        // Unmodified defaults must be explicitly captured
        assert.equal(parsed['player:okShowOsdOnly'], 'false', 'Default okShowOsdOnly must be backed up');
        assert.equal(parsed['pref:imageQuality'], 'medium', 'Default pref:imageQuality must be backed up');
        assert.equal(parsed['pref:detailsImageQuality'], 'very-high', 'Default pref:detailsImageQuality must be backed up');
        assert.equal(parsed['pref:heroImageQuality'], 'default', 'Default pref:heroImageQuality must be backed up');
        assert.equal(parsed['home:rowOrder'], '["resume","latest"]', 'Custom home row order must be backed up');

        // Sensitive & transient keys must be excluded
        assert.equal(parsed['litefin:serverUrl'], undefined);
        assert.equal(parsed['litefin:accessToken'], undefined);
        assert.equal(parsed['litefin:activeUserId'], undefined);
        assert.equal(parsed['libThumb:abc'], undefined);
        assert.equal(parsed['serverPlugin:available:mdblist-ratings'], undefined);
    } finally {
        api.post = origPost;
    }
});

test('BackupTab: restores okShowOsdOnly, image quality, and per-user profiles even when settings_per_user starts disabled', async () => {
    resetStorageState();

    // Simulate pre-upgrade TV with Settings Per User enabled and multiple profiles
    storage.setItem('litefin:activeUserId', 'user-1');
    storage.setItem('litefin:settings_per_user', 'true');
    PlayerSettings.set('okShowOsdOnly', true);
    imageService.setPreset('ultra');
    imageService.setDetailsPreset('high');
    storage.setItem('litefin:user_settings_user-2', JSON.stringify({ 'player:okShowOsdOnly': 'false', 'pref:imageQuality': 'low' }));

    let capturedSettingsJson = null;
    const origPost = api.post;
    api.post = async (_url, body) => {
        capturedSettingsJson = body.Settings;
        return {};
    };

    try {
        const tab = new BackupTab({ _triggerHardReload: () => {} });
        await tab._sendBackup({ Name: 'Pre-Upgrade' });
    } finally {
        api.post = origPost;
    }

    assert.ok(capturedSettingsJson, 'Backup JSON should be captured');

    // Simulate post-upgrade fresh TV install where user logged in as user-1:
    // settings_per_user is NOT enabled yet, and a stale user_settings_user-1 blob exists
    resetStorageState();
    storage.setItem('litefin:activeUserId', 'user-1');
    storage.setItem('litefin:user_settings_user-1', JSON.stringify({ 'player:okShowOsdOnly': 'false', 'pref:imageQuality': 'low' }));
    storage.setItem('pref:someStalePref', 'old');

    let reloadCalled = false;
    const tab = new BackupTab({
        _triggerHardReload: () => {
            reloadCalled = true;
        }
    });

    await tab.handleRestoreNow({ Settings: capturedSettingsJson });

    assert.equal(reloadCalled, true, 'Hard reload should be triggered after restore');

    // Verify disk flush happened synchronously (diskStorage must already have the updated user blob)
    assert.equal(diskStorage.get('litefin:settings_per_user'), 'true');
    const restoredUser1Disk = JSON.parse(diskStorage.get('litefin:user_settings_user-1'));
    assert.equal(restoredUser1Disk['player:okShowOsdOnly'], 'true', 'okShowOsdOnly must be restored in user-1 profile on disk');
    assert.equal(restoredUser1Disk['pref:imageQuality'], 'ultra', 'pref:imageQuality must be restored in user-1 profile on disk');
    assert.equal(restoredUser1Disk['pref:detailsImageQuality'], 'high', 'pref:detailsImageQuality must be restored in user-1 profile on disk');
    assert.equal(restoredUser1Disk['pref:someStalePref'], undefined, 'Stale preferences must be wiped on restore');

    // Verify secondary profile was also restored
    const restoredUser2Disk = JSON.parse(diskStorage.get('litefin:user_settings_user-2'));
    assert.equal(restoredUser2Disk['pref:imageQuality'], 'low', 'Other user profiles must also be preserved');

    // Verify live getters reflect the restored values
    assert.equal(PlayerSettings.get('okShowOsdOnly'), true);
    assert.equal(imageService.getPreset(), 'ultra');
    assert.equal(imageService.getDetailsPreset(), 'high');
});

test('BackupTab: restores global settings cleanly and flushes to disk before reload', async () => {
    resetStorageState();

    // Simulate global mode backup
    PlayerSettings.set('okShowOsdOnly', true);
    imageService.setPreset('very-high');
    imageService.setDetailsPreset('original');
    storage.setItem('home:rowOrder', '["latest","resume"]');

    let capturedSettingsJson = null;
    const origPost = api.post;
    api.post = async (_url, body) => {
        capturedSettingsJson = body.Settings;
        return {};
    };

    try {
        const tab = new BackupTab({ _triggerHardReload: () => {} });
        await tab._sendBackup({ Name: 'Global' });
    } finally {
        api.post = origPost;
    }

    // Fresh post-upgrade state
    resetStorageState();
    storage.setItem('litefin:activeUserId', 'user-1');

    const tab = new BackupTab({ _triggerHardReload: () => {} });
    await tab.handleRestoreNow({ Settings: capturedSettingsJson });

    // Check diskStorage directly (ensuring storage.flush() ran synchronously)
    assert.equal(diskStorage.get('player:okShowOsdOnly'), 'true');
    assert.equal(diskStorage.get('pref:imageQuality'), 'very-high');
    assert.equal(diskStorage.get('pref:detailsImageQuality'), 'original');
    assert.equal(diskStorage.get('home:rowOrder'), '["latest","resume"]');
});
