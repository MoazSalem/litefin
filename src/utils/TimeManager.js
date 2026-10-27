/**
 * ============================================================================
 * Litefin - High-Precision Hybrid Time Manager
 * ============================================================================
 * Solves client-side time inaccuracy and desynchronization when Smart TVs
 * (Samsung Tizen, LG webOS) run in offline environments without internet access
 * (e.g. connected solely to a local Jellyfin server on LAN).
 *
 * Architecture:
 * 1. Samsung Tizen Driver: Queries native OS hardware clock via window.tizen.time.
 * 2. LG webOS Driver: Connects to Luna bus (time/getSystemTime) for live system time.
 * 3. Jellyfin Server Sync: NTP-style clock offset calculation (/GetUTCTime) using
 *    monotonic time (performance.now) as anchor to survive hardware RTC resets.
 * ============================================================================
 */

import { api } from '../api/index.js';
import { eventBus } from '../core/EventBus.js';
import { logger } from './Logger.js';
import { PlayerSettings } from './PlayerSettings.js';
// Centralized platform capabilities & environment detection
import { platformInfo } from './PlatformInfo.js';

const log = logger.create('TimeManager');

// Interval between automatic Jellyfin server time synchronization polls (15 minutes)
const SYNC_INTERVAL_MS = 15 * 60 * 1000;

class TimeManager {
    constructor() {
        // Platform detection flags
        this._isTizen = false;
        this._isWebOS = false;

        // Warning throttle flags to prevent console spam
        this._warnedNoTizenTime = false;

        // WebOS system time cache and active subscription bridge
        this._webosTime = null;
        this._webosSubscription = null;

        // Server anchor for monotonic high-resolution calculation
        // Structure: { serverEpochMs: number, perfMs: number, offsetMs: number }
        this._serverAnchor = null;
        this._isServerSynced = false;

        // Background polling handle
        this._syncTimer = null;
        this._isSyncing = false;
        this._lastLoggedMinute = null;
    }

    /**
     * Resolves the native Samsung Tizen host object across global contexts.
     * Looks for window.tizen, globalThis.tizen, or direct global namespace.
     * @private
     * @returns {Object|null}
     */
    _getTizenApi() {
        if (typeof window !== 'undefined' && window.tizen) return window.tizen;
        if (typeof globalThis !== 'undefined' && globalThis.tizen) return globalThis.tizen;
        if (typeof tizen !== 'undefined') return tizen;
        return null;
    }

    /**
     * Safely reads the hardware/OS wall clock through the native Tizen Time module.
     * Returns a valid TZDate instance or null if the module/privilege is unavailable.
     * @private
     * @returns {Object|null}
     */
    _getTizenDateTime() {
        try {
            // Locate root platform namespace
            const tizenApi = this._getTizenApi();
            if (tizenApi && tizenApi.time && typeof tizenApi.time.getCurrentDateTime === 'function') {
                return tizenApi.time.getCurrentDateTime();
            }
        } catch (err) {
            log.warn('Error invoking tizen.time.getCurrentDateTime():', err);
        }
        return null;
    }

