/**
 * ============================================================================
 * Litefin Tizen - Audio Fallback Languages Modal Controller
 * ============================================================================
 * Manages the unified preferred and fallback audio languages configuration
 * dialog. Supports 2-tier tab bar navigation:
 * - Tier 1: Filter tabs (Favorites vs All Languages)
 * - Tier 2: Priority slot tabs (Preferred Language, Fallback 1, Fallback 2, Fallback 3)
 * Provides remote D-pad Left/Right navigation across slots, star toggle for
 * favorite languages, and deterministic focus trapping/restoration.
 * ============================================================================
 */

import { api } from '../../../api/index.js';
import { storage } from '../../../utils/StorageService.js';
import { i18n } from '../../../utils/i18n.js';
import { escapeHtml } from '../../../utils/Utils.js';
import { languageManager } from '../../../utils/LanguageManager.js';
import { focusManager } from '../../../ui/FocusManager.js';
import { logger } from '../../../utils/Logger.js';
import { AUDIO_FALLBACK_SLOTS } from '../../../utils/AudioFallbackConfig.js';

const log = logger.create('AudioFallbackModal');

/**
 * Controller for the Audio Fallback Languages selection modal dialog.
 */
export class AudioFallbackModal {
    /**
     * Initializes a new instance of AudioFallbackModal.
     * @param {Object} pageContext Parent SettingsPage instance
     */
    constructor(pageContext) {
        this.page = pageContext;
    }

    /**
     * Generates a human-readable summary string of preferred and fallback languages.
     * @param {Array} prefLanguages Cached list of available language options
     * @returns {string} Formatted summary (e.g. "Japanese • 1: English")
     */
    static getSummaryLabel(prefLanguages = []) {
        const rawPref = storage.getItem('pref:audioLang');
        const prefVal = !rawPref || rawPref === 'Default' ? 'Default' : rawPref;
        let prefLabel = i18n.t('Default') || 'Default';

        if (prefVal !== 'Default') {
            const match = prefLanguages.find((o) => String(o.value) === String(prefVal));
            prefLabel = match ? match.label : prefVal;
        }

        const fallbackParts = [];
        for (const priority of AUDIO_FALLBACK_SLOTS) {
            const raw = storage.getItem(`pref:audioLangFallback${priority}`);
            if (raw && raw !== 'Default' && raw !== 'none') {
                const match = prefLanguages.find((o) => String(o.value) === String(raw));
                const name = match ? match.label : raw;
                fallbackParts.push(`${priority}: ${name}`);
            }
        }

        return fallbackParts.length > 0 ? `${prefLabel} • ${fallbackParts.join(' • ')}` : prefLabel;
    }

