/**
 * ============================================================================
 * Litefin - PinManager
 * ============================================================================
 * Opt-in, per-profile PIN lock for profile selection.
 *
 * This is a LOCAL convenience lock, not server authentication. A user can
 * enable a 4-digit PIN from Settings; once set, the PIN must be entered before
 * that profile can be selected on the sign-in page (LoginPage) or switched to
 * in-app ("Who's Watching" / ProfilesPage). It stacks on top of (and is
 * independent of) the Jellyfin account password.
 *
 * SECURITY NOTE: The stored value is a lightly obfuscated (salted, non-crypto)
 * hash — NOT real cryptography. `crypto.subtle` is unreliable on the legacy
 * Chromium baselines this app targets and is overkill for a kid/housemate
 * lock. Treat this as obfuscation, not a security boundary against someone
 * with local-storage access.
 *
 * Storage: one key per user, `pin:<userId>`, holding the hashed PIN string.
 * ============================================================================
 */

import { storage } from './StorageService.js';
import { logger } from './Logger.js';

const log = logger.create('PinManager');

// Fixed app salt mixed into the hash so the stored value isn't a bare digest
// of the digits. Not secret (it's in the bundle) — just raises the bar above
// plaintext.
const PIN_SALT = 'litefin:pin:v1';

const KEY_PREFIX = 'pin:';

class PinManager {
    /**
     * Build the storage key for a user.
     * @param {string} userId
     * @returns {string}
     * @private
     */
    _key(userId) {
        return KEY_PREFIX + userId;
    }

    /**
     * Deterministic, non-cryptographic salted hash of a PIN.
     * djb2-style string hash over salt + pin, returned as an unsigned hex
     * string. Stable across reloads so verification works.
     * @param {string} pin
     * @returns {string}
     * @private
     */
    _hash(pin) {
        const input = PIN_SALT + ':' + String(pin);
        let h = 5381;
        for (let i = 0; i < input.length; i++) {
            // h * 33 + charCode, kept in 32-bit range
            h = (h * 33) ^ input.charCodeAt(i);
        }
        // Coerce to unsigned 32-bit, then hex
        return (h >>> 0).toString(16);
    }

    /**
     * Whether the given user has a PIN configured.
     * @param {string} userId
     * @returns {boolean}
     */
    hasPin(userId) {
        if (!userId) return false;
        return storage.getItem(this._key(userId)) !== null;
    }

    /**
     * Store (or replace) the PIN for a user.
     * @param {string} userId
     * @param {string} pin - raw 4-digit PIN
     */
    setPin(userId, pin) {
        if (!userId) {
            log.warn('setPin called without a userId — ignoring');
            return;
        }
        storage.setItem(this._key(userId), this._hash(pin));
        log.info('PIN set for user');
    }

    /**
     * Verify a candidate PIN against the stored hash.
     * @param {string} userId
     * @param {string} pin - raw candidate PIN
     * @returns {boolean}
     */
    verifyPin(userId, pin) {
        if (!userId) return false;
        const stored = storage.getItem(this._key(userId));
        if (stored === null) return false;
        return stored === this._hash(pin);
    }

    /**
     * Remove a user's PIN (disables the lock for that profile).
     * @param {string} userId
     */
    removePin(userId) {
        if (!userId) return;
        storage.removeItem(this._key(userId));
        log.info('PIN removed for user');
    }
}

export const pinManager = new PinManager();
export default PinManager;
