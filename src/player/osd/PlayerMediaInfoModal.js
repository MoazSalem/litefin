/**
 * ============================================================================
 * PlayerMediaInfoModal
 * ============================================================================
 * Full technical media specification modal accessible directly from the player
 * settings menu.
 * 
 * Extends BaseMenu to integrate seamlessly with OSDController lifecycle,
 * remote D-pad scrolling, backdrop dismissal, and focus restoration.
 * ============================================================================
 */

import BaseMenu from './BaseMenu.js';
import { api } from '../../api/index.js';
import { i18n } from '../../utils/i18n.js';
import { logger } from '../../utils/Logger.js';

const log = logger.create('PlayerMediaInfoModal');

export default class PlayerMediaInfoModal extends BaseMenu {
    /**
     * Initializes modal with OSD controller reference.
     * @param {Object} osdController 
     */
    constructor(osdController) {
        super(osdController);
        this.isModal = true;
        this._item = null;
        this._openedAt = 0;
    }

    /**
     * Open and render the media info modal for the current playing item.
     * @param {Object} item - The current media item from OSDController.
     */
    open(item) {
        this._item = item;
        this.render();

        // Capture previous focus state for restoration
        this._prevRow = this.osd._currentFocusRow;
        this._prevIndex = this.osd._currentFocusIndex;

        this.show();

        // Debounce Enter key immediately after opening
        this._openedAt = Date.now();

        // Fetch detailed metadata including MediaSources and Streams
        this._loadItemData();

        requestAnimationFrame(() => {
            this.updateFocus();
        });
    }

