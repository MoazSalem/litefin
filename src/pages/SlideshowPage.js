/**
 * ============================================================================
 * Litefin Tizen - Slideshow Page
 * ============================================================================
 * Full-screen photo viewer for Home Videos and Photos libraries.
 *
 * Design philosophy (Apple HIG for TV):
 *  - Absolutely minimal chrome — the photo is the UI.
 *  - All controls appear only on focus / navigation, then fade out.
 *  - Opacity crossfade transition (NOT translate) prevents GPU composite
 *    layer blowout on tighter Tizen 4 / 5 hardware.
 *  - Max 3 <img> objects are kept warm (prev, current, next) — avoids
 *    exhausting the limited VRAM budget on 2 GB Tizen baseline devices.
 *
 * Navigation (D-pad remote):
 *  ← / →     Previous / Next photo
 *  OK/Enter  Toggle EXIF metadata overlay
 *  Play      Toggle auto-advance timer
 *  Back      Exit to previous page
 * ============================================================================
 */

import Page from './Page.js';
import { api } from '../api/index.js';
import { router } from '../core/Router.js';
import { eventBus } from '../core/EventBus.js';
import { i18n } from '../utils/i18n.js';
import { logger } from '../utils/Logger.js';

const log = logger.create('SlideshowPage');

/** How long (ms) each slide is shown during auto-advance. */
const AUTO_ADVANCE_INTERVAL_MS = 5000;

/** Crossfade duration (ms) — kept short to hide loading hiccups gracefully. */
const CROSSFADE_DURATION_MS = 300;

/**
 * EXIF fields requested from the server.
 * We only ask for what we display — keeps the response payload trim.
 */
const PHOTO_FIELDS = [
    'DateCreated',
    'PrimaryImageAspectRatio',
    'Width',
    'Height',
    'CameraMake',
    'CameraModel',
    'ExposureTime',
    'FocalLength',
    'Aperture',
    'Altitude'
].join(',');

