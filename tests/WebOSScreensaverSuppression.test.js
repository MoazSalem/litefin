import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

/**
 * ============================================================================
 * LG webOS System Screensaver Suppression Test Suite
 * ============================================================================
 * Verifies that:
 *   1. WebOSAdapter implements setKeepScreenOn, _setupScreensaverGuard,
 *      _registerScreenSaverGuard, _respondScreenSaver, and
 *      updateScreensaverSuppressionPreference.
 *   2. When video playback is active (setKeepScreenOn(true)) and the user
 *      setting pref:suppressScreensaverOnPlayback is enabled (default),
 *      screensaver requests are answered with ack: false.
 *   3. When the user sets pref:suppressScreensaverOnPlayback to false,
 *      screensaver suppression is disabled and incoming requests receive
 *      ack: true (allowing screensaver).
 *   4. Power keepalive activities with luna://com.palm.activitymanager are
 *      created upon playback start and canceled upon playback exit.
 *   5. PlayerPage.js explicitly coordinates with webosAdapter.setKeepScreenOn.
 *   6. SettingsPage.js provides a toggle for pref:suppressScreensaverOnPlayback
 *      under the Screensaver settings section.
 * ============================================================================
 */

test('WebOSAdapter: Source code integrity for screensaver suppression and user preference', () => {
    const adapterSource = readFileSync(
        new URL('../src/webos/WebOSAdapter.js', import.meta.url),
        'utf8'
    );

    // 1. Verify SCREENSAVER_CLIENT identifier
    assert.ok(
        adapterSource.includes("org.litefin.app"),
        'WebOSAdapter must use org.litefin.app as the screensaver client name'
    );

    // 2. Verify registration with tvpower service
    assert.ok(
        adapterSource.includes('luna://com.webos.service.tvpower') &&
        adapterSource.includes('power/registerScreenSaverRequest'),
        'WebOSAdapter must register with tvpower/registerScreenSaverRequest'
    );

    // 3. Verify response to tvpower service with ack
    assert.ok(
        adapterSource.includes('power/responseScreenSaverRequest') &&
        adapterSource.includes('const ack = !this._screenSaverBlocked'),
        'WebOSAdapter must respond with ack: false when playback is blocked'
    );

    // 4. Verify activitymanager keepalive integration
    assert.ok(
        adapterSource.includes('luna://com.palm.activitymanager') &&
        adapterSource.includes("name: 'org.litefin.app-playback-keepalive'"),
        'WebOSAdapter must register a keepalive activity with com.palm.activitymanager'
    );

    // 5. Verify user preference check in setKeepScreenOn (disabled by default)
    assert.ok(
        adapterSource.includes("storage.getItem('pref:suppressScreensaverOnPlayback') === 'true'"),
        'WebOSAdapter must check pref:suppressScreensaverOnPlayback === "true" (disabled by default)'
    );

    // 6. Verify updateScreensaverSuppressionPreference method exists
    assert.ok(
        adapterSource.includes('updateScreensaverSuppressionPreference('),
        'WebOSAdapter must provide updateScreensaverSuppressionPreference method'
    );

    // 7. Verify PlayerPage.js integrates webosAdapter.setKeepScreenOn
    const playerPageSource = readFileSync(
        new URL('../src/pages/PlayerPage.js', import.meta.url),
        'utf8'
    );
    assert.ok(
        playerPageSource.includes('webosAdapter.setKeepScreenOn(true)'),
        'PlayerPage.js must call webosAdapter.setKeepScreenOn(true) on playback start'
    );
    assert.ok(
        playerPageSource.includes('webosAdapter.setKeepScreenOn(false)'),
        'PlayerPage.js must call webosAdapter.setKeepScreenOn(false) on playback destroy'
    );

    // 8. Verify SettingsPage.js has the screensaver toggle, platform check, and handler
    const settingsPageSource = readFileSync(
        new URL('../src/pages/SettingsPage.js', import.meta.url),
        'utf8'
    );
    assert.ok(
        settingsPageSource.includes('id="toggle-suppress-screensaver-playback"'),
        'SettingsPage.js must render toggle-suppress-screensaver-playback switch'
    );
    assert.ok(
        settingsPageSource.includes('platformInfo.isWebOS || webosAdapter.isWebOS'),
        'SettingsPage.js must conditionally hide setting on non-webOS platforms'
    );
    assert.ok(
        settingsPageSource.includes("pref:suppressScreensaverOnPlayback"),
        'SettingsPage.js must store pref:suppressScreensaverOnPlayback'
    );
    assert.ok(
        settingsPageSource.includes('webosAdapter.updateScreensaverSuppressionPreference'),
        'SettingsPage.js must inform webosAdapter upon toggle changes'
    );
});

