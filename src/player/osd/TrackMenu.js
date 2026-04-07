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

    show() {
        this._prevRow = this.osd._currentFocusRow;
        this._prevIndex = this.osd._currentFocusIndex;

        this.isVisible = true;
        if (this.$el) {
            this.$el.classList.add('visible');
            this.updateFocus();
        }
    }

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

            return `
                <button class="track-option track-item ${isSelected ? 'selected' : ''}" data-index="${track.Index}" data-menu-index="${i}">
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
                this.selectTrack(parseInt(btn.dataset.menuIndex));
            });
        });

        const switchBtn = this.$el.querySelector('.track-mode-switch');
        if (switchBtn) {
            switchBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.switchMode();
            });
        }

        this.updateFocus();
    }

    handleKey(key) {
        const options = this.$el?.querySelectorAll('.track-option') || [];
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
                // Rely on native click event which is triggered by the browser on Enter
                // The buttons have 'click' event listeners attached in render()
                return true;
            case 'back':
            case 'left':
            case 'right':
                this.osd.closeMenu();
                return true;
        }
        return false;
    }

    switchMode() {
        const newMode = (this.mode === 'primary') ? 'secondary' : 'primary';
        this.open('subtitles', newMode);
    }

    selectTrack(menuIndex) {
        const player = this.osd.player;
        if (!player) return;

        if (this.type === 'subtitles') {
            const tracksRaw = player.getSubtitleTracks();
            const tracks = Array.isArray(tracksRaw) ? tracksRaw : []; 
            
            // Offset for "Off" at index 0
            const index = (menuIndex === 0) ? -1 : (tracks[menuIndex - 1]?.Index ?? -1);
            
            if (this.mode === 'secondary') {
                this.osd.currentSecondarySubtitleIndex = index;
                player.setSecondarySubtitleStreamIndex?.(index);
            } else {
                this.osd.currentSubtitleIndex = index;
                player.setSubtitleStreamIndex?.(index);
            }
        } else {
            const tracksRaw = player.getAudioTracks();
            const tracks = Array.isArray(tracksRaw) ? tracksRaw : [];
            const index = tracks[menuIndex]?.Index ?? 0;
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
                opt.focus();
                opt.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
            }
        });
    }
}