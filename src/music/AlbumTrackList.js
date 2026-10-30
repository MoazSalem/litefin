/**
 * ============================================================================
 * Litefin Tizen - Album Track List
 * ============================================================================
 */

import Component from '../core/Component.js';
import { state } from '../core/StateManager.js';
import { i18n } from '../utils/i18n.js';
import { formatDuration, groupByDisc, trackNumber, trackArtistLine } from './albumFormat.js';

const PLAYING_CLASS = 'playing';

const escapeHtml = (text) =>
    String(text).replace(
        /[&<>"']/g,
        (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
    );

export default class AlbumTrackList extends Component {
    constructor(options = {}) {
        super(options);
        this._currentId = null;
        this._indexById = new Map();
    }

    render() {
        const { album, tracks } = this.props;
        this._indexById = new Map(tracks.map((track, index) => [track.Id, index]));
        const groups = groupByDisc(tracks);
        this._currentId = state.get('music:currentItemId') || null;
        const playingId = this._currentId;

        const rows = groups
            .map((group) => {
                const header = group.disc === null ? '' : this._renderDiscHeader(group.disc);
                const body = group.tracks.map((track, position) => this._renderRow(track, position, album, playingId));
                return header + body.join('');
            })
            .join('');

        return `<div class="album-tracks" role="list">${rows}</div>`;
    }

    _renderDiscHeader(disc) {
        return `<div class="album-disc">${escapeHtml(i18n.t('music.disc', [disc]))}</div>`;
    }

    _renderRow(track, position, album, playingId) {
        const isPlaying = track.Id === playingId;
        const number = isPlaying
            ? '<span class="album-eq"><i></i><i></i><i></i></span>'
            : String(trackNumber(track, position));
        const artistLine = trackArtistLine(track, album);
        const artist = artistLine ? `<small>${escapeHtml(artistLine)}</small>` : '';
        return `
            <div class="album-track ${isPlaying ? PLAYING_CLASS : ''}" tabindex="0" role="listitem" data-item-id="${escapeHtml(track.Id)}">
                <span class="album-track-n">${number}</span>
                <span class="album-track-t">${escapeHtml(track.Name || '')}${artist}</span>
                <span class="album-track-d">${formatDuration(track.RunTimeTicks)}</span>
            </div>`;
    }

    onMounted() {
        const container = this.container;
        if (!container) return;

        this._onClick = (e) => {
            const row = e.target.closest('.album-track');
            if (!row || !container.contains(row)) return;
            const index = this._indexById.get(row.dataset.itemId);
            if (index !== undefined) this.props.onPlay(index);
        };
        container.addEventListener('click', this._onClick);

        this.on('music:track', ({ item } = {}) => this._setCurrent(item?.Id ?? null));
        this.on('music:stopped', () => this._setCurrent(null));
    }

    _setCurrent(id) {
        if (id === this._currentId) return;
        this._currentId = id;
        this._applyPlaying();
    }

    _applyPlaying() {
        const container = this.container;
        if (!container) return;
        for (const row of container.querySelectorAll('.album-track')) {
            const isPlaying = row.dataset.itemId === this._currentId;
            const wasPlaying = row.classList.contains(PLAYING_CLASS);
            if (isPlaying === wasPlaying) continue;
            row.classList.toggle(PLAYING_CLASS, isPlaying);
            const numberEl = row.firstElementChild;
            if (isPlaying) {
                numberEl.innerHTML = '<span class="album-eq"><i></i><i></i><i></i></span>';
            } else {
                const index = this._indexById.get(row.dataset.itemId);
                const track = this.props.tracks[index];
                numberEl.textContent = String(trackNumber(track, this._positionInGroup(row)));
            }
        }
    }

    _positionInGroup(row) {
        let position = 0;
        for (let prev = row.previousElementSibling; prev && !prev.classList.contains('album-disc'); ) {
            position += 1;
            prev = prev.previousElementSibling;
        }
        return position;
    }

    destroy() {
        this.container?.removeEventListener('click', this._onClick);
        this.container = null;
        super.destroy();
    }
}