    /**
     * Initializes the TimeManager, detecting platform drivers and establishing
     * native OS clock listeners and server sync hooks.
     */
    init() {
        log.info('Initializing TimeManager subsystem...');

        // --------------------------------------------------------------------
        // 1. Identify Host Operating Environment
        // --------------------------------------------------------------------
        // Query native platform indicators. Samsung Tizen runtime provides window.tizen
        // for direct hardware clock queries.
        const tizenObj = this._getTizenApi();
        this._isTizen = Boolean(tizenObj) || platformInfo.isTizen;

        // For LG webOS, rely on centralized platformInfo detection.
        // We must never check window.webOS directly here because webostvjs imports
        // define window.webOS globally across every supported platform.
        this._isWebOS = platformInfo.isWebOS;

        log.info(`Platform clock drivers detected — Tizen: ${this._isTizen}, WebOS: ${this._isWebOS}`);

        // --------------------------------------------------------------------
        // 1.1. Diagnostic Probe: Print OS Date and Environment State
        // --------------------------------------------------------------------
        try {
            // Record active configuration preferences
            const activeSource =
                (typeof PlayerSettings !== 'undefined' && PlayerSettings.get('timeSource')) || 'browser';
            log.info(`Active timeSource preference: "${activeSource}"`);

            // Record baseline JavaScript Date engine state
            const baselineJsDate = new Date();
            log.info(
                `JS runtime Date baseline: "${baselineJsDate.toString()}" (epoch: ${baselineJsDate.getTime()}, tzOffset: ${baselineJsDate.getTimezoneOffset()})`
            );

            // Inspect Tizen native environment if present
            if (this._isTizen) {
                const hasTime = Boolean(tizenObj && tizenObj.time);
                const getCurrentDateTimeType = typeof tizenObj?.time?.getCurrentDateTime;
                log.info(
                    `Tizen probe — tizen.time present: ${hasTime}, getCurrentDateTime type: "${getCurrentDateTimeType}"`
                );

                // Execute live date query safely
                const tz = this._getTizenDateTime();
                if (tz) {
                    try {
                        const secOffset = typeof tz.secondsFromUTC === 'function' ? tz.secondsFromUTC() : null;
                        const tzName = typeof tz.getTimezone === 'function' ? tz.getTimezone() : 'unknown';
                        log.info(
                            `Tizen startup OS clock probe — toLocaleString: "${tz.toLocaleString()}", timezone: "${tzName}", secFromUTC: ${secOffset}, raw:`,
                            {
                                year: tz.getFullYear(),
                                month: tz.getMonth(),
                                date: tz.getDate(),
                                hours: tz.getHours(),
                                minutes: tz.getMinutes(),
                                seconds: tz.getSeconds(),
                                milliseconds: tz.getMilliseconds()
                            }
                        );
                    } catch (probeErr) {
                        log.warn('Tizen startup probe formatting failed:', probeErr);
                    }
                } else {
                    log.warn('Tizen OS date is currently unavailable via tizen.time.');
                }
            }
        } catch (diagErr) {
            log.warn('Startup diagnostic probe exception caught safely:', diagErr);
        }

        // --------------------------------------------------------------------
        // 2. Initialize Platform-Specific Native Drivers
        // --------------------------------------------------------------------
        if (this._isWebOS) {
            this._initWebOSClockDriver();
        }

        // --------------------------------------------------------------------
        // 3. Register Event Bus Hooks for Server Time Synchronization
        // --------------------------------------------------------------------
        // Trigger clock alignment whenever server connectivity is confirmed
        if (typeof eventBus !== 'undefined' && typeof eventBus.on === 'function') {
            eventBus.on('auth:success', () => {
                log.debug('Authentication confirmed, initiating server time sync...');
                this.syncServerTime();
            });

            eventBus.on('api:ready', () => {
                this.syncServerTime();
            });

            eventBus.on('network:online', () => {
                this.syncServerTime();
            });

            eventBus.on('pref:timeSource', (newSource) => {
                log.info(`Time source preference changed to: ${newSource}`);
                if (newSource === 'server') {
                    this.syncServerTime();
                } else if (newSource === 'os') {
                    if (this._isTizen) {
                        const tz = this._getTizenDateTime();
                        if (tz) {
                            try {
                                log.info(
                                    `Tizen OS date on switch: toLocaleString="${tz.toLocaleString()}", timezone="${tz.getTimezone()}", raw=${tz.getFullYear()}-${tz.getMonth() + 1}-${tz.getDate()} ${tz.getHours()}:${tz.getMinutes()}:${tz.getSeconds()}`
                                );
                            } catch (e) {
                                log.warn('Tizen OS switch probe error:', e);
                            }
                        } else {
                            log.warn('Tizen OS date unavailable on switch. Check time privilege.');
                        }
                    } else if (this._isWebOS) {
                        this._initWebOSClockDriver();
                    }
                }
            });

            // React immediately when user adjusts timezone offset for server time
            eventBus.on('pref:timeZoneOffset', (newOffset) => {
                log.info(`Timezone offset preference updated to: ${newOffset}`);
                if (typeof eventBus !== 'undefined' && typeof eventBus.emit === 'function') {
                    eventBus.emit('time:synced');
                }
            });
        }

        // --------------------------------------------------------------------
        // 4. Initial Server Sync Attempt & Periodic Recalibration
        // --------------------------------------------------------------------
        this.syncServerTime();

        if (this._syncTimer) {
            clearInterval(this._syncTimer);
        }
        this._syncTimer = setInterval(() => {
            this.syncServerTime();
        }, SYNC_INTERVAL_MS);

        log.info('TimeManager successfully initialized');
    }

