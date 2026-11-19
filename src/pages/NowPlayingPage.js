/**
 * ============================================================================
 * Litefin - Now Playing Page
 * ============================================================================
 */

import Page from './Page.js';
import '../styles/now-playing.css';
import { api } from '../api/ApiClient.js';
import { musicSession } from '../music/musicPlayback.js';
import { formatClock, progressRatio } from '../music/formatClock.js';
import { osdIcons } from '../utils/Icons.js';
import { escapeHtml } from '../utils/Utils.js';
import { i18n } from '../utils/i18n.js';
import { logger } from '../utils/Logger.js';

const log = logger.create('NowPlayingPage');

const COVER_SIZE = 640;
const CONTROLS_SECTION = 'now-playing-controls';

function coverUrl(item) {
    if (item.AlbumId && item.AlbumPrimaryImageTag) {
        return api.getImageUrl(item.AlbumId, 'Primary', { maxWidth: COVER_SIZE, tag: item.AlbumPrimaryImageTag });
    }
    return api.getImageUrl(item.Id, 'Primary', { maxWidth: COVER_SIZE, tag: item.ImageTags?.Primary });
}

function subtitleOf(item) {
    const artist = (item.Artists && item.Artists.length > 0 ? item.Artists.join(', ') : item.AlbumArtist) || '';
    return [artist, item.Album].filter(Boolean).join(' · ');
}

class NowPlayingPage extends Page {
    constructor() {
        super();
        this.title = i18n.t('music.nowPlaying');
    }

    render() {
        return `
            <div class="page now-playing-page">
                <div class="now-playing">
                    <div class="now-playing-cover">
                        <img class="now-playing-cover-img" alt="">
                    </div>
                    <div class="now-playing-info">
                        <p class="now-playing-label">${escapeHtml(i18n.t('music.nowPlaying'))}</p>
                        <h1 class="now-playing-title"></h1>
                        <p class="now-playing-subtitle"></p>
                        <p class="now-playing-ended">${escapeHtml(i18n.t('music.ended'))}</p>
                        <div class="now-playing-progress">
                            <span class="now-playing-elapsed">0:00</span>
                            <div class="now-playing-bar"><div class="now-playing-bar-fill"></div></div>
                            <span class="now-playing-total">0:00</span>
                        </div>
                        <div class="now-playing-controls" id="now-playing-controls">
                            <button class="osd-btn now-playing-btn now-playing-previous focusable" tabindex="0"
                                aria-label="${escapeHtml(i18n.t('music.previous'))}">${osdIcons.skipPrevious}</button>
                            <button class="osd-btn now-playing-btn now-playing-play focusable" tabindex="0"
                                aria-label="${escapeHtml(i18n.t('music.pause'))}">${osdIcons.pause}</button>
                            <button class="osd-btn now-playing-btn now-playing-next focusable" tabindex="0"
                                aria-label="${escapeHtml(i18n.t('music.next'))}">${osdIcons.skipNext}</button>
                        </div>
                    </div>
                </div>
            </div>
        `;
    }

    onMounted() {
        this._bindControls();
        this._setupFocus();

        this.on('music:track', ({ item }) => this._showTrack(item));
        this.on('music:state', ({ isPlaying }) => this._showPlayState(isPlaying));
        this.on('music:time', ({ positionMs, durationMs }) => this._showTime(positionMs, durationMs));
        this.on('music:stopped', ({ reason }) => this._showStopped(reason));

        const item = musicSession.currentItem;
        if (item && musicSession.isActive) {
            this._showTrack(item);
            this._showPlayState(musicSession.isPlaying);
            this._showTime(musicSession.positionMs, musicSession.durationMs);
        } else {
            this._showStopped('ended');
        }
        this.markReady();
    }

    _bindControls() {
        const run = (promise) => Promise.resolve(promise).catch((err) => log.warn('Music control failed', err));
        this.$('.now-playing-previous').addEventListener('click', () => run(musicSession.previous()));
        this.$('.now-playing-play').addEventListener('click', () => musicSession.togglePlayPause());
        this.$('.now-playing-next').addEventListener('click', () => run(musicSession.next()));
        this.$('.now-playing-cover-img').addEventListener('error', (event) => {
            event.target.classList.add('is-missing');
        });
    }

    _setupFocus() {
        this.registerFocusSection(CONTROLS_SECTION, this.$('#now-playing-controls'), {
            orientation: 'horizontal',
            defaultFocusSelector: '.now-playing-play'
        });
        this.setActiveSection(CONTROLS_SECTION);
    }

    _showTrack(item) {
        this.el.classList.remove('is-ended');
        const img = this.$('.now-playing-cover-img');
        img.classList.remove('is-missing');
        img.src = coverUrl(item);
        this.$('.now-playing-title').textContent = item.Name || '';
        this.$('.now-playing-subtitle').textContent = subtitleOf(item);
        this._showTime(0, (item.RunTimeTicks || 0) / 10000);
    }

    _showPlayState(isPlaying) {
        const button = this.$('.now-playing-play');
        button.innerHTML = isPlaying ? osdIcons.pause : osdIcons.play;
        button.setAttribute('aria-label', i18n.t(isPlaying ? 'music.pause' : 'music.play'));
    }

    _showTime(positionMs, durationMs) {
        this.$('.now-playing-elapsed').textContent = formatClock(positionMs);
        this.$('.now-playing-total').textContent = formatClock(durationMs);
        this.$('.now-playing-bar-fill').style.transform = `scaleX(${progressRatio(positionMs, durationMs)})`;
    }

    _showStopped(reason) {
        log.info(`Music stopped (${reason})`);
        this.el.classList.add('is-ended');
        this._showPlayState(false);
    }
}

export default NowPlayingPage;