    /**
     * Opens the audio fallback selection modal dialog.
     */
    async open() {
        const overlay = this.page?.$?.('#modal-overlay') || document.querySelector('#modal-overlay');
        if (!overlay) return;

        // Ensure cultures are loaded before displaying modal content
        if (!this.page?.prefLanguages || this.page.prefLanguages.length <= 1) {
            try {
                const cultures = await api.getCultures();
                if (cultures && Array.isArray(cultures)) {
                    languageManager.registerCultures(cultures);
                    // Filter out regional dialects to retain only singular canonical languages
                    const singularCultures = languageManager.filterSingularCultures(cultures);
                    this.page.prefLanguages = singularCultures
                        .map((c) => ({
                            value: c.ThreeLetterISOLanguageName || c.Name,
                            label: i18n.ensureBiDi(c.DisplayName),
                            ThreeLetterISOLanguageName: c.ThreeLetterISOLanguageName,
                            TwoLetterISOLanguageName: c.TwoLetterISOLanguageName,
                            DisplayName: c.DisplayName
                        }))
                        .sort((a, b) => a.label.localeCompare(b.label));
                }
            } catch (err) {
                log.error('Failed to load cultures for audio fallback modal:', err);
            }
        }

        // Preserve previous focus state for dismissal restoration
        if (this.page) {
            this.page._prevFocus = focusManager.getFocused();
            this.page._prevSection = focusManager.getActiveSection();
        }

        const SLOTS = ['pref', '1', '2', '3'];
        let activeSlot = 'pref';
        let activeFilter = languageManager.hasFavorites() ? 'favorites' : 'all';
        // Filter out Default/none and exclude any regional dialects
        const validLanguages = languageManager.filterSingularCultures(
            (this.page?.prefLanguages || []).filter((o) => o.value !== 'Default' && o.value !== 'none')
        );

        // Helper: retrieve slot label and short code
        const getSlotValueAndLabel = (slot) => {
            const isPref = slot === 'pref';
            const raw = storage.getItem(isPref ? 'pref:audioLang' : `pref:audioLangFallback${slot}`);
            const fallbackDefault = isPref ? 'Default' : 'none';
            const val = !raw || raw === 'Default' || raw === 'none' ? fallbackDefault : raw;

            if (val === 'Default' || val === 'none') {
                const label = i18n.t(isPref ? 'Default' : 'None') || (isPref ? 'Default' : 'None');
                return { value: val, label, shortLabel: label };
            }

            const match = validLanguages.find((o) => String(o.value) === String(val));
            const fullLabel = match ? match.label : val;
            const twoLetter = match?.TwoLetterISOLanguageName || languageManager.normalizeLanguage(val)?.twoLetter;
            const shortCode = (twoLetter || match?.ThreeLetterISOLanguageName || val).toLowerCase();
            return { value: val, label: fullLabel, shortLabel: shortCode };
        };

        const renderModal = (focusTarget = 'options') => {
            const currentSlotInfo = getSlotValueAndLabel(activeSlot);
            const currentSlotVal = currentSlotInfo.value;
            const specialOption = activeSlot === 'pref'
                ? { value: 'Default', label: i18n.t('Default') || 'Default' }
                : { value: 'none', label: i18n.t('None') || 'None' };

            const hasFavorites = languageManager.hasFavorites();
            if (!hasFavorites && activeFilter === 'favorites') activeFilter = 'all';

            const filteredLanguages = hasFavorites && activeFilter === 'favorites'
                ? languageManager.filterOptions(validLanguages)
                : validLanguages;

            const slotOptions = [specialOption, ...filteredLanguages];
            const favoritesCount = validLanguages.filter((o) => languageManager.isFavorite(o)).length;
            const allCount = validLanguages.length;

            // Tier 1: Filter tabs
            const filterPillsHtml = hasFavorites ? `
                <div class="modal-filter-pills has-slot-subrow" id="modal-lang-filter-pills">
                    <button class="modal-filter-pill ${activeFilter === 'favorites' ? 'active' : ''}" data-filter="favorites" tabindex="0">
                        ★ ${i18n.t('FavoritesOnly') || 'Favorites'} (${favoritesCount})
                    </button>
                    <button class="modal-filter-pill ${activeFilter === 'all' ? 'active' : ''}" data-filter="all" tabindex="0">
                        ${i18n.t('AllLanguages') || 'All Languages'} (${allCount})
                    </button>
                </div>` : '';

            // Tier 2: Priority slot tabs
            const slotPillsHtml = `
                <div class="modal-slot-pills" id="modal-audio-slot-pills">
                    ${SLOTS.map((slot) => {
                        const isActive = slot === activeSlot;
                        const info = getSlotValueAndLabel(slot);
                        const displayTitle = slot === 'pref' ? (i18n.t('Preferred') || 'Preferred') : `${i18n.t('Fallback') || 'Fallback'} ${slot}`;
                        return `
                            <button class="modal-filter-pill modal-slot-pill ${isActive ? 'active' : ''}" data-slot="${slot}" tabindex="0" title="${displayTitle}: ${escapeHtml(info.label)}">
                                <span class="slot-pill-title">${displayTitle}:</span>
                                <span class="slot-pill-val">${escapeHtml(info.shortLabel)}</span>
                            </button>`;
                    }).join('')}
                </div>`;

            // Tier 3: Language options list
            const optionsHtml = slotOptions.map((opt) => {
                const isSelected = String(opt.value) === String(currentSlotVal);
                const valStr = String(opt.value).toLowerCase();
                const isSpecial = valStr === 'none' || valStr === 'default' || valStr === 'auto' || valStr === '-1';
                const isFav = !isSpecial && languageManager.isFavorite(opt);
                const starBtn = !isSpecial ? `<span class="modal-star-btn ${isFav ? 'active' : ''}" data-value="${opt.value}" role="button" aria-label="Toggle Favorite">${isFav ? '★' : '☆'}</span>` : '';

                return `
                    <button class="modal-option-btn ${isSelected ? 'selected' : ''}" data-value="${opt.value}" tabindex="0">
                        <span class="modal-option-label">${escapeHtml(i18n.ensureBiDi(opt.label))}</span>
                        ${starBtn}
                    </button>`;
            }).join('');

            overlay.innerHTML = `
                <div class="settings-modal" role="dialog" aria-modal="true">
                    <div class="modal-header">
                        <h2>${i18n.t('LabelAudioLanguagePreference') || 'Preferred audio language'}</h2>
                    </div>
                    ${filterPillsHtml}
                    ${slotPillsHtml}
                    <div class="modal-options">${optionsHtml}</div>
                    <div class="modal-actions">
                        <button class="modal-action-btn primary" id="btn-modal-done" tabindex="0" data-i18n="Done">${i18n.t('Done') || 'Done'}</button>
                    </div>
                </div>`;

            this._bindModalEvents(overlay, validLanguages, renderModal, () => activeSlot, (v) => { activeSlot = v; }, () => activeFilter, (v) => { activeFilter = v; });
            this._registerFocusSections(overlay, hasFavorites, renderModal, SLOTS, () => activeSlot, (v) => { activeSlot = v; }, activeFilter, focusTarget);
        };

        overlay.classList.add('visible');
        overlay.setAttribute('aria-hidden', 'false');
        renderModal('options');
    }