    /**
     * Connects to LG webOS Luna System Service to receive authoritative OS wall-clock time
     * and subscribe to live time/timezone updates configured by the user in TV menus.
     * @private
     */
    _initWebOSClockDriver() {
        try {
            // Guard: Luna bus services strictly depend on the native PalmServiceBridge
            // injected by the LG webOS WebAppMgr environment. If running in a standard
            // browser or environment without this bridge, attempting webOS.service.request
            // throws an unhandled 'PalmServiceBridge is not found' error into the console.
            if (typeof window === 'undefined' || typeof window.PalmServiceBridge === 'undefined') {
                log.debug('PalmServiceBridge not present in window; skipping webOS clock driver initialization');
                return;
            }

            const requestMethod = 'time/getSystemTime';
            const requestParams = { subscribe: true };

            const handleResponse = (response) => {
                if (!response) return;

                // Typical response contains localtime: { year, month, day, hour, minute, second }
                // and utc timestamp + timezone offset
                log.info('Received native time from webOS system service:', response);

                if (response.localtime) {
                    this._webosTime = {
                        year: response.localtime.year,
                        month: response.localtime.month, // Note: 1-indexed (1-12)
                        day: response.localtime.day,
                        hour: response.localtime.hour,
                        minute: response.localtime.minute,
                        second: response.localtime.second,
                        offsetMinutes: typeof response.offset === 'number' ? response.offset : null,
                        perfMs: performance.now()
                    };
                }
            };

            // Attempt standard webOS service bus invocation
            if (window.webOS && window.webOS.service && typeof window.webOS.service.request === 'function') {
                this._webosSubscription = window.webOS.service.request('luna://com.palm.systemservice', {
                    method: requestMethod,
                    parameters: requestParams,
                    subscribe: true,
                    onSuccess: handleResponse,
                    onFailure: (err) => {
                        log.warn('Primary com.palm.systemservice call failed, attempting com.webos fallback:', err);
                        // Fallback for modern webOS OSE / newer firmware releases
                        this._tryWebOSFallbackService(handleResponse);
                    }
                });
            } else if (typeof window.PalmServiceBridge !== 'undefined') {
                // Direct PalmServiceBridge for legacy/bare environments
                const bridge = new window.PalmServiceBridge();
                bridge.onservicecallback = (msg) => {
                    try {
                        const parsed = JSON.parse(msg);
                        handleResponse(parsed);
                    } catch (err) {
                        log.warn('Failed parsing PalmServiceBridge response:', err);
                    }
                };
                bridge.call('luna://com.palm.systemservice/' + requestMethod, JSON.stringify(requestParams));
                this._webosSubscription = bridge;
            }
        } catch (error) {
            log.warn('Exception during webOS clock driver initialization:', error);
        }
    }

    /**
     * Fallback driver for newer webOS revisions utilizing com.webos.service.systemservice.
     * @private
     * @param {Function} handleResponse
     */
    _tryWebOSFallbackService(handleResponse) {
        try {
            // Validate that the native bridge exists before dispatching fallback Luna call
            if (typeof window === 'undefined' || typeof window.PalmServiceBridge === 'undefined') {
                return;
            }

            if (window.webOS && window.webOS.service) {
                window.webOS.service.request('luna://com.webos.service.systemservice', {
                    method: 'time/getSystemTime',
                    parameters: { subscribe: true },
                    subscribe: true,
                    onSuccess: handleResponse,
                    onFailure: (err) => {
                        log.warn('All webOS system time service calls failed:', err);
                    }
                });
            }
        } catch (e) {
            log.warn('Fallback webOS system service exception:', e);
        }
    }

