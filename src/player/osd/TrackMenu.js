import BaseMenu from './BaseMenu.js';
import { i18n } from '../../utils/i18n.js';

/**
 * TrackMenu
 * 
 * Manages the selection of Audio and Subtitle tracks.
 * - Lists available streams from the current media source.
 * - Handles track switching (direct play or transcoding triggers).
 * - Reflects the currently selected indices.
 * - Supports "Off" state for subtitles.
 */
export default class TrackMenu extends BaseMenu {
    constructor(osdController) {
        super(osdController);
        this.type = 'subtitles';
        this.mode = 'primary';
        this.isModal = true;
    }

    async open(type, mode = 'primary') {
        this.type = type;
        this.mode = mode;
        this.focusIndex = 0;
        
        await this.render();
        this.show();
    }

    /**
     * Display the track menu overlay.
     * Preserves the initial OSD focus row and index so that closing the menu
     * restores control to the original trigger button, even if mode switching occurs.
     */
    show() {
        // Only capture initial OSD focus row/index when menu first becomes visible
        if (!this.isVisible) {
            this._prevRow = this.osd._currentFocusRow;
            this._prevIndex = this.osd._currentFocusIndex;
        }

        this.isVisible = true;
        if (this.$el) {
            this.$el.classList.add('visible');
            this.updateFocus();
        }
    }

    /**
     * Hide the track menu overlay and return focus to the OSD controls.
     */
    hide() {
        this.isVisible = false;
        if (this.$el) {
            this.$el.classList.remove('visible');
        }

        if (this._prevRow !== undefined) {
            this.osd._currentFocusRow = this._prevRow;
            this.osd._currentFocusIndex = this._prevIndex;
            this.osd._updateFocus();
        }
    }