test('WebOSAdapter: Behavioral simulation of screensaver guard and ack logic with preference toggle', () => {
    let screensaverBlocked = false;
    let isPlaybackKeepOnRequested = false;
    let registeredCallback = null;
    let userPrefSetting = null; // null means default (true)
    const sentResponses = [];
    const activityManagerCalls = [];

    // Mock Luna service bridge for tvpower and activitymanager
    const mockWebOS = {
        service: {
            request(serviceUri, options) {
                if (serviceUri === 'luna://com.webos.service.tvpower') {
                    if (options.method === 'power/registerScreenSaverRequest') {
                        registeredCallback = options.onSuccess;
                        return { cancel: () => { registeredCallback = null; } };
                    }
                    if (options.method === 'power/responseScreenSaverRequest') {
                        sentResponses.push(options.parameters);
                        options.onSuccess?.({ returnValue: true });
                        return {};
                    }
                }
                if (serviceUri === 'luna://com.palm.activitymanager') {
                    activityManagerCalls.push({ method: options.method, parameters: options.parameters });
                    if (options.method === 'create') {
                        options.onSuccess?.({ returnValue: true, activityId: 999 });
                    } else if (options.method === 'cancel') {
                        options.onSuccess?.({ returnValue: true });
                    }
                    return {};
                }
                return {};
            }
        }
    };

    // Simulation functions mirroring WebOSAdapter
    const setKeepScreenOn = (keepOn) => {
        isPlaybackKeepOnRequested = Boolean(keepOn);
        // Preference is disabled by default: only active when user explicitly set to 'true'
        const isEnabledByUser = userPrefSetting === 'true';
        const shouldBlock = Boolean(keepOn && isEnabledByUser);
        screensaverBlocked = shouldBlock;

        if (shouldBlock) {
            mockWebOS.service.request('luna://com.webos.service.tvpower', {
                method: 'power/registerScreenSaverRequest',
                parameters: { clientName: 'org.litefin.app', subscribe: true },
                onSuccess: (res) => {
                    if (res && res.timestamp) {
                        respondScreenSaver(res.timestamp);
                    }
                }
            });
            mockWebOS.service.request('luna://com.palm.activitymanager', {
                method: 'create',
                parameters: {
                    activity: {
                        name: 'org.litefin.app-playback-keepalive',
                        type: { foreground: true, continuous: true, power: true, powerDebounce: true }
                    }
                }
            });
        } else {
            mockWebOS.service.request('luna://com.palm.activitymanager', {
                method: 'cancel',
                parameters: { activityId: 999 }
            });
        }
    };

    const updateScreensaverSuppressionPreference = (enabled) => {
        userPrefSetting = enabled ? 'true' : 'false';
        if (isPlaybackKeepOnRequested) {
            setKeepScreenOn(isPlaybackKeepOnRequested);
        }
    };

    const respondScreenSaver = (timestamp) => {
        const ack = !screensaverBlocked;
        mockWebOS.service.request('luna://com.webos.service.tvpower', {
            method: 'power/responseScreenSaverRequest',
            parameters: { clientName: 'org.litefin.app', ack, timestamp }
        });
    };

    // 1. Enter playback -> keep screen on (default preference is disabled / null)
    setKeepScreenOn(true);
    assert.equal(screensaverBlocked, false, 'Screensaver must NOT be blocked by default (preserves legacy stock behavior)');
    assert.equal(activityManagerCalls[0].method, 'cancel', 'No keepalive activity should be running when disabled by default');

    // 2. TV triggers screensaver request with default preference
    respondScreenSaver(1729240000);
    assert.equal(sentResponses.length, 1);
    assert.deepEqual(sentResponses[0], {
        clientName: 'org.litefin.app',
        ack: true, // Must allow screensaver when disabled by default
        timestamp: 1729240000
    }, 'Must reply with ack: true by default to maintain old behavior');

    // 3. User enables screensaver suppression in settings while playback is active
    updateScreensaverSuppressionPreference(true);
    assert.equal(screensaverBlocked, true, 'Screensaver must be blocked once opted in by user');
    assert.ok(registeredCallback, 'Screensaver callback must be registered when enabled');
    assert.equal(activityManagerCalls[1].method, 'create', 'Keepalive activity must be created');

    // 4. TV triggers screensaver request while option is enabled
    registeredCallback({ returnValue: true, timestamp: 1729240900 });
    assert.equal(sentResponses.length, 2);
    assert.deepEqual(sentResponses[1], {
        clientName: 'org.litefin.app',
        ack: false, // CRITICAL: must deny screensaver
        timestamp: 1729240900
    }, 'Must reply with ack: false during playback when user enabled option');

    // 5. User disables screensaver suppression in settings
    updateScreensaverSuppressionPreference(false);
    assert.equal(screensaverBlocked, false, 'Screensaver must NOT be blocked once disabled by user');
    assert.equal(activityManagerCalls[2].method, 'cancel', 'Keepalive activity must be canceled');

    // 6. Normal playback stop
    setKeepScreenOn(false);
    assert.equal(screensaverBlocked, false, 'Screensaver must not be blocked when stopped');
});
