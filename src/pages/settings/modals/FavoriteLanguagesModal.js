/**
 * ============================================================================
 * Litefin Tizen - Favorite Languages Modal Controller
 * ============================================================================
 * Manages the interactive dialog allowing users to pick favorite languages:
 * - Real-time keyword filter across names, native names, and ISO codes
 * - Interactive star toggle pins/unpins languages instantly in-place
 * - Deduplicated master catalog spanning system standards, server cultures, and UI
 * - Full remote D-pad spatial navigation across search box, list, and clear action
 * ============================================================================
 */

import { i18n } from '../../../utils/i18n.js';
import { languageManager } from '../../../utils/LanguageManager.js';
import { focusManager } from '../../../ui/FocusManager.js';
import { escapeHtml } from '../../../utils/Utils.js';
import { logger } from '../../../utils/Logger.js';

const log = logger.create('FavoriteLanguagesModal');

/**
 * Controller for the Favorite Languages selection dialog.
 */
export class FavoriteLanguagesModal {
    /**
     * Initializes a new instance of FavoriteLanguagesModal.
     * @param {Object} page Host SettingsPage instance
     */
    constructor(page) {
        this.page = page;
        this._searchQuery = '';
    }

    /**
     * Opens the Favorite Languages dialog.
     * @param {Array<Object>} [cachedCultures] Cached culture objects from server
     */
    open(cachedCultures = null) {
        log.debug('Opening FavoriteLanguagesModal');
        const overlay = this.page ? this.page.$('#modal-overlay') : document.getElementById('modal-overlay');
        if (!overlay) return;

        // Save active focus and section for restoration on dismiss
        this.page._prevFocus = focusManager.getFocused();
        this.page._prevSection = focusManager.getActiveSection();

        // Build comprehensive deduplicated master catalog of known languages
        const allLangs = [];
        const seenKeys = new Set();

        const addLanguageEntry = (item) => {
            if (!item) return;

            // Exclude dialects and regional variants (e.g., 'en-US', 'ar-EG', 'Arabic (Egypt)')
            // Subtitles and audio tracks in media streams use singular canonical languages
            const rawName = item.DisplayName || item.label || item.name || '';
            const rawCode = item.Name || item.value || item.code || '';
            if (rawCode.includes('-') || rawCode.includes('_') || rawName.includes('(')) {
                return;
            }

            // Normalize item to retrieve canonical language codes and standard names
            const norm = languageManager.normalizeLanguage(item);
            if (!norm || !norm.code) return;

            // Ensure normalized language is singular and not a regional subtag
            if (norm.code.includes('-') || norm.code.includes('_') || (norm.name && norm.name.includes('('))) {
                return;
            }

            const canonicalCode = (norm.code || '').toLowerCase();
            const twoLetterCode = (norm.twoLetter || '').toLowerCase();
            const englishName = (norm.name || '').toLowerCase();

            // Skip languages already indexed by ISO-639-2, ISO-639-1, or English name
            if (
                seenKeys.has(canonicalCode) ||
                (twoLetterCode && seenKeys.has(twoLetterCode)) ||
                (englishName && seenKeys.has(englishName))
            ) {
                return;
            }

            // Index all matching identifiers to prevent dialect collisions
            seenKeys.add(canonicalCode);
            if (twoLetterCode) seenKeys.add(twoLetterCode);
            if (englishName) seenKeys.add(englishName);
            if (norm.altCodes && Array.isArray(norm.altCodes)) {
                norm.altCodes.forEach((alt) => seenKeys.add(alt.toLowerCase()));
            }

            allLangs.push(norm);
        };

        // Populate baseline system standard languages
        languageManager.getAllStandardLanguages().forEach(addLanguageEntry);

        // Populate server-reported cultures
        if (cachedCultures && Array.isArray(cachedCultures)) {
            cachedCultures.forEach(addLanguageEntry);
        }

        // Populate client UI languages
        if (this.page && this.page.uiLanguages && Array.isArray(this.page.uiLanguages)) {
            this.page.uiLanguages.forEach(addLanguageEntry);
        }

        // Sort alphabetically by English display name
        allLangs.sort((a, b) => (a.name || '').localeCompare(b.name || ''));

        this._searchQuery = '';

        const renderModal = () => {
            // Filter languages against real-time search query
            const q = this._searchQuery.toLowerCase();
            const filteredLangs = this._searchQuery
                ? allLangs.filter(
                      (l) =>
                          (l.name && l.name.toLowerCase().includes(q)) ||
                          (l.nativeName && l.nativeName.toLowerCase().includes(q)) ||
                          (l.code && l.code.toLowerCase().includes(q)) ||
                          (l.twoLetter && l.twoLetter.toLowerCase().includes(q))
                  )
                : allLangs;

            // Generate full language rows with toggle buttons
            const langRowsHtml = filteredLangs
                .map((l) => {
                    const isFav = languageManager.isFavorite(l);
                    const codeBadge = (l.twoLetter || l.code).toUpperCase();
                    const nativeStr = l.nativeName && l.nativeName !== l.name ? ` (${escapeHtml(l.nativeName)})` : '';
                    return `
                    <button class="modal-option-btn fav-lang-row ${isFav ? 'selected' : ''}" data-code="${l.code}" tabindex="0">
                        <div class="fav-lang-info">
                            <span class="track-badge">${codeBadge}</span>
                            <span class="fav-lang-name">${escapeHtml(l.name)}${nativeStr}</span>
                        </div>
                        <div class="fav-lang-star ${isFav ? 'active' : ''}">${isFav ? '★' : '☆'}</div>
                    </button>
                `;
                })
                .join('');

            overlay.innerHTML = `
                <div class="settings-modal fav-languages-modal" role="dialog" aria-modal="true">
                    <div class="modal-header">
                        <h2 data-i18n="FavoriteLanguages">${i18n.t('FavoriteLanguages') || 'Favorite Languages'}</h2>
                    </div>
                    
                    <!-- Search Input -->
                    <div class="fav-lang-search-box">
                        <input type="text" id="fav-lang-search-input" class="fav-lang-search-input" 
                               placeholder="${i18n.t('SearchLanguages') || 'Search languages...'}" 
                               value="${escapeHtml(this._searchQuery)}" tabindex="0" />
                    </div>

                    <!-- Full Language List -->
                    <div class="modal-options fav-lang-list" id="fav-lang-list">
                        ${langRowsHtml || `<div class="modal-no-options" data-i18n="NoResultsFound">${i18n.t('NoResultsFound') || 'No languages found'}</div>`}
                    </div>

                    <div class="modal-actions">
                        <button class="modal-action-btn" id="btn-fav-lang-clear" tabindex="0" data-i18n="ClearAll">${i18n.t('ClearAll') || 'Clear All'}</button>
                    </div>
                </div>
            `;

            // Bind click handlers to toggle favorite status in-place
            overlay.querySelectorAll('.fav-lang-row').forEach((row) => {
                row.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const code = row.dataset.code;
                    const match = allLangs.find((l) => l.code === code) || code;
                    const isNowFav = languageManager.toggleFavorite(match);

                    // Update row classes and star icon in-place
                    row.classList.toggle('selected', isNowFav);
                    const starEl = row.querySelector('.fav-lang-star');
                    if (starEl) {
                        starEl.classList.toggle('active', isNowFav);
                        starEl.textContent = isNowFav ? '★' : '☆';
                    }
                });
            });

