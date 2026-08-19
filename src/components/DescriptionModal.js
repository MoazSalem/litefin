/**
 * ============================================================================
 * Litefin Tizen - Description Modal Component
 * ============================================================================
 * Displays full item overview description in a wide, scrollable dialog.
 * Designed following TV/desktop UI best practices:
 * sleek, modern, minimal aesthetic with responsive focus feel, dark frosted UI,
 * clear typography, and full D-pad/keyboard/mouse support.
 *
 * Direct Remote Controls:
 * - D-pad UP/DOWN: Smooth scroll text
 * - Remote OK / Enter key: Close modal immediately
 * - Remote Back / Esc key: Close modal immediately
 * ============================================================================
 */

import { focusManager } from '../ui/FocusManager.js';
import { i18n } from '../utils/i18n.js';
import { logger } from '../utils/Logger.js';

const log = logger.create('DescriptionModal');

class DescriptionModal {
    /**
     * Show the Description Modal.
     * @param {Object} options
     * @param {string} options.title - The title of the item
     * @param {string} options.overview - The full overview text
     * @param {Object} detailsPage - Reference to parent DetailsPage instance
     */
    static show({ title, overview }, detailsPage) {
        // Capture previous focus state so we restore focus perfectly upon closing
        const prevFocus = focusManager.getFocused();
        const prevSection = focusManager.getActiveSection();
        const oldOnBack = detailsPage.onBack;

        // Clean up any stale overlay instance that might exist
        let overlay = document.getElementById('details-description-modal');
        if (overlay) overlay.remove();

        // Create overlay container
        overlay = document.createElement('div');
        overlay.id = 'details-description-modal';
        overlay.className = 'modal-overlay visible';
        document.body.appendChild(overlay);

        const safeTitle = i18n.ensureBiDi(title || i18n.t('Overview') || 'Overview');
        const safeOverview = overview || '';

        // Render clean, wide modal HTML without footer buttons
        overlay.innerHTML = `
            <div class="settings-modal description-dialog-modal" role="dialog" aria-modal="true" aria-label="${safeTitle}">
                <div class="modal-header">
                    <h2>${safeTitle}</h2>
                </div>
                <div class="modal-options description-dialog-content media-info-scrollable" id="description-modal-scrollable" tabindex="0">
                    <p class="description-dialog-text">${safeOverview}</p>
                </div>
            </div>
        `;

        const scrollableContent = overlay.querySelector('#description-modal-scrollable');

        // Capture timestamp to debounce instant keyup/keydown events right after opening
        const openedAt = Date.now();

        // Cleanup & Close Helper
        const _close = (restoreFocus = true) => {
            // Restore previous onBack handler
            if (detailsPage.onBack === myOnBack) {
                detailsPage.onBack = oldOnBack;
            }

            // Animate out gracefully
            overlay.classList.remove('visible');
            setTimeout(() => overlay.remove(), 300);

            // Unregister focus section created for this modal
            focusManager.unregister('description-modal-content');

            // Restore focus state
            if (restoreFocus) {
                if (prevSection) focusManager.setActiveSection(prevSection, false);
                if (prevFocus) focusManager.focusElement(prevFocus);
            }
        };

        // Scroll helper function for D-Pad UP/DOWN movement
        const _handleScroll = (direction) => {
            if (direction === 'up') {
                if (scrollableContent.scrollTop > 0) {
                    scrollableContent.scrollTop -= 180;
                    return true;
                }
            } else if (direction === 'down') {
                const isAtBottom = scrollableContent.scrollHeight - scrollableContent.scrollTop <= scrollableContent.clientHeight + 10;
                if (!isAtBottom) {
                    scrollableContent.scrollTop += 180;
                    return true;
                }
            }
            return false;
        };

        // Register focus section on the scrollable content container
        // Utilizing onMove callback so FocusManager delegates UP/DOWN directly to our scroll handler
        focusManager.register('description-modal-content', scrollableContent, {
            orientation: 'vertical',
            leaveUp: null,
            leaveDown: null,
            leaveLeft: null,
            leaveRight: null,
            onMove: (direction) => {
                if (direction === 'up' || direction === 'down') {
                    _handleScroll(direction);
                    return true; // Indicate we consumed the move event
                }
                return false;
            }
        });

        // Additional keydown listener as fallback for direct element focus / native key events
        scrollableContent.addEventListener('keydown', (e) => {
            const now = Date.now();

            // 1. Remote OK / Enter key (13) closes modal
            if (e.keyCode === 13) {
                if (now - openedAt > 200) {
                    e.preventDefault();
                    e.stopPropagation();
                    _close();
                }
                return;
            }

            // 2. D-pad UP (38) / DOWN (40) scrolling
            if (e.keyCode === 38) {
                if (_handleScroll('up')) {
                    e.preventDefault();
                    e.stopPropagation();
                }
            } else if (e.keyCode === 40) {
                if (_handleScroll('down')) {
                    e.preventDefault();
                    e.stopPropagation();
                }
            }
        });

        // Intercept remote Back key
        const myOnBack = () => {
            _close();
            return true;
        };
        detailsPage.onBack = myOnBack;

        // Click anywhere inside or outside content closes the modal
        overlay.onclick = () => {
            if (Date.now() - openedAt > 200) {
                _close();
            }
        };

        // Set focus directly onto the scrollable content container (in the middle of the modal)
        focusManager.setActiveSection('description-modal-content');
        focusManager.focusElement(scrollableContent);
    }
}

export default DescriptionModal;
