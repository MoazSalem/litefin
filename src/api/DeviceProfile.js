/**
 * ============================================================================
 * Litefin — Device Profile (Unified Dispatcher)
 * ============================================================================
 * Single source of truth for all device capability detection and Jellyfin
 * profile generation. Delegates hardware detection, codec support, and
 * transcoding configuration to platform-specific implementations.
 *
 * @module api/DeviceProfile
 * ============================================================================
 */

import { platformInfo } from '../utils/PlatformInfo.js';
import * as TizenProfile from './profiles/TizenProfile.js';
import * as WebOSProfile from './profiles/WebOSProfile.js';
import * as WebProfile from './profiles/WebProfile.js';

export function getActiveProfileModule() {
    if (platformInfo.isWebOS) return WebOSProfile;
    if (platformInfo.isTizen) return TizenProfile;
    return WebProfile; // Default for normal web browsers
}

/**
 * Detect the Tizen platform version from tizen.systeminfo.
 * Kept for backwards compatibility for explicit callers.
 * @returns {number} Tizen version
 */
export function detectTizenVersion() {
    if (platformInfo.isTizen) {
        return TizenProfile.detectTizenVersion();
    }
    return 99; // Legacy fallback for non-Tizen
}

/**
 * Detect hardware capabilities based on the active platform.
 *
 * @returns {Object} Capabilities object with resolution, HDR, codec flags
 */
export function getDeviceCapabilities() {
    return getActiveProfileModule().getDeviceCapabilities();
}

/**
 * Clear the cached capabilities.
 */
export function clearCapabilitiesCache() {
    getActiveProfileModule().clearCapabilitiesCache();
}

/**
 * Build the complete Jellyfin DeviceProfile object based on the active platform.
 *
 * @param {Object} [options={}] - Options for profile generation
 * @param {number} [options.manualBitrate] - Optional overrides for max bitrate
 * @param {string} [options.playbackMode='auto'] - 'auto', 'directPlay', 'transcode', 'remux'
 * @returns {Object} A Jellyfin-compatible DeviceProfile
 */
export function buildJellyfinProfile(options = {}) {
    return getActiveProfileModule().buildJellyfinProfile(options);
}

/**
 * Get a unique device identifier.
 * @returns {string}
 */
export function getDeviceId() {
    return getActiveProfileModule().getDeviceId();
}

/**
 * Get a human-readable device name.
 * @returns {string}
 */
export function getDeviceName() {
    return getActiveProfileModule().getDeviceName();
}

// ============================================================================
// Convenience / Backward Compatibility Exports
// ============================================================================

/**
 * Get profile with auto-detected capabilities (backward compat).
 * @returns {Object} Jellyfin DeviceProfile
 */
export function getAutoProfile() {
    return getActiveProfileModule().buildJellyfinProfile();
}

/**
 * Legacy alias — wraps buildJellyfinProfile for old callers.
 * @param {Object} [options] - Ignored (capabilities are auto-detected now)
 * @returns {Object} Jellyfin DeviceProfile
 */
export function getDeviceProfile(options = {}) {
    return getActiveProfileModule().buildJellyfinProfile(options);
}

export default {
    detectTizenVersion,
    getDeviceCapabilities,
    clearCapabilitiesCache,
    buildJellyfinProfile,
    getDeviceId,
    getDeviceName,
    getAutoProfile,
    getDeviceProfile
};
