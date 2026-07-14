/**
 * ============================================================================
 * Litefin Tizen - StorageService
 * ============================================================================
 * In-memory cache layer over localStorage to eliminate synchronous disk I/O
 * during normal app operation. All reads come from memory, writes are batched
 * and flushed to disk on a debounced timer.
 *
 * Why: localStorage is synchronous and disk-backed. On low-end Tizen TVs,
 * each getItem/setItem call blocks the UI thread. This service loads all
 * keys once at startup and then operates entirely from RAM.
 *
 * Tizen 4 compatible — uses setTimeout instead of requestIdleCallback.
 *
 * Usage:
 *   import { storage } from '../utils/StorageService.js';
 *   storage.getItem('myKey');         // instant, from memory
 *   storage.setItem('myKey', 'val');  // writes to memory + schedules flush
 *   storage.removeItem('myKey');      // removes from memory + schedules flush
 * ============================================================================
 */

import { logger } from './Logger.js';

const log = logger.create('Storage');

// ============================================================================
// Configuration
// ============================================================================

// Debounce delay before flushing dirty keys to disk (ms)
// 1 second is a good balance between responsiveness and batching
const FLUSH_DELAY_MS = 1000;

// ============================================================================
// StorageService Class
// ============================================================================
class StorageService {
    constructor() {
        // In-memory cache of all localStorage key-value pairs
        // Populated once by init(), then serves all reads
        this._cache = new Map();

        // Set of keys that have been modified but not yet flushed to disk
        this._dirtyKeys = new Set();

        // Set of keys that need to be removed from disk on next flush
        this._removedKeys = new Set();

        // Timer handle for the debounced flush
        this._flushTimer = null;

        // Whether init() has been called
        this._initialized = false;
    }

    // ========================================================================
    // Initialization
    // ========================================================================

