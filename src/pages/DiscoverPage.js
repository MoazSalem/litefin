/**
 * ============================================================================
 * Litefin Tizen - Discover Page (Jellyseerr)
 * ============================================================================
 * Discovery rows and search against a Jellyseerr instance. Items are normalized
 * to the Jellyfin shape upstream (seerrNormalize), so MediaGrid and CardRenderer
 * are reused as-is.
 * ============================================================================
 */

import Page from './Page.js';
import MediaGrid from '../components/MediaGrid.js';
import CardRenderer from '../utils/CardRenderer.js';
import { seerr } from '../api/JellyseerrClient.js';
import { focusManager } from '../ui/FocusManager.js';
import { router } from '../core/Router.js';
import { logger } from '../utils/Logger.js';
import { i18n } from '../utils/i18n.js';

const log = logger.create('DiscoverPage');

/** Matches SearchPage. */
const SEARCH_DEBOUNCE = 500;

class DiscoverPage extends Page {
    constructor() {
        super();
        this._isAsyncPage = true;
        this._query = '';
        this._lastSearchedQuery = '';
        this._debounceTimer = null;
        this._grids = {};
    }

    render() {
        return `
            <div class="page discover-page">
                <main class="page-content discover-content">
                    <div class="discover-controls" id="discover-header">
                        <div class="search-input-wrapper">
                            <input
                                type="text"
                                id="discover-input"
                                class="search-input text-input tv-input"
                                data-i18n="SearchPlaceholder"
                                placeholder="Search..."
                                autocomplete="off"
                                tabindex="0"
                            >
                        </div>
                    </div>

                    <div class="discover-rows" id="discover-rows"></div>

                    <div class="discover-message hidden" id="discover-message"></div>

                    <div class="page-loading hidden">
                        <div class="loading-spinner"></div>
                    </div>
                </main>
            </div>
        `;
    }

    async onInit() {
        this.title = i18n.t('SeerrDiscover');
        this._input = this.$('#discover-input');

        i18n.translateDOM(this.el);
        this._bindEvents();

        this.registerFocusSection('discover-header', this.$('#discover-header'), {
            orientation: 'horizontal',
            leaveLeft: 'sidebar'
        });
        this.setActiveSection('discover-header');

        const status = await seerr.status(true);
        if (!status.available) {
            this._showMessage(i18n.t('SeerrNotConfigured'), true);
            this.markReady();
            this.restoreScrollFocusWhenReady();
            return;
        }

        await this._loadRows();
        this.markReady();
        this.restoreScrollFocusWhenReady();
    }

    // ========================================================================
    // Loading
    // ========================================================================

    async _loadRows() {
        this.setLoading(true);
        this._hideMessage();

        // A failing row must not blank the page, so each promise is isolated
        const settle = (promise) =>
            promise.catch((err) => {
                log.warn('Discover row failed', err);
                return null;
            });

        const [trending, movies, series] = await Promise.all([
            settle(seerr.discoverTrending()),
            settle(seerr.discoverMovies()),
            settle(seerr.discoverTv())
        ]);

        this.setLoading(false);

        // Covers both all-rejected (null) rows and all-succeeded-but-empty rows —
        // an empty array is truthy, so null-checks alone miss the latter.
        const totalItems = (trending?.length || 0) + (movies?.length || 0) + (series?.length || 0);
        if (totalItems === 0) {
            this._showMessage(i18n.t('SeerrLoadFailed'), false);
            return;
        }

        this._renderRows([
            { key: 'trending', title: i18n.t('SeerrTrending'), items: trending },
            { key: 'movies', title: i18n.t('SeerrPopularMovies'), items: movies },
            { key: 'series', title: i18n.t('SeerrPopularSeries'), items: series }
        ]);
    }

    async _search() {
        if (!this._query) return;
        if (this._query === this._lastSearchedQuery) return;
        this._lastSearchedQuery = this._query;

        this.setLoading(true);
        this._hideMessage();

        try {
            const results = await seerr.search(this._query);
            this.setLoading(false);
            if (results.length === 0) {
                this._destroyGrids();
                this.$('#discover-rows').innerHTML = '';
                this._showMessage(i18n.t('SearchResultsEmpty', [this._query]), false);
                return;
            }
            this._renderRows([{ key: 'results', title: i18n.t('SearchResults'), items: results }]);
        } catch (err) {
            this.setLoading(false);
            log.warn('Discover search failed', err);
            this._showMessage(
                err.message === 'SeerrUnauthorized' ? i18n.t('SeerrSessionExpired') : i18n.t('SeerrLoadFailed'),
                false
            );
        }
    }

    // ========================================================================
    // Rendering
    // ========================================================================

    /**
     * @param {Array<{key: string, title: string, items: Array|null}>} rows
     * @private
     */
    _renderRows(rows) {
        const container = this.$('#discover-rows');
        this._destroyGrids();
        container.innerHTML = '';
        this._grids = {};

        // CardRenderer keeps a static HTML cache keyed by item.Id, cleared only
        // when render options change. Ours do not change between discovery rows
        // and search results, so without this a card whose status just changed
        // would re-render with its stale badge. Same precaution as LibraryPage.
        CardRenderer.clearCache();

        rows.forEach((row) => {
            if (!row.items || row.items.length === 0) return;
            const grid = new MediaGrid({
                id: `discover-${row.key}`,
                title: row.title,
                items: row.items,
                type: 'poster',
                contextType: 'discover',
                limit: 20,
                allowSeeMore: false,
                onClick: (card) => this._onCardActivated(card)
            });
            grid.mount(container);
            this._grids[row.key] = { grid, items: row.items };
        });

        this._registerRowFocus();
    }

