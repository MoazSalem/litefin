/**
 * ============================================================================
 * Litefin Tizen - Trailer Dialog
 * ============================================================================
 * Selection dialog shown when an item has BOTH local and remote trailers.
 * Offers two choices: "Play Local" (native player) and "Watch Online" (iframe).
 *
 * When only one type exists this dialog is skipped entirely — the caller
 * is responsible for detecting that and routing directly.
 *
 * Pattern: mirrors `MediaInfoModal` — static class, overlay div injected into
 * document.body, `detailsPage.onBack` hijacked for Back-key support.
 * ============================================================================
 */

import { focusManager } from '../ui/FocusManager.js';
import { i18n } from '../utils/i18n.js';
import { logger } from '../utils/Logger.js';
import { tizenAdapter } from '../tizen/TizenAdapter.js';
import { webosAdapter } from '../webos/WebOSAdapter.js';

const log = logger.create('TrailerDialog');

class TrailerDialog {
    /**
     * Show the trailer selection dialog.
     *
     * @param {Object} options
     * @param {boolean} options.hasLocal         - Whether local trailers are available
     * @param {boolean} options.hasRemote        - Whether remote trailers are available
     * @param {Object}  detailsPage              - The parent DetailsPage instance (for onBack/focus)
     * @param {Function} onPlayLocal             - Callback when "Play Local" is selected
     * @param {Function} onPlayRemote            - Callback when "Watch Online" is selected
     */
    static show({ hasLocal, hasRemote }, detailsPage, onPlayLocal, onPlayRemote) {
        // Capture current focus context so we can restore it on close
        const prevFocus   = focusManager.getFocused();
        const prevSection = focusManager.getActiveSection();
        const oldOnBack   = detailsPage.onBack;

        // ================================================================
        // Build the overlay
        // ================================================================

        // Remove any stale instance before creating a fresh one
        let overlay = document.getElementById('trailer-dialog');
        if (overlay) overlay.remove();

        overlay = document.createElement('div');
        overlay.id        = 'trailer-dialog';
        overlay.className = 'modal-overlay visible';
        document.body.appendChild(overlay);

        // ================================================================
        // Build option list HTML
        // ================================================================

        const options = [];

        if (hasLocal) {
            options.push({
                id: 'local',
                // Icon: film reel (inline SVG to keep zero external deps)
                icon: `<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M18 3v2h-2V3H8v2H6V3H4v18h2v-2h2v2h8v-2h2v2h2V3h-2zM8 17H6v-2h2v2zm0-4H6v-2h2v2zm0-4H6V7h2v2zm10 8h-2v-2h2v2zm0-4h-2v-2h2v2zm0-4h-2V7h2v2z"/>
                </svg>`,
                label: i18n.t('PlayLocalTrailer') || 'Play Local Trailer',
                sublabel: i18n.t('PlayLocalTrailerHint') || 'Stored on your server'
            });
        }

        if (hasRemote) {
            options.push({
                id: 'remote',
                // Icon: external link / globe
                icon: `<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"/>
                </svg>`,
                label: i18n.t('WatchTrailerOnline') || 'Watch Online',
                sublabel: (tizenAdapter.isTizen() || webosAdapter.isWebOS) 
                    ? (i18n.t('WatchTrailerYouTubeHint') || 'Opens YouTube app') 
                    : (i18n.t('WatchTrailerOnlineHint') || 'Opens an in-app viewer')
            });
        }

        // Build option buttons HTML
        const optionsHtml = options.map((opt) => `
            <button class="modal-option-btn trailer-option" data-id="${opt.id}" tabindex="0">
                <span class="trailer-option-icon">${opt.icon}</span>
                <span class="trailer-option-text">
                    <span class="trailer-option-label">${opt.label}</span>
                    <span class="trailer-option-sublabel">${opt.sublabel}</span>
                </span>
            </button>
        `).join('');

        overlay.innerHTML = `
            <div class="settings-modal trailer-dialog-modal" role="dialog" aria-modal="true" aria-label="${i18n.t('WatchTrailer') || 'Watch Trailer'}">
                <div class="modal-header">
                    <h2>${i18n.t('WatchTrailer') || 'Watch Trailer'}</h2>
                </div>
                <div class="modal-options trailer-dialog-options" id="trailer-dialog-options">
                    ${optionsHtml}
                </div>
                <div class="modal-actions" id="trailer-dialog-actions">
                    <button class="modal-action-btn" id="trailer-dialog-cancel" tabindex="0">
                        ${i18n.t('ButtonCancel') || 'Cancel'}
                    </button>
                </div>
            </div>
        `;

        // ================================================================
        // Close helper — restores focus and removes overlay
        // ================================================================

        const _close = (restoreFocus = true) => {
            // Only uninstall our onBack handler if it's still active
            if (detailsPage.onBack === myOnBack) {
                detailsPage.onBack = oldOnBack;
            }

            // Animate out, then remove from DOM
            overlay.classList.remove('visible');
            setTimeout(() => overlay.remove(), 300);

            // Unregister focus sections added by this dialog
            focusManager.unregister('trailer-dialog-options');
            focusManager.unregister('trailer-dialog-actions');

            if (restoreFocus) {
                if (prevSection) focusManager.setActiveSection(prevSection, false);
                if (prevFocus)   focusManager.focusElement(prevFocus);
            }
        };

        // ================================================================
        // Selection handler — calls the appropriate callback, then closes
        // ================================================================

        const _onSelect = (id) => {
            _close(true); // Close AND restore focus so the remote player captures the right caller

            if (id === 'local') {
                log.info('User chose: Play Local Trailer');
                onPlayLocal();
            } else if (id === 'remote') {
                log.info('User chose: Watch Online (remote trailer)');
                onPlayRemote();
            }
        };

        // ================================================================
        // Focus management
        // ================================================================

        const optionsContainer = overlay.querySelector('#trailer-dialog-options');
        const actionsContainer = overlay.querySelector('#trailer-dialog-actions');

        // Options list — vertical, circular, links down to Cancel
        focusManager.register('trailer-dialog-options', optionsContainer, {
            orientation: 'vertical',
            circular: true,
            leaveDown: 'trailer-dialog-actions',
            leaveLeft: null,
            leaveRight: null,
            enterTo: 'first'
        });

        // Cancel button row — links back up to options
        focusManager.register('trailer-dialog-actions', actionsContainer, {
            orientation: 'horizontal',
            leaveUp: 'trailer-dialog-options',
            leaveLeft: null,
            leaveRight: null
        });

        // Default focus: first option
        focusManager.setActiveSection('trailer-dialog-options');

        // ================================================================
        // Event bindings
        // ================================================================

        // Option buttons
        overlay.querySelectorAll('.trailer-option').forEach((btn) => {
            btn.onclick = (e) => {
                e.stopPropagation();
                _onSelect(btn.dataset.id);
            };
        });

        // Cancel button
        overlay.querySelector('#trailer-dialog-cancel').onclick = (e) => {
            e.stopPropagation();
            _close();
        };

        // Click outside the modal card closes it
        overlay.onclick = (e) => {
            if (e.target === overlay) _close();
        };

        // ================================================================
        // Back-key integration
        // ================================================================

        const myOnBack = () => {
            _close();
            return true; // Signal that we consumed the back event
        };
        detailsPage.onBack = myOnBack;
    }
}

export default TrailerDialog;