    /**
     * Binds click and interaction events for the audio fallback modal.
     * @private
     */
    _bindModalEvents(overlay, validLanguages, renderModal, getActiveSlot, setActiveSlot, getActiveFilter, setActiveFilter) {
        // Wire option and star clicks
        overlay.querySelectorAll('.modal-option-btn').forEach((btn) => {
            btn.addEventListener('click', (e) => {
                if (e.target.closest('.modal-star-btn')) {
                    e.stopPropagation();
                    const starBtn = e.target.closest('.modal-star-btn');
                    const val = starBtn.dataset.value;
                    const matchedOpt = validLanguages.find((o) => String(o.value) === String(val)) || val;
                    const isNowFav = languageManager.toggleFavorite(matchedOpt);

                    if (getActiveFilter() === 'all') {
                        starBtn.classList.toggle('active', isNowFav);
                        starBtn.textContent = isNowFav ? '★' : '☆';
                        const favPill = overlay.querySelector('.modal-filter-pill[data-filter="favorites"]');
                        if (favPill) {
                            const count = validLanguages.filter((o) => languageManager.isFavorite(o)).length;
                            favPill.textContent = `★ ${i18n.t('FavoritesOnly') || 'Favorites'} (${count})`;
                        }
                    } else {
                        renderModal('options');
                    }
                    return;
                }

                e.stopPropagation();
                const chosenValue = btn.dataset.value;
                const slot = getActiveSlot();
                if (slot === 'pref') {
                    storage.setItem('pref:audioLang', chosenValue);
                } else {
                    storage.setItem(`pref:audioLangFallback${slot}`, chosenValue);
                }

                const triggerBtn = this.page?.$?.('#audio-fallback-languages-btn .btn-label');
                if (triggerBtn) {
                    triggerBtn.innerText = AudioFallbackModal.getSummaryLabel(this.page?.prefLanguages);
                }
                renderModal('options');
            });
        });

        // Wire Tier 1 filter pills
        overlay.querySelectorAll('#modal-lang-filter-pills .modal-filter-pill').forEach((pill) => {
            pill.addEventListener('click', (e) => {
                e.stopPropagation();
                const targetFilter = pill.dataset.filter;
                if (targetFilter && targetFilter !== getActiveFilter()) {
                    setActiveFilter(targetFilter);
                    renderModal('filter-pills');
                }
            });
        });

        // Wire Tier 2 slot pills
        overlay.querySelectorAll('#modal-audio-slot-pills .modal-slot-pill').forEach((pill) => {
            pill.addEventListener('click', (e) => {
                e.stopPropagation();
                const targetSlot = pill.dataset.slot;
                if (targetSlot && targetSlot !== getActiveSlot()) {
                    setActiveSlot(targetSlot);
                    renderModal('slot-pills');
                }
            });
        });

        // Wire Done button and backdrop dismiss
        overlay.querySelector('#btn-modal-done')?.addEventListener('click', (e) => {
            e.stopPropagation();
            this.page?._closeSelectionModal?.();
        });
        overlay.onclick = (e) => {
            if (e.target === overlay) {
                e.stopPropagation();
                this.page?._closeSelectionModal?.();
            }
        };
    }

