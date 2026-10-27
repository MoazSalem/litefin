/**
 * ============================================================================
 * Litefin Tizen - Selection Modal Dialog Controller
 * ============================================================================
 * Manages the generic full-screen overlay selection modal dialog:
 * - Dynamic favorite language filter tabs with D-pad Left/Right navigation
 * - In-place star toggle for language options
 * - Percentage completeness badges for translation coverage
 * - Spatial navigation with focus restoration
 * ============================================================================
 */

import { focusManager } from '../../../ui/FocusManager.js';
import { languageManager } from '../../../utils/LanguageManager.js';
import { isAudioFallbackSelect } from '../../../utils/AudioFallbackConfig.js';
import { eventBus } from '../../../core/EventBus.js';
import { i18n } from '../../../utils/i18n.js';
import { escapeHtml } from '../../../utils/Utils.js';
import { logger } from '../../../utils/Logger.js';

const log = logger.create('SelectionModal');

/**
 * Controller for the generic option selection modal dialog.
 */
export class SelectionModal {
    /**
     * Initializes a new instance of SelectionModal.
     * @param {Object} page Host SettingsPage instance
     */
    constructor(page) {
        this.page = page;
        this._modalFocusChangedHandler = null;
    }

    /**
     * Opens the selection modal dialog.
     * @param {string} title Modal header title
     * @param {Array<Object>} options Selectable option items
     * @param {string} currentValue Currently active value
     * @param {Function} onSelect Selection callback
     * @param {string} [selectId=''] Dropdown control identifier
     */
    open(title, options, currentValue, onSelect, selectId = '') {
        log.debug(`Opening SelectionModal for ${selectId || title}`);
        const overlay = this.page ? this.page.$('#modal-overlay') : document.getElementById('modal-overlay');
        if (!overlay) return;

        // Store focus context for restoration
        this.page._prevFocus = focusManager.getFocused();
        this.page._prevSection = focusManager.getActiveSection();

        // Check if this dropdown is a language selection menu
        const isLanguageSelect =
            selectId === 'app-language-select' ||
            selectId === 'audio-lang-select' ||
            isAudioFallbackSelect(selectId) ||
            selectId === 'subtitle-lang-select' ||
            (title &&
                (title.toLowerCase().includes('language') ||
                    title.toLowerCase().includes('idioma') ||
                    title.toLowerCase().includes('langue') ||
                    title.toLowerCase().includes('sprache')));

        // Determine initial filter view
        let activeFilter = isLanguageSelect && languageManager.hasFavorites() ? 'favorites' : 'all';

        const renderModalContent = () => {
            let displayOptions = options;
            if (isLanguageSelect && activeFilter === 'favorites') {
                displayOptions = languageManager.filterOptions(options);
            }

            const favoritesCount = options.filter((o) => languageManager.isFavorite(o)).length;

            let filterPillsHtml = '';
            if (isLanguageSelect && languageManager.hasFavorites()) {
                filterPillsHtml = `
                    <div class="modal-filter-pills" id="modal-lang-filter-pills">
                        <button class="modal-filter-pill ${activeFilter === 'favorites' ? 'active' : ''}" data-filter="favorites" tabindex="0">
                            ★ ${i18n.t('FavoritesOnly') || 'Favorites'} (${favoritesCount})
                        </button>
                        <button class="modal-filter-pill ${activeFilter === 'all' ? 'active' : ''}" data-filter="all" tabindex="0">
                            ${i18n.t('AllLanguages') || 'All Languages'} (${options.length})
                        </button>
                    </div>
                `;
            }

            const optionsHtml =
                displayOptions.length === 0
                    ? `
                    <div class="modal-empty-placeholder" style="padding: 24px 16px; text-align: center; opacity: 0.7; font-size: 1.1rem; pointer-events: none;" data-i18n="NoOptionsAvailable">
                        ${i18n.t('NoOptionsAvailable') || 'No options available'}
                    </div>
                `
                    : displayOptions
                          .map((opt) => {
                              let badge = '';
                              if (opt.completeness !== undefined) {
                                  const percentage = Math.floor(opt.completeness);
                                  let innerBadge = '';
                                  if (percentage === 0) {
                                      innerBadge = `<span class="track-badge lang-badge badge-danger">0%</span>`;
                                  } else if (percentage < 85) {
                                      innerBadge = `<span class="track-badge lang-badge badge-warning">${percentage}%</span>`;
                                  } else {
                                      innerBadge = `<span class="track-badge lang-badge badge-success">100%</span>`;
                                  }
                                  badge = `<span class="track-badges">${innerBadge}</span>`;
                              }

                              let starBtnHtml = '';
                              if (isLanguageSelect) {
                                  const valStr = String(opt.value).toLowerCase();
                                  const isSpecial =
                                      valStr === 'none' || valStr === 'default' || valStr === 'auto' || valStr === '-1';
                                  if (!isSpecial) {
                                      const isFav = languageManager.isFavorite(opt);
                                      starBtnHtml = `
                                <span class="modal-star-btn ${isFav ? 'active' : ''}" data-value="${opt.value}" title="Toggle Favorite" role="button" aria-label="Toggle Favorite">
                                    ${isFav ? '★' : '☆'}
                                </span>
                            `;
                                  }
                              }

                              return `
                        <button class="modal-option-btn ${String(opt.value) === String(currentValue) ? 'selected' : ''}" 
                                data-value="${escapeHtml(String(opt.value))}"
                                tabindex="0">
                            <span class="modal-option-label">${escapeHtml(i18n.ensureBiDi(opt.label))}</span>
                            ${badge}
                            ${starBtnHtml}
                        </button>
                    `;
                          })
                          .join('');

            overlay.innerHTML = `
                <div class="settings-modal" role="dialog" aria-modal="true">
                    <div class="modal-header">
                        <h2>${title}</h2>
                    </div>
                    ${filterPillsHtml}
                    <div class="modal-options">
                        ${optionsHtml}
                    </div>
                    <div class="modal-actions">
                        <button class="modal-action-btn" id="btn-modal-cancel" tabindex="0" data-i18n="ButtonCancel">${i18n.t('ButtonCancel')}</button>
                    </div>
                </div>
            `;

            // Bind option clicks
            overlay.querySelectorAll('.modal-option-btn').forEach((btn) => {
                btn.addEventListener('click', (e) => {
                    if (e.target.closest('.modal-star-btn')) {
                        e.stopPropagation();
                        const starBtn = e.target.closest('.modal-star-btn');
                        const val = starBtn.dataset.value;
                        const matchedOpt = options.find((o) => String(o.value) === String(val)) || val;
                        const isNowFav = languageManager.toggleFavorite(matchedOpt);

                        if (activeFilter === 'all') {
                            starBtn.classList.toggle('active', isNowFav);
                            starBtn.textContent = isNowFav ? '★' : '☆';

                            const favPill = overlay.querySelector('.modal-filter-pill[data-filter="favorites"]');
                            if (favPill) {
                                const newCount = options.filter((o) => languageManager.isFavorite(o)).length;
                                favPill.textContent = `★ ${i18n.t('FavoritesOnly') || 'Favorites'} (${newCount})`;
                            }
                        } else {
                            const currentIdx = Array.from(overlay.querySelectorAll('.modal-option-btn')).indexOf(btn);
                            renderModalContent();
                            const remainingOptions = overlay.querySelectorAll('.modal-option-btn');
                            if (remainingOptions.length > 0) {
                                const targetIdx = Math.min(currentIdx, remainingOptions.length - 1);
                                focusManager.setActiveSection('modal-options');
                                focusManager.focusElement(remainingOptions[targetIdx]);
                            }
                        }
                        return;
                    }
                    e.stopPropagation();
                    onSelect(btn.dataset.value);
                    this.close();
                });
            });

            // Bind filter pill clicks
            overlay.querySelectorAll('.modal-filter-pill').forEach((pill) => {
                pill.addEventListener('click', (e) => {
                    e.stopPropagation();
                    activeFilter = pill.dataset.filter;
                    renderModalContent();
                });
            });

            overlay.querySelector('#btn-modal-cancel').addEventListener('click', (e) => {
                e.stopPropagation();
                this.close();
            });

            overlay.onclick = (e) => {
                if (e.target === overlay) {
                    e.stopPropagation();
                    this.close();
                }
            };

            // Register spatial navigation sections
            if (overlay.querySelector('#modal-lang-filter-pills')) {
                this.page.registerFocusSection('modal-filter-pills', overlay.querySelector('#modal-lang-filter-pills'), {
                    orientation: 'horizontal',
                    leaveDown: 'modal-options',
                    onMove: (direction) => {
                        const isRtl = document.documentElement.getAttribute('dir') === 'rtl';
                        if (direction === 'left') {
                            const targetFilter = isRtl ? 'all' : 'favorites';
                            if (activeFilter !== targetFilter) {
                                activeFilter = targetFilter;
                                renderModalContent();
                                setTimeout(() => {
                                    const pill = overlay.querySelector(
                                        `.modal-filter-pill[data-filter="${targetFilter}"]`
                                    );
                                    if (pill) focusManager.focusElement(pill);
                                }, 50);
                                return true;
                            }
                        } else if (direction === 'right') {
                            const targetFilter = isRtl ? 'favorites' : 'all';
                            if (activeFilter !== targetFilter) {
                                activeFilter = targetFilter;
                                renderModalContent();
                                setTimeout(() => {
                                    const pill = overlay.querySelector(
                                        `.modal-filter-pill[data-filter="${targetFilter}"]`
                                    );
                                    if (pill) focusManager.focusElement(pill);
                                }, 50);
                                return true;
                            }
                        }
                        return false;
                    }
                });
            }

            this.page.registerFocusSection('modal-options', overlay.querySelector('.modal-options'), {
                orientation: 'vertical',
                leaveDown: 'modal-actions',
                leaveUp: overlay.querySelector('#modal-lang-filter-pills') ? 'modal-filter-pills' : 'modal-actions',
                enterTo: 'last-focused',
                onMove: (direction) => {
                    if (isLanguageSelect && languageManager.hasFavorites()) {
                        const isRtl = document.documentElement.getAttribute('dir') === 'rtl';
                        if (direction === 'left') {
                            const targetFilter = isRtl ? 'all' : 'favorites';
                            if (activeFilter !== targetFilter) {
                                activeFilter = targetFilter;
                                renderModalContent();
                                return true;
                            }
                        } else if (direction === 'right') {
                            const targetFilter = isRtl ? 'favorites' : 'all';
                            if (activeFilter !== targetFilter) {
                                activeFilter = targetFilter;
                                renderModalContent();
                                return true;
                            }
                        }
                    }
                    return false;
                }
            });

            this.page.registerFocusSection('modal-actions', overlay.querySelector('.modal-actions'), {
                orientation: 'horizontal',
                leaveUp: 'modal-options',
                onMove: (direction) => {
                    if (direction === 'down') {
                        focusManager.setActiveSection('modal-options', true, null, { enterTo: 'first' });
                        return true;
                    }
                    return false;
                }
            });

            // Focus appropriate element
            if (displayOptions.length === 0) {
                focusManager.setActiveSection('modal-actions');
                setTimeout(() => {
                    const cancelBtn = overlay.querySelector('#btn-modal-cancel');
                    if (cancelBtn) focusManager.focusElement(cancelBtn);
                }, 50);
            } else {
                focusManager.setActiveSection('modal-options');
                setTimeout(() => {
                    const selected =
                        overlay.querySelector('.modal-option-btn.selected') ||
                        overlay.querySelector('.modal-option-btn');
                    if (selected) focusManager.focusElement(selected);
                }, 50);
            }
        };

        overlay.classList.add('visible');
        overlay.setAttribute('aria-hidden', 'false');

        renderModalContent();
    }

