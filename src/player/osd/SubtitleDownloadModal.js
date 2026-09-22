/**
 * ============================================================================
 * Litefin Player - Subtitle Download Modal
 * ============================================================================
 * Allows searching and downloading remote subtitles directly inside the player
 * during active playback.
 * 
 * Extends BaseMenu to integrate seamlessly with OSDController lifecycle,
 * remote D-pad navigation, TV focus guards, and modal state management.
 * ============================================================================
 */

import BaseMenu from './BaseMenu.js';
import { api } from '../../api/index.js';
import { i18n } from '../../utils/i18n.js';
import { toast } from '../../ui/Toast.js';
import { storage } from '../../utils/StorageService.js';
import { languageManager } from '../../utils/LanguageManager.js';
import { escapeHtml } from '../../utils/Utils.js';
import { logger } from '../../utils/Logger.js';

const log = logger.create('SubtitleDownloadModal');

export default class SubtitleDownloadModal extends BaseMenu {
    /**
     * Initializes the modal with reference to OSD controller.
     * @param {Object} osdController - Reference to parent OSDController
     */
    constructor(osdController) {
        super(osdController);
        this.isModal = true;

        // Current media item
        this._item = null;

        // Languages and cultures cached from API
        this._cultures = [];
        this._langOptions = [];
        this._currentLang = 'eng';
        this._currentLangLabel = 'English';

        // Search results
        this._results = [];
        this._isSearching = false;
        this._isDownloading = false;

        // Focus and navigation state
        // section: 'search-row' | 'results' | 'actions' | 'lang-modal'
        this._activeSection = 'search-row';
        this._searchRowFocusIndex = 0; // 0 = Lang button, 1 = Search button
        this._resultFocusIndex = 0;
        this._actionFocusIndex = 0;

        // Language sub-modal state
        this._isLangModalOpen = false;
        this._langFilter = 'all';
        this._langFocusIndex = 0;

        // Edit mode state for managing / deleting existing subtitle tracks
        this._isEditMode = false;
        this._isDeleting = false;
    }

    /**
     * Open the subtitle download modal for the currently playing item.
     * @param {Object} item - Current Jellyfin item being played
     */
    async open(item) {
        this._item = item || this.osd._item;
        this.focusIndex = 0;
        this._activeSection = 'search-row';
        this._searchRowFocusIndex = 0;
        this._resultFocusIndex = 0;
        this._isSearching = false;
        this._isDownloading = false;
        this._isDeleting = false;
        this._isEditMode = false;
        this._isLangModalOpen = false;
        this._results = [];

        // Resolve preferred language
        this._resolveDefaultLanguage();

        // Render base shell
        this.render();
        this.show();

        // Load cultures and trigger initial search in background
        await this._loadCultures();
        this._performSearch();
    }

    /**
     * Determine initial search language based on storage preferences and audio track.
     * @private
     */
    _resolveDefaultLanguage() {
        const savedLang = storage.getItem('litefin:subtitle-language');
        let prefLang = storage.getItem('pref:subtitleLang');
        if (prefLang === 'none') prefLang = '';

        // Check active audio track language from player
        let audioLang = '';
        if (this.player) {
            const audioTracks = this.player.getAudioTracks ? this.player.getAudioTracks() : [];
            const activeAudio = audioTracks.find((t) => t.Index === this.player._currentAudioStreamIndex);
            audioLang = activeAudio?.Language || '';
        }

        this._currentLang = savedLang || prefLang || audioLang || 'eng';
        // Immediately resolve human-readable display name from LanguageManager cache
        // to prevent raw 3-letter ISO codes (e.g. 'ara') from flashing on initial render
        const norm = languageManager.normalizeLanguage(this._currentLang);
        this._currentLangLabel = norm?.name || this._currentLang;
    }

    /**
     * Fetch cultures from server if not already loaded.
     * @private
     */
    async _loadCultures() {
        if (this._cultures && this._cultures.length > 0) return;

        try {
            const fetched = await api.getCultures();
            this._cultures = fetched || [];

            // Register cultures with languageManager for universal lookup
            languageManager.registerCultures(this._cultures);

            this._langOptions = this._cultures
                .filter((c) => c.ThreeLetterISOLanguageName)
                .sort((a, b) => (a.DisplayName || '').localeCompare(b.DisplayName || ''))
                .map((c) => ({
                    value: c.ThreeLetterISOLanguageName,
                    label: c.DisplayName || c.ThreeLetterISOLanguageName
                }));

            const matched = this._langOptions.find((o) => o.value === this._currentLang);
            if (matched) {
                this._currentLangLabel = matched.label;
            } else {
                const norm = languageManager.normalizeLanguage(this._currentLang);
                if (norm?.name) {
                    this._currentLangLabel = norm.name;
                }
            }

            // Update label on button if already in DOM
            const langBtn = this.$el?.querySelector('#player-sub-lang-btn .btn-label');
            if (langBtn) {
                langBtn.textContent = this._currentLangLabel;
            }
        } catch (err) {
            log.warn('Failed to load cultures:', err);
        }
    }

