/**
 * ============================================================================
 * Litefin Tizen - Discover Page (Jellyseerr)
 * ============================================================================
 * Discovery rows (My Requests, Watchlist, Trending, Popular Movies/Series) against
 * a Jellyseerr instance. Rendered as high-performance horizontal rows using
 * VirtualCardRow (matching HomePage layout).
 * ============================================================================
 */

import Page from './Page.js';
import { VirtualCardRow } from '../components/VirtualCardRow.js';
import CardRenderer from '../utils/CardRenderer.js';
import { seerr } from '../api/JellyseerrClient.js';
import { focusManager } from '../ui/FocusManager.js';
import { router } from '../core/Router.js';
import { lazyLoader } from '../utils/LazyLoader.js';
import { logger } from '../utils/Logger.js';
import { i18n } from '../utils/i18n.js';

const log = logger.create('DiscoverPage');

class DiscoverPage extends Page {
    constructor() {
        super();
        this._isAsyncPage = true;
        this._virtualRows = [];
        this._rowRegistry = new Map();
    }

    render() {
        return `
            <div class="page discover-page">
                <main class="page-content discover-content">
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

        i18n.translateDOM(this.el);

        const status = await seerr.status(true);
        if (!status.available) {
            this._showMessage(i18n.t('SeerrNotConfigured'), true);
            this.markReady();
            this.restoreScrollFocusWhenReady();
            return;
        }

        this._attachDelegatedListeners();
        await this._loadRows();
        this.markReady();
        this.restoreScrollFocusWhenReady();
    }

    // ========================================================================
    // Loading & Data Fetching
    // ========================================================================

    async _loadRows() {
        this.setLoading(true);
        this._hideMessage();

        // A failing row must not blank the page, so each promise is isolated
        const settle = (promise) =>
            promise.catch((err) => {
                log.warn('Discover row fetch failed', err);
                return null;
            });

        // Load discovery rows: Recently Added (Row 1), My Requests, Watchlist, Trending, Movies, Series
        const [recentlyAdded, requests, watchlist, trending, movies, series] = await Promise.all([
            settle(seerr.recentlyAdded()),
            settle(seerr.requests()),
            settle(seerr.watchlist()),
            settle(seerr.discoverTrending()),
            settle(seerr.discoverMovies()),
            settle(seerr.discoverTv())
        ]);

        this.setLoading(false);

        const totalItems =
            (recentlyAdded?.length || 0) +
            (requests?.length || 0) +
            (watchlist?.length || 0) +
            (trending?.length || 0) +
            (movies?.length || 0) +
            (series?.length || 0);

        if (totalItems === 0) {
            this._showMessage(i18n.t('SeerrLoadFailed'), false);
            return;
        }

        const rows = [];
        if (recentlyAdded && recentlyAdded.length > 0) {
            rows.push({ key: 'recentlyAdded', title: i18n.t('SeerrRecentlyAdded', ['Recently Added']), items: recentlyAdded });
        }
        if (requests && requests.length > 0) {
            rows.push({ key: 'requests', title: i18n.t('SeerrMyRequests', ['My Requests']), items: requests });
        }
        if (watchlist && watchlist.length > 0) {
            rows.push({ key: 'watchlist', title: i18n.t('SeerrWatchlist', ['Watchlist']), items: watchlist });
        }
        if (trending && trending.length > 0) {
            rows.push({ key: 'trending', title: i18n.t('SeerrTrending', ['Trending']), items: trending });
        }
        if (movies && movies.length > 0) {
            rows.push({ key: 'movies', title: i18n.t('SeerrPopularMovies', ['Popular Movies']), items: movies });
        }
        if (series && series.length > 0) {
            rows.push({ key: 'series', title: i18n.t('SeerrPopularSeries', ['Popular Series']), items: series });
        }

        this._renderRows(rows);
    }

    // ========================================================================
    // Rendering Horizontal Card Rows (VirtualCardRow)
    // ========================================================================

    /**
     * Renders rows as horizontal VirtualCardRow sections matching the homepage layout.
     * @param {Array<{key: string, title: string, items: Array}>} rows
     * @private
     */
    _renderRows(rows) {
        const container = this.$('#discover-rows');
        if (!container) return;

        this._destroyVirtualRows();
        container.innerHTML = '';
        this._rowRegistry.clear();

        CardRenderer.clearCache();

        rows.forEach((row, index) => {
            if (!row.items || row.items.length === 0) return;

            const sectionEl = document.createElement('section');
            sectionEl.className = 'media-row';
            sectionEl.setAttribute('data-row-id', row.key);
            sectionEl.setAttribute('data-row-index', index);

            sectionEl.innerHTML = `
                <h2 class="row-title">${row.title}</h2>
                <div class="row-items" id="row-items-${row.key}">
                    <div class="row-items-track"></div>
                </div>
            `;
            container.appendChild(sectionEl);

            const trackEl = sectionEl.querySelector('.row-items-track');
            const virtualRow = new VirtualCardRow(trackEl, row.items, {
                isLandscape: false,
                cardType: 'poster',
                visibleCount: 10,
                initialWindow: Math.min(row.items.length, 12),
                focusSectionId: `discover-row-${row.key}`,
                renderCard: (item) =>
                    this._renderMediaCard(item, false, 'poster', 'discover')
            });

            const itemsContainer = sectionEl.querySelector('.row-items');
            const prevKey = index > 0 ? rows[index - 1].key : null;
            const nextKey = index < rows.length - 1 ? rows[index + 1].key : null;

            this.registerFocusSection(`discover-row-${row.key}`, itemsContainer, {
                orientation: 'horizontal',
                leaveUp: prevKey ? `discover-row-${prevKey}` : null,
                leaveDown: nextKey ? `discover-row-${nextKey}` : null,
                leaveLeft: 'sidebar',

                onMove: (direction, currentElement) => {
                    if (!currentElement || currentElement.dataset.virtualIndex === undefined) {
                        return false;
                    }
                    const idx = parseInt(currentElement.dataset.virtualIndex, 10);
                    const nextNode = virtualRow.handleMove(direction, idx);
                    if (nextNode) {
                        focusManager.focusElement(nextNode);
                        return true;
                    }
                    return false;
                },

                onEnter: (fromElement, options) => {
                    if (fromElement && options && (options.direction === 'up' || options.direction === 'down')) {
                        const existingNode = virtualRow.domNodes.get(virtualRow.currentIndex);
                        if (existingNode && existingNode.isConnected) {
                            return existingNode;
                        }
                        virtualRow._updateWindow(virtualRow.currentIndex);
                        return virtualRow.domNodes.get(virtualRow.currentIndex);
                    }
                    return null;
                }
            });

            this._rowRegistry.set(row.key, { row, sectionEl, virtualRow });
            this._virtualRows.push(virtualRow);
            lazyLoader.observe(sectionEl);
        });

        if (rows.length > 0) {
            this.setActiveSection(`discover-row-${rows[0].key}`);
        }
    }

    /**
     * Attaches event delegation on #discover-rows for fast card activation and index syncing.
     * @private
     */
    _attachDelegatedListeners() {
        const container = this.$('#discover-rows');
        if (!container) return;

        let lastActivateTime = 0;
        const handleActivate = (e) => {
            const card = e.target.closest('.media-card');
            if (!card) return;

            const now = Date.now();
            if (now - lastActivateTime < 400) return;
            lastActivateTime = now;

            e.stopPropagation();

            const itemId = card.dataset.itemId;
            if (!itemId) return;

            // Find item in registry
            let found = null;
            for (const [, entry] of this._rowRegistry) {
                found = entry.virtualRow.items.find((i) => i.Id === itemId);
                if (found) break;
            }

            if (found) {
                router.navigate(`/seerr/${found._mediaType}/${found._tmdbId}`);
            }
        };

        container.addEventListener('click', handleActivate);
        container.addEventListener('mousedown', handleActivate);

        container.addEventListener('focusin', (e) => {
            if (!e.target.classList.contains('media-card')) return;
            const sectionEl = e.target.closest('section[data-row-id]');
            if (!sectionEl) return;
            const rowId = sectionEl.getAttribute('data-row-id');
            const rowEntry = this._rowRegistry.get(rowId);
            if (rowEntry) {
                rowEntry.virtualRow.syncIndexFromNode(e.target);
            }
        });
    }

    // ========================================================================
    // UI Helpers & Messaging
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
                leaveLeft: 'sidebar'
            });
            this.setActiveSection('discover-message');
        }
    }

    _hideMessage() {
        this.$('#discover-message')?.classList.add('hidden');
    }

    setLoading(show) {
        const spinner = this.$('.page-loading');
        if (!spinner) return;
        spinner.classList.toggle('hidden', !show);
    }

    // ========================================================================
    // Lifecycle & Cleanup
    // ========================================================================

    _destroyVirtualRows() {
        for (const [key] of this._rowRegistry) {
            focusManager.unregister(`discover-row-${key}`);
        }
        this._virtualRows = [];
        this._rowRegistry.clear();
    }

    destroy() {
        this._destroyVirtualRows();
        super.destroy();
    }
}

export default DiscoverPage;