            // Bind search input with debounced restoration
            const searchInput = overlay.querySelector('#fav-lang-search-input');
            if (searchInput) {
                searchInput.addEventListener('input', (e) => {
                    this._searchQuery = e.target.value;
                    renderModal();
                    const updatedInput = overlay.querySelector('#fav-lang-search-input');
                    if (updatedInput) {
                        updatedInput.focus();
                        updatedInput.setSelectionRange(updatedInput.value.length, updatedInput.value.length);
                    }
                });
            }

            // Bind Clear All action
            overlay.querySelector('#btn-fav-lang-clear').addEventListener('click', (e) => {
                e.stopPropagation();
                languageManager.clearFavorites();
                overlay.querySelectorAll('.fav-lang-row').forEach((row) => {
                    row.classList.remove('selected');
                    const starEl = row.querySelector('.fav-lang-star');
                    if (starEl) {
                        starEl.classList.remove('active');
                        starEl.textContent = '☆';
                    }
                });
            });

            // Backdrop dismissal
            overlay.onclick = (e) => {
                if (e.target === overlay) {
                    e.stopPropagation();
                    this.close();
                }
            };

            // Register spatial navigation sections: Search -> List -> Actions
            this.page.registerFocusSection('fav-search', overlay.querySelector('.fav-lang-search-box'), {
                orientation: 'horizontal',
                leaveDown: 'fav-list'
            });

            this.page.registerFocusSection('fav-list', overlay.querySelector('#fav-lang-list'), {
                orientation: 'vertical',
                leaveUp: 'fav-search',
                leaveDown: 'fav-actions'
            });

            this.page.registerFocusSection('fav-actions', overlay.querySelector('.modal-actions'), {
                orientation: 'horizontal',
                leaveUp: 'fav-list'
            });

            // Initial focus
            focusManager.setActiveSection('fav-search');
            setTimeout(() => {
                const searchEl = overlay.querySelector('#fav-lang-search-input');
                if (searchEl) focusManager.focusElement(searchEl);
            }, 50);
        };

        overlay.classList.add('visible');
        overlay.setAttribute('aria-hidden', 'false');

        renderModal();
    }

    /**
     * Closes the favorite languages modal dialog and restores focus.
     */
    close() {
        const overlay = this.page ? this.page.$('#modal-overlay') : document.getElementById('modal-overlay');
        if (!overlay || !overlay.classList.contains('visible')) return;

        overlay.onclick = null;
        overlay.classList.remove('visible');
        overlay.setAttribute('aria-hidden', 'true');
        overlay.innerHTML = '';

        // Unregister modal focus sections
        this.page.unregisterFocusSection('fav-search');
        this.page.unregisterFocusSection('fav-list');
        this.page.unregisterFocusSection('fav-actions');
        focusManager.unregister('fav-search');
        focusManager.unregister('fav-list');
        focusManager.unregister('fav-actions');

        // Update settings trigger button label
        if (this.page) {
            const countLabel = this.page.$('#favorite-languages-count-label');
            if (countLabel) {
                countLabel.innerText = languageManager.hasFavorites()
                    ? i18n.t('LanguagesSelected', [languageManager.getFavorites().length])
                    : i18n.t('AllLanguages') || 'All Languages';
            }

            // Restore active section and focus
            const targetSection = this.page._prevSection || 'settings-display';
            focusManager.setActiveSection(targetSection, false);

            if (this.page._prevFocus && document.contains(this.page._prevFocus)) {
                focusManager.focusElement(this.page._prevFocus);
            } else {
                const manageBtn = this.page.$('#btn-manage-favorite-languages');
                if (manageBtn) {
                    focusManager.focusElement(manageBtn);
                } else {
                    focusManager.focusFirstInActiveSection();
                }
            }

            this.page._prevFocus = null;
            this.page._prevSection = null;
        }
    }

    /**
     * Destroys modal state.
     */
    destroy() {
        this.close();
    }
}

export default FavoriteLanguagesModal;
