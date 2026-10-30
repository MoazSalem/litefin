/**
 * ============================================================================
 * Litefin - Now Playing Page
 * ============================================================================
 */

import Page from './Page.js';
import '../styles/now-playing.css';
import { api } from '../api/ApiClient.js';
import { playQueue } from '../core/PlayQueue.js';
import { musicSession } from '../music/musicPlayback.js';
import { formatClock, progressRatio } from '../music/formatClock.js';
import { activeLineIndex } from '../music/lyricsSync.js';
import { createLyricsStore } from '../music/lyricsStore.js';
import { paletteForItem } from '../music/coverPalette.js';
import { ambientEnabled } from '../music/ambient.js';
import {
    LAYOUT,
    chooseLayout,
    changedLineStates,
    lyricsScrollOffset,
    nextRepeatMode,
    washBackground
} from '../music/nowPlayingView.js';
import QueueModalHost from '../music/queueModalHost.js';
import { playFromQueueCursor } from '../music/queueJump.js';
import { focusManager } from '../ui/FocusManager.js';
import { osdIcons, detailsIcons } from '../utils/Icons.js';
import { escapeHtml } from '../utils/Utils.js';
import { storage } from '../utils/StorageService.js';
import { i18n } from '../utils/i18n.js';
import { logger } from '../utils/Logger.js';

const log = logger.create('NowPlayingPage');

const COVER_SIZE = 640;
const PALETTE_SAMPLE_SIZE = 64;
const LYRICS_SCROLL_STEP = 160;
const FIRST_LYRICS_WAIT_MS = 700;
const CONTROLS_SECTION = 'now-playing-controls';
const LYRICS_SECTION = 'now-playing-lyrics';
const SHOW_LYRICS_KEY = 'music:showLyrics';
const LAYOUT_CLASSES = Object.values(LAYOUT).map((layout) => `np-layout-${layout}`);

const lyricsStore = createLyricsStore({ fetchLyrics: (itemId) => api.getLyrics(itemId), log });

function coverSource(item) {
    if (item.AlbumId && item.AlbumPrimaryImageTag) return { id: item.AlbumId, tag: item.AlbumPrimaryImageTag };
    return { id: item.Id, tag: item.ImageTags?.Primary };
}

function coverUrl(item, maxWidth = COVER_SIZE) {
    const { id, tag } = coverSource(item);
    return api.getImageUrl(id, 'Primary', { maxWidth, tag });
}

function subtitleOf(item) {
    const artist = (item.Artists && item.Artists.length > 0 ? item.Artists.join(', ') : item.AlbumArtist) || '';
    return [artist, item.Album].filter(Boolean).join(' · ');
}

function upNextItem() {
    return playQueue.getRepeatMode() === 'RepeatOne' ? null : playQueue.peekNext();
}

function loadPalette(item) {
    return paletteForItem(coverSource(item).id, coverUrl(item, PALETTE_SAMPLE_SIZE));
}

function lineHtml(line) {
    const text = line.text.trim();
    return `<li class="np-line${text ? '' : ' is-gap'}">${text ? escapeHtml(text) : '♪'}</li>`;
}

function iconButton(className, labelKey, icon) {
    return `<button class="osd-btn np-btn ${className} focusable" tabindex="0"
        aria-label="${escapeHtml(i18n.t(labelKey))}">${icon}</button>`;
}

class NowPlayingPage extends Page {
    constructor() {
        super();
        this.title = i18n.t('music.nowPlaying');
        this._item = null;
        this._lyrics = null;
        this._layout = LAYOUT.AMBIENT;
        this._lyricsOn = storage.getItem(SHOW_LYRICS_KEY) !== 'false';
        this._lineEls = [];
        this._lineTops = null;
        this._lyricsViewportHeight = 0;
        this._activeLine = -1;
        this._washCoverId = null;
        this._shownSecond = -1;
        this._shownTotal = -1;
        this._warmCover = null;
        this._resetFrame = null;
        this._pendingTimer = null;
        this._isFirstTrack = true;
        this._queueHost = null;
    }