    /**
     * Render the initial modal shell following Apple HIG sleek aesthetics.
     */
    render() {
        if (this.$el) {
            this.$el.remove();
            this.$el = null;
        }

        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay visible player-media-info-overlay';

        const titleText = i18n.t('MoreMediaInfo') || 'Media Info';

        overlay.innerHTML = `
            <div class="settings-modal media-info-modal player-media-info-modal" role="dialog" aria-modal="true" aria-label="${titleText}">
                <div class="modal-header">
                    <h2>${titleText}</h2>
                </div>
                <div class="modal-options media-info-scrollable" tabindex="0">
                    <div class="media-info-loading">
                        <div class="loading-spinner-small"></div>
                        <span>${i18n.t('Loading') || 'Loading...'}</span>
                    </div>
                </div>
            </div>
        `;

        // Dismiss on backdrop click
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) {
                e.stopPropagation();
                this._close();
            }
        });

        const overlaysEl = this.osd._osdEl?.querySelector('.osd-overlays') || document.body;
        overlaysEl.appendChild(overlay);

        this.$el = overlay;
    }

    /**
     * Fetch complete media sources and stream information.
     * @private
     */
    async _loadItemData() {
        if (!this._item || !this._item.Id) return;

        try {
            const fullItem = await (this.osd.api || api).getItem(this._item.Id, {
                Fields: 'MediaSources,MediaStreams,DateCreated,PremiereDate'
            });

            if (!this.isVisible || !this.$el) return;

            const scrollable = this.$el.querySelector('.media-info-scrollable');
            if (!scrollable) return;

            if (!fullItem.MediaSources || fullItem.MediaSources.length === 0) {
                scrollable.innerHTML = `<p class="media-info-empty">${i18n.t('NoMediaSourcesFound') || 'No media information available.'}</p>`;
                return;
            }

            this._renderInfo(scrollable, fullItem);
        } catch (err) {
            log.error('Failed to load media info specs:', err);
            if (this.$el) {
                const scrollable = this.$el.querySelector('.media-info-scrollable');
                if (scrollable) {
                    scrollable.innerHTML = `<p class="media-info-error">${i18n.t('ErrorLoadingMediaInfo') || 'Failed to load media specs.'}</p>`;
                }
            }
        }
    }

    /**
     * Renders media details into the scrollable body container.
     * @private
     */
    _renderInfo(container, item) {
        let html = '';

        item.MediaSources.forEach((source, sourceIdx) => {
            // Header for Source if multiple sources exist
            if (item.MediaSources.length > 1) {
                html += `<div class="media-info-source-title">${i18n.t('Source')} ${sourceIdx + 1}: ${source.Name || ''}</div>`;
            }

            // General Table
            html += `
                <div class="media-info-section">
                    <div class="media-info-grid">
                        ${this._renderRow(i18n.t('Container'), source.Container)}
                        ${source.Size ? this._renderRow(i18n.t('Size'), this._formatSize(source.Size)) : ''}
                        ${source.Bitrate ? this._renderRow(i18n.t('Bitrate'), this._formatBitrate(source.Bitrate)) : ''}
                        ${item.DateCreated ? this._renderRow(i18n.t('Added'), this._formatDate(item.DateCreated)) : ''}
                        ${item.PremiereDate ? this._renderRow(i18n.t('Aired'), this._formatDate(item.PremiereDate)) : ''}
                    </div>
                </div>
            `;

            // File Details (Full width for long file names or local disk paths)
            if (source.Path || source.FileName) {
                html += `
                    <div class="media-info-section">
                        <div class="media-info-full-rows">
                            ${source.FileName ? this._renderRow(i18n.t('FileName'), source.FileName) : ''}
                            ${source.Path ? this._renderRow(i18n.t('Path'), source.Path) : ''}
                        </div>
                    </div>
                `;
            }

            // Streams breakdown (Video, Audio, Subtitle)
            if (source.MediaStreams && source.MediaStreams.length > 0) {
                source.MediaStreams.forEach((stream) => {
                    const typeLabel = i18n.t(stream.Type);
                    const title = stream.DisplayTitle || stream.Title || '';

                    html += `
                        <div class="media-info-stream">
                            <div class="media-info-stream-header">
                                <span class="stream-type-badge ${stream.Type.toLowerCase()}">${typeLabel}</span>
                                <span class="stream-title">${title}</span>
                            </div>
                            <div class="media-info-grid">
                                ${this._renderRow(i18n.t('Codec'), (stream.Codec || '').toUpperCase())}
                                ${stream.Type === 'Video' ? this._renderVideoRows(stream) : ''}
                                ${stream.Type === 'Audio' ? this._renderAudioRows(stream) : ''}
                                ${stream.Type === 'Subtitle' ? this._renderSubtitleRows(stream) : ''}
                            </div>
                        </div>
                    `;
                });
            }
        });

        container.innerHTML = `<div class="media-info-content-track">${html}</div>`;
    }

    /**
     * Render single metadata key-value row.
     * @private
     */
    _renderRow(label, value) {
        if (!value) return '';
        return `
            <div class="media-info-row">
                <span class="info-label">${label}</span>
                <span class="info-value">${value}</span>
            </div>
        `;
    }

    /**
     * Render video stream properties.
     * @private
     */
    _renderVideoRows(s) {
        let rows = '';
        if (s.Width && s.Height) rows += this._renderRow(i18n.t('Resolution'), `${s.Width}x${s.Height}`);
        if (s.AspectRatio) rows += this._renderRow(i18n.t('AspectRatio'), s.AspectRatio);
        if (s.RealFrameRate) rows += this._renderRow(i18n.t('Framerate'), `${s.RealFrameRate} fps`);
        if (s.BitDepth) rows += this._renderRow(i18n.t('BitDepth'), `${s.BitDepth} bit`);
        if (s.VideoRange) {
            const range = s.VideoRange === 'SDR' ? 'SDR' : `[${s.VideoRange}]`;
            rows += this._renderRow(i18n.t('VideoRange'), range);
        }
        if (s.ColorSpace) rows += this._renderRow(i18n.t('ColorSpace'), s.ColorSpace);
        if (s.ColorTransfer) rows += this._renderRow(i18n.t('ColorTransfer'), s.ColorTransfer);
        if (s.ColorPrimaries) rows += this._renderRow(i18n.t('ColorPrimaries'), s.ColorPrimaries);
        if (s.PixelFormat) rows += this._renderRow(i18n.t('PixelFormat'), s.PixelFormat);
        if (s.IsAnamorphic !== undefined) {
            rows += this._renderRow(i18n.t('Anamorphic'), s.IsAnamorphic ? i18n.t('Yes') : i18n.t('No'));
        }
        return rows;
    }

    /**
     * Render audio stream properties.
     * @private
     */
    _renderAudioRows(s) {
        let rows = '';
        if (s.Language) rows += this._renderRow(i18n.t('Language'), s.Language);
        if (s.Channels) rows += this._renderRow(i18n.t('Channels'), `${s.Channels} ch`);
        if (s.SampleRate) rows += this._renderRow(i18n.t('SampleRate'), `${s.SampleRate} Hz`);
        if (s.BitDepth) rows += this._renderRow(i18n.t('BitDepth'), `${s.BitDepth} bit`);
        if (s.BitRate) rows += this._renderRow(i18n.t('Bitrate'), this._formatBitrate(s.BitRate));
        return rows;
    }

    /**
     * Render subtitle stream properties.
     * @private
     */
    _renderSubtitleRows(s) {
        let rows = '';
        if (s.Language) rows += this._renderRow(i18n.t('Language'), s.Language);
        if (s.IsExternal !== undefined) {
            rows += this._renderRow(i18n.t('Type'), s.IsExternal ? i18n.t('External') : i18n.t('Internal'));
        }
        return rows;
    }

    /**
     * Format byte sizes into readable metrics.
     * @private
     */
    _formatSize(bytes) {
        if (!bytes || bytes === 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    }

    /**
     * Format stream bitrates into Mbps/Kbps.
     * @private
     */
    _formatBitrate(bits) {
        if (!bits) return '';
        if (bits > 1000000) return (bits / 1000000).toFixed(1) + ' Mbps';
        return (bits / 1000).toFixed(0) + ' Kbps';
    }

    /**
     * Format date string to standard display.
     * @private
     */
    _formatDate(dateStr) {
        if (!dateStr) return '';
        try {
            const d = new Date(dateStr);
            const day = String(d.getDate()).padStart(2, '0');
            const month = String(d.getMonth() + 1).padStart(2, '0');
            const year = d.getFullYear();
            return `${day}/${month}/${year}`;
        } catch (e) {
            return dateStr;
        }
    }

    /**
     * Remote D-Pad and keyboard key delegation.
     * @param {string} key
     * @returns {boolean}
     */
    handleKey(key) {
        if (!this.isVisible) return false;

        const scrollable = this.$el?.querySelector('.media-info-scrollable');

        switch (key) {
            case 'up':
                if (scrollable) {
                    scrollable.scrollTop -= 100;
                }
                return true;

            case 'down':
                if (scrollable) {
                    scrollable.scrollTop += 100;
                }
                return true;

            case 'enter':
                // Debounce rapid repeated enter keys
                if (this._openedAt && (Date.now() - this._openedAt < 300)) {
                    return true;
                }
                this._close();
                return true;

            case 'back':
            case 'left':
            case 'right':
                this._close();
                return true;

            default:
                return true;
        }
    }

    /**
     * Update focus state.
     */
    updateFocus() {
        if (!this.$el) return;
        const scrollable = this.$el.querySelector('.media-info-scrollable');
        if (scrollable) {
            scrollable.focus();
        }
    }

    /**
     * Dismiss modal and restore focus cleanly.
     * @private
     */
    _close() {
        this.osd.closeMenu();
    }

    /**
     * Hide and restore previous focus row and index.
     */
    hide() {
        if (!this.isVisible) return;
        this.isVisible = false;

        if (this.$el) {
            this.$el.classList.remove('visible');
            setTimeout(() => {
                if (this.$el) {
                    this.$el.remove();
                    this.$el = null;
                }
            }, 300);
        }

        // Restore focus to previous position
        if (this._prevRow !== undefined) {
            this.osd._currentFocusRow = this._prevRow;
            this.osd._currentFocusIndex = this._prevIndex;
            this.osd._updateFocus();
        }
    }
}