    /**
     * Synchronizes local high-precision clock against the connected Jellyfin server.
     * Uses NTP-style calculation over /GetUTCTime to derive network delay and offset.
     * @returns {Promise<boolean>}
     */
    async syncServerTime() {
        if (this._isSyncing) return false;
        if (!api || typeof api.getServerTime !== 'function') return false;

        this._isSyncing = true;
        const t0 = Date.now();

        try {
            // GET /GetUTCTime returns RequestReceptionTime and ResponseTransmissionTime
            const response = await api.getServerTime();
            const t3 = Date.now();

            let receptionMs = Date.parse(response?.RequestReceptionTime);
            let transmissionMs = Date.parse(response?.ResponseTransmissionTime);

            // Handle servers returning a single timestamp string or alternative field
            if (isNaN(receptionMs) || isNaN(transmissionMs)) {
                if (typeof response === 'string') {
                    const parsed = Date.parse(response);
                    if (!isNaN(parsed)) {
                        receptionMs = parsed;
                        transmissionMs = parsed;
                    }
                } else if (response && typeof response === 'object') {
                    const candidate = response.ServerTime || response.Time || response.DateTime || response.UtcTime;
                    if (candidate) {
                        const parsed = Date.parse(candidate);
                        if (!isNaN(parsed)) {
                            receptionMs = parsed;
                            transmissionMs = parsed;
                        }
                    }
                }
            }

            if (!isNaN(receptionMs) && !isNaN(transmissionMs)) {
                // Classic NTP delay and clock offset computation
                const roundTrip = t3 - t0;
                const serverProcessing = transmissionMs - receptionMs;
                const networkDelay = Math.max(0, (roundTrip - serverProcessing) / 2);
                const estimatedServerEpoch = transmissionMs + networkDelay;

                // Anchor server time against high-resolution monotonic timer
                this._serverAnchor = {
                    serverEpochMs: estimatedServerEpoch,
                    perfMs: performance.now(),
                    offsetMs: estimatedServerEpoch - t3
                };
                this._isServerSynced = true;

                log.info(
                    `Server time synchronized — offset: ${this._serverAnchor.offsetMs}ms, ` +
                        `rtt: ${roundTrip}ms, delay: ${networkDelay.toFixed(1)}ms`
                );

                // Notify all live clock displays (GlobalClock, MobileNav, OSD) to immediately re-render
                if (typeof eventBus !== 'undefined' && typeof eventBus.emit === 'function') {
                    eventBus.emit('time:synced');
                }
                return true;
            } else {
                log.debug('Server response did not contain parseable timestamps:', response);
            }
        } catch (error) {
            log.debug('Server time synchronization skipped/failed:', error?.message || error);
        } finally {
            this._isSyncing = false;
        }

        return false;
    }