    render() {
        return `
            <div class="page now-playing-page np-layout-ambient">
                <div class="np-backdrop" aria-hidden="true"><div class="np-wash"></div></div>
                <div class="np-shade" aria-hidden="true"></div>
                <div class="np-body">
                    <div class="np-art">
                        <div class="np-cover"><img class="np-cover-img" alt=""></div>
                        <div class="np-meta">
                            <h1 class="np-title"></h1>
                            <p class="np-subtitle"></p>
                            <p class="np-up-next">${escapeHtml(i18n.t('music.upNext'))} · <b class="np-up-next-title"></b></p>
                            <p class="np-ended">${escapeHtml(i18n.t('music.ended'))}</p>
                        </div>
                    </div>
                    <div class="np-lyrics" id="now-playing-lyrics">
                        <div class="np-lyrics-scroller" tabindex="-1" aria-label="${escapeHtml(i18n.t('music.lyrics'))}">
                            <ol class="np-lyrics-list"></ol>
                        </div>
                    </div>
                </div>
                <div class="np-transport">
                    <div class="np-scrub">
                        <span class="np-elapsed">0:00</span>
                        <div class="np-bar"><div class="np-bar-fill"></div></div>
                        <span class="np-total">0:00</span>
                    </div>
                    <div class="np-controls" id="now-playing-controls">
                        <div class="np-side np-side-left">
                            ${iconButton('np-shuffle', 'music.shuffle', detailsIcons.shuffle)}
                            ${iconButton('np-repeat', 'music.repeat', osdIcons.repeat)}
                        </div>
                        <div class="np-center">
                            ${iconButton('np-previous', 'music.previous', osdIcons.skipPrevious)}
                            ${iconButton('np-play', 'music.pause', osdIcons.pause)}
                            ${iconButton('np-next', 'music.next', osdIcons.skipNext)}
                        </div>
                        <div class="np-side np-side-right">
                            ${iconButton('np-lyrics-toggle', 'music.lyrics', osdIcons.lyrics)}
                            ${iconButton('np-queue', 'music.queue', osdIcons.queue)}
                        </div>
                    </div>
                </div>
                <div class="osd-overlays np-overlays"></div>
            </div>
        `;
    }

    onMounted() {
        this.el.classList.toggle('np-static', !ambientEnabled());
        this._lyricsList = this.$('.np-lyrics-list');
        this._lyricsScroller = this.$('.np-lyrics-scroller');
        this._barFill = this.$('.np-bar-fill');
        this._elapsed = this.$('.np-elapsed');
        this._total = this.$('.np-total');

        this._bindControls();
        this._setupFocus();
        this._queueHost = new QueueModalHost({
            root: this.el,
            api,
            onJump: () => this._jumpToQueueCursor(),
            onClose: (focusPlay) => this._focusButton(focusPlay ? '.np-play' : '.np-queue')
        });

        this.on('music:track', ({ item }) => this._showTrack(item));
        this.on('music:state', ({ isPlaying }) => this._showPlayState(isPlaying));
        this.on('music:time', ({ positionMs, durationMs }) => this._showTime(positionMs, durationMs));
        this.on('music:stopped', ({ reason }) => this._showStopped(reason));
        this.on('playqueue:updated', () => this._showQueueState());

        const item = musicSession.currentItem;
        if (item && musicSession.isActive) {
            this._showTrack(item);
            this._showPlayState(musicSession.isPlaying);
            this._showTime(musicSession.positionMs, musicSession.durationMs);
        } else {
            this._showStopped('ended');
        }
        this._showQueueState();
        this._remeasureWhenFontsLoad();
        this.markReady();
    }

    onBack() {
        if (!this._queueHost || !this._queueHost.isOpen) return false;
        this._queueHost.back();
        return true;
    }

    destroy() {
        clearTimeout(this._pendingTimer);
        if (this._resetFrame) cancelAnimationFrame(this._resetFrame);
        if (this._queueHost) this._queueHost.destroy();
        this._queueHost = null;
        super.destroy();
    }

    // ========================================================================
    // Controls & focus
    // ========================================================================

    _bindControls() {
        const run = (promise) => Promise.resolve(promise).catch((err) => log.warn('Music control failed', err));
        const bind = (selector, handler) => this.$(selector).addEventListener('click', handler);
        bind('.np-previous', () => run(musicSession.previous()));
        bind('.np-play', () => musicSession.togglePlayPause());
        bind('.np-next', () => run(musicSession.next()));
        bind('.np-shuffle', () => this._toggleShuffle());
        bind('.np-repeat', () => this._cycleRepeat());
        bind('.np-lyrics-toggle', () => this._toggleLyrics());
        bind('.np-queue', () => this._queueHost.open());
        this.$('.np-cover-img').addEventListener('error', (event) => event.target.classList.add('is-missing'));
    }

    _setupFocus() {
        this.registerFocusSection(CONTROLS_SECTION, this.$('#now-playing-controls'), {
            orientation: 'horizontal',
            defaultFocusSelector: '.np-play',
            leaveUp: () => (this._layout === LAYOUT.STATIC_LYRICS ? LYRICS_SECTION : null),
            leaveDown: () => null
        });
        this.registerFocusSection(LYRICS_SECTION, this.$('#now-playing-lyrics'), {
            orientation: 'vertical',
            leaveDown: CONTROLS_SECTION,
            onMove: (direction) => this._scrollStaticLyrics(direction)
        });
        this.setActiveSection(CONTROLS_SECTION);
    }