    /**
     * Render the modal DOM.
     */
    render() {
        if (this.$el) {
            this.$el.remove();
            this.$el = null;
        }

        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay visible player-subtitle-download-overlay';

        // Primary title matches the track menu action button with graceful fallback
        const titleText = this._isEditMode
            ? (i18n.t('EditSubtitles') || 'Edit Subtitles')
            : (i18n.t('DownloadSubtitles') || i18n.t('SearchSubtitles') || 'Download Subtitles');

        overlay.innerHTML = `
            <div class="settings-modal player-subtitle-download-modal" role="dialog" aria-modal="true" aria-label="${titleText}">
                <div class="modal-header">
                    <h2>${titleText}</h2>
                </div>

                <!-- Language selection and Edit mode toggle row -->
                <div class="subtitle-search-row">
                    ${this._isEditMode ? `
                        <div class="modal-section-title" style="margin: 0; align-self: center; flex: 1; padding: 0; font-size: 1.2rem; font-weight: 600;">${i18n.t('HeaderMySubtitles') || 'My Subtitles'}</div>
                        <button id="player-sub-edit-btn" class="modal-action-btn" tabindex="0">${i18n.t('Done') || 'Done'}</button>
                    ` : `
                        <button id="player-sub-lang-btn" class="modal-select setting-action-btn select-btn" tabindex="0" data-value="${this._currentLang}">
                            <span class="btn-label">${this._currentLangLabel}</span>
                        </button>
                        <button id="player-sub-edit-btn" class="modal-action-btn" tabindex="0">${i18n.t('Edit') || 'Edit'}</button>
                    `}
                </div>

                <!-- Subtitle Results / Installed Tracks List -->
                <div class="modal-options subtitle-results-scrollable" id="player-sub-results-list" tabindex="-1">
                    <div class="media-info-loading">
                        <div class="loading-spinner-small"></div>
                        <span>${i18n.t('Searching') || 'Searching...'}</span>
                    </div>
                </div>

                <!-- Bottom Modal Actions -->
                <div class="modal-actions">
                    <button class="modal-action-btn" id="player-sub-back-btn" tabindex="0">${i18n.t('ButtonBack') || 'Back'}</button>
                </div>
            </div>
        `;

        // Dismiss on clicking backdrop
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) {
                e.stopPropagation();
                this._close();
            }
        });

        // Bind interactive elements
        this._bindShellEvents(overlay);

        const overlaysEl = this.osd._osdEl?.querySelector('.osd-overlays') || document.body;
        overlaysEl.appendChild(overlay);

        this.$el = overlay;

        // Render appropriate content based on active mode without stealing focus
        if (this._isEditMode) {
            // Populate installed subtitle tracks for deletion
            this._renderInstalledTracks();
        } else if (this._results && this._results.length > 0) {
            // Restore previously fetched search results without hijacking focus away from header
            this._renderResults(false);
        }

        // Apply visual and DOM focus
        this.updateFocus();
    }

    /**
     * Bind click events for the shell controls.
     * @param {HTMLElement} overlay - Root overlay element
     * @private
     */
    _bindShellEvents(overlay) {
        // Language select button
        const langBtn = overlay.querySelector('#player-sub-lang-btn');
        if (langBtn) {
            langBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                // Guard against programmatic focus, active transitions, and synthetic enter clicks
                if (langBtn._programmaticFocus || this._isTransitioning) return;
                if (e.detail === 0 || (e.clientX === 0 && e.clientY === 0)) return;
                this._openLanguageModal();
            });
        }

        // Edit mode toggle button (switches between Download and Delete modes)
        const editBtn = overlay.querySelector('#player-sub-edit-btn');
        if (editBtn) {
            editBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                // Guard against programmatic focus, active transitions, and synthetic enter clicks
                if (editBtn._programmaticFocus || this._isTransitioning) return;
                if (e.detail === 0 || (e.clientX === 0 && e.clientY === 0)) return;
                this._toggleEditMode();
            });
        }

        // Back action button
        const backBtn = overlay.querySelector('#player-sub-back-btn');
        if (backBtn) {
            backBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                // Guard against programmatic focus, active transitions, and synthetic enter clicks
                if (backBtn._programmaticFocus || this._isTransitioning) return;
                if (e.detail === 0 || (e.clientX === 0 && e.clientY === 0)) return;
                if (this._isEditMode) {
                    this._toggleEditMode(false);
                } else {
                    this._close();
                }
            });
        }
    }

    /**
     * Query remote subtitles from Jellyfin server.
     * @private
     */
    async _performSearch() {
        if (!this._item?.Id || this._isSearching) return;

        this._isSearching = true;
        const resultsContainer = this.$el?.querySelector('#player-sub-results-list');
        if (resultsContainer) {
            resultsContainer.innerHTML = `
                <div class="media-info-loading">
                    <div class="loading-spinner-small"></div>
                    <span>${i18n.t('Searching') || 'Searching...'}</span>
                </div>
            `;
        }

        try {
            log.info(`Searching remote subtitles: item=${this._item.Id}, lang=${this._currentLang}`);
            this._results = (await api.searchSubtitles(this._item.Id, this._currentLang)) || [];
            this._renderResults();
        } catch (err) {
            log.error('Remote subtitle search failed:', err);
            if (resultsContainer) {
                resultsContainer.innerHTML = `
                    <p class="subtitle-empty-notice">${i18n.t('MessageErrorSubtitleSearch') || 'Subtitle search failed.'}</p>
                `;
            }
        } finally {
            this._isSearching = false;
        }
    }

    /**
     * Render remote subtitle search results into the container.
     * @param {boolean} [autoFocus=true] - Whether to shift focus to results list
     * @private
     */
    _renderResults(autoFocus = true) {
        const resultsContainer = this.$el?.querySelector('#player-sub-results-list');
        if (!resultsContainer) return;

        // Display empty notice if no subtitles were returned
        if (!this._results || this._results.length === 0) {
            resultsContainer.innerHTML = `
                <p class="subtitle-empty-notice">${i18n.t('NoSubtitleSearchResultsFound') || 'No results found.'}</p>
            `;
            return;
        }

        // Generate rich markup for subtitle cards matching SubtitleEditorModal details
        const resultsHtml = this._results
            .map((r, idx) => {
                const name = r.Name || `Result ${idx + 1}`;
                const provider = r.ProviderName || '';
                const format = (r.Format || '').toUpperCase();
                // Format download count with localized commas (e.g. 30,983)
                const downloads = r.DownloadCount != null ? `↓ ${r.DownloadCount.toLocaleString()}` : '';
                const frameRate = r.FrameRate ? `${r.FrameRate} fps` : '';
                const isPerfectMatch = !!r.IsHashMatch;

                // Hearing Impaired / SDH detection from API flags or filename tags
                const isHearingImpaired = !!(
                    r.HearingImpaired ||
                    r.IsHearingImpaired ||
                    (r.ThreeLetterISOLanguageName && r.ThreeLetterISOLanguageName.toLowerCase().includes('hi')) ||
                    (name && /\b(sdh|hearing impaired|hi)\b/i.test(name))
                );

                // Forced subtitle detection from API flags or filename tags
                const isForced = !!(
                    r.IsForced ||
                    r.Forced ||
                    (name && /\bforced\b/i.test(name))
                );

                // Match rate percentage or badge calculation
                let matchBadge = '';
                if (isPerfectMatch) {
                    // Perfect hash match badge
                    matchBadge = `<span class="track-badge match-badge">★ 100% Match</span>`;
                } else if (typeof r.Score === 'number' && !isNaN(r.Score)) {
                    // Numerical score percentage badge
                    const pct = r.Score <= 1 ? Math.round(r.Score * 100) : Math.round(r.Score);
                    if (pct > 0) {
                        matchBadge = `<span class="track-badge match-badge">${pct}% Match</span>`;
                    }
                } else if (typeof r.CommunityRating === 'number' && !isNaN(r.CommunityRating) && r.CommunityRating > 0) {
                    // Star rating badge
                    matchBadge = `<span class="track-badge match-badge">★ ${r.CommunityRating.toFixed(1)}</span>`;
                }

                return `
                    <button class="modal-option-btn subtitle-result-btn" data-id="${r.Id}" data-index="${idx}" tabindex="0">
                        <div class="subtitle-result-info">
                            <div class="track-label-text">${escapeHtml(name)}</div>
                            <div class="subtitle-result-meta">
                                ${matchBadge}
                                ${isHearingImpaired ? `<span class="track-badge badge-sdh" title="${i18n.t('HearingImpaired') || 'Hearing Impaired'}">SDH</span>` : ''}
                                ${isForced ? `<span class="track-badge badge-forced" title="${i18n.t('Forced') || 'Forced'}">Forced</span>` : ''}
                                ${provider ? `<span class="track-badge provider-badge">${escapeHtml(provider)}</span>` : ''}
                                ${format ? `<span class="track-badge">${escapeHtml(format)}</span>` : ''}
                                ${frameRate ? `<span class="track-badge">${escapeHtml(frameRate)}</span>` : ''}
                                ${downloads ? `<span class="track-badge">${downloads}</span>` : ''}
                            </div>
                        </div>
                    </button>
                `;
            })
            .join('');

        resultsContainer.innerHTML = resultsHtml;

        // Bind download actions on result buttons with double-press prevention
        resultsContainer.querySelectorAll('.subtitle-result-btn').forEach((btn) => {
            btn.addEventListener('click', async (e) => {
                e.stopPropagation();
                // Block clicks during transitions, programmatic focus, or synthetic enter clicks
                if (btn._programmaticFocus || this._isTransitioning) return;
                if (e.detail === 0 || (e.clientX === 0 && e.clientY === 0)) return;
                const subtitleId = btn.dataset.id;
                await this._downloadSubtitle(subtitleId, btn);
            });
        });

        // Only shift focus to results if explicitly requested (e.g. from a direct search)
        if (autoFocus) {
            this._activeSection = 'results';
            this._resultFocusIndex = 0;
            this.updateFocus();
        }
    }

    /**
     * Download the selected remote subtitle and activate it in the player.
     * @param {string} subtitleId - Provider subtitle ID
     * @param {HTMLElement} btn - The clicked button element
     * @private
     */
    async _downloadSubtitle(subtitleId, btn) {
        if (this._isDownloading || !this.player) return;
        this._isDownloading = true;

        // Provide immediate visual feedback
        btn.disabled = true;
        const originalText = btn.innerHTML;
        btn.innerHTML = `
            <div class="subtitle-result-info">
                <div class="track-label-text" style="opacity: 0.7;">${i18n.t('Downloading') || 'Downloading...'}</div>
            </div>
        `;

        try {
            log.info(`[Subtitle Downloader] Downloading subtitle ${subtitleId} via player`);
            const selectedSub = this._results?.find((r) => r.Id === subtitleId);
            const res = await this.player.downloadAndApplySubtitle(subtitleId, {
                language: this._currentLang,
                name: selectedSub?.Name,
                format: selectedSub?.Format
            });

            if (res?.success) {
                if (res.track?.Index !== undefined && this.osd) {
                    this.osd.currentSubtitleIndex = res.track.Index;
                }
                toast.show(i18n.t('MessageSubtitleDownloadQueued') || 'Subtitle downloaded and activated!');
                // Close downloader modal cleanly
                this._close(true);
            } else {
                throw new Error('Player failed to download and apply subtitle');
            }
        } catch (err) {
            log.error('Failed to download subtitle:', err);
            toast.show(i18n.t('MessageSubtitleDownloadFailed') || 'Download failed.');
            btn.disabled = false;
            btn.innerHTML = originalText;
            this._isDownloading = false;
        }
    }

    /**
     * Render the list of currently installed subtitle tracks with delete capabilities.
     * @private
     */
    _renderInstalledTracks() {
        const resultsEl = this.$el?.querySelector('#player-sub-results-list');
        if (!resultsEl) return;

        // Fetch current media source from player
        const mediaSource = this.player?._currentMediaSource || this._item?.MediaSources?.[0];
        const subtitleStreams = (mediaSource?.MediaStreams || []).filter(
            (s) => s.Type === 'Subtitle'
        );

        if (subtitleStreams.length === 0) {
            resultsEl.innerHTML = `
                <div class="modal-empty-placeholder" style="padding: 24px 16px; text-align: center; opacity: 0.7;">
                    ${i18n.t('LabelNoSubtitles') || 'No subtitle tracks found.'}
                </div>
            `;
            return;
        }

        resultsEl.innerHTML = subtitleStreams
            .map((s) => {
                const label = s.DisplayTitle || s.Title || s.Language || `Track ${s.Index}`;
                const codec = (s.Codec || '').toUpperCase();
                const loc = s.IsExternal ? 'EXT' : 'INT';
                const canDel = s.IsExternal || !!s.Path;
                // Identify hearing impaired, forced, and default subtitle flags
                const isHearingImpaired = !!(s.HearingImpaired || s.IsHearingImpaired);
                const isForced = !!(s.Forced || s.IsForced);
                const isDefault = !!(s.Default || s.IsDefault);

                return `
                    <div class="subtitle-track-row" data-index="${s.Index}">
                        <span class="subtitle-track-label">${escapeHtml(label)}</span>
                        <div class="subtitle-track-meta">
                            ${isDefault ? `<span class="track-badge match-badge">${i18n.t('Default') || 'Default'}</span>` : ''}
                            ${isHearingImpaired ? `<span class="track-badge badge-sdh" title="${i18n.t('HearingImpaired') || 'Hearing Impaired'}">SDH</span>` : ''}
                            ${isForced ? `<span class="track-badge badge-forced" title="${i18n.t('Forced') || 'Forced'}">Forced</span>` : ''}
                            <span class="track-badge">${escapeHtml(codec)}</span>
                            <span class="track-badge">${loc}</span>
                        </div>
                        ${
                            canDel
                                ? `<button class="modal-action-btn subtitle-delete-btn" data-index="${s.Index}" tabindex="0">${i18n.t('Delete') || 'Delete'}</button>`
                                : `<span class="subtitle-track-locked" title="${i18n.t('CannotDeleteInternalSubtitle') || 'Internal track — cannot be deleted'}">🔒</span>`
                        }
                    </div>
                `;
            })
            .join('');

        // Bind delete action buttons
        resultsEl.querySelectorAll('.subtitle-delete-btn').forEach((btn) => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                // Discard synthetic clicks and rapid double presses
                if (btn._programmaticFocus || this._isDeleting || this._isTransitioning) return;
                if (e.detail === 0 || (e.clientX === 0 && e.clientY === 0)) return;
                const streamIndex = parseInt(btn.dataset.index, 10);
                this._deleteSubtitle(streamIndex, btn);
            });
        });
    }

    /**
     * Delete an external subtitle stream from the server and reconcile player state.
     * @param {number} streamIndex - Subtitle stream index
     * @param {HTMLElement} btn - The clicked button element
     * @private
     */
    async _deleteSubtitle(streamIndex, btn) {
        if (this._isDeleting || !this.player) return;
        this._isDeleting = true;

        btn.disabled = true;
        btn.textContent = '...';

        try {
            log.info(`[Subtitle Downloader] Deleting subtitle stream: ${streamIndex}`);
            const res = await this.player.deleteAndReconcileSubtitle(streamIndex);
            if (res?.success) {
                toast.show(i18n.t('MessageSubtitleDeleted') || 'Subtitle deleted.');
                this._renderInstalledTracks();
                if (this.osd?.subtitleMenu) {
                    this.osd.subtitleMenu.render();
                }
                const resultButtons = this._getResultButtons();
                if (this._resultFocusIndex >= resultButtons.length) {
                    this._resultFocusIndex = Math.max(0, resultButtons.length - 1);
                }
                this.updateFocus();
            } else {
                throw new Error('Player failed to delete subtitle');
            }
        } catch (err) {
            log.error('Failed to delete subtitle:', err);
            toast.show(i18n.t('MessageErrorDeletingSubtitle') || 'Failed to delete subtitle.');
            btn.disabled = false;
            btn.textContent = i18n.t('Delete') || 'Delete';
        } finally {
            this._isDeleting = false;
        }
    }

    /**
     * Toggle between remote subtitle search/download and local subtitle edit/delete.
     * @param {boolean} [enable] - Optional explicit target mode
     * @private
     */
    _toggleEditMode(enable) {
        // Transition guard prevents trailing synthetic events from triggering accidental toggles
        if (this._isTransitioning) return;
        this._isTransitioning = true;
        setTimeout(() => {
            this._isTransitioning = false;
        }, 250);

        // Determine target edit mode
        const targetMode = typeof enable === 'boolean' ? enable : !this._isEditMode;
        if (this._isEditMode === targetMode) return;
        this._isEditMode = targetMode;

        // Reset section and index to header row
        this._activeSection = 'search-row';
        this._resultFocusIndex = 0;
        // When entering edit mode: only 1 button in search row (Done), index is 0
        // When leaving edit mode: 2 buttons in search row (Lang, Edit), keep focus on Edit (index 1)
        this._searchRowFocusIndex = this._isEditMode ? 0 : 1;

        // Re-render modal shell with updated title and controls
        this.render();

        if (this._isEditMode) {
            // Render installed subtitles list for deletion
            this._renderInstalledTracks();
        } else {
            // Restore previous search results if available without stealing focus to results
            if (this._results && this._results.length > 0) {
                this._renderResults(false);
            } else {
                this._performSearch();
            }
        }

        // Apply focus to the Edit/Done button in search row
        this.updateFocus();
    }

    /**
     * Open sub-modal for language selection with Favorite Languages support.
     * @private
     */
    _openLanguageModal() {
        if (this._isLangModalOpen || this._isTransitioning || !this.$el) return;
        this._isLangModalOpen = true;
        this._isTransitioning = true;
        setTimeout(() => {
            this._isTransitioning = false;
        }, 200);

        // Default to favorites filter if the user has favorites saved, else all languages
        this._langFilter = languageManager.hasFavorites() ? 'favorites' : 'all';
        this._langPillIndex = this._langFilter === 'favorites' ? 0 : 1;
        this._langModalSection = 'options';

        // Find initial focused item matching current language
        let displayOptions = this._langOptions;
        if (this._langFilter === 'favorites' && languageManager.hasFavorites()) {
            displayOptions = languageManager.filterOptions(this._langOptions);
        }
        const selIdx = displayOptions.findIndex((o) => o.value === this._currentLang);
        this._langFocusIndex = selIdx >= 0 ? selIdx : 0;

        const subOverlay = document.createElement('div');
        subOverlay.className = 'modal-overlay visible';
        subOverlay.id = 'player-sub-lang-modal-overlay';
        this.$el.appendChild(subOverlay);

        this._renderLanguageModalContent(subOverlay);
    }

    /**
     * Render language selection sub-modal content.
     * @param {HTMLElement} subOverlay - Sub-modal overlay container
     * @private
     */
    _renderLanguageModalContent(subOverlay) {
        let displayOptions = this._langOptions;
        if (this._langFilter === 'favorites' && languageManager.hasFavorites()) {
            displayOptions = languageManager.filterOptions(this._langOptions);
        }

        const favoritesCount = this._langOptions.filter((o) => languageManager.isFavorite(o)).length;

        // Build segmented filter pills if favorite languages exist
        let filterPillsHtml = '';
        if (languageManager.hasFavorites()) {
            filterPillsHtml = `
                <div class="modal-filter-pills" id="player-sub-lang-filter-pills">
                    <button class="modal-filter-pill ${this._langFilter === 'favorites' ? 'active' : ''}" data-filter="favorites" tabindex="0">
                        ★ ${i18n.t('FavoritesOnly') || 'Favorites'} (${favoritesCount})
                    </button>
                    <button class="modal-filter-pill ${this._langFilter === 'all' ? 'active' : ''}" data-filter="all" tabindex="0">
                        ${i18n.t('AllLanguages') || 'All Languages'} (${this._langOptions.length})
                    </button>
                </div>
            `;
        }

        // Build language options list. Using <span> for the star button to prevent illegal nested <button> tags
        const optionsHtml =
            displayOptions.length === 0
                ? `<div class="modal-empty-placeholder" style="padding: 24px 16px; text-align: center; opacity: 0.7;">${i18n.t('NoOptionsAvailable') || 'No options available'}</div>`
                : displayOptions
                      .map((opt, idx) => {
                          const isFav = languageManager.isFavorite(opt);
                          const isSelected = opt.value === this._currentLang;
                          return `
                        <button class="modal-option-btn player-lang-option-btn ${isSelected ? 'selected' : ''}" data-value="${opt.value}" data-index="${idx}" tabindex="0">
                            <span class="modal-option-label">${opt.label}</span>
                            <span class="modal-star-btn ${isFav ? 'active' : ''}" data-value="${opt.value}" title="Toggle Favorite" role="button" aria-label="Toggle Favorite">
                                ${isFav ? '★' : '☆'}
                            </span>
                        </button>
                    `;
                      })
                      .join('');

        subOverlay.innerHTML = `
            <div class="settings-modal" role="dialog" aria-modal="true">
                <div class="modal-header">
                    <h2>${i18n.t('LabelLanguage') || 'Language'}</h2>
                </div>
                ${filterPillsHtml}
                <div class="modal-options player-lang-options-list">
                    ${optionsHtml}
                </div>
                <div class="modal-actions">
                    <button class="modal-action-btn" id="btn-player-lang-cancel" tabindex="0">${i18n.t('ButtonCancel') || 'Cancel'}</button>
                </div>
            </div>
        `;

        // Bind filter pills click
        subOverlay.querySelectorAll('.modal-filter-pill').forEach((pill) => {
            pill.addEventListener('click', (e) => {
                e.stopPropagation();
                if (pill._programmaticFocus || this._isTransitioning) return;
                this._langFilter = pill.dataset.filter;
                this._langPillIndex = this._langFilter === 'favorites' ? 0 : 1;
                this._langModalSection = 'pills';
                this._renderLanguageModalContent(subOverlay);
            });
        });

        // Bind language options and favorite stars
        subOverlay.querySelectorAll('.player-lang-option-btn').forEach((btn) => {
            btn.addEventListener('click', (e) => {
                if (btn._programmaticFocus || this._isTransitioning) return;

                // If star was clicked, toggle favorite status
                if (e.target.closest('.modal-star-btn')) {
                    e.stopPropagation();
                    const starBtn = e.target.closest('.modal-star-btn');
                    const val = starBtn.dataset.value;
                    const matchedOpt = this._langOptions.find((o) => o.value === val) || val;
                    const isNowFav = languageManager.toggleFavorite(matchedOpt);

                    if (this._langFilter === 'all') {
                        // Update in-place in "All" view without resetting scroll/focus
                        starBtn.classList.toggle('active', isNowFav);
                        starBtn.textContent = isNowFav ? '★' : '☆';

                        const favPill = subOverlay.querySelector('.modal-filter-pill[data-filter="favorites"]');
                        if (favPill) {
                            const newCount = this._langOptions.filter((o) => languageManager.isFavorite(o)).length;
                            favPill.textContent = `★ ${i18n.t('FavoritesOnly') || 'Favorites'} (${newCount})`;
                        }
                    } else {
                        // Re-render in Favorites view to remove untoggled item
                        const currentIdx = parseInt(btn.dataset.index, 10);
                        this._renderLanguageModalContent(subOverlay);
                        const remaining = subOverlay.querySelectorAll('.player-lang-option-btn');
                        if (remaining.length > 0) {
                            this._langFocusIndex = Math.min(currentIdx, remaining.length - 1);
                        } else {
                            this._langModalSection = 'pills';
                        }
                        this._updateLangModalFocus();
                    }
                    return;
                }

                // Language selection confirmed
                e.stopPropagation();
                this._selectLanguage(btn.dataset.value);
            });
        });

        // Cancel button
        subOverlay.querySelector('#btn-player-lang-cancel')?.addEventListener('click', (e) => {
            e.stopPropagation();
            if (this._isTransitioning) return;
            this._closeLanguageModal();
        });

        // Backdrop click to dismiss
        subOverlay.addEventListener('click', (e) => {
            if (e.target === subOverlay && !this._isTransitioning) {
                e.stopPropagation();
                this._closeLanguageModal();
            }
        });

        this._updateLangModalFocus();
    }

    /**
     * Apply selected language, update UI and trigger search.
     * @param {string} langCode - Selected BCP-47 / language tag
     * @private
     */
    _selectLanguage(langCode) {
        if (!langCode) return;
        this._currentLang = langCode;
        const matched = this._langOptions?.find((o) => o.value === this._currentLang);
        const norm = languageManager.normalizeLanguage(this._currentLang);
        this._currentLangLabel = matched?.label || norm?.name || this._currentLang;

        // Update search button text and persist selection
        storage.setItem('litefin:subtitle-language', this._currentLang);
        const langBtn = this.$el?.querySelector('#player-sub-lang-btn .btn-label');
        if (langBtn) {
            langBtn.textContent = this._currentLangLabel;
        }

        this._closeLanguageModal();
        this._performSearch();
    }

    /**
     * Close language selection sub-modal.
     * @private
     */
    _closeLanguageModal() {
        const subModal = this.$el?.querySelector('#player-sub-lang-modal-overlay');
        if (subModal) {
            subModal.remove();
        }
        this._isLangModalOpen = false;
        this._langModalSection = 'options';
        this._activeSection = 'search-row';
        this._searchRowFocusIndex = 0;
        this._isTransitioning = true;
        setTimeout(() => {
            this._isTransitioning = false;
        }, 200);
        this.updateFocus();
    }

    /**
     * Update focus within the language modal.
     * @private
     */
    _updateLangModalFocus() {
        const subModal = this.$el?.querySelector('#player-sub-lang-modal-overlay');
        if (!subModal) return;

        // Clear all previous focused classes
        subModal.querySelectorAll('.focused').forEach((el) => el.classList.remove('focused'));

        const filterPills = Array.from(subModal.querySelectorAll('.modal-filter-pill'));
        const options = Array.from(subModal.querySelectorAll('.player-lang-option-btn'));
        const cancelBtn = subModal.querySelector('#btn-player-lang-cancel');

        if (this._langModalSection === 'pills' && filterPills.length > 0) {
            const targetPill = filterPills[this._langPillIndex] || filterPills[0];
            if (targetPill) {
                targetPill.classList.add('focused');
                this._focusElementSafely(targetPill);
            }
        } else if (this._langModalSection === 'options' && options.length > 0) {
            if (this._langFocusIndex < 0) this._langFocusIndex = 0;
            if (this._langFocusIndex >= options.length) this._langFocusIndex = options.length - 1;

            const target = options[this._langFocusIndex];
            if (target) {
                target.classList.add('focused');
                this._focusElementSafely(target);
                target.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
            }
        } else if (this._langModalSection === 'actions' || options.length === 0) {
            if (cancelBtn) {
                cancelBtn.classList.add('focused');
                this._focusElementSafely(cancelBtn);
            }
        }
    }

    /**
     * Close the SubtitleDownloadModal and return focus to TrackMenu or OSD.
     * @param {boolean} [didDownload=false] - Whether a subtitle was downloaded
     * @private
     */
    _close(didDownload = false) {
        this.hide();

        if (this.$el) {
            this.$el.remove();
            this.$el = null;
        }

        if (didDownload) {
            // Subtitle downloaded: re-render subtitle menu and close to resume video
            if (this.osd.subtitleMenu) {
                this.osd.subtitleMenu.render();
            }
            this.osd.closeMenu();
        } else {
            // User backed out: return to TrackMenu
            if (this.osd.subtitleMenu) {
                this.osd.activeMenu = this.osd.subtitleMenu;
                this.osd.subtitleMenu.show();
            } else {
                this.osd.closeMenu();
            }
        }
    }

    /**
     * Handle directional and Enter/Back remote control keys.
     * @param {string} key - 'up' | 'down' | 'left' | 'right' | 'enter' | 'back'
     * @returns {boolean} True if handled
     */
    handleKey(key) {
        if (!this.isVisible) return false;

        // If language sub-modal is open, delegate keys to it
        if (this._isLangModalOpen) {
            return this._handleLangModalKey(key);
        }

        switch (key) {
            case 'back':
                if (this._isEditMode) {
                    this._toggleEditMode(false);
                    return true;
                }
                this._close(false);
                return true;

            case 'up':
                return this._navigateUp();

            case 'down':
                return this._navigateDown();

            case 'left':
                return this._navigateLeft();

            case 'right':
                return this._navigateRight();

            case 'enter':
                return this._handleEnter();
        }

        return false;
    }

    /**
     * Handle navigation within language selection sub-modal.
     * Supports full Left/Right tab switching between Favorites and All Languages.
     * @param {string} key - Directional or action key
     * @returns {boolean} True if handled
     * @private
     */
    _handleLangModalKey(key) {
        const subModal = this.$el?.querySelector('#player-sub-lang-modal-overlay');
        if (!subModal) return false;

        const options = Array.from(subModal.querySelectorAll('.player-lang-option-btn'));
        const filterPills = Array.from(subModal.querySelectorAll('.modal-filter-pill'));
        const isRtl = document.documentElement.getAttribute('dir') === 'rtl';

        // Back key closes the language selection submodal
        if (key === 'back') {
            this._closeLanguageModal();
            return true;
        }

        // Left / Right keys switch between Favorites and All Languages tabs
        if (key === 'left' || key === 'right') {
            if (languageManager.hasFavorites()) {
                const targetFilter =
                    key === 'left'
                        ? isRtl
                            ? 'all'
                            : 'favorites'
                        : isRtl
                          ? 'favorites'
                          : 'all';

                if (this._langFilter !== targetFilter) {
                    this._langFilter = targetFilter;
                    this._langPillIndex = targetFilter === 'favorites' ? 0 : 1;
                    this._renderLanguageModalContent(subModal);

                    // If currently in options, clamp focus index to the new list size
                    if (this._langModalSection === 'options') {
                        const newOptions = Array.from(subModal.querySelectorAll('.player-lang-option-btn'));
                        if (newOptions.length > 0) {
                            this._langFocusIndex = Math.min(this._langFocusIndex, newOptions.length - 1);
                        } else {
                            this._langModalSection = 'pills';
                        }
                    }
                    this._updateLangModalFocus();
                    return true;
                }
            }
            return true;
        }

        // Up key navigates up across actions -> options -> pills
        if (key === 'up') {
            if (this._langModalSection === 'actions') {
                if (options.length > 0) {
                    this._langModalSection = 'options';
                    this._langFocusIndex = options.length - 1;
                } else if (filterPills.length > 0) {
                    this._langModalSection = 'pills';
                }
                this._updateLangModalFocus();
                return true;
            }

            if (this._langModalSection === 'options') {
                if (this._langFocusIndex > 0) {
                    this._langFocusIndex--;
                    this._updateLangModalFocus();
                } else if (filterPills.length > 0) {
                    this._langModalSection = 'pills';
                    this._updateLangModalFocus();
                }
                return true;
            }

            if (this._langModalSection === 'pills') {
                return true;
            }
        }

        // Down key navigates down across pills -> options -> actions
        if (key === 'down') {
            if (this._langModalSection === 'pills') {
                if (options.length > 0) {
                    this._langModalSection = 'options';
                    this._langFocusIndex = 0;
                } else {
                    this._langModalSection = 'actions';
                }
                this._updateLangModalFocus();
                return true;
            }

            if (this._langModalSection === 'options') {
                if (this._langFocusIndex < options.length - 1) {
                    this._langFocusIndex++;
                    this._updateLangModalFocus();
                } else {
                    this._langModalSection = 'actions';
                    this._updateLangModalFocus();
                }
                return true;
            }

            if (this._langModalSection === 'actions') {
                return true;
            }
        }

        // Enter key confirms selection or activates focused action directly without synthetic clicks
        if (key === 'enter') {
            if (this._isTransitioning) return true;

            if (this._langModalSection === 'pills') {
                const targetPill = filterPills[this._langPillIndex];
                if (targetPill) {
                    this._langFilter = targetPill.dataset.filter;
                    this._langPillIndex = this._langFilter === 'favorites' ? 0 : 1;
                    this._renderLanguageModalContent(subModal);
                    this._updateLangModalFocus();
                }
                return true;
            }

            if (this._langModalSection === 'options') {
                const targetOption = options[this._langFocusIndex];
                if (targetOption) {
                    this._selectLanguage(targetOption.dataset.value);
                }
                return true;
            }

            if (this._langModalSection === 'actions') {
                this._closeLanguageModal();
                return true;
            }
        }

        return false;
    }

    /**
     * Navigate up across modal sections.
     * @private
     */
    _navigateUp() {
        if (this._activeSection === 'actions') {
            const resultButtons = this._getResultButtons();
            if (resultButtons.length > 0) {
                this._activeSection = 'results';
                this._resultFocusIndex = resultButtons.length - 1;
            } else {
                this._activeSection = 'search-row';
            }
            this.updateFocus();
            return true;
        }

        if (this._activeSection === 'results') {
            if (this._resultFocusIndex > 0) {
                this._resultFocusIndex--;
            } else {
                this._activeSection = 'search-row';
            }
            this.updateFocus();
            return true;
        }

        if (this._activeSection === 'search-row') {
            // Already at the top
            return true;
        }

        return false;
    }

    /**
     * Navigate down across modal sections.
     * @private
     */
    _navigateDown() {
        if (this._activeSection === 'search-row') {
            const resultButtons = this._getResultButtons();
            if (resultButtons.length > 0) {
                this._activeSection = 'results';
                this._resultFocusIndex = 0;
            } else {
                this._activeSection = 'actions';
                this._actionFocusIndex = 0;
            }
            this.updateFocus();
            return true;
        }

        if (this._activeSection === 'results') {
            const resultButtons = this._getResultButtons();
            if (this._resultFocusIndex < resultButtons.length - 1) {
                this._resultFocusIndex++;
            } else {
                this._activeSection = 'actions';
                this._actionFocusIndex = 0;
            }
            this.updateFocus();
            return true;
        }

        if (this._activeSection === 'actions') {
            // Already at the bottom
            return true;
        }

        return false;
    }

    /**
     * Navigate left in horizontal sections.
     * @private
     */
    _navigateLeft() {
        if (this._activeSection === 'search-row') {
            if (!this._isEditMode && this._searchRowFocusIndex > 0) {
                this._searchRowFocusIndex--;
                this.updateFocus();
            }
            return true;
        }
        return false;
    }

    /**
     * Navigate right in horizontal sections.
     * @private
     */
    _navigateRight() {
        if (this._activeSection === 'search-row') {
            // In edit mode: 1 button (max index 0). In search mode: 2 buttons (Lang=0, Edit=1, max index 1)
            const maxIndex = this._isEditMode ? 0 : 1;
            if (this._searchRowFocusIndex < maxIndex) {
                this._searchRowFocusIndex++;
                this.updateFocus();
            }
            return true;
        }
        return false;
    }

    /**
     * Handle Enter / OK key on currently focused element.
     * @private
     */
    _handleEnter() {
        if (this._isTransitioning) return true;

        if (this._activeSection === 'search-row') {
            if (this._isEditMode) {
                // Done button exits edit mode and returns to search results view
                this._toggleEditMode(false);
            } else {
                // Search row has 2 buttons: Language selector (0) and Edit button (1)
                if (this._searchRowFocusIndex === 0) {
                    this._openLanguageModal();
                } else if (this._searchRowFocusIndex === 1) {
                    this._toggleEditMode(true);
                }
            }
            return true;
        }

        if (this._activeSection === 'results') {
            const resultButtons = this._getResultButtons();
            const focusedBtn = resultButtons[this._resultFocusIndex];
            if (focusedBtn) {
                if (this._isEditMode) {
                    const streamIndex = parseInt(focusedBtn.dataset.index, 10);
                    this._deleteSubtitle(streamIndex, focusedBtn);
                } else {
                    const subtitleId = focusedBtn.dataset.id;
                    this._downloadSubtitle(subtitleId, focusedBtn);
                }
            }
            return true;
        }

        if (this._activeSection === 'actions') {
            if (this._isEditMode) {
                this._toggleEditMode(false);
            } else {
                this._close(false);
            }
            return true;
        }

        return false;
    }

    /**
     * Get array of currently rendered result / action buttons in the list container.
     * @returns {Array<HTMLElement>}
     * @private
     */
    _getResultButtons() {
        const selector = this._isEditMode ? '.subtitle-delete-btn' : '.subtitle-result-btn';
        return Array.from(this.$el?.querySelectorAll(selector) || []);
    }

    /**
     * Synchronize DOM visual focus states with internal navigation tracking.
     */
    updateFocus() {
        if (!this.$el || !this.isVisible) return;

        // Clear previous focused classes
        this.$el.querySelectorAll('.focused').forEach((el) => el.classList.remove('focused'));

        if (this._activeSection === 'search-row') {
            // Query current header action buttons
            const langBtn = this.$el.querySelector('#player-sub-lang-btn');
            const editBtn = this.$el.querySelector('#player-sub-edit-btn');

            let target = null;
            if (this._isEditMode) {
                // In edit mode, target is the Done button
                target = editBtn;
            } else {
                // In search mode, index 0 is Language button, index 1 is Edit button
                if (this._searchRowFocusIndex === 0) target = langBtn;
                else target = editBtn;
            }

            if (target) {
                target.classList.add('focused');
                this._focusElementSafely(target);
            }
        } else if (this._activeSection === 'results') {
            const resultButtons = this._getResultButtons();
            const target = resultButtons[this._resultFocusIndex];
            if (target) {
                target.classList.add('focused');
                this._focusElementSafely(target);
                target.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
            }
        } else if (this._activeSection === 'actions') {
            const backBtn = this.$el.querySelector('#player-sub-back-btn');
            if (backBtn) {
                backBtn.classList.add('focused');
                this._focusElementSafely(backBtn);
            }
        }
    }

    /**
     * Focus an element while preventing Samsung Tizen phantom clicks.
     * @param {HTMLElement} el - Element to focus
     * @private
     */
    _focusElementSafely(el) {
        if (!el) return;
        el._programmaticFocus = true;
        el.focus({ preventScroll: true });
        setTimeout(() => {
            el._programmaticFocus = false;
        }, 150);
    }
}
