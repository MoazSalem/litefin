import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

// Exercise the actual visibility listener without loading the TV application.
const appSource = readFileSync(new URL('../src/core/App.js', import.meta.url), 'utf8');
const listener = appSource.slice(
    appSource.indexOf("        document.addEventListener('visibilitychange'"),
    appSource.indexOf('        // Handle app close (browser mode)')
);

function setup({ authenticated = true, count = 2, path = '/home', preference = 'true', remember = false } = {}) {
    const calls = [];
    const saved = new Map();
    if (preference !== null) saved.set('pref:showProfilesOnResume', preference);
    saved.set('pref:rememberLastActiveUser', String(remember));
    let callback;
    const document = {
        hidden: false,
        addEventListener(name, fn) {
            callback = fn;
        }
    };
    const storage = { getItem: (key) => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value) };
    vm.runInNewContext(listener, {
        document,
        storage,
        log: { info() {}, debug() {} },
        eventBus: { emit: (name) => calls.push(name) },
        state: { get: (key) => ({ 'user:authenticated': authenticated, 'user:sessionCount': count })[key] },
        api: { openWebSocket: () => calls.push('open'), closeWebSocket: () => calls.push('close') },
        pluginManager: { destroy: () => calls.push('destroyPlugins') },
        router: {
            getCurrentPath: () => path,
            getCurrentPage: () => ({
                showResumeProfileSelector: () => calls.push('showPlayerProfiles')
            }),
            reset: (target) => {
                calls.push(target);
                path = target;
            },
            reload: () => calls.push('reload')
        }
    });
    return {
        calls,
        saved,
        storage,
        resume: callback,
        hide() {
            document.hidden = true;
            callback();
        }
    };
}

for (const path of ['/home', '/details/123', '/player/123']) {
    test(`enabled: resume from ${path} shows saved profiles`, () => {
        const { calls, resume } = setup({ path });
        resume();
        assert.deepEqual(
            calls,
            path.startsWith('/player')
                ? ['app:visible', 'open', 'showPlayerProfiles']
                : ['app:visible', 'open', 'destroyPlugins', '/profiles']
        );
    });
}

for (const count of [0, 1]) {
    test(`${count} saved sessions preserves normal page reload`, () => {
        const { calls, resume } = setup({ count });
        resume();
        assert.deepEqual(calls, ['app:visible', 'open', 'reload']);
    });
}

test('disabled preference preserves an existing player', () => {
    const { calls, resume } = setup({ path: '/player/123', preference: 'false' });
    resume();
    assert.deepEqual(calls, ['app:visible', 'open']);
});

test('disabled preference reloads other pages', () => {
    const { calls, resume } = setup({ preference: 'false' });
    resume();
    assert.deepEqual(calls, ['app:visible', 'open', 'reload']);
});

test('unauthenticated resume does not show saved profiles or reopen the socket', () => {
    const { calls, resume } = setup({ authenticated: false, path: '/login' });
    resume();
    assert.deepEqual(calls, ['app:visible', 'reload']);
});

test('already on profiles does not destroy plugins or reset navigation again', () => {
    const { calls, resume } = setup({ path: '/profiles' });
    resume();
    assert.deepEqual(calls, ['app:visible', 'open', 'reload']);
});

test('backgrounding only emits hidden and closes the socket', () => {
    const { calls, hide } = setup();
    hide();
    assert.deepEqual(calls, ['app:hidden', 'close']);
});

test('remembering the startup user is independent of resume selection', () => {
    const { calls, resume } = setup({ remember: true });
    resume();
    assert.equal(calls.at(-1), '/profiles');
});

test('controls toggle persists and affects the next resume without restarting', () => {
    const { calls, saved, storage, resume } = setup();
    const source = readFileSync(new URL('../src/pages/SettingsPage.js', import.meta.url), 'utf8');
    const block = source.slice(
        source.indexOf('        const profilesOnResumeToggle ='),
        source.indexOf('        const rememberLastUserToggle =')
    );
    let click;
    let active;
    const button = {
        addEventListener(name, fn) {
            click = fn;
        },
        classList: {
            toggle(name, value) {
                active = value;
            }
        }
    };
    vm.runInNewContext(`(function () {${block}}).call(view)`, { storage, view: { $: () => button } });
    click();
    assert.equal(saved.get('pref:showProfilesOnResume'), 'false');
    assert.equal(active, false);
    resume();
    assert.equal(calls.at(-1), 'reload');
    click();
    assert.equal(saved.get('pref:showProfilesOnResume'), 'true');
    assert.equal(active, true);
    resume();
    assert.equal(calls.at(-1), '/profiles');
});