    _focusButton(selector) {
        const button = this.$(selector);
        if (!button) return;
        this.setActiveSection(CONTROLS_SECTION, false);
        focusManager.focusElement(button);
    }

    _scrollStaticLyrics(direction) {
        const scroller = this._lyricsScroller;
        if (direction === 'down' && scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 1) {
            return false;
        }
        if (direction === 'up' || direction === 'down') {
            scroller.scrollTop += direction === 'up' ? -LYRICS_SCROLL_STEP : LYRICS_SCROLL_STEP;
        }
        return true;
    }

    _toggleShuffle() {
        playQueue.setShuffleMode(!playQueue.getShuffleMode());
        this._afterQueueOrderChange();
    }

    _cycleRepeat() {
        playQueue.setRepeatMode(nextRepeatMode(playQueue.getRepeatMode()));
        this._afterQueueOrderChange();
    }

    _afterQueueOrderChange() {
        musicSession.refreshUpNext();
        this._showQueueState();
        this._prefetchNext();
    }

    _toggleLyrics() {
        if (!this._lyrics) return;
        this._lyricsOn = !this._lyricsOn;
        storage.setItem(SHOW_LYRICS_KEY, this._lyricsOn ? 'true' : 'false');
        this._applyLayout();
    }

    _jumpToQueueCursor() {
        lyricsStore.load(playQueue.getCurrentItem());
        Promise.resolve(playFromQueueCursor(playQueue, musicSession)).catch((err) =>
            log.warn('Queue jump failed', err)
        );
    }

    // ========================================================================
    // Track display
    // ========================================================================

    _showTrack(item) {
        this._item = item;
        this.el.classList.remove('is-ended');
        const img = this.$('.np-cover-img');
        img.classList.remove('is-missing');
        img.src = coverUrl(item);
        this.$('.np-title').textContent = item.Name || '';
        this.$('.np-subtitle').textContent = subtitleOf(item);
        this._showTime(0, (item.RunTimeTicks || 0) / 10000);
        this._showWash(item);
        this._showLyricsFor(item);
        this._showQueueState();
        this._prefetchNext();
    }

    _showWash(item) {
        const coverId = coverSource(item).id;
        if (coverId === this._washCoverId) return;
        loadPalette(item).then((palette) => {
            if (!this._item || coverSource(this._item).id !== coverId || !this.el) return;
            this._washCoverId = coverId;
            this.$('.np-wash').style.backgroundImage = washBackground(palette);
        });
    }

    _showLyricsFor(item) {
        clearTimeout(this._pendingTimer);
        const cached = lyricsStore.peek(item.Id);
        if (cached) {
            this._isFirstTrack = false;
            this.el.classList.remove('is-pending');
            this._applyLyrics(cached.lyrics);
            return;
        }
        this._applyLyrics(null);
        if (this._isFirstTrack) {
            this.el.classList.add('is-pending');
            this._pendingTimer = setTimeout(
                () => this.el && this.el.classList.remove('is-pending'),
                FIRST_LYRICS_WAIT_MS
            );
        }
        this._isFirstTrack = false;
        lyricsStore.load(item).then((lyrics) => {
            if (!this.el || !this._item || this._item.Id !== item.Id) return;
            clearTimeout(this._pendingTimer);
            this.el.classList.remove('is-pending');
            this._applyLyrics(lyrics);
        });
    }

    _prefetchNext() {
        const next = upNextItem();
        if (!next) return;
        lyricsStore.load(next);
        loadPalette(next);
        this._warmCover = new Image();
        this._warmCover.src = coverUrl(next);
    }

    _showQueueState() {
        if (!this.el) return;
        const next = this._item ? upNextItem() : null;
        this.$('.np-up-next-title').textContent = next ? next.Name || '' : '';
        this.el.classList.toggle('has-up-next', Boolean(next));
        const repeat = playQueue.getRepeatMode();
        this.$('.np-shuffle').classList.toggle('is-on', Boolean(playQueue.getShuffleMode()));
        const repeatButton = this.$('.np-repeat');
        repeatButton.classList.toggle('is-on', repeat === 'RepeatAll' || repeat === 'RepeatOne');
        repeatButton.classList.toggle('is-one', repeat === 'RepeatOne');
    }

    _showPlayState(isPlaying) {
        const button = this.$('.np-play');
        button.innerHTML = isPlaying ? osdIcons.pause : osdIcons.play;
        button.setAttribute('aria-label', i18n.t(isPlaying ? 'music.pause' : 'music.play'));
        this.el.classList.toggle('is-paused', !isPlaying);
    }

