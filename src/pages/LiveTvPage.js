/**
 * ============================================================================
 * Litefin Tizen - Live TV Page
 * ============================================================================
 * Main entry point for Live TV. Handles tabs for:
 * - On Now (Suggestions)
 * - Guide (EPG)
 * - Channels
 * - Recordings
 * ============================================================================
 */

import Page from './Page.js';
import { api } from '../api/index.js';
import { focusManager } from '../ui/FocusManager.js';
import { eventBus } from '../core/EventBus.js';
import { i18n } from '../utils/i18n.js';
import { logger } from '../utils/Logger.js';
import { VirtualCardRow } from '../components/VirtualCardRow.js';
import MediaGrid from '../components/MediaGrid.js';
import EpgGrid from '../components/EpgGrid.js';
import CardRenderer from '../utils/CardRenderer.js';

const log = logger.create('LiveTvPage');

class LiveTvPage extends Page {
    constructor(options = {}) {
        super(options);
        this.title = i18n.t('LiveTV');
        this._currentTab = 'suggestions';
        this._tabData = new Map(); // Cache data for tabs
        this._virtualRows = [];
        this._isMounted = false;
    }

    render() {
        return `
            <div class="livetv-page page">
                <div class="page-header">
                    <h1 data-i18n="LiveTV">${i18n.t('LiveTV')}</h1>
                    <div class="tab-header" id="livetv-tabs">
                        <button class="tab-btn active" data-tab="suggestions" tabindex="0">${i18n.t('Suggestions')}</button>
                        <button class="tab-btn" data-tab="guide" tabindex="0">${i18n.t('Guide')}</button>
                        <button class="tab-btn" data-tab="channels" tabindex="0">${i18n.t('Channels')}</button>
                        <button class="tab-btn" data-tab="recordings" tabindex="0">${i18n.t('Recordings')}</button>
                    </div>
                </div>
                <div class="tab-content" id="livetv-content">
                    <div class="page-loading"><div class="loading-spinner"></div></div>
                </div>
            </div>
        `;
    }

    onInit() {
        this._isMounted = true;
        this._setupTabHandlers();
        this._loadTab(this._currentTab);
        this.markReady();
    }

    onDestroyed() {
        this._isMounted = false;
        this._virtualRows.forEach(row => {
            if (row && row.destroy) row.destroy();
        });
        this._virtualRows = [];
    }

    _setupTabHandlers() {
        const tabs = this.$('#livetv-tabs');
        tabs.addEventListener('click', (e) => {
            const btn = e.target.closest('.tab-btn');
            if (btn) {
                this._switchTab(btn.dataset.tab);
            }
        });

        // Focus registration for tabs
        this.registerFocusSection('livetv-tabs', tabs, {
            orientation: 'horizontal',
            selector: '.tab-btn'
        });
    }

    _switchTab(tabId) {
        if (this._currentTab === tabId) return;

        // Update UI state
        const oldTab = this.$(`.tab-btn[data-tab="${this._currentTab}"]`);
        const newTab = this.$(`.tab-btn[data-tab="${tabId}"]`);
        
        if (oldTab) oldTab.classList.remove('active');
        if (newTab) newTab.classList.add('active');

        this._currentTab = tabId;
        this._loadTab(tabId);
    }

    async _loadTab(tabId) {
        const container = this.$('#livetv-content');
        container.innerHTML = '<div class="page-loading"><div class="loading-spinner"></div></div>';
        
        // Reset virtual rows
        this._virtualRows = [];
        focusManager.removeSection('livetv-content-section');

        try {
            switch (tabId) {
                case 'suggestions':
                    await this._renderSuggestions();
                    break;
                case 'guide':
                    await this._renderGuide();
                    break;
                case 'channels':
                    await this._renderChannels();
                    break;
                case 'recordings':
                    await this._renderRecordings();
                    break;
            }
        } catch (err) {
            log.error(`Failed to load tab ${tabId}:`, err);
            container.innerHTML = `<div class="page-error">${i18n.t('ErrorLoadingData')}</div>`;
        }
    }

    // =========================================================================
    // Tab Renderers
    // =========================================================================

