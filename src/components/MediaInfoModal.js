import { api } from '../api/index.js';
import { focusManager } from '../ui/FocusManager.js';
import { i18n } from '../utils/i18n.js';
import { logger } from '../utils/Logger.js';

/**
 * ============================================================================
 * Litefin Tizen - Media Info Modal
 * ============================================================================
 * Displays technical media specifications for an item.
 * Designed with Apple HIG principles: clean, modern, and information-dense.
 * ============================================================================
 */

const log = logger.create('MediaInfoModal');

class MediaInfoModal {
    /**
     * Show the Media Info Modal.
     * @param {string} itemId           - The item ID to show info for.
     * @param {Object} detailsPage      - Reference to parent DetailsPage.
     * @param {Object} transitionCtx    - Navigation context for focus restoration.
     */
    static async show(itemId, detailsPage, transitionCtx = null) {
        const oldOnBack = transitionCtx?.oldOnBack || detailsPage.onBack;
        const prevFocus = transitionCtx?.prevFocus || focusManager.getFocused();
        const prevSection = transitionCtx?.prevSection || focusManager.getActiveSection();

        // --- 1. Create Layout Overlay ---
        let overlay = document.getElementById('details-media-info');
        if (overlay) overlay.remove();

        overlay = document.createElement('div');
        overlay.id = 'details-media-info';
        overlay.className = 'modal-overlay visible';
        document.body.appendChild(overlay);

        // Render initial skeleton/loading state
        overlay.innerHTML = `
            <div class="settings-modal media-info-modal" role="dialog" aria-modal="true">
                <div class="modal-header">
                    <h2>${i18n.t('MoreMediaInfo') || 'Media Info'}</h2>
                </div>
                <div class="modal-options media-info-scrollable">
                    <div class="media-info-loading">
                        <div class="loading-spinner-small"></div>
                        <span>${i18n.t('Loading') || 'Loading...'}</span>
                    </div>
                </div>
                <div class="modal-actions">
                    <button class="modal-action-btn" id="btn-media-info-cancel" tabindex="0">${i18n.t('ButtonBack') || 'Back'}</button>
                </div>
            </div>
        `;

        // Register initial focus for the Back/Cancel button
        const actionsSection = 'media-info-actions';
        focusManager.register(actionsSection, overlay.querySelector('.modal-actions'), {
            orientation: 'horizontal',
            leaveUp: 'media-info-content' // Link back to content
        });
        focusManager.setActiveSection(actionsSection);

        // Clean-up/Close helper
        const _close = (restoreFocus = true) => {
            if (detailsPage.onBack === myOnBack) detailsPage.onBack = oldOnBack;
            
            overlay.classList.remove('visible');
            setTimeout(() => overlay.remove(), 300);

            focusManager.unregister('media-info-content');
            focusManager.unregister(actionsSection);

            if (restoreFocus) {
                if (prevSection) focusManager.setActiveSection(prevSection, false);
                if (prevFocus) focusManager.focusElement(prevFocus);
            }
        };

        const myOnBack = () => {
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

        overlay.querySelector('#btn-media-info-cancel').onclick = (e) => {
            e.stopPropagation();
            myOnBack();
        };

        overlay.onclick = (e) => {
            if (e.target === overlay) myOnBack();
        };

        // --- 2. Fetch Detailed Metadata ---
        try {
            const item = await api.getItem(itemId, { 
                Fields: 'MediaSources,MediaStreams' 
            });
            
            if (!item.MediaSources || item.MediaSources.length === 0) {
                overlay.querySelector('.modal-options').innerHTML = `<p class="media-info-empty">${i18n.t('NoMediaSourcesFound') || 'No media information available.'}</p>`;
                return;
            }

            this._renderInfo(overlay, item);
            this._setupFocus(overlay);

        } catch (err) {
            log.error('Failed to load media info', err);
            overlay.querySelector('.modal-options').innerHTML = `<p class="media-info-error">${i18n.t('ErrorLoadingMediaInfo') || 'Failed to load media specs.'}</p>`;
        }
    }

    /**
     * Renders the technical specs into the modal.
     */
    static _renderInfo(overlay, item) {
        const contentContainer = overlay.querySelector('.modal-options');
        let html = '';

        item.MediaSources.forEach((source, sourceIdx) => {
            // Header for Source (if multiple)
            if (item.MediaSources.length > 1) {
                html += `<div class="media-info-source-title">${i18n.t('Source')} ${sourceIdx + 1}: ${source.Name || ''}</div>`;
            }

            // General Table
            html += `
                <div class="media-info-section media-info-focusable" tabindex="0">
                    <div class="media-info-grid">
                        ${this._renderRow(i18n.t('Container'), source.Container)}
                        ${source.Size ? this._renderRow(i18n.t('Size'), this._formatSize(source.Size)) : ''}
                        ${source.Bitrate ? this._renderRow(i18n.t('Bitrate'), this._formatBitrate(source.Bitrate)) : ''}
                    </div>
                </div>
            `;

            // File Details (Full Width for long paths)
            if (source.Path || source.FileName) {
                html += `
                    <div class="media-info-section media-info-focusable" tabindex="0">
                        <div class="media-info-full-rows">
                            ${source.FileName ? this._renderRow(i18n.t('FileName'), source.FileName) : ''}
                            ${source.Path ? this._renderRow(i18n.t('Path'), source.Path) : ''}
                        </div>
                    </div>
                `;
            }

            // Streams
            source.MediaStreams.forEach((stream) => {
                const typeLabel = i18n.t(stream.Type);
                const title = stream.DisplayTitle || stream.Title || '';
                
                html += `
                    <div class="media-info-stream media-info-focusable" tabindex="0">
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
        });

        contentContainer.innerHTML = `<div id="media-info-content-track" class="media-info-content-track">${html}</div>`;
    }

    static _renderRow(label, value) {
        if (!value) return '';
        return `
            <div class="media-info-row">
                <span class="info-label">${label}</span>
                <span class="info-value">${value}</span>
            </div>
        `;
    }

    static _renderVideoRows(s) {
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
        if (s.IsAnamorphic !== undefined) rows += this._renderRow(i18n.t('Anamorphic'), s.IsAnamorphic ? i18n.t('Yes') : i18n.t('No'));
        return rows;
    }

    static _renderAudioRows(s) {
        let rows = '';
        if (s.Language) rows += this._renderRow(i18n.t('Language'), s.Language);
        if (s.Channels) rows += this._renderRow(i18n.t('Channels'), `${s.Channels} ch`);
        if (s.SampleRate) rows += this._renderRow(i18n.t('SampleRate'), `${s.SampleRate} Hz`);
        if (s.BitDepth) rows += this._renderRow(i18n.t('BitDepth'), `${s.BitDepth} bit`);
        if (s.BitRate) rows += this._renderRow(i18n.t('Bitrate'), this._formatBitrate(s.BitRate));
        return rows;
    }

    static _renderSubtitleRows(s) {
        let rows = '';
        if (s.Language) rows += this._renderRow(i18n.t('Language'), s.Language);
        if (s.IsExternal !== undefined) rows += this._renderRow(i18n.t('Type'), s.IsExternal ? i18n.t('External') : i18n.t('Internal'));
        return rows;
    }

    static _formatSize(bytes) {
        if (bytes === 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    }

    static _formatBitrate(bits) {
        if (!bits) return '';
        if (bits > 1000000) return (bits / 1000000).toFixed(1) + ' Mbps';
        return (bits / 1000).toFixed(0) + ' Kbps';
    }

    /**
     * Sets up focus for the scrollable content.
     */
    static _setupFocus(overlay) {
        const track = overlay.querySelector('.media-info-content-track');
        
        // Register focus section for the technical info cards
        focusManager.register('media-info-content', track, {
            orientation: 'vertical',
            leaveDown: 'media-info-actions',
            leaveUp: 'media-info-actions'
        });

        // Set initial focus to the first card if available, otherwise stay on Back button
        const firstCard = track.querySelector('.media-info-focusable');
        if (firstCard) {
            focusManager.setActiveSection('media-info-content');
            focusManager.focusElement(firstCard);
        }
    }
}

export default MediaInfoModal;
