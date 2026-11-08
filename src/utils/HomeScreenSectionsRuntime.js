/**
 * ============================================================================
 * Litefin Tizen - Home Screen Sections Runtime Wiring
 * ============================================================================
 *
 * Connects the dependency-free Home Screen Sections provider to the app's API
 * client, language and Seerr client. Shared by HomePage and the Home settings
 * tab so both talk to the server plugin the same way.
 * ============================================================================
 */

import { api } from '../api/index.js';
import { i18n } from './i18n.js';
import { logger } from './Logger.js';
import { createHomeScreenSectionsProvider } from './HomeScreenSections.js';

const log = logger.create('HomeScreenSections');

/**
 * Whether Seerr can be used in Litefin. Imported on demand like in the Sidebar
 * so the Home chunk does not pull in the Seerr client. Never rejects.
 * @returns {Promise<boolean>}
 */
export async function isSeerrAvailable() {
    try {
        const { seerr } = await import('../api/seerrClient.js');
        return !!(await seerr.isAvailable());
    } catch (err) {
        log.debug('Seerr availability check failed', err);
        return false;
    }
}

/**
 * Creates a provider bound to the current server and user.
 * @returns {{ loadSections: Function, buildDescriptors: Function }}
 */
export function createAppHomeScreenSectionsProvider() {
    return createHomeScreenSectionsProvider({
        // suppressUnauthorized: a 401 from a plugin route must never log the user out
        getJson: (endpoint, params) => api.get(endpoint, params, { suppressUnauthorized: true, warnOnError: true }),
        serverUrl: api._serverUrl,
        userId: api._userId,
        language: i18n.currentLang,
        isSeerrAvailable,
        onError: (msg, err) => log.warn(msg, err),
        onDebug: (msg, err) => log.debug(msg, err)
    });
}