    async render() {
        if (!this.$el) {
            this.$el = document.createElement('div');
            this.$el.className = 'track-menu-overlay';
            document.body.appendChild(this.$el);

            this.$el.addEventListener('click', (e) => {
                if (e.target === this.$el) {
                    this.osd.closeMenu();
                }
            });
        }

        const player = this.osd.player;
        let tracks = [];
        let title = '';
        let currentIndex = -1;

        if (this.type === 'subtitles') {
            const tracksRaw = player.getSubtitleTracks ? player.getSubtitleTracks() : [];
            tracks = (tracksRaw.then) ? await tracksRaw : tracksRaw;

            if (this.mode === 'secondary') {
                // ============================================================
                // Secondary subtitle restriction: only text-renderable codecs.
                // PGS, image-based, and unknown formats cannot be DOM-rendered,
                // so we filter them out entirely. This set must stay in sync
                // with SubtitleManager._isSecondaryRenderable().
                // ============================================================
                const TEXT_CODECS = new Set([
                    'srt', 'subrip',
                    'vtt', 'webvtt',
                    'ttml', 'dfxp',
                    'smi', 'sami',
                    'mov_text', 'tx3g',
                    'scc', 'sbv', 'ttxt',
                    'ass', 'ssa'  // server transcodes these to VTT
                ]);
                tracks = tracks.filter(t => TEXT_CODECS.has((t.Codec || '').toLowerCase()));
                title = i18n.t('SecondaryTextOnly');
            } else {
                title = i18n.t('Subtitles');
            }

            currentIndex = (this.mode === 'secondary') ? this.osd.currentSecondarySubtitleIndex : this.osd.currentSubtitleIndex;
            tracks = [{ Index: -1, DisplayTitle: i18n.t('Off') }, ...tracks];
        } else {
            const tracksRaw = player.getAudioTracks ? player.getAudioTracks() : [];
            tracks = (tracksRaw.then) ? await tracksRaw : tracksRaw;
            title = i18n.t('Audio');
            currentIndex = this.osd.currentAudioIndex;
        }

        // Cache the currently rendered list of tracks for accurate selectTrack lookup
        this._renderedTracks = tracks;

        // Ensure currentIndex is a number for comparison
        currentIndex = parseInt(currentIndex);
        if (isNaN(currentIndex)) currentIndex = -1;

        const trackListIndex = tracks.findIndex(t => t.Index === currentIndex);
        const headerOffset = this.type === 'subtitles' ? 1 : 0;
        
        // Default to 'Off' (0 + offset) if not found for subtitles, or first item (0) for audio
        this.focusIndex = trackListIndex < 0 ? (this.type === 'subtitles' ? headerOffset : 0) : trackListIndex + headerOffset;

        let headerHtml = '';
        if (this.type === 'subtitles') {
            const isRTL = document.documentElement.dir === 'rtl';
            const backArrow = isRTL ? '→' : '←';
            const label = (this.mode === 'primary') ? i18n.t('SecondarySubtitles') : backArrow + ' ' + i18n.t('ButtonBack');
            headerHtml = `
                <button class="track-option track-mode-switch">
                    <span class="track-option-check"></span>
                    <span class="track-option-label">${label}</span>
                </button>
            `;
        }

        const optionsHtml = tracks.map((track, i) => {
            const isSelected = track.Index === currentIndex;
            
            const label = track.DisplayTitle || track.Title || track.Language || i18n.t('TrackIndex', [track.Index]);
            let metadataHtml = '';

            // For subtitles, add Type and Location metadata
            if (this.type === 'subtitles' && track.Index !== -1) {
                const type = (track.Codec || '').toUpperCase();
                const location = track.IsExternal ? 'EXT' : 'INT';
                
                metadataHtml = `
                    <span class="track-badge">${type}</span>
                    <span class="track-badge">${location}</span>
                `;
            }

            // For audio tracks, check if the codec is natively playable by the
            // current backend. Unsupported tracks (e.g. FLAC in MKV on HTML5)
            // get a visual indicator showing they'll require a transcode restart.
            let isUnsupported = false;
            if (this.type === 'audio' && track.Index !== -1) {
                isUnsupported = player.isAudioTrackNativelyPlayable
                    ? !player.isAudioTrackNativelyPlayable(track)
                    : false;

                if (isUnsupported) {
                    metadataHtml += `<span class="track-badge track-badge-unsupported">${i18n.t('Transcode') || 'TRANSCODE'}</span>`;
                }
            }

            return `
                <button class="track-option track-item ${isSelected ? 'selected' : ''} ${isUnsupported ? 'track-unsupported' : ''}" data-index="${track.Index}" data-menu-index="${i}">
                    <span class="track-option-check"><svg viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor" d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg></span>
                    <span class="track-option-label">
                        <span class="track-label-text">${label}</span>
                        ${metadataHtml}
                    </span>
                </button>
            `;
        }).join('');

        this.$el.innerHTML = `
            <div class="track-menu">
                <div class="track-menu-title">${title}</div>
                <div class="track-menu-options">
                    ${headerHtml}
                    ${optionsHtml}
                </div>
            </div>
        `;

        this.$el.querySelectorAll('.track-item').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                /*
                 * ================================================================
                 * TIZEN TV CLICK ORIGIN GUARD
                 * ================================================================
                 * On Tizen Samsung TVs, two types of synthetic click events can
                 * fire on a focused <button> without a real pointer interaction:
                 *
                 *   1. Focus-click: .focus() fires an immediate click on the element.
                 *   2. Enter-click: Pressing OK/Enter fires a click at (0, 0) with
                 *      detail === 0.
                 *
                 * Both must be discarded. Only clicks from the Magic Remote cursor
                 * (real pointer device, detail >= 1, non-zero coordinates) should
                 * be processed here. D-pad Enter is handled exclusively through the
                 * handleKey() → handleEnter() path to avoid double-execution.
                 * ================================================================
                 */
                if (btn._programmaticFocus) return;
                if (e.detail === 0) return; // Enter-synthesized click, not a real pointer
                if (e.clientX === 0 && e.clientY === 0) return; // TV platform fallback guard
                this.selectTrack(parseInt(btn.dataset.menuIndex));
            });
        });

        const switchBtn = this.$el.querySelector('.track-mode-switch');
        if (switchBtn) {
            switchBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                // Same double-fire guard as .track-item above
                if (switchBtn._programmaticFocus) return;
                if (e.detail === 0) return;
                if (e.clientX === 0 && e.clientY === 0) return;
                this.switchMode();
            });
        }

        this.updateFocus();
    }

    /**
     * Handle directional and selection key events within the track menu.
     * 
     * Aligning with TV interface navigation standards:
     * - UP/DOWN cycles focus within available menu items smoothly.
     * - In sub-menus (Secondary Subtitles), BACK/LEFT/RIGHT returns cleanly to the parent level
     *   (Primary Subtitles) rather than unexpectedly closing the menu to the main OSD.
     * - ENTER activates the focused track or sub-menu toggle.
     *
     * @param {string} key - Directional or action key string ('up', 'down', 'enter', 'back', 'left', 'right')
     * @returns {boolean} True if key was handled
     */
    handleKey(key) {
        const options = this.$el?.querySelectorAll('.track-option') || [];
        if (!options.length) return false;

        switch (key) {
            case 'up':
                if (this.focusIndex > 0) {
                    this.focusIndex--;
                } else {
                    this.focusIndex = options.length - 1;
                }
                this.updateFocus();
                return true;
            case 'down':
                if (this.focusIndex < options.length - 1) {
                    this.focusIndex++;
                } else {
                    this.focusIndex = 0;
                }
                this.updateFocus();
                return true;
            case 'enter':
                this.handleEnter();
                return true;
            case 'back':
            case 'left':
            case 'right':
                // Sub-menu back navigation: returning from secondary subtitles level
                // goes back to primary subtitles track selection menu.
                if (this.type === 'subtitles' && this.mode === 'secondary') {
                    this.switchMode();
                    return true;
                }
                this.osd.closeMenu();
                return true;
        }
        return false;
    }

    handleEnter() {
        if (this.type === 'subtitles') {
            if (this.focusIndex === 0) {
                this.switchMode();
            } else {
                this.selectTrack(this.focusIndex - 1);
            }
        } else {
            this.selectTrack(this.focusIndex);
        }
    }

    switchMode() {
        const newMode = (this.mode === 'primary') ? 'secondary' : 'primary';
        this.open('subtitles', newMode);
    }

    selectTrack(menuIndex) {
        const player = this.osd.player;
        if (!player) return;

        // Retrieve the exact track object rendered at this menu index from cached list
        const selectedTrack = this._renderedTracks ? this._renderedTracks[menuIndex] : null;
        const index = selectedTrack ? (selectedTrack.Index ?? -1) : -1;

        if (this.type === 'subtitles') {
            if (this.mode === 'secondary') {
                this.osd.currentSecondarySubtitleIndex = index;
                player.setSecondarySubtitleStreamIndex?.(index);
            } else {
                this.osd.currentSubtitleIndex = index;
                player.setSubtitleStreamIndex?.(index);
            }
        } else {
            this.osd.currentAudioIndex = index;
            player.setAudioStreamIndex?.(index);
        }
        
        this.osd.closeMenu();
    }

    updateFocus() {
        if (!this.$el) return;
        const options = this.$el.querySelectorAll('.track-option');
        options.forEach((opt, i) => {
            const isFocused = i === this.focusIndex;
            opt.classList.toggle('focused', isFocused);
            if (isFocused) {
                /*
                 * ================================================================
                 * TIZEN PHANTOM CLICK GUARD
                 * ================================================================
                 * On Samsung Tizen TVs, calling element.focus() on a <button>
                 * fires a synthetic click event immediately, even though no key
                 * was pressed. This is a platform-level quirk that causes the
                 * focused button's click listener to fire on every D-pad move.
                 *
                 * The guard works by setting a transient flag on the element
                 * BEFORE calling .focus(), and then ignoring click events in the
                 * listener when that flag is present. The flag is cleared on a
                 * zero-delay timeout so only the synthetic focus-click is blocked;
                 * genuine Enter-key clicks (which arrive on a later event loop
                 * tick) are processed normally.
                 * ================================================================
                 */
                opt._programmaticFocus = true;
                opt.focus({ preventScroll: true });
                setTimeout(() => { opt._programmaticFocus = false; }, 0);

                opt.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
            }
        });
    }
}