    async _renderSuggestions() {
        const container = this.$('#livetv-content');
        container.innerHTML = '<div class="home-rows" id="suggestions-rows"></div>';
        const rowsContainer = this.$('#suggestions-rows');

        // Fetch Recommended Programs
        const programs = await api.getLiveTvRecommendedPrograms({
            userId: api.userId,
            limit: 24,
            enableImageTypes: 'Primary,Thumb,Backdrop',
            fields: 'PrimaryImageAspectRatio,CanSelfDelete,SortName'
        });

        if (!this._isMounted) return;

        if (programs.Items && programs.Items.length > 0) {
            this._createRow(rowsContainer, i18n.t('OnNow'), programs.Items, {
                id: 'on-now',
                isLandscape: true,
                cardType: 'thumb'
            });
        } else {
            rowsContainer.innerHTML = `<div class="no-items">${i18n.t('NoItemsFound')}</div>`;
        }
    }

    async _renderChannels() {
        const container = this.$('#livetv-content');
        const channels = await api.getLiveTvChannels({
            userId: api.userId,
            enableImageTypes: 'Primary,Thumb,Backdrop'
        });

        if (!this._isMounted) return;

        const grid = new MediaGrid({
            id: 'livetv-channels-grid',
            title: '',
            items: channels.Items || [],
            type: 'square',
            limit: 50
        });

        container.innerHTML = grid.render();
        grid.onMounted();

        this.registerFocusSection('livetv-content-section', this.$('#livetv-channels-grid-items'), {
            orientation: 'both',
            selector: '.media-card'
        });
    }

    async _renderRecordings() {
        const container = this.$('#livetv-content');
        const recordings = await api.getLiveTvRecordings({
            userId: api.userId,
            limit: 50,
            enableImageTypes: 'Primary,Thumb,Backdrop'
        });

        if (!this._isMounted) return;

        const grid = new MediaGrid({
            id: 'livetv-recordings-grid',
            title: '',
            items: recordings.Items || [],
            type: 'thumb',
            isLandscape: true,
            limit: 50
        });

        container.innerHTML = grid.render();
        grid.onMounted();

        this.registerFocusSection('livetv-content-section', this.$('#livetv-recordings-grid-items'), {
            orientation: 'both',
            selector: '.media-card'
        });
    }

    async _renderGuide() {
        const container = this.$('#livetv-content');
        container.innerHTML = '<div class="epg-grid-container" id="epg-container"></div>';
        
        const epg = new EpgGrid(container.querySelector('#epg-container'));
        await epg.init();
        
        this._virtualRows.push(epg);
    }

    // =========================================================================
    // Helpers
    // =========================================================================

    _createRow(container, title, items, options = {}) {
        const rowId = options.id || `row-${Math.random().toString(36).substr(2, 9)}`;
        const sectionId = `section-${rowId}`;
        
        const rowHtml = `
            <div class="media-row" id="${rowId}">
                <h2 class="row-title">${title}</h2>
                <div class="row-items-container">
                    <div class="row-items-track" id="${sectionId}"></div>
                </div>
            </div>
        `;
        container.insertAdjacentHTML('beforeend', rowHtml);

        const track = document.getElementById(sectionId);
        const virtualRow = new VirtualCardRow(track, items, {
            isLandscape: options.isLandscape || false,
            cardType: options.cardType || 'poster',
            focusSectionId: sectionId,
            renderCard: (item) => CardRenderer.createCardHtml(item, {
                isLandscape: options.isLandscape,
                type: options.cardType,
                contextType: 'livetv'
            })
        });

        this._virtualRows.push(virtualRow);

        this.registerFocusSection(sectionId, track, {
            orientation: 'horizontal',
            selector: '.media-card',
            indices: true
        });

        // Bind horizontal movement
        focusManager.setHandler(sectionId, 'left', () => virtualRow.handleMove('left', focusManager.getSelectedIndex(sectionId)));
        focusManager.setHandler(sectionId, 'right', () => virtualRow.handleMove('right', focusManager.getSelectedIndex(sectionId)));
        
        return virtualRow;
    }
}

export default LiveTvPage;
