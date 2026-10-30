/**
 * ============================================================================
 * Litefin - Music Mini-Player
 * ============================================================================
 */

import Component from '../core/Component.js';
import { api } from '../api/ApiClient.js';
import { eventBus } from '../core/EventBus.js';
import { router } from '../core/Router.js';
import { focusManager } from '../ui/FocusManager.js';
import { i18n } from '../utils/i18n.js';
import { logger } from '../utils/Logger.js';
import { progressRatio } from './formatClock.js';
import { miniPlayerVisible } from './miniPlayerVisibility.js';
import { musicSession } from './musicPlayback.js';

const log = logger.create('MiniPlayer');

const SECTION = 'mini-player';
const NOW_PLAYING_PATH = '/now-playing';
const COVER_SIZE = 96;

function coverUrl(item) {
    if (item.AlbumId && item.AlbumPrimaryImageTag) {
        return api.getImageUrl(item.AlbumId, 'Primary', { maxWidth: COVER_SIZE, tag: item.AlbumPrimaryImageTag });
    }
    return api.getImageUrl(item.Id, 'Primary', { maxWidth: COVER_SIZE, tag: item.ImageTags?.Primary });
}

function artistOf(item) {
    return (item.Artists && item.Artists.length > 0 ? item.Artists.join(', ') : item.AlbumArtist) || '';
}

export default class MiniPlayer extends Component {
    constructor() {
        super();
        this._registered = false;
    }

    render() {
        return `
            <button class="mini-player focusable" tabindex="0" hidden
                aria-label="${i18n.t('music.nowPlaying')}">
                <img class="mini-player-cover" alt="">
                <span class="mini-player-text">
                    <span class="mini-player-title"></span>
                    <span class="mini-player-artist"></span>
                </span>
                <span class="mini-player-bar"><span class="mini-player-bar-fill"></span></span>
            </button>
        `;
    }

    onMounted() {
        this._cover = this.el.querySelector('.mini-player-cover');
        this._title = this.el.querySelector('.mini-player-title');
        this._artist = this.el.querySelector('.mini-player-artist');
        this._fill = this.el.querySelector('.mini-player-bar-fill');

        this.el.addEventListener('click', () => router.navigate(NOW_PLAYING_PATH));

        this._subscriptions.push(
            eventBus.on('music:track', ({ item }) => {
                this._showTrack(item);
                this._syncVisibility();
            }),
            eventBus.on('music:time', ({ positionMs, durationMs }) => this._showProgress(positionMs, durationMs)),
            eventBus.on('music:stopped', () => this._syncVisibility()),
            eventBus.on('router:navigate', ({ path }) => this._syncVisibility(path))
        );

        this._syncVisibility();
    }

    onBeforeDestroy() {
        this._setVisible(false);
    }

    _showTrack(item) {
        this._title.textContent = item.Name || '';
        this._artist.textContent = artistOf(item);
        this._cover.src = coverUrl(item);
        this._showProgress(0, 0);
    }

    _showProgress(positionMs, durationMs) {
        this._fill.style.transform = `scaleX(${progressRatio(positionMs, durationMs)})`;
    }

    _syncVisibility(path = router.getCurrentPath()) {
        const visible = miniPlayerVisible({ active: musicSession.isActive, path });
        if (visible && musicSession.currentItem && !this._title.textContent) {
            this._showTrack(musicSession.currentItem);
        }
        this._setVisible(visible);
    }

    _setVisible(visible) {
        this.el.hidden = !visible;
        if (visible) document.documentElement.setAttribute('data-mini-player', 'true');
        else document.documentElement.removeAttribute('data-mini-player');

        if (visible && !this._registered) {
            focusManager.register(SECTION, this.el, { orientation: 'horizontal', leaveUp: () => this._returnUp() });
            this._registered = true;
        } else if (!visible && this._registered) {
            focusManager.unregister(SECTION);
            this._registered = false;
        }
        log.debug(`visible=${visible}`);
    }

    _returnUp() {
        const previous = focusManager.getPreviousSection();
        return previous && previous !== SECTION ? previous : null;
    }
}
