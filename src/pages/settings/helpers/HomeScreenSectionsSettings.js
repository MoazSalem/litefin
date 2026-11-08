/**
 * ============================================================================
 * Litefin Tizen - Home Screen Sections Settings
 * ============================================================================
 * Adds the Home Screen Sections server plugin rows to the Home layout editor
 * (Settings → Home), so they can be reordered or hidden like native rows.
 * The plugin itself is switched on or off in Settings → Plugins.
 * ============================================================================
 */

import { storage } from '../../../utils/StorageService.js';
import { i18n } from '../../../utils/i18n.js';
import { isHomeScreenSectionsEnabled, readSectionList } from '../../../utils/HomeScreenSections.js';

/**
 * Adds the Home Screen Sections rows to the layout editor list, using the
 * section list saved by the last load.
 * @param {Array<{id: string, title: string}>} descriptors
 */
export function appendHomeScreenSectionsRows(descriptors) {
    if (!isHomeScreenSectionsEnabled(storage)) return;
    readSectionList(storage).forEach((section) => {
        descriptors.push({
            id: section.id,
            title: i18n.t('HomeScreenSectionsRowTitle', [section.title])
        });
    });
}