    /**
     * Load ALL localStorage keys into the in-memory cache.
     * Must be called once at app startup, before any other module reads storage.
     * This is the ONLY point where we do bulk synchronous disk I/O — everything
     * after this is pure memory access.
     */
    init() {
        if (this._initialized) {
            log.warn('StorageService already initialized, skipping');
            return;
        }

        const startTime = performance.now();

        // Bulk-read every key from localStorage into memory
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key !== null) {
                this._cache.set(key, localStorage.getItem(key));
            }
        }

        this._initialized = true;
        const elapsed = (performance.now() - startTime).toFixed(1);
        log.info(`Loaded ${this._cache.size} keys from localStorage in ${elapsed}ms`);

        // Flush pending writes during app teardown/sleep
        // This prevents data loss if the app is suspended or reloaded
        const flushHandler = () => this.flush();
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'hidden') flushHandler();
        });
        window.addEventListener('pagehide', flushHandler);
        window.addEventListener('beforeunload', flushHandler);
    }

    // ========================================================================
    // Read Operations (instant — from memory only)
    // ========================================================================

    /**
     * Determine if a storage key is system-level and should not be isolated per user.
     * @param {string} key
     * @returns {boolean}
     * @private
     */
    _isGlobalKey(key) {
        const globalKeys = [
            'litefin:serverUrl',
            'litefin:deviceId',
            'litefin:activeUserId',
            'litefin:serverSessions',
            'litefin:sessions',
            'litefin:serverNames',
            'litefin:accessToken',
            'litefin:userId',
            'app_platform',
            'litefin:settings_per_user',
            'litefin:skip_profiles_once'
        ];
        if (globalKeys.includes(key)) return true;
        if (key.startsWith('serverPlugin:available:')) return true;
        if (key.startsWith('litefin:user_settings_')) return true;
        if (key.startsWith('pin:')) return true;
        return false;
    }

    /**
     * Copy all current global settings to the user's isolated storage object.
     * Called the first time the toggle is active for a given user.
     * @param {string} userId
     * @private
     */
    _initializeUserSettings(userId) {
        const userSettingsKey = `litefin:user_settings_${userId}`;
        if (this._cache.has(userSettingsKey)) return;

        const userSettingsObj = {};
        for (const [k, v] of this._cache.entries()) {
            if (!this._isGlobalKey(k)) {
                userSettingsObj[k] = v;
            }
        }

        this._cache.set(userSettingsKey, JSON.stringify(userSettingsObj));
        this._dirtyKeys.add(userSettingsKey);
        this._scheduleSave();
    }

    /**
     * Get a value by key. Returns null if the key doesn't exist, matching
     * the native localStorage.getItem() behavior.
     * @param {string} key - Storage key
     * @returns {string|null} The stored value or null
     */
    getItem(key) {
        if (this._isGlobalKey(key)) {
            return this._cache.has(key) ? this._cache.get(key) : null;
        }

        if (this._cache.get('litefin:settings_per_user') === 'true') {
            const activeUserId = this._cache.get('litefin:activeUserId');
            if (activeUserId) {
                const userSettingsKey = `litefin:user_settings_${activeUserId}`;
                this._initializeUserSettings(activeUserId);

                const userSettingsObj = JSON.parse(this._cache.get(userSettingsKey) || '{}');
                return key in userSettingsObj ? userSettingsObj[key] : null;
            }
        }

        return this._cache.has(key) ? this._cache.get(key) : null;
    }

    // ========================================================================
    // Write Operations (memory + scheduled flush)
    // ========================================================================

    /**
     * Set a value. Updates memory immediately, then schedules a debounced
     * disk write. Multiple setItem calls within the flush window are batched
     * into a single disk operation per key.
     * @param {string} key - Storage key
     * @param {string} value - Value to store (will be converted to string)
     */
    setItem(key, value) {
        const strValue = String(value);

        if (this._isGlobalKey(key)) {
            if (this._cache.get(key) === strValue) return;
            this._cache.set(key, strValue);
            this._dirtyKeys.add(key);
            this._removedKeys.delete(key);
            this._scheduleSave();
            return;
        }

        if (this._cache.get('litefin:settings_per_user') === 'true') {
            const activeUserId = this._cache.get('litefin:activeUserId');
            if (activeUserId) {
                const userSettingsKey = `litefin:user_settings_${activeUserId}`;
                this._initializeUserSettings(activeUserId);

                const userSettingsObj = JSON.parse(this._cache.get(userSettingsKey) || '{}');
                if (userSettingsObj[key] === strValue) return;

                userSettingsObj[key] = strValue;
                this._cache.set(userSettingsKey, JSON.stringify(userSettingsObj));
                this._dirtyKeys.add(userSettingsKey);
                this._scheduleSave();
                return;
            }
        }

        if (this._cache.get(key) === strValue) return;

        this._cache.set(key, strValue);
        this._dirtyKeys.add(key);
        this._removedKeys.delete(key);
        this._scheduleSave();
    }

    /**
     * Remove a key. Deletes from memory immediately and schedules disk removal.
     * @param {string} key - Storage key to remove
     */
    removeItem(key) {
        if (this._isGlobalKey(key)) {
            if (!this._cache.has(key)) return;
            this._cache.delete(key);
            this._dirtyKeys.delete(key);
            this._removedKeys.add(key);
            this._scheduleSave();
            return;
        }

        if (this._cache.get('litefin:settings_per_user') === 'true') {
            const activeUserId = this._cache.get('litefin:activeUserId');
            if (activeUserId) {
                const userSettingsKey = `litefin:user_settings_${activeUserId}`;
                this._initializeUserSettings(activeUserId);

                const userSettingsObj = JSON.parse(this._cache.get(userSettingsKey) || '{}');
                if (!(key in userSettingsObj)) return;

                delete userSettingsObj[key];
                this._cache.set(userSettingsKey, JSON.stringify(userSettingsObj));
                this._dirtyKeys.add(userSettingsKey);
                this._scheduleSave();
                return;
            }
        }

        if (!this._cache.has(key)) return;

        this._cache.delete(key);
        this._dirtyKeys.delete(key);
        this._removedKeys.add(key);
        this._scheduleSave();
    }

    // ========================================================================
    // Enumeration (for Logger's key iteration pattern)
    // ========================================================================

    /**
     * Get the number of keys in the cache.
     * Mirrors localStorage.length.
     * @returns {number} Number of stored keys
     */
    get length() {
        return this.keys().length;
    }

    /**
     * Get a key by its index position.
     * Mirrors localStorage.key(index).
     * @param {number} index - Zero-based index
     * @returns {string|null} The key at that index, or null
     */
    key(index) {
        const keys = this.keys();
        return index >= 0 && index < keys.length ? keys[index] : null;
    }

    /**
     * Get all keys in the cache.
     * Convenience method — avoids the awkward length/key(i) loop pattern.
     * @returns {string[]} Array of all keys
     */
    keys() {
        const list = [];
        for (const k of this._cache.keys()) {
            if (this._isGlobalKey(k)) {
                list.push(k);
            }
        }
        if (this._cache.get('litefin:settings_per_user') === 'true') {
            const activeUserId = this._cache.get('litefin:activeUserId');
            if (activeUserId) {
                const userSettingsKey = `litefin:user_settings_${activeUserId}`;
                this._initializeUserSettings(activeUserId);
                const userSettingsObj = JSON.parse(this._cache.get(userSettingsKey) || '{}');
                for (const k in userSettingsObj) {
                    list.push(k);
                }
                return list;
            }
        }
        for (const k of this._cache.keys()) {
            if (!this._isGlobalKey(k)) {
                list.push(k);
            }
        }
        return list;
    }

    // ========================================================================
    // Bulk Operations
    // ========================================================================

    /**
     * Remove ALL keys that start with the given prefix from both the
     * in-memory cache and disk.
     *
     * Preferred over calling localStorage.clear() because that nukes
     * everything including auth tokens and user preferences. This is a
     * surgical, targeted operation — only the named group is affected.
     *
     * @param {string} prefix - The key prefix to match (e.g. 'libThumb:')
     * @returns {number} The number of keys that were removed
     */
    clearByPrefix(prefix) {
        if (this._isGlobalKey(prefix)) {
            const matching = Array.from(this._cache.keys()).filter((k) => k.startsWith(prefix));

            for (const key of matching) {
                this._cache.delete(key);
                this._dirtyKeys.delete(key);
                this._removedKeys.add(key);
            }

            if (matching.length > 0) {
                log.info(`clearByPrefix('${prefix}'): removed ${matching.length} key(s)`);
                this.flush();
            }

            return matching.length;
        }

        if (this._cache.get('litefin:settings_per_user') === 'true') {
            const activeUserId = this._cache.get('litefin:activeUserId');
            if (activeUserId) {
                const userSettingsKey = `litefin:user_settings_${activeUserId}`;
                this._initializeUserSettings(activeUserId);

                const userSettingsObj = JSON.parse(this._cache.get(userSettingsKey) || '{}');
                let count = 0;
                for (const k in userSettingsObj) {
                    if (k.startsWith(prefix)) {
                        delete userSettingsObj[k];
                        count++;
                    }
                }
                if (count > 0) {
                    this._cache.set(userSettingsKey, JSON.stringify(userSettingsObj));
                    this._dirtyKeys.add(userSettingsKey);
                    log.info(`clearByPrefix('${prefix}'): removed ${count} key(s) from user settings`);
                    this.flush();
                }
                return count;
            }
        }

        const matching = Array.from(this._cache.keys()).filter((k) => k.startsWith(prefix) && !this._isGlobalKey(k));
        for (const key of matching) {
            this._cache.delete(key);
            this._dirtyKeys.delete(key);
            this._removedKeys.add(key);
        }

        if (matching.length > 0) {
            log.info(`clearByPrefix('${prefix}'): removed ${matching.length} key(s)`);
            this.flush();
        }

        return matching.length;
    }

    /**
     * Generate a human-readable storage usage report.
     *
     * Tallies byte usage purely from the in-memory cache — zero disk I/O.
     * localStorage stores UTF-16, so each character costs 2 bytes. We count
     * both key and value lengths to match what the browser quota system tracks.
     *
     * @returns {{ totalBytes: number, keyCount: number, breakdown: Object }}
     *   breakdown keys are the first segment of each storage key (e.g. "libThumb", "pref")
     */
    getStorageReport() {
        let totalBytes = 0;
        const breakdown = {};

        for (const [key, value] of this._cache.entries()) {
            // 2 bytes per UTF-16 character for key + value
            const bytes = (key.length + (value ? value.length : 0)) * 2;
            totalBytes += bytes;

            /*
             * Group by the first semantic segment of the key name so the
             * breakdown stays readable. Priority: colon separator first
             * (e.g. "libThumb:xyz" → "libThumb"), then underscore
             * (e.g. "debug_filter_Module" → "debug"), then the whole key.
             */
            const prefix = key.includes(':') ? key.split(':')[0] : key.includes('_') ? key.split('_')[0] : key;

            breakdown[prefix] = (breakdown[prefix] || 0) + bytes;
        }

        return { totalBytes, keyCount: this._cache.size, breakdown };
    }

    // ========================================================================
    // Flush Control
    // ========================================================================

    /**
     * Force an immediate synchronous flush of all pending writes to disk.
     * Called on app exit and visibility change to prevent data loss.
     *
     * If a QuotaExceededError is encountered, the flush automatically evicts
     * all libThumb:* cache keys (the largest and most expendable group) from
     * disk and retries the write. This prevents the app from being permanently
     * broken by a full localStorage partition on older Tizen hardware.
     */
    flush() {
        // Cancel any pending debounced flush
        if (this._flushTimer !== null) {
            clearTimeout(this._flushTimer);
            this._flushTimer = null;
        }

        // Write all dirty keys to disk
        if (this._dirtyKeys.size > 0) {
            for (const key of this._dirtyKeys) {
                try {
                    localStorage.setItem(key, this._cache.get(key));
                } catch (e) {
                    // ----------------------------------------------------------------
                    // QuotaExceededError recovery strategy:
                    //
                    // Tizen's localStorage partition can fill up, particularly when
                    // the user has many libraries in static thumbnail mode. Instead
                    // of silently dropping the write (which diverges memory from disk),
                    // we evict the most expendable cache group (libThumb:*) and retry.
                    // ----------------------------------------------------------------
                    if (e.name === 'QuotaExceededError' || e.code === 22) {
                        log.warn(`QuotaExceededError writing "${key}" — evicting libThumb:* cache and retrying`);
                        this._evictLibThumbs();

                        // Retry the failed write after freeing space
                        try {
                            localStorage.setItem(key, this._cache.get(key));
                            log.info(`Retry after eviction succeeded for key "${key}"`);
                        } catch (retryErr) {
                            // Even after eviction we still can't write — disk is critically full
                            log.error(
                                `Retry still failed for key "${key}" — localStorage may be critically full`,
                                retryErr
                            );
                        }
                    } else {
                        log.error(`Failed to write key "${key}" to disk:`, e);
                    }
                }
            }
            log.debug(`Flushed ${this._dirtyKeys.size} dirty key(s) to disk`);
            this._dirtyKeys.clear();
        }

        // Remove all keys marked for deletion from disk
        if (this._removedKeys.size > 0) {
            for (const key of this._removedKeys) {
                try {
                    localStorage.removeItem(key);
                } catch (e) {
                    log.error(`Failed to remove key "${key}" from disk:`, e);
                }
            }
            log.debug(`Removed ${this._removedKeys.size} key(s) from disk`);
            this._removedKeys.clear();
        }
    }

    // ========================================================================
    // Internal — Debounced Save Scheduling
    // ========================================================================

    /**
     * Schedule a debounced flush to disk.
     * Uses setTimeout for Tizen 4 compatibility (no requestIdleCallback).
     * Multiple calls within the window collapse into a single flush.
     * @private
     */
    _scheduleSave() {
        // Already scheduled — the pending timer will handle it
        if (this._flushTimer !== null) return;

        this._flushTimer = setTimeout(() => {
            this._flushTimer = null;
            this.flush();
        }, FLUSH_DELAY_MS);
    }

    /**
     * Emergency eviction: remove all libThumb:* keys from disk-level localStorage.
     *
     * Called only when a QuotaExceededError fires during flush. These are purely
     * cosmetic cached URLs — losing them on disk is harmless because the home page
     * will regenerate them on the next visit. We do NOT remove them from the
     * in-memory cache so the current session keeps showing them.
     * @private
     */
    _evictLibThumbs() {
        let count = 0;
        for (const key of this._cache.keys()) {
            if (key.startsWith('libThumb:')) {
                try {
                    localStorage.removeItem(key);
                    count++;
                } catch (_) {
                    // Best-effort — ignore individual removal errors
                }
            }
        }
        if (count > 0) {
            log.info(`Emergency eviction: freed ${count} libThumb:* key(s) from disk`);
        }
    }
}

// ============================================================================
// Singleton Export
// ============================================================================
export const storage = new StorageService();
export default StorageService;
