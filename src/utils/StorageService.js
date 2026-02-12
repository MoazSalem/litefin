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

        // Flush pending writes on visibility change (TV sleep, input switch)
        // This prevents data loss if the app is suspended without a clean exit
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'hidden') {
                this.flush();
            }
        });
    }

    // ========================================================================
    // Read Operations (instant — from memory only)
    // ========================================================================

    /**
     * Get a value by key. Returns null if the key doesn't exist, matching
     * the native localStorage.getItem() behavior.
     * @param {string} key - Storage key
     * @returns {string|null} The stored value or null
     */
    getItem(key) {
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

        // Skip if value hasn't actually changed
        if (this._cache.get(key) === strValue) return;

        // Update in-memory cache immediately
        this._cache.set(key, strValue);

        // Mark this key as needing a disk write
        this._dirtyKeys.add(key);

        // If this key was pending removal, cancel that removal
        this._removedKeys.delete(key);

        // Schedule a batched flush to disk
        this._scheduleSave();
    }

    /**
     * Remove a key. Deletes from memory immediately and schedules disk removal.
     * @param {string} key - Storage key to remove
     */
    removeItem(key) {
        // Only act if the key actually exists in our cache
        if (!this._cache.has(key)) return;

        // Remove from in-memory cache
        this._cache.delete(key);

        // If this key was pending a write, cancel it
        this._dirtyKeys.delete(key);

        // Mark for disk removal on next flush
        this._removedKeys.add(key);

        // Schedule flush
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
        return this._cache.size;
    }

    /**
     * Get a key by its index position.
     * Mirrors localStorage.key(index).
     * @param {number} index - Zero-based index
     * @returns {string|null} The key at that index, or null
     */
    key(index) {
        const keys = Array.from(this._cache.keys());
        return index >= 0 && index < keys.length ? keys[index] : null;
    }

    /**
     * Get all keys in the cache.
     * Convenience method — avoids the awkward length/key(i) loop pattern.
     * @returns {string[]} Array of all keys
     */
    keys() {
        return Array.from(this._cache.keys());
    }

    // ========================================================================
    // Flush Control
    // ========================================================================

    /**
     * Force an immediate synchronous flush of all pending writes to disk.
     * Called on app exit and visibility change to prevent data loss.
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
                    // localStorage can throw if storage quota is exceeded
                    log.error(`Failed to write key "${key}" to disk:`, e);
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
}

// ============================================================================
// Singleton Export
// ============================================================================
export const storage = new StorageService();
export default StorageService;