    /**
     * Registers spatial navigation focus sections for the modal.
     * @private
     */
    _registerFocusSections(overlay, hasFavorites, renderModal, SLOTS, getActiveSlot, setActiveSlot, activeFilter, focusTarget) {
        const switchSlot = (direction, targetFocus) => {
            const isRtl = document.documentElement.getAttribute('dir') === 'rtl';
            const curIdx = SLOTS.indexOf(getActiveSlot());
            const delta = direction === 'left' ? (isRtl ? 1 : -1) : isRtl ? -1 : 1;
            const nextIdx = curIdx + delta;
            if (nextIdx >= 0 && nextIdx < SLOTS.length) {
                setActiveSlot(SLOTS[nextIdx]);
                renderModal(targetFocus);
                return true;
            }
            return false;
        };

        if (hasFavorites && overlay.querySelector('#modal-lang-filter-pills')) {
            focusManager.register('modal-filter-pills', overlay.querySelector('#modal-lang-filter-pills'), {
                orientation: 'horizontal',
                leaveDown: 'modal-slot-pills'
            });
        } else {
            focusManager.unregister('modal-filter-pills');
        }

        focusManager.register('modal-slot-pills', overlay.querySelector('#modal-audio-slot-pills'), {
            orientation: 'horizontal',
            leaveUp: hasFavorites ? 'modal-filter-pills' : null,
            leaveDown: 'modal-options',
            onMove: (dir) => (dir === 'left' || dir === 'right') && switchSlot(dir, 'slot-pills')
        });

        focusManager.register('modal-options', overlay.querySelector('.modal-options'), {
            orientation: 'vertical',
            leaveUp: 'modal-slot-pills',
            leaveDown: 'modal-actions',
            enterTo: 'last-focused',
            onMove: (dir) => (dir === 'left' || dir === 'right') && switchSlot(dir, 'options')
        });

        focusManager.register('modal-actions', overlay.querySelector('.modal-actions'), {
            orientation: 'horizontal',
            leaveUp: 'modal-options'
        });

        // Apply initial focus
        setTimeout(() => {
            if (focusTarget === 'filter-pills' && hasFavorites) {
                focusManager.setActiveSection('modal-filter-pills');
                const pill = overlay.querySelector(`#modal-lang-filter-pills .modal-filter-pill[data-filter="${activeFilter}"]`);
                if (pill) focusManager.focusElement(pill);
            } else if (focusTarget === 'slot-pills' || (focusTarget === 'filter-pills' && !hasFavorites)) {
                focusManager.setActiveSection('modal-slot-pills');
                const pill = overlay.querySelector(`#modal-audio-slot-pills .modal-slot-pill[data-slot="${getActiveSlot()}"]`);
                if (pill) focusManager.focusElement(pill);
            } else if (focusTarget === 'actions') {
                focusManager.setActiveSection('modal-actions');
                const btn = overlay.querySelector('#btn-modal-done');
                if (btn) focusManager.focusElement(btn);
            } else {
                focusManager.setActiveSection('modal-options');
                const selected = overlay.querySelector('.modal-option-btn.selected') || overlay.querySelector('.modal-option-btn');
                if (selected) {
                    focusManager.focusElement(selected);
                    selected.scrollIntoView?.({ block: 'nearest' });
                }
            }
        }, 40);
    }
}

export default AudioFallbackModal;
