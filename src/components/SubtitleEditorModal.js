import { api } from '../api/index.js';
import { focusManager } from '../ui/FocusManager.js';
import { i18n } from '../utils/i18n.js';
import { toast } from '../ui/Toast.js';
import { logger } from '../utils/Logger.js';

const log = logger.create('SubtitleEditor');

class SubtitleEditorModal {
    /**
     * Display the main subtitle editor modal (Panel A).
     * @param {string} itemId           - Jellyfin item ID
     * @param {Object} detailsPage      - Reference to the parent DetailsPage instance
     * @param {Object} [transitionCtx]  - Back-navigation context from the caller modal
     */
    static async show(itemId, detailsPage, transitionCtx = null) {
        const oldOnBack = transitionCtx?.oldOnBack || detailsPage.onBack;

        // Preserve the focus state for final restoration when the entire modal chain closes.
        const prevFocus = transitionCtx?.prevFocus || focusManager.getFocused();
        const prevSection = transitionCtx?.prevSection || focusManager.getActiveSection();

        // ── Create overlay ──────────────────────────────────────────────────
        let overlay = document.getElementById('details-subtitle-editor');
        if (overlay) overlay.remove();

        overlay = document.createElement('div');
        overlay.id = 'details-subtitle-editor';
        overlay.className = 'modal-overlay visible';
        document.body.appendChild(overlay);

        // ── Fetch required data in parallel ──────────────────────────────────
        let cultures = [];
        try {
            cultures = await api.getCultures();
        } catch (e) {
            log.warn('Failed to load cultures for subtitle search', e);
        }

        // ── Helpers ──────────────────────────────────────────────────────────

        /**
         * Resolve the close function — cleans up the overlay and optionally
         * restores focus back to the caller (e.g. the details page actions row).
         */
        const _close = (restoreFocus = true) => {
            if (detailsPage.onBack === myOnBack) detailsPage.onBack = oldOnBack;

            overlay.classList.remove('visible');
            setTimeout(() => overlay.remove(), 300);

            // Unregister all focus sections owned by this modal
            focusManager.unregister('subtitle-editor-tracks');
            focusManager.unregister('subtitle-editor-search');
            focusManager.unregister('subtitle-editor-actions');

            if (restoreFocus) {
                detailsPage._prevFocus = null;
                detailsPage._prevSection = null;
                if (prevFocus) focusManager.focusElement(prevFocus);
                if (prevSection) focusManager.setActiveSection(prevSection, false);
            }
        };

        // ── Render ───────────────────────────────────────────────────────────

        /**
         * (Re)build the inner HTML of the overlay. Called on first render and
         * again after a delete to refresh the track list without reopening.
         */
        const renderPanel = () => {
            // Filter subtitle streams from the already-loaded item
            const subtitleStreams = (detailsPage._item?.MediaSources?.[0]?.MediaStreams || []).filter(
                (s) => s.Type === 'Subtitle'
            );

            // Build a row for each subtitle track.
            const tracksHtml =
                subtitleStreams.length > 0
                    ? subtitleStreams
                          .map((s) => {
                              const label = s.DisplayTitle || s.Title || s.Language || `Track ${s.Index}`;
                              const codec = (s.Codec || '').toUpperCase();
                              const loc = s.IsExternal ? 'EXT' : 'INT';
                              const canDel = !!s.Path; // Can only delete file-based external tracks

                              return `
                        <div class="subtitle-track-row" data-index="${s.Index}">
                            <span class="subtitle-track-label">${label}</span>
                            <div class="subtitle-track-meta">
                                <span class="track-badge">${codec}</span>
                                <span class="track-badge">${loc}</span>
                            </div>
                            ${
                                canDel
                                    ? `<button class="modal-option-btn subtitle-delete-btn" data-index="${s.Index}" tabindex="0">${i18n.t('Delete')}</button>`
                                    : `<span class="subtitle-track-locked" title="${i18n.t('CannotDeleteInternalSubtitle') || 'Internal track — cannot be deleted'}">🔒</span>`
                            }
                        </div>
                    `;
                          })
                          .join('')
                    : `<p class="subtitle-empty-notice">${i18n.t('LabelNoSubtitles') || 'No subtitle tracks found.'}</p>`;

            // Build language options for the search dropdown.
            const savedLang = localStorage.getItem('litefin:subtitle-language') || '';
            const audioLang =
                detailsPage._item?.MediaSources?.[0]?.MediaStreams?.find((s) => s.Type === 'Audio')?.Language || '';
            let currentLang = savedLang || audioLang || 'eng';

            const langOptions = cultures
                .filter((c) => c.ThreeLetterISOLanguageName) // Only include languages with a valid code
                .sort((a, b) => (a.DisplayName || '').localeCompare(b.DisplayName || ''))
                .map((c) => ({
                    value: c.ThreeLetterISOLanguageName,
                    label: c.DisplayName || c.ThreeLetterISOLanguageName
                }));

            // Find current label
            const currentOption = langOptions.find((o) => o.value === currentLang) || langOptions[0];
            const currentLabel = currentOption ? currentOption.label : 'English';

            overlay.innerHTML = `
                <div class="settings-modal" role="dialog" aria-modal="true">
                    <div class="modal-header">
                        <h2>${i18n.t('EditSubtitles') || 'Edit Subtitles'}</h2>
                    </div>

                    <!-- Current subtitle tracks -->
                    <div class="modal-section-title">${i18n.t('HeaderMySubtitles') || 'My Subtitles'}</div>
                    <div class="subtitle-tracks-list modal-options" id="subtitle-tracks-list">
                        ${tracksHtml}
                    </div>

                    <!-- Remote subtitle search -->
                    <div class="modal-section-title">${i18n.t('SearchSubtitles') || 'Search Subtitles'}</div>
                    <div class="subtitle-search-row">
                        <button id="subtitle-lang-select-btn" class="modal-select setting-action-btn select-btn" tabindex="0" data-value="${currentLang}">
                            <span class="btn-label">${currentLabel}</span>
                        </button>
                        <button id="btn-subtitle-search" class="modal-action-btn" tabindex="0">${i18n.t('Search') || 'Search'}</button>
                    </div>

                    <div class="modal-actions">
                        <button class="modal-action-btn" id="btn-subtitle-cancel" tabindex="0">${i18n.t('ButtonCancel')}</button>
                    </div>
                </div>
            `;

            // ── Language Selection Modal ─────────────────────────────────────
            const showLanguageModal = () => {
                const langBtn = overlay.querySelector('#subtitle-lang-select-btn');
                const prevFocus = focusManager.getFocused();
                const prevSection = focusManager.getActiveSection();

                // Build options HTML
                const optionsHtml = langOptions
                    .map(
                        (opt) => `
                    <button class="modal-option-btn ${opt.value === currentLang ? 'selected' : ''}" 
                            data-value="${opt.value}"
                            tabindex="0">
                        <span>${opt.label}</span>
                        <div class="check-icon"></div>
                    </button>
                `
                    )
                    .join('');

                const subOverlay = document.createElement('div');
                subOverlay.className = 'modal-overlay visible';
                subOverlay.id = 'subtitle-lang-modal-overlay';

                subOverlay.innerHTML = `
                    <div class="settings-modal" role="dialog" aria-modal="true">
                        <div class="modal-header">
                            <h2>${i18n.t('LabelLanguage') || 'Language'}</h2>
                        </div>
                        <div class="modal-options">
                            ${optionsHtml}
                        </div>
                        <div class="modal-actions">
                            <button class="modal-action-btn" id="btn-lang-modal-cancel" tabindex="0">${i18n.t('ButtonCancel')}</button>
                        </div>
                    </div>
                `;

                overlay.appendChild(subOverlay);

                const closeLangModal = () => {
                    subOverlay.remove();
                    focusManager.unregister('lang-modal-options');
                    focusManager.unregister('lang-modal-actions');
                    if (prevSection) focusManager.setActiveSection(prevSection, false);
                    if (prevFocus) focusManager.focusElement(prevFocus);
                };

                // Bind events
                subOverlay.querySelectorAll('.modal-option-btn').forEach((btn) => {
                    btn.addEventListener('click', (e) => {
                        e.stopPropagation();
                        currentLang = btn.dataset.value;
                        const newLabel = langOptions.find((o) => o.value === currentLang)?.label || currentLang;
                        if (langBtn) {
                            langBtn.dataset.value = currentLang;
                            langBtn.querySelector('.btn-label').textContent = newLabel;
                        }
                        closeLangModal();
                    });
                });

                subOverlay.querySelector('#btn-lang-modal-cancel').addEventListener('click', (e) => {
                    e.stopPropagation();
                    closeLangModal();
                });

                subOverlay.addEventListener('click', (e) => {
                    if (e.target === subOverlay) closeLangModal();
                });

                // Focus Registration
                detailsPage.registerFocusSection('lang-modal-options', subOverlay.querySelector('.modal-options'), {
                    orientation: 'vertical',
                    leaveDown: 'lang-modal-actions',
                    leaveUp: 'lang-modal-actions',
                    enterTo: 'last-focused'
                });

                detailsPage.registerFocusSection('lang-modal-actions', subOverlay.querySelector('.modal-actions'), {
                    orientation: 'horizontal',
                    leaveUp: 'lang-modal-options',
                    onMove: (direction) => {
                        if (direction === 'down') {
                            focusManager.setActiveSection('lang-modal-options', true, null, { enterTo: 'first' });
                            return true;
                        }
                        return false;
                    }
                });

                focusManager.setActiveSection('lang-modal-options');
                setTimeout(() => {
                    const selected =
                        subOverlay.querySelector('.modal-option-btn.selected') ||
                        subOverlay.querySelector('.modal-option-btn');
                    if (selected) focusManager.focusElement(selected);
                }, 50);
            };

            // Bind lang select button
            overlay.querySelector('#subtitle-lang-select-btn').onclick = (e) => {
                e.stopPropagation();
                showLanguageModal();
            };

            // ── Bind delete buttons ──────────────────────────────────────────
            overlay.querySelectorAll('.subtitle-delete-btn').forEach((btn) => {
                btn.onclick = async (e) => {
                    e.stopPropagation();
                    const streamIndex = parseInt(btn.dataset.index, 10);

                    // Disable the button immediately to prevent double-clicks
                    btn.disabled = true;
                    btn.textContent = '...';

                    try {
                        await api.deleteSubtitle(itemId, streamIndex);
                        await this._reloadSubtitleStreams(itemId, detailsPage);
                        renderPanel();
                        _bindPanelFocus();
                    } catch (err) {
                        log.error('Failed to delete subtitle', err);
                        toast.show(i18n.t('MessageErrorDeletingSubtitle') || 'Failed to delete subtitle.');
                        btn.disabled = false;
                        btn.textContent = i18n.t('Delete');
                    }
                };
            });

            // ── Bind search button ───────────────────────────────────────────
            overlay.querySelector('#btn-subtitle-search').onclick = async (e) => {
                e.stopPropagation();
                // Persist the selection for next time
                localStorage.setItem('litefin:subtitle-language', currentLang);

                // Close Panel A (without full cleanup) and open results Panel B
                focusManager.unregister('subtitle-editor-tracks');
                focusManager.unregister('subtitle-editor-search');
                focusManager.unregister('subtitle-editor-actions');

                this._showSubtitleResultsModal(
                    itemId,
                    currentLang,
                    overlay,
                    renderPanel,
                    _close,
                    oldOnBack,
                    prevFocus,
                    prevSection,
                    detailsPage
                );
            };

            // ── Bind cancel button ───────────────────────────────────────────
            overlay.querySelector('#btn-subtitle-cancel').onclick = (e) => {
                e.stopPropagation();
                _close();
            };

            // ── Click outside to close ───────────────────────────────────────
            overlay.onclick = (e) => {
                if (e.target === overlay) _close();
            };
        };

        /**
         * Register focus sections for the Panel A layout.
         */
        const _bindPanelFocus = () => {
            const trackList = overlay.querySelector('#subtitle-tracks-list');
            const searchRow = overlay.querySelector('.subtitle-search-row');
            const actionsRow = overlay.querySelector('.modal-actions');

            if (trackList) {
                focusManager.register('subtitle-editor-tracks', trackList, {
                    orientation: 'vertical',
                    leaveDown: 'subtitle-editor-search',
                    leaveUp: 'subtitle-editor-actions',
                    circular: false
                });
            }

            if (searchRow) {
                focusManager.register('subtitle-editor-search', searchRow, {
                    orientation: 'horizontal',
                    leaveUp: trackList?.childElementCount > 0 ? 'subtitle-editor-tracks' : 'subtitle-editor-actions',
                    leaveDown: 'subtitle-editor-actions'
                });
            }

            if (actionsRow) {
                focusManager.register('subtitle-editor-actions', actionsRow, {
                    orientation: 'horizontal',
                    leaveUp: 'subtitle-editor-search',
                    leaveDown: trackList?.childElementCount > 0 ? 'subtitle-editor-tracks' : 'subtitle-editor-search'
                });
            }

            focusManager.setActiveSection('subtitle-editor-search');
        };

        // ── First render ─────────────────────────────────────────────────────
        renderPanel();
        _bindPanelFocus();

        // ── Back button ──────────────────────────────────────────────────────
        const myOnBack = () => {
            const subModal = document.getElementById('subtitle-lang-modal-overlay');
            if (subModal) {
                subModal.querySelector('#btn-lang-modal-cancel')?.click();
                return true;
            }

            if (transitionCtx?.fromMoreOptions) {
                detailsPage.onBack = oldOnBack;
                _close(false);
                detailsPage._showMoreOptionsModal(itemId);
            } else {
                _close();
            }
            return true;
        };
        detailsPage.onBack = myOnBack;
    }