    _registerRowFocus() {
        const keys = Object.keys(this._grids);
        if (keys.length === 0) return;

        this.registerFocusSection('discover-header', this.$('#discover-header'), {
            orientation: 'horizontal',
            leaveDown: `discover-${keys[0]}-items`,
            leaveLeft: 'sidebar'
        });

        keys.forEach((key, index) => {
            const sectionId = `discover-${key}-items`;
            const prev = index > 0 ? `discover-${keys[index - 1]}-items` : 'discover-header';
            const next = index < keys.length - 1 ? `discover-${keys[index + 1]}-items` : null;

            this.registerFocusSection(sectionId, this.$(`#${sectionId}`), {
                orientation: 'grid',
                leaveUp: prev,
                leaveDown: next,
                leaveLeft: 'sidebar'
            });
        });
    }

    /**
     * Resolves the normalized item behind a card and opens its details page.
     * @param {HTMLElement} card
     * @private
     */
    _onCardActivated(card) {
        const itemId = card.dataset.itemId;
        if (!itemId) return;

        let found = null;
        Object.keys(this._grids).forEach((key) => {
            if (found) return;
            found = this._grids[key].items.find((i) => i.Id === itemId) || null;
        });
        if (!found) return;

        router.navigate(`/seerr/${found._mediaType}/${found._tmdbId}`);
    }

    // ========================================================================
    // States and input
    // ========================================================================

    _showMessage(text, withSettingsButton) {
        const el = this.$('#discover-message');
        if (!el) return;
        el.innerHTML = `
            <p>${text}</p>
            ${
                withSettingsButton
                    ? `<div class="discover-message-actions">
                           <button class="btn btn-secondary focusable" id="btn-discover-settings" tabindex="0">
                               ${i18n.t('SeerrOpenSettings')}
                           </button>
                       </div>`
                    : ''
            }
        `;
        el.classList.remove('hidden');

        const btn = this.$('#btn-discover-settings');
        if (btn) {
            btn.addEventListener('click', () => router.navigate('/settings'));
            this.registerFocusSection('discover-message', el, {
                orientation: 'horizontal',
                leaveUp: 'discover-header',
                leaveLeft: 'sidebar'
            });

            // Reciprocal link so Down from the search input reaches the button —
            // mirrors what _registerRowFocus() does for the row sections.
            this.registerFocusSection('discover-header', this.$('#discover-header'), {
                orientation: 'horizontal',
                leaveDown: 'discover-message',
                leaveLeft: 'sidebar'
            });
        }
    }

    _hideMessage() {
        this.$('#discover-message')?.classList.add('hidden');
    }

    /**
     * Like SearchPage: never hide the whole page while loading, or the input
     * field vanishes on every keystroke.
     */
    setLoading(show) {
        const spinner = this.$('.page-loading');
        if (!spinner) return;
        spinner.classList.toggle('hidden', !show);
    }

    _bindEvents() {
        if (!this._input) return;

        this._input.addEventListener('input', (e) => {
            this._query = e.target.value.trim();
            if (this._debounceTimer) clearTimeout(this._debounceTimer);

            if (!this._query) {
                // Cleared field returns to the discovery rows
                this._lastSearchedQuery = '';
                this._hideMessage();
                if (seerr.isConfigured) this._loadRows();
                return;
            }

            this._debounceTimer = setTimeout(() => this._search(), SEARCH_DEBOUNCE);
        });

        // Same workaround as SearchPage: readonly on blur stops the Tizen
        // virtual keyboard from reopening as soon as focus returns.
        this._input.addEventListener('blur', () => {
            this._input.setAttribute('readonly', 'true');
        });

        this._input.addEventListener('click', () => {
            this._input.removeAttribute('readonly');
            this._input.focus();
        });

        this._input.addEventListener('keydown', (e) => {
            if (e.keyCode === 13) {
                this._input.removeAttribute('readonly');
                this._input.focus();
            }
            if (e.keyCode === 40) {
                const keys = Object.keys(this._grids);
                // No rows yet (e.g. not configured): fall back to the message's
                // settings button, if one is showing, so Down isn't a dead end.
                const settingsBtn = keys.length === 0 ? this.$('#btn-discover-settings') : null;
                if (keys.length === 0 && !settingsBtn) return;
                e.preventDefault();
                requestAnimationFrame(() => {
                    if (keys.length > 0) {
                        const sectionId = `discover-${keys[0]}-items`;
                        const container = this.$(`#${sectionId}`);
                        const firstCard = container?.querySelector('button, [tabindex="0"]');
                        if (firstCard) {
                            this.setActiveSection(sectionId);
                            focusManager.focusElement(firstCard);
                        }
                    } else if (settingsBtn) {
                        this.setActiveSection('discover-message');
                        focusManager.focusElement(settingsBtn);
                    }
                });
            }
        });
    }

    // ========================================================================
    // Lifecycle
    // ========================================================================

    _destroyGrids() {
        Object.keys(this._grids).forEach((key) => {
            const entry = this._grids[key];
            focusManager.unregister(`${entry.grid.id}-items`);
            focusManager.unregister(`${entry.grid.id}-btn-zone`);
            entry.grid.destroy();
        });
        this._grids = {};
    }

    destroy() {
        if (this._debounceTimer) clearTimeout(this._debounceTimer);
        this._destroyGrids();
        super.destroy();
    }
}

export default DiscoverPage;
