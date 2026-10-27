/**
 * ============================================================================
 * Litefin Tizen - API Module Exports
 * ============================================================================
 */

export {
    api,
    discoverServers,
    cancelDiscovery,
    testServer,
    ServerUnreachableError,
    sendWakeOnLan,
    hasBackgroundDiscoveryService
} from './ApiClient.js';
export { auth } from './AuthManager.js';
export { customHeaders, HEADER_PRESETS } from '../utils/CustomHeaders.js';
export {
    getDeviceProfile,
    getAutoProfile,
    buildJellyfinProfile,
    getDeviceCapabilities,
    getDeviceId,
    getDeviceName,
    detectTizenVersion,
    clearCapabilitiesCache
} from './DeviceProfile.js';