test('resume selection is disabled when the preference has never been saved', () => {
    const { calls, resume } = setup({ preference: null });
    resume();
    assert.deepEqual(calls, ['app:visible', 'open', 'reload']);
});

test('player resume selector is a full-screen playback gate', () => {
    const playerSource = readFileSync(new URL('../src/pages/PlayerPage.js', import.meta.url), 'utf8');
    const menuSource = readFileSync(new URL('../src/player/osd/ResumeProfilesMenu.js', import.meta.url), 'utf8');
    const styles = readFileSync(new URL('../src/styles/player-osd.css', import.meta.url), 'utf8');

    assert.match(playerSource, /_resumeProfileSelectionActive = true;[\s\S]*?_player\?\.pause\?\.\(\)/);
    assert.match(playerSource, /if \(this\._resumeProfileSelectionActive\) \{[\s\S]*?_player\?\.pause\?\.\(\)/);
    assert.match(playerSource, /if \(resumePlayback\) this\._player\?\.unpause\?\.\(\)/);
    assert.match(playerSource, /App backgrounded, pausing playback[\s\S]*?this\.showResumeProfileSelector\(\)/);
    assert.doesNotMatch(playerSource, /window\.addEventListener\('blur'/);
    assert.match(playerSource, /if \(shouldGateProfileSelection\)[\s\S]*?_player\?\.setMuted\?\.\(true\)/);
    assert.match(playerSource, /videoElement\.style\.display = 'none'/);
    assert.match(playerSource, /videoElement\.style\.display = this\._resumeVideoDisplayAfterProfileSelection/);
    assert.match(playerSource, /_player\?\.setMuted\?\.\(restoreMuted\)/);
    assert.match(playerSource, /Keep the opaque takeover[\s\S]*?await this\._stopAndExit/);
    assert.match(menuSource, /key === 'back'\) return true/);
    assert.match(styles, /\.resume-profiles-overlay[\s\S]*?width: 100vw;[\s\S]*?height: 100vh/);
    assert.match(styles, /body\.resume-profile-selection-active \.jellyfin-video-player/);
});

test('default-disabled resume preserves the player', () => {
    const { calls, resume } = setup({ preference: null, path: '/player/123' });
    resume();
    assert.deepEqual(calls, ['app:visible', 'open']);
});

test('resume preference is shared by profiles and persists across app initialization', () => {
    const source = readFileSync(new URL('../src/utils/StorageService.js', import.meta.url), 'utf8')
        .replace(/^import .*;\r?\n/gm, '')
        .replace('export const storage = new StorageService();', '')
        .replace('export default StorageService;', 'StorageService;');
    const disk = new Map();
    const Store = vm.runInNewContext(source, {
        logger: { create: () => ({ info() {}, debug() {}, warn() {}, error() {} }) },
        performance: { now: () => 0 },
        document: { addEventListener() {} },
        window: { addEventListener() {} },
        setTimeout: () => 1,
        clearTimeout() {},
        localStorage: {
            get length() {
                return disk.size;
            },
            key: (index) => [...disk.keys()][index],
            getItem: (key) => disk.get(key) ?? null,
            setItem: (key, value) => disk.set(key, value),
            removeItem: (key) => disk.delete(key)
        }
    });
    const storage = new Store();
    storage.init();
    storage.setItem('litefin:settings_per_user', 'true');
    storage.setItem('litefin:activeUserId', 'alice');
    storage.setItem('pref:showProfilesOnResume', 'true');
    storage.setItem('pref:example', 'alice-only');
    storage.setItem('litefin:activeUserId', 'bob');
    assert.equal(storage.getItem('pref:showProfilesOnResume'), 'true');
    storage.setItem('pref:showProfilesOnResume', 'false');
    storage.setItem('pref:example', 'bob-only');
    storage.setItem('litefin:activeUserId', 'alice');
    assert.equal(storage.getItem('pref:showProfilesOnResume'), 'false');
    assert.equal(storage.getItem('pref:example'), 'alice-only');
    for (const user of ['alice', 'bob']) {
        const settings = JSON.parse(storage.getItem(`litefin:user_settings_${user}`));
        assert.equal(Object.hasOwn(settings, 'pref:showProfilesOnResume'), false);
    }
    const restored = new Store();
    restored.init();
    assert.equal(restored.getItem('pref:showProfilesOnResume'), 'false');
    restored.setItem('litefin:activeUserId', 'bob');
    assert.equal(restored.getItem('pref:showProfilesOnResume'), 'false');
});