    /**
     * Returns a valid JavaScript Date object reflecting current local time
     * according to the user's selected timeSource preference:
     * - 'browser': Standard host environment Date (Default)
     * - 'os': Native TV OS hardware/system clock (Tizen / webOS)
     * - 'server': Jellyfin Server time sync via /GetUTCTime + performance.now anchor
     *
     * @returns {Date}
     */
    now() {
        // Retrieve user preference, defaulting strictly to 'browser'
        const source = (typeof PlayerSettings !== 'undefined' && PlayerSettings.get('timeSource')) || 'browser';

        // --------------------------------------------------------------------
        // Strategy: Native Device Operating System (Tizen / webOS)
        // --------------------------------------------------------------------
        if (source === 'os') {
            // ----------------------------------------------------------------
            // 1. Samsung Tizen Native Hardware Clock Driver
            // ----------------------------------------------------------------
            if (this._isTizen) {
                try {
                    // Query native hardware clock through Tizen time bridge
                    const tz = this._getTizenDateTime();
                    if (tz && typeof tz.getFullYear === 'function') {
                        // Diagnostic log: throttled to once per minute to avoid spamming
                        const minuteKey = `${tz.getFullYear()}-${tz.getMonth()}-${tz.getDate()} ${tz.getHours()}:${tz.getMinutes()}`;
                        if (this._lastLoggedMinute !== minuteKey) {
                            this._lastLoggedMinute = minuteKey;
                            const secOffset = typeof tz.secondsFromUTC === 'function' ? tz.secondsFromUTC() : null;
                            const tzName = typeof tz.getTimezone === 'function' ? tz.getTimezone() : 'unknown';
                            log.info(
                                `Tizen OS active date: "${tz.toLocaleString()}" (tz: ${tzName}, secFromUTC: ${secOffset}, year: ${tz.getFullYear()}, hours: ${tz.getHours()}:${tz.getMinutes()}:${tz.getSeconds()})`
                            );
                        }

                        // Construct native JavaScript Date instance using hardware clock fields
                        return new Date(
                            tz.getFullYear(),
                            tz.getMonth(),
                            tz.getDate(),
                            tz.getHours(),
                            tz.getMinutes(),
                            tz.getSeconds(),
                            tz.getMilliseconds()
                        );
                    }
                } catch (tizenErr) {
                    log.warn('Tizen native date calculation failed:', tizenErr);
                }

                // Log a throttled warning if Tizen time is unavailable
                if (!this._warnedNoTizenTime) {
                    this._warnedNoTizenTime = true;
                    log.warn('"os" time source selected, but tizen.time.getCurrentDateTime() is unavailable.');
                }
            }

            // ----------------------------------------------------------------
            // 2. LG webOS Native System Service Time
            // ----------------------------------------------------------------
            if (this._isWebOS && this._webosTime) {
                try {
                    const elapsedMs = performance.now() - this._webosTime.perfMs;
                    const baseLocalMs = new Date(
                        this._webosTime.year,
                        this._webosTime.month - 1, // Convert 1-indexed month to 0-indexed JS month
                        this._webosTime.day,
                        this._webosTime.hour,
                        this._webosTime.minute,
                        this._webosTime.second
                    ).getTime();

                    return new Date(baseLocalMs + elapsedMs);
                } catch (err) {
                    log.warn('WebOS native time calculation failed:', err);
                }
            }

            // Fallback to browser date if native OS bridge is unavailable on this platform
            return new Date();
        }

        // --------------------------------------------------------------------
        // Strategy: Jellyfin Server Monotonic Anchor
        // --------------------------------------------------------------------
        if (source === 'server') {
            if (this._isServerSynced && this._serverAnchor) {
                try {
                    // Elapsed high-resolution monotonic time since the last server sync
                    const elapsed = performance.now() - this._serverAnchor.perfMs;
                    const serverUtcEpoch = this._serverAnchor.serverEpochMs + elapsed;

                    // Browser runtime local timezone offset in minutes West of GMT (e.g. -180 for UTC+3, -120 for UTC+2, 0 for UTC)
                    const browserOffsetMinutes = new Date().getTimezoneOffset();

                    // Retrieve user-configured timezone offset preference
                    // Value can be 'auto' or offset in minutes East of UTC as string (e.g. '120' for UTC+2, '-300' for UTC-5)
                    const selectedTz =
                        (typeof PlayerSettings !== 'undefined' && PlayerSettings.get('timeZoneOffset')) || 'auto';
                    let targetOffsetEastMinutes = null;

                    // Parse manual UTC offset if explicitly selected
                    if (selectedTz !== 'auto') {
                        const parsed = parseInt(selectedTz, 10);
                        if (!isNaN(parsed)) {
                            targetOffsetEastMinutes = parsed;
                        }
                    }

                    // If 'auto' or parsing was not applicable, resolve local timezone from platform drivers
                    if (targetOffsetEastMinutes === null) {
                        // Check if Tizen provides native timezone configuration via secondsFromUTC
                        const tizenTz = this._getTizenDateTime();
                        if (tizenTz) {
                            try {
                                if (typeof tizenTz.secondsFromUTC === 'function') {
                                    // secondsFromUTC in Tizen TZDate returns seconds offset
                                    targetOffsetEastMinutes = -Math.round(tizenTz.secondsFromUTC() / 60);
                                }
                            } catch (_) {}
                        }

                        // Check if webOS reported a native timezone offset
                        if (
                            targetOffsetEastMinutes === null &&
                            this._webosTime &&
                            typeof this._webosTime.offsetMinutes === 'number'
                        ) {
                            // webOS offset is minutes East of GMT (e.g. +120 for UTC+2)
                            targetOffsetEastMinutes = this._webosTime.offsetMinutes;
                        }

                        // If native platform drivers did not report an offset, fallback to browser engine's local timezone
                        if (targetOffsetEastMinutes === null) {
                            targetOffsetEastMinutes = -browserOffsetMinutes;
                        }
                    }

                    /*
                     * Universal Local Time Alignment Formula
                     * -------------------------------------------------------------------------
                     * When formatting a Date instance, the host JavaScript runtime computes:
                     *   displayedTime = epochMs - (browserOffsetMinutes * 60000)
                     *
                     * We require the displayed time to accurately reflect the desired timezone:
                     *   displayedTime = serverUtcEpoch + (targetOffsetEastMinutes * 60000)
                     *
                     * Equating both expressions yields the required runtime timestamp:
                     *   epochMs = serverUtcEpoch + (targetOffsetEastMinutes + browserOffsetMinutes) * 60000
                     * -------------------------------------------------------------------------
                     */
                    const adjustmentMs = (targetOffsetEastMinutes + browserOffsetMinutes) * 60 * 1000;

                    return new Date(serverUtcEpoch + adjustmentMs);
                } catch (err) {
                    log.warn('Server anchor calculation failed:', err);
                }
            }

            // Fallback to standard browser date if server sync is still pending
            return new Date();
        }

        // --------------------------------------------------------------------
        // Strategy: Standard Browser JavaScript Engine (Default: 'browser')
        // --------------------------------------------------------------------
        return new Date();
    }

    /**
     * Convenient helper returning the current epoch millisecond timestamp.
     * @returns {number}
     */
    getTime() {
        return this.now().getTime();
    }
}

// Export singleton instance
export const timeManager = new TimeManager();
export default timeManager;