class SlideshowPage extends Page {
    constructor() {
        super();

        /**
         * The full ordered list of Photo items fetched from the parent container.
         * @type {Array<Object>}
         */
        this._photos = [];

        /**
         * Index of the currently displayed photo in this._photos.
         * @type {number}
         */
        this._currentIndex = 0;

        /**
         * Whether the crossfade animation is currently in progress.
         * Guards against rapid key presses during the transition.
         * @type {boolean}
         */
        this._transitioning = false;

        /**
         * Whether the EXIF info overlay is currently visible.
         * @type {boolean}
         */
        this._exifVisible = false;

        /**
         * Whether auto-advance playback is currently active.
         * @type {boolean}
         */
        this._autoAdvancing = false;

        /**
         * The setInterval ID for auto-advance. Cleared on pause / destroy.
         * @type {number|null}
         */
        this._autoTimer = null;

        /**
         * Bound reference to the keyboard handler so we can cleanly
         * removeEventListener on destroy().
         */
        this._keyHandler = this._onKeyDown.bind(this);

        /**
         * Two <img> scratch elements for off-screen preloading.
         * The 'active' slot holds the currently visible image source, the
         * 'next' slot is used to fire off the speculative load for preloading.
         * We never attach these to the DOM — they are purely for cache warming.
         * @type {{ prev: HTMLImageElement|null, next: HTMLImageElement|null }}
         */
        this._preloadSlots = { prev: null, next: null };

        // Mark as async so NavigationState doesn't try to restore focus
        this._isAsyncPage = true;
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Page Lifecycle
    // ──────────────────────────────────────────────────────────────────────────

    render() {
        return `
            <div class="page slideshow-page" id="slideshow-root">

                <!-- ── Stage: Two image layers for crossfade ── -->
                <!-- Layer A is the "outgoing" frame, Layer B is the "incoming" frame.
                     We swap their roles on every transition for zero allocation overhead. -->
                <div class="slideshow-stage" id="slideshow-stage">
                    <img
                        class="slideshow-img slideshow-img-a is-active"
                        id="slideshow-img-a"
                        alt=""
                        aria-hidden="true"
                    />
                    <img
                        class="slideshow-img slideshow-img-b"
                        id="slideshow-img-b"
                        alt=""
                        aria-hidden="true"
                    />
                </div>

                <!-- ── Center Video Indicator (hidden for photos) ── -->
                <div class="slideshow-video-play hidden" id="video-play-indicator" aria-hidden="true">
                    <svg viewBox="0 0 24 24" fill="currentColor">
                        <polygon points="5 3 19 12 5 21 5 3"/>
                    </svg>
                </div>

                <!-- ── Top-right counter: "4 / 47" ── -->
                <div class="slideshow-counter" id="slideshow-counter" aria-live="polite"></div>

                <!-- ── Auto-advance indicator (play icon, shown when active) ── -->
                <div class="slideshow-autoplay-badge hidden" id="autoplay-badge" aria-hidden="true">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                        <polygon points="5 3 19 12 5 21 5 3"/>
                    </svg>
                </div>

                <!-- ── Ghost nav arrows (visible only on left/right D-pad press) ── -->
                <!-- These aren't real focusable buttons — we handle nav in keydown.
                     They provide a visual cue that left/right navigation is possible. -->
                <div class="slideshow-arrow slideshow-arrow-left hidden" id="arrow-left" aria-hidden="true">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
                         stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                        <polyline points="15 18 9 12 15 6"/>
                    </svg>
                </div>
                <div class="slideshow-arrow slideshow-arrow-right hidden" id="arrow-right" aria-hidden="true">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
                         stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                        <polyline points="9 18 15 12 9 6"/>
                    </svg>
                </div>

                <!-- ── EXIF Metadata Overlay ── -->
                <!-- Slides up from the bottom on OK/Enter. Frosted dark scrim. -->
                <div class="slideshow-exif-overlay hidden" id="exif-overlay" role="region" aria-label="${i18n.t('PhotoInfo') || 'Photo Info'}">
                    <div class="exif-content" id="exif-content">
                        <!-- Populated dynamically by _renderExifOverlay() -->
                    </div>
                </div>

                <!-- ── Invisible focus trap: keeps focusManager happy on TV ── -->
                <!-- SlideshowPage bypasses focusManager entirely and handles all
                     D-pad input in the document keydown handler, but we still need
                     at least one focusable element so the browser doesn't fire
                     unhandled Tab events. -->
                <button class="slideshow-focus-trap" id="slideshow-focus-trap" tabindex="0" aria-label="Slideshow"></button>
            </div>
        `;
    }

    async onInit() {
        const photoId = this.params.photoId;
        const parentId = this.params.parentId; /* optional query param */

        log.info(`Slideshow init for photo: ${photoId}, parentId: ${parentId || 'none'}`);

        this.setLoading(true);

        try {
            /*
             * ── Fast-path: returning from the video player ──
             * setNavigationState() stashes the photos array and the index we
             * were at before navigating away. Skip the network round-trip and
             * restore directly so the user lands back on the same slide instantly.
             */
            if (this._restoredState && this._restoredState.photos?.length > 0) {
                log.debug('Restoring slideshow from navigation state (no re-fetch needed)');
                this._photos = this._restoredState.photos;
                this._currentIndex = this._restoredState.currentIndex || 0;
                this._restoredState = null; /* consume the snapshot */
            } else {
                /* ── Normal cold-start: fetch all photos in the album ── */
                await this._fetchPhotos(photoId, parentId);

                if (this._photos.length === 0) {
                    log.warn('No photos found for slideshow');
                    router.back();
                    return;
                }

                /* Find the starting index (the photo the user tapped) */
                const startIdx = this._photos.findIndex((p) => p.Id === photoId);
                this._currentIndex = startIdx !== -1 ? startIdx : 0;
            }

            /* ── Show the current image (no crossfade on first display) ── */
            await this._showPhoto(this._currentIndex, false /* no transition */);

            /* ── Wire up keyboard handling ── */
            document.addEventListener('keydown', this._keyHandler, true /* capture */);

            /* ── Set focus to our invisible trap so the page receives keys ── */
            const trap = this.$('#slideshow-focus-trap');
            if (trap) trap.focus();

            /* ── Signal page ready ── */
            this.markReady();

            /* ── Auto-play if requested via query param ── */
            if (this.params.autoPlay === 'true') {
                this._startAutoAdvance();
            }

        } catch (err) {
            log.error('Slideshow init failed:', err);
            router.back();
        } finally {
            this.setLoading(false);
        }
    }

    destroy() {
        /* Stop any running auto-advance before teardown */
        this._stopAutoAdvance();

        /* Release keyboard capture */
        document.removeEventListener('keydown', this._keyHandler, true);

        /* Drop preload references so the browser can GC the image data */
        this._preloadSlots.prev = null;
        this._preloadSlots.next = null;

        super.destroy();

        log.debug('SlideshowPage destroyed');
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Navigation State — persists current index across player round-trips
    // ──────────────────────────────────────────────────────────────────────────

    /**
     * Called by NavigationState.captureState() just before the router
     * pushes a new page (e.g. the video player). We save enough data so
     * that setNavigationState() can restore the exact slide without a
     * re-fetch.
     * @returns {Object}
     */
    getNavigationState() {
        return {
            currentIndex: this._currentIndex,
            /*
             * Persist the photos array so we can restore the view without
             * reissuing the full API call. The array size is bounded (≤ 5000
             * lightweight DTOs) and is already in memory, so this is safe.
             */
            photos: this._photos
        };
    }

    /**
     * Called by NavigationState.restorePageState() at the start of onInit()
     * when the user navigates back from the player.
     * We stash the state for consumption by onInit() after the DOM is ready.
     * @param {Object} state
     */
    setNavigationState(state) {
        if (!state) return;
        /* Stash it — onInit() will pick it up instead of re-fetching */
        this._restoredState = state;
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Data Fetching
    // ──────────────────────────────────────────────────────────────────────────

    /**
     * Fetches all photos that share a parent with the given photoId.
     * If the caller already knows the parentId (from query string), we
     * use that directly. Otherwise we fetch the photo itself first to
     * discover its ParentId.
     *
     * @param {string} photoId   - The item ID of the photo the user selected.
     * @param {string} [parentId] - Optional container ID, skips the lookup fetch.
     */
    async _fetchPhotos(photoId, parentId) {
        let resolvedParentId = parentId;

        /*
         * If no parentId was passed, we need to look it up by fetching the
         * target photo item. This adds one extra RTT, but it's only triggered
         * when navigating to a slideshow via DetailsPage rather than the
         * Photos grid tab (which always passes parentId).
         */
        if (!resolvedParentId) {
            log.debug('No parentId — fetching photo to resolve parent');
            const photo = await api.getItem(photoId, { Fields: PHOTO_FIELDS });
            resolvedParentId = photo.ParentId;
        }

        if (!resolvedParentId) {
            /* Absolute fallback: can't build queue without a parent. Show solo. */
            log.warn('Could not determine parentId — solo slideshow');
            const solo = await api.getItem(photoId, { Fields: PHOTO_FIELDS });
            this._photos = [solo];
            return;
        }

        const sortBy = this.params.sortBy || 'SortName';
        const sortOrder = this.params.sortOrder || 'Ascending';

        /* Fetch all Photo and Video items from the parent, sorted according to params */
        const response = await api.getItems({
            ParentId: resolvedParentId,
            IncludeItemTypes: 'Photo,Video',
            SortBy: sortBy,
            SortOrder: sortOrder,
            Recursive: false,    /* Direct children only for speed */
            Fields: PHOTO_FIELDS,
            Limit: 5000          /* Reasonable upper bound for large albums */
        });

        this._photos = response.Items || [];
        log.info(`Loaded ${this._photos.length} photos for slideshow`);
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Photo Display
    // ──────────────────────────────────────────────────────────────────────────

    /**
     * Display the photo at the given index.
     *
     * Uses a two-layer crossfade: the currently visible <img> fades out
     * while the new one (preloaded if possible) fades in. Both layers
     * are absolutely positioned in the stage container.
     *
     * @param {number}  index     - Index into this._photos to display.
     * @param {boolean} [fade]    - Whether to play the crossfade, default true.
     */
    async _showPhoto(index, fade = true) {
        if (this._transitioning) return;
        if (index < 0 || index >= this._photos.length) return;

        this._transitioning = true;
        this._currentIndex = index;

        const photo = this._photos[index];
        const imageUrl = api.getImageUrl(photo.Id, 'Primary', {
            /* Request bounded resolution: Tizen UI renders at 1080p maximum.
               Failing to limit this causes Jellyfin to re-encode a 20MP original at 100% scale,
               taking 5-10 seconds per image and destroying responsiveness! */
            maxWidth: 1920,
            maxHeight: 1080,
            quality: 90
        });

        /* Reference to the two stage layers */
        const imgA = this.$('#slideshow-img-a');
        const imgB = this.$('#slideshow-img-b');

        /* Determine which layer is currently "active" (visible) */
        const isAActive = imgA.classList.contains('is-active');
        const outgoing = isAActive ? imgA : imgB; /* currently visible */
        const incoming = isAActive ? imgB : imgA; /* will become visible */

        /* ── Prepare the incoming layer with the new image ── */
        incoming.src = imageUrl;
        incoming.alt = photo.Name || '';
        incoming.style.opacity = '0';
        incoming.classList.add('is-loading');

        /* Wait for the image to load before fading it in */
        await new Promise((resolve) => {
            const onLoad = () => {
                incoming.classList.remove('is-loading');
                resolve();
            };
            const onError = () => {
                /* Still resolve — we'll show a blank frame rather than hang */
                incoming.classList.remove('is-loading');
                resolve();
            };
            if (incoming.complete && incoming.naturalWidth > 0) {
                /* Image was already in the browser cache (preloaded!) */
                onLoad();
            } else {
                incoming.addEventListener('load', onLoad, { once: true });
                incoming.addEventListener('error', onError, { once: true });
            }
        });

        /* ── Crossfade ── */
        if (fade) {
            /* Promote layers for the duration of the animation only */
            incoming.style.willChange = 'opacity';
            outgoing.style.willChange = 'opacity';

            /* Trigger the CSS transition */
            incoming.style.opacity = '1';
            outgoing.style.opacity = '0';

            /* After the transition, clean up — demote compositor layer */
            setTimeout(() => {
                outgoing.style.willChange = '';
                incoming.style.willChange = '';
                this._transitioning = false;
            }, CROSSFADE_DURATION_MS);
        } else {
            /* No animation (first photo, or "skip" when preload missed) */
            incoming.style.opacity = '1';
            outgoing.style.opacity = '0';
            this._transitioning = false;
        }

        /* Swap active class markers */
        incoming.classList.add('is-active');
        outgoing.classList.remove('is-active');

        /* ── Update the counter ── */
        this._updateCounter();

        /* ── Update Video Indicator ── */
        const videoIndicator = this.$('#video-play-indicator');
        if (videoIndicator) {
            if (photo.Type === 'Video') {
                videoIndicator.classList.remove('hidden');
            } else {
                videoIndicator.classList.add('hidden');
            }
        }

        /* ── Update EXIF overlay content if it's open ── */
        if (this._exifVisible) {
            this._renderExifContent(photo);
        }

        /* ── Preload neighbours for the next navigation ── */
        this._preloadNeighbours(index);
    }

    /**
     * Preload the previous and next images into hidden <img> elements so the
     * browser can warm its decode/GPU cache for instant transitions.
     *
     * We reuse the same two scratch elements on every call to avoid DOM churn.
     *
     * @param {number} index - Current photo index.
     */
    _preloadNeighbours(index) {
        /* Lazily create scratch <img> elements (never in the DOM) */
        if (!this._preloadSlots.prev) this._preloadSlots.prev = new Image();
        if (!this._preloadSlots.next) this._preloadSlots.next = new Image();

        /* Previous photo */
        const prevPhoto = this._photos[index - 1];
        if (prevPhoto) {
            this._preloadSlots.prev.src = api.getImageUrl(prevPhoto.Id, 'Primary', { maxWidth: 1920, maxHeight: 1080, quality: 90 });
        } else {
            this._preloadSlots.prev.src = '';
        }

        /* Next photo */
        const nextPhoto = this._photos[index + 1];
        if (nextPhoto) {
            this._preloadSlots.next.src = api.getImageUrl(nextPhoto.Id, 'Primary', { maxWidth: 1920, maxHeight: 1080, quality: 90 });
        } else {
            this._preloadSlots.next.src = '';
        }
    }

    /**
     * Update the "N / Total" counter chip in the top-right corner.
     */
    _updateCounter() {
        const counter = this.$('#slideshow-counter');
        if (!counter) return;
        counter.textContent = `${this._currentIndex + 1} / ${this._photos.length}`;
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Navigation
    // ──────────────────────────────────────────────────────────────────────────

    /** Show the preceding photo (wraps to end). */
    _prev() {
        if (this._transitioning) return;
        const nextIdx = (this._currentIndex - 1 + this._photos.length) % this._photos.length;
        this._flashArrow('left');
        this._showPhoto(nextIdx);
    }

    /** Show the following photo (wraps to start). */
    _next() {
        if (this._transitioning) return;
        const nextIdx = (this._currentIndex + 1) % this._photos.length;
        this._flashArrow('right');
        this._showPhoto(nextIdx);
    }

    /**
     * Briefly show the directional arrow icon for visual feedback.
     * @param {'left'|'right'} direction
     */
    _flashArrow(direction) {
        const arrow = this.$(`#arrow-${direction}`);
        if (!arrow) return;

        arrow.classList.remove('hidden');
        clearTimeout(arrow._flashTimer);
        arrow._flashTimer = setTimeout(() => arrow.classList.add('hidden'), 600);
    }

    // ──────────────────────────────────────────────────────────────────────────
    // EXIF Overlay
    // ──────────────────────────────────────────────────────────────────────────

    /** Toggle the EXIF metadata panel. */
    _toggleExif() {
        this._exifVisible = !this._exifVisible;
        const overlay = this.$('#exif-overlay');
        if (!overlay) return;

        if (this._exifVisible) {
            /* Render content for the current photo before showing the panel */
            this._renderExifContent(this._photos[this._currentIndex]);
            overlay.classList.remove('hidden');
        } else {
            overlay.classList.add('hidden');
        }
    }

    /**
     * Populate the EXIF panel with metadata from the given photo item.
     * All fields are optional — we only emit rows that have data.
     *
     * @param {Object} photo - A Jellyfin BaseItemDto for a Photo item.
     */
    _renderExifContent(photo) {
        const container = this.$('#exif-content');
        if (!container || !photo) return;

        /**
         * Small helper to create a key/value row.
         * Returns an empty string if value is nullish.
         */
        const row = (label, value) => {
            if (value === null || value === undefined || value === '') return '';
            return `
                <div class="exif-row">
                    <span class="exif-label">${label}</span>
                    <span class="exif-value">${value}</span>
                </div>
            `;
        };

        /* Photo title */
        const titleHtml = photo.Name
            ? `<div class="exif-title">${this._esc(photo.Name)}</div>`
            : '';

        /* Date — prefer DateCreated, fall back to ProductionYear */
        let dateStr = '';
        if (photo.DateCreated) {
            try {
                dateStr = new Date(photo.DateCreated).toLocaleDateString(undefined, {
                    year: 'numeric', month: 'long', day: 'numeric'
                });
            } catch (_) {
                dateStr = photo.DateCreated;
            }
        } else if (photo.ProductionYear) {
            dateStr = String(photo.ProductionYear);
        }

        /* Camera make + model */
        const camera = [photo.CameraMake, photo.CameraModel]
            .filter(Boolean)
            .join(' ');

        /* Aperture: f/2.8 */
        const aperture = photo.Aperture ? `f/${photo.Aperture}` : null;

        /* Exposure time: 1/125 s (stored as a decimal, e.g. 0.008) */
        let exposure = null;
        if (photo.ExposureTime) {
            const et = photo.ExposureTime;
            if (et < 1) {
                /* Convert to fraction notation for readability */
                exposure = `1/${Math.round(1 / et)} s`;
            } else {
                exposure = `${et} s`;
            }
        }

        /* Focal length */
        const focal = photo.FocalLength ? `${photo.FocalLength} mm` : null;

        /* Resolution */
        const resolution = (photo.Width && photo.Height)
            ? `${photo.Width} × ${photo.Height}`
            : null;

        /* Altitude */
        const altitude = photo.Altitude != null ? `${Math.round(photo.Altitude)} m` : null;

        /* Build final HTML */
        container.innerHTML = `
            ${titleHtml}
            <div class="exif-grid">
                ${row(i18n.t('ExifDate')     || 'Date',         this._esc(dateStr))}
                ${row(i18n.t('ExifCamera')   || 'Camera',       this._esc(camera))}
                ${row(i18n.t('ExifAperture') || 'Aperture',     aperture)}
                ${row(i18n.t('ExifExposure') || 'Exposure',     exposure)}
                ${row(i18n.t('ExifFocalLength') || 'Focal Length', focal)}
                ${row(i18n.t('ExifResolution')  || 'Resolution',   resolution)}
                ${row(i18n.t('ExifAltitude')    || 'Altitude',     altitude)}
            </div>
        `;
    }

    /**
     * Minimal HTML escape to prevent XSS when injecting photo metadata strings.
     * @param {string} str
     * @returns {string}
     */
    _esc(str) {
        if (!str) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Auto-Advance
    // ──────────────────────────────────────────────────────────────────────────

    /** Start the auto-advance timer. Shows the playback badge. */
    _startAutoAdvance() {
        if (this._autoAdvancing) return;
        this._autoAdvancing = true;

        const badge = this.$('#autoplay-badge');
        if (badge) badge.classList.remove('hidden');

        this._autoTimer = setInterval(() => {
            /* Wrap around to the beginning when we reach the end */
            if (this._currentIndex >= this._photos.length - 1) {
                this._showPhoto(0);
            } else {
                this._next();
            }
        }, AUTO_ADVANCE_INTERVAL_MS);

        log.debug('Auto-advance started');
    }

    /** Stop the auto-advance timer and hide the badge. */
    _stopAutoAdvance() {
        if (!this._autoAdvancing) return;
        this._autoAdvancing = false;

        if (this._autoTimer !== null) {
            clearInterval(this._autoTimer);
            this._autoTimer = null;
        }

        const badge = this.$('#autoplay-badge');
        if (badge) badge.classList.add('hidden');

        log.debug('Auto-advance stopped');
    }

    /** Toggle auto-advance on/off. */
    _toggleAutoAdvance() {
        if (this._autoAdvancing) {
            this._stopAutoAdvance();
        } else {
            this._startAutoAdvance();
        }
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Keyboard Input
    // ──────────────────────────────────────────────────────────────────────────

    /**
     * Keyboard handler registered at the document capture phase.
     * We intercept at capture to prevent the D-pad events from reaching
     * focusManager or the sidebar.
     *
     * @param {KeyboardEvent} e
     */
    _onKeyDown(e) {
        switch (e.key) {
            /*
             * D-pad Left / Right navigation.
             * We consume the event so focusManager doesn't try to move
             * sidebar focus at the same time.
             */
            case 'ArrowLeft':
                e.preventDefault();
                e.stopPropagation();
                this._prev();
                break;

            case 'ArrowRight':
                e.preventDefault();
                e.stopPropagation();
                this._next();
                break;

            /*
             * OK / Enter — if Video, open player. If Photo, toggle EXIF.
             */
            case 'Enter':
                e.preventDefault();
                e.stopPropagation();
                if (this._photos[this._currentIndex]?.Type === 'Video') {
                    // Stop auto advance just in case
                    this._stopAutoAdvance();
                    eventBus.emit('player:play', { item: this._photos[this._currentIndex] });
                } else {
                    this._toggleExif();
                }
                break;

            /*
             * Play / Pause remote key and 'p' keyboard shortcut.
             * Toggles the auto-advance timer.
             */
            case 'MediaPlay':
            case 'MediaPlayPause':
            case 'p':
                e.preventDefault();
                e.stopPropagation();
                if (this._photos[this._currentIndex]?.Type === 'Video') {
                    this._stopAutoAdvance();
                    eventBus.emit('player:play', { item: this._photos[this._currentIndex] });
                } else {
                    this._toggleAutoAdvance();
                }
                break;

            /*
             * Back key is handled by App.js via key:back event bus → onBack().
             * We don't need to intercept it here.
             */
            default:
                break;
        }
    }

    /**
     * Custom back handler — stop auto advance and let the router go back.
     * @returns {boolean} false (tells App.js to also call router.back())
     */
    onBack() {
        this._stopAutoAdvance();
        return false; /* Delegate to router.back() */
    }
}

export default SlideshowPage;