    _showTime(positionMs, durationMs) {
        const second = Math.floor(positionMs / 1000);
        if (second !== this._shownSecond) {
            this._shownSecond = second;
            this._elapsed.textContent = formatClock(positionMs);
        }
        const total = Math.floor(durationMs / 1000);
        if (total !== this._shownTotal) {
            this._shownTotal = total;
            this._total.textContent = formatClock(durationMs);
        }
        this._barFill.style.transform = `scaleX(${progressRatio(positionMs, durationMs)})`;
        this._syncLyrics(positionMs);
    }

    _showStopped(reason) {
        log.info(`Music stopped (${reason})`);
        this.el.classList.add('is-ended');
        this.el.classList.remove('has-up-next');
        this._showPlayState(false);
    }

    // ========================================================================
    // Lyrics
    // ========================================================================

    _applyLyrics(lyrics) {
        this._lyrics = lyrics;
        this._lyricsList.innerHTML = lyrics ? lyrics.lines.map(lineHtml).join('') : '';
        this._lineEls = Array.prototype.slice.call(this._lyricsList.children);
        this._activeLine = -1;
        this._lineTops = null;
        this._lyricsScroller.scrollTop = 0;
        this._jumpListTo(0);
        this._applyLayout();
    }

    _applyLayout() {
        this._layout = chooseLayout(this._lyrics, this._lyricsOn);
        LAYOUT_CLASSES.forEach((name) => this.el.classList.remove(name));
        this.el.classList.add(`np-layout-${this._layout}`);
        const scrollable = this._layout === LAYOUT.STATIC_LYRICS;
        this._lyricsScroller.setAttribute('tabindex', scrollable ? '0' : '-1');
        focusManager.invalidateCache(LYRICS_SECTION);
        if (!scrollable && document.activeElement === this._lyricsScroller) this._focusButton('.np-play');

        const toggle = this.$('.np-lyrics-toggle');
        toggle.classList.toggle('is-on', this._layout !== LAYOUT.AMBIENT);
        toggle.classList.toggle('is-unavailable', !this._lyrics);
        toggle.setAttribute('aria-disabled', this._lyrics ? 'false' : 'true');

        this._lineTops = null;
        if (this._layout === LAYOUT.LYRICS) {
            const previous = this._activeLine;
            this._activeLine = -1;
            this._resetLineClasses(previous);
            this._syncLyrics(musicSession.positionMs);
        }
    }

    _resetLineClasses(previousActive) {
        changedLineStates(previousActive, -1).forEach(({ index }) => this._setLineState(index, 'next'));
    }

    _setLineState(index, state) {
        const line = this._lineEls[index];
        if (!line) return;
        line.classList.toggle('is-now', state === 'now');
        line.classList.toggle('is-past', state === 'past');
    }

    _syncLyrics(positionMs) {
        if (this._layout !== LAYOUT.LYRICS || !this._lyrics) return;
        const active = activeLineIndex(this._lyrics.lines, positionMs);
        if (active === this._activeLine) return;
        if (!this._lineTops) this._measureLines();
        changedLineStates(this._activeLine, active).forEach(({ index, state }) => this._setLineState(index, state));
        this._activeLine = active;
        this._scrollToActiveLine();
    }

    _scrollToActiveLine() {
        const active = this._activeLine;
        const offset = active < 0 ? 0 : lyricsScrollOffset(this._lineTops[active], this._lyricsViewportHeight);
        this._lyricsList.style.transform = `translate3d(0, ${-offset}px, 0)`;
    }

    /* Line tops measured with the fallback font are off once the web font swaps in. */
    _remeasureWhenFontsLoad() {
        if (!document.fonts || !document.fonts.ready) return;
        document.fonts.ready.then(() => {
            if (!this.el) return;
            this._lineTops = null;
            if (this._layout !== LAYOUT.LYRICS || this._activeLine < 0) return;
            this._measureLines();
            this._scrollToActiveLine();
        });
    }

    _measureLines() {
        this._lyricsViewportHeight = this._lyricsScroller.clientHeight;
        this._lineTops = this._lineEls.map((line) => line.offsetTop);
    }

    /* Snap without the 700 ms slide: the new list must not glide in from the previous song's offset. */
    _jumpListTo(offset) {
        const list = this._lyricsList;
        list.classList.add('is-jumping');
        list.style.transform = `translate3d(0, ${-offset}px, 0)`;
        if (this._resetFrame) cancelAnimationFrame(this._resetFrame);
        this._resetFrame = requestAnimationFrame(() => {
            this._resetFrame = requestAnimationFrame(() => {
                this._resetFrame = null;
                list.classList.remove('is-jumping');
            });
        });
    }
}

export default NowPlayingPage;