    /**
     * Closes the selection modal dialog and restores focus.
     */
    close() {
        const overlay = this.page ? this.page.$('#modal-overlay') : document.getElementById('modal-overlay');
        if (!overlay || !overlay.classList.contains('visible')) return;

        if (this._modalFocusChangedHandler) {
            eventBus.off('focus:changed', this._modalFocusChangedHandler);
            this._modalFocusChangedHandler = null;
        }

        overlay.onclick = null;
        overlay.classList.remove('visible');
        overlay.setAttribute('aria-hidden', 'true');
        overlay.innerHTML = '';

        // Unregister modal focus sections
        focusManager.unregister('modal-filter-pills');
        focusManager.unregister('modal-slot-pills');
        focusManager.unregister('modal-options');
        focusManager.unregister('modal-loader-options');
        focusManager.unregister('modal-color-grid');
        focusManager.unregister('modal-actions');
        focusManager.unregister('modal-error-content');

        // Restore Section & Focus
        if (this.page) {
            if (this.page._prevSection) {
                focusManager.setActiveSection(this.page._prevSection, false);
            }
            if (this.page._prevFocus) {
                focusManager.focusElement(this.page._prevFocus);
            }
            this.page._prevFocus = null;
            this.page._prevSection = null;
        }
    }

    /**
     * Cleans up all attached modal resources.
     */
    destroy() {
        this.close();
    }
}

export default SelectionModal;