    /**
     * Display remote subtitle search results (Panel B).
     */
    static async _showSubtitleResultsModal(
        itemId,
        language,
        overlay,
        renderPanel,
        closeAll,
        oldOnBack,
        prevFocus,
        prevSection,
        detailsPage
    ) {
        // Show a loading state inside the existing overlay while we fetch
        overlay.querySelector('.settings-modal').innerHTML = `
            <div class="modal-header"><h2>${i18n.t('SearchSubtitles') || 'Search Subtitles'}</h2></div>
            <div class="modal-options"><p class="subtitle-empty-notice">${i18n.t('Searching') || 'Searching…'}</p></div>
            <div class="modal-actions">
                <button class="modal-action-btn" id="btn-results-back" tabindex="0">${i18n.t('ButtonBack') || 'Back'}</button>
                <button class="modal-action-btn" id="btn-results-cancel" tabindex="0">${i18n.t('ButtonCancel')}</button>
            </div>
        `;

        let results = [];
        try {
            results = await api.searchSubtitles(itemId, language);
        } catch (err) {
            log.error('Subtitle search failed', err);
            toast.show(i18n.t('MessageErrorSubtitleSearch') || 'Subtitle search failed.');
        }

        // ── Build results HTML ───────────────────────────────────────────────
        const resultsHtml =
            results && results.length > 0
                ? results
                      .map((r, idx) => {
                          const name = r.Name || `Result ${idx + 1}`;
                          const provider = r.ProviderName || '';
                          const format = (r.Format || '').toUpperCase();
                          const downloads = r.DownloadCount != null ? `↓ ${r.DownloadCount}` : '';
                          const rating = r.CommunityRating != null ? `★ ${r.CommunityRating.toFixed(1)}` : '';

                          return `
                    <button class="modal-option-btn subtitle-result-btn" data-id="${r.Id}" tabindex="0">
                        <span class="track-option-label">
                            <span class="track-label-text">${name}</span>
                            <span class="subtitle-result-meta">
                                ${provider ? `<span class="track-badge">${provider}</span>` : ''}
                                ${format ? `<span class="track-badge">${format}</span>` : ''}
                                ${downloads ? `<span class="track-badge">${downloads}</span>` : ''}
                                ${rating ? `<span class="track-badge">${rating}</span>` : ''}
                            </span>
                        </span>
                        <div class="check-icon">⬇</div>
                    </button>
                `;
                      })
                      .join('')
                : `<p class="subtitle-empty-notice">${i18n.t('NoSubtitleSearchResultsFound') || 'No results found.'}</p>`;

        // Re-render the overlay with final results
        overlay.querySelector('.settings-modal').innerHTML = `
            <div class="modal-header"><h2>${i18n.t('SearchSubtitles') || 'Search Subtitles'}</h2></div>
            <div class="modal-options" id="subtitle-results-list">${resultsHtml}</div>
            <div class="modal-actions">
                <button class="modal-action-btn" id="btn-results-back" tabindex="0">${i18n.t('ButtonBack') || 'Back'}</button>
                <button class="modal-action-btn" id="btn-results-cancel" tabindex="0">${i18n.t('ButtonCancel')}</button>
            </div>
        `;

        // ── Bind download buttons ────────────────────────────────────────────
        overlay.querySelectorAll('.subtitle-result-btn').forEach((btn) => {
            btn.onclick = async (e) => {
                e.stopPropagation();
                const subtitleId = btn.dataset.id;

                // Visual feedback — disable button immediately
                btn.disabled = true;
                const icon = btn.querySelector('.check-icon');
                if (icon) icon.textContent = '…';

                try {
                    await api.downloadSubtitle(itemId, subtitleId);
                    toast.show(i18n.t('MessageSubtitleDownloadQueued') || 'Subtitle queued for download.');
                } catch (err) {
                    log.error('Failed to queue subtitle download', err);
                    toast.show(i18n.t('MessageSubtitleDownloadFailed') || 'Download failed.');
                    btn.disabled = false;
                    if (icon) icon.textContent = '⬇';
                    return;
                }

                // Reload item streams and go back to Panel A
                await this._reloadSubtitleStreams(itemId, detailsPage);
                focusManager.unregister('subtitle-results-list');
                focusManager.unregister('subtitle-results-actions');

                renderPanel();
                _bindResultsFocus(); // will be gone; call Panel A focus binder

                // Re-register Panel A focus
                const trackList = overlay.querySelector('#subtitle-tracks-list');
                const searchRow = overlay.querySelector('.subtitle-search-row');
                const actionsRow = overlay.querySelector('.modal-actions');

                if (trackList)
                    detailsPage.registerFocusSection('subtitle-editor-tracks', trackList, {
                        orientation: 'vertical',
                        leaveDown: 'subtitle-editor-search',
                        leaveUp: 'subtitle-editor-actions'
                    });
                if (searchRow)
                    detailsPage.registerFocusSection('subtitle-editor-search', searchRow, {
                        orientation: 'horizontal',
                        leaveUp: 'subtitle-editor-tracks',
                        leaveDown: 'subtitle-editor-actions'
                    });
                if (actionsRow)
                    detailsPage.registerFocusSection('subtitle-editor-actions', actionsRow, {
                        orientation: 'horizontal',
                        leaveUp: 'subtitle-editor-search'
                    });
                focusManager.setActiveSection('subtitle-editor-search');
            };
        });

        // ── Back button — return to Panel A ──────────────────────────────────
        const goBack = () => {
            focusManager.unregister('subtitle-results-list');
            focusManager.unregister('subtitle-results-actions');

            renderPanel();

            // Re-bind Panel A focus after renderPanel rebuilt the DOM
            const trackList = overlay.querySelector('#subtitle-tracks-list');
            const searchRow = overlay.querySelector('.subtitle-search-row');
            const actionsRow = overlay.querySelector('.modal-actions');

            if (trackList)
                detailsPage.registerFocusSection('subtitle-editor-tracks', trackList, {
                    orientation: 'vertical',
                    leaveDown: 'subtitle-editor-search',
                    leaveUp: 'subtitle-editor-actions'
                });
            if (searchRow)
                detailsPage.registerFocusSection('subtitle-editor-search', searchRow, {
                    orientation: 'horizontal',
                    leaveUp: 'subtitle-editor-tracks',
                    leaveDown: 'subtitle-editor-actions'
                });
            if (actionsRow)
                detailsPage.registerFocusSection('subtitle-editor-actions', actionsRow, {
                    orientation: 'horizontal',
                    leaveUp: 'subtitle-editor-search'
                });
            focusManager.setActiveSection('subtitle-editor-search');

            // Restore Panel A's back handler
            detailsPage.onBack = panelAOnBack;
        };

        overlay.querySelector('#btn-results-back').onclick = (e) => {
            e.stopPropagation();
            goBack();
        };

        overlay.querySelector('#btn-results-cancel').onclick = (e) => {
            e.stopPropagation();
            closeAll();
        };

        overlay.onclick = (e) => {
            if (e.target === overlay) closeAll();
        };

        // ── Focus setup ──────────────────────────────────────────────────────
        const resultsList = overlay.querySelector('#subtitle-results-list');
        const actionsPanel = overlay.querySelector('.modal-actions');

        const _bindResultsFocus = () => {}; // placeholder so download handler can call it safely

        if (resultsList) {
            focusManager.register('subtitle-results-list', resultsList, {
                orientation: 'vertical',
                leaveDown: 'subtitle-results-actions',
                leaveUp: 'subtitle-results-actions',
                circular: false
            });
        }

        if (actionsPanel) {
            focusManager.register('subtitle-results-actions', actionsPanel, {
                orientation: 'horizontal',
                leaveUp: 'subtitle-results-list'
            });
        }

        // Land focus on results list if there are results, otherwise on the Back button
        if (results && results.length > 0) {
            focusManager.setActiveSection('subtitle-results-list');
        } else {
            focusManager.setActiveSection('subtitle-results-actions');
        }

        // ── Back button handler for Panel B ──────────────────────────────────
        const panelAOnBack = detailsPage.onBack; // capture current (Panel A) handler before overwriting
        detailsPage.onBack = () => {
            goBack();
            return true;
        };
    }

    /**
     * Reload MediaStreams from the server after a delete/download action.
     * Mutates `detailsPage._item` in-place so the track list re-render reflects the change.
     */
    static async _reloadSubtitleStreams(itemId, detailsPage) {
        try {
            // Fetch only the MediaStreams field to keep the request light
            const fresh = await api.getItem(itemId, { Fields: 'MediaStreams' });

            // Patch the existing MediaSources array rather than replacing the whole item
            if (fresh?.MediaSources && detailsPage._item) {
                detailsPage._item.MediaSources = fresh.MediaSources;
            }
        } catch (err) {
            log.warn('Failed to reload MediaStreams after subtitle change', err);
        }
    }
}

export default SubtitleEditorModal;
