/**
 * ============================================================================
 * Litefin Tizen - Backdrop Screensaver
 * ============================================================================
 * Displays a slideshow of random backdrops from the user's library.
 * Requires an active server connection and authentication.
 * ============================================================================
 */

import { api, auth } from '../../api/index.js';
import { storage } from '../../utils/StorageService.js';
import BackdropManager from '../../utils/BackdropManager.js';
import { logger } from '../../utils/Logger.js';

const log = logger.create('BackdropScreensaver');

export class BackdropScreensaver {
    constructor() {
        this.name = 'BackdropScreensaver';
        this.id = 'backdropscreensaver';
        this._interval = null;
        this._items = [];
        this._currentIndex = 0;
        this._container = null;
        this._img1 = null;
        this._img2 = null;
        this._activeImg = 1;

        // Configuration
        this._slideDuration = parseInt(storage.getItem('pref:backdropScreensaverInterval'), 10) || 10000;

        // Dim level: 0 = no dimming, 0.8 = very dark (stored as a float string)
        this._dimLevel = parseFloat(storage.getItem('pref:backdropDimmer'));
        if (isNaN(this._dimLevel)) this._dimLevel = 0.4; // default: 40% dim

        // Hide text option: if true, we don't render titles/taglines
        this._hideText = storage.getItem('pref:backdropHideText') === 'true';

        // Include music option: if true, we Include MusicArtist in the backdrop search
        this._includeMusic = storage.getItem('pref:backdropIncludeMusic') === 'true';
    }

    async show() {
        if (!auth.isAuthenticated()) {
            log.warn('Cannot start BackdropScreensaver without authentication');
            return;
        }

        this._createElements();

        try {
            // Fetch random items with backdrops
            const result = await api.getItems({
                ImageTypes: 'Backdrop',
                EnableImageTypes: 'Backdrop',
                IncludeItemTypes: this._includeMusic ? 'Movie,Series,MusicArtist' : 'Movie,Series',
                SortBy: 'Random',
                Recursive: true,
                Fields: 'Taglines',
                ImageTypeLimit: 10,
                StartIndex: 0,
                Limit: 50
            });

            if (result && result.Items && result.Items.length > 0) {
                this._items = result.Items;
                this._currentIndex = 0;

                // Show first image immediately
                this._nextSlide();

                // Start slideshow interval
                this._stopInterval();
                this._interval = setInterval(() => this._nextSlide(), this._slideDuration);
            } else {
                log.warn('No items with backdrops found');
                this.hide();
            }
        } catch (error) {
            log.error('Failed to load items for backdrop screensaver:', error);
            this.hide();
        }
    }

    _createElements() {
        if (!this._container) {
            this._container = document.createElement('div');
            this._container.className = 'backdrop-screensaver';

            // Create two image layers for crossfading
            this._img1 = document.createElement('div');
            this._img1.className = 'backdrop-screensaver-image active';

            this._img2 = document.createElement('div');
            this._img2.className = 'backdrop-screensaver-image';

            const overlay = document.createElement('div');
            overlay.className = 'backdrop-screensaver-overlay';

            this._titleElem = document.createElement('div');
            this._titleElem.className = 'backdrop-screensaver-title';

            this._container.appendChild(this._img1);
            this._container.appendChild(this._img2);
            this._container.appendChild(overlay);

            // Dim layer: a semi-transparent black panel sitting above the images
            // but below the text overlay, giving the screensaver a darker look.
            if (this._dimLevel > 0) {
                const dimLayer = document.createElement('div');
                dimLayer.className = 'backdrop-screensaver-dim';
                dimLayer.style.opacity = String(this._dimLevel);
                this._container.appendChild(dimLayer);
            }

            this._container.appendChild(this._titleElem);

            document.body.appendChild(this._container);
        }
    }

    _nextSlide() {
        if (!this._items.length) return;

        const item = this._items[this._currentIndex];
        const url = BackdropManager.getBackdropUrl(item, { maxWidth: 1920, quality: 90 });

        if (url) {
            // Determine incoming and outgoing elements based on active index
            const incoming = this._activeImg === 1 ? this._img2 : this._img1;
            const outgoing = this._activeImg === 1 ? this._img1 : this._img2;

            // Preload image
            const img = new Image();
            img.onload = () => {
                incoming.style.backgroundImage = `url('${url}')`;

                // Trigger crossfade
                incoming.classList.add('active');
                outgoing.classList.remove('active');

                // Update text
                if (this._hideText) {
                    this._titleElem.innerHTML = '';
                } else {
                    this._titleElem.innerHTML = `
                        <div class="screensaver-text-name">${item.Name}</div>
                        ${item.Taglines && item.Taglines.length ? `<div class="screensaver-text-tagline">${item.Taglines[0]}</div>` : ''}
                    `;
                }

                // Swap active tracker
                this._activeImg = this._activeImg === 1 ? 2 : 1;
            };
            img.src = url;
        }

        // Advance index
        this._currentIndex++;
        if (this._currentIndex >= this._items.length) {
            this._currentIndex = 0;
        }
    }

    _stopInterval() {
        if (this._interval) {
            clearInterval(this._interval);
            this._interval = null;
        }
    }

    hide() {
        this._stopInterval();

        if (this._container) {
            return new Promise((resolve) => {
                const onAnimationFinish = () => {
                    if (this._container && this._container.parentNode) {
                        this._container.parentNode.removeChild(this._container);
                    }
                    this._container = null;
                    this._img1 = null;
                    this._img2 = null;
                    resolve();
                };

                // Simple fade out
                if (this._container.animate) {
                    const animation = this._container.animate([{ opacity: '1' }, { opacity: '0' }], { duration: 400 });
                    animation.onfinish = onAnimationFinish;
                } else {
                    onAnimationFinish();
                }
            });
        }

        return Promise.resolve();
    }
}
