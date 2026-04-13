/**
 * ============================================================================
 * Litefin Tizen - EPG Grid Component
 * ============================================================================
 * High-performance, virtualized EPG grid for TV interfaces.
 * Uses a double-virtualization strategy (vertical for channels, horizontal
 * for time) to maintain 60FPS on slow Tizen hardware.
 * ============================================================================
 */

import { api } from '../api/index.js';
import { focusManager } from '../ui/FocusManager.js';
import { logger } from '../utils/Logger.js';
import { i18n } from '../utils/i18n.js';
import { imageService } from '../utils/ImageService.js';

const log = logger.create('EpgGrid');

class EpgGrid {
    /**
     * @param {HTMLElement} container - The container to mount the grid in
     * @param {Object} options - Configuration options
     */
    constructor(container, options = {}) {
        this.container = container;
        this.options = options;

        // Constants
        this.CHANNEL_WIDTH = 250;
        this.ROW_HEIGHT = 100;
        this.PIXELS_PER_MINUTE = 10; // 1 hour = 600px
        this.PIXELS_PER_HOUR = this.PIXELS_PER_MINUTE * 60;
        
        // State
        this.channels = [];
        this.programsMap = new Map(); // channelId -> Array of programs
        this.startTime = this._getRoundStartTime();
        this.endTime = new Date(this.startTime.getTime() + 24 * 60 * 60 * 1000); // 24 hours EPG
        
        this.scrollX = 0;
        this.scrollY = 0;
        this.visibleRows = 0;
        this.visibleWidth = 0;
        
        this.domNodes = new Map(); // channelId -> { rowEl, channelEl, programNodes: Map<programId, node> }
        
        this._isMounted = false;
        this._isDestroyed = false;
    }

    async init() {
        this._isMounted = true;
        this._renderSkeleton();
        
        try {
            // 1. Fetch channels
            const channelsResult = await api.getLiveTvChannels({ userId: api.userId });
            this.channels = channelsResult.Items || [];
            
            if (this._isDestroyed) return;

            // 2. Render initial structure
            this._renderStructure();
            
            // 3. Setup Focus & Event Listeners
            this._setupFocus();
            this._setupEventListeners();
            
            // 4. Initial Load & Start rendering loop
            this._updateVisibleDimensions();
            await this._loadPrograms();
            this._startRenderLoop();
            
            // 5. Initial Scroll to "Now"
            this._scrollToNow();
            
            // 6. Focus initial program
            this._focusNow();
            
        } catch (err) {
            log.error('EPG Init failed:', err);
            this.container.innerHTML = `<div class="epg-error">${i18n.t('ErrorLoadingData')}</div>`;
        }
    }

    destroy() {
        this._isDestroyed = true;
        this._isMounted = false;
    }

    // =========================================================================
    // Core Rendering
    // =========================================================================

    _renderSkeleton() {
        this.container.innerHTML = `
            <div class="epg-grid-container">
                <div class="page-loading"><div class="loading-spinner"></div></div>
            </div>
        `;
    }

    _renderStructure() {
        this.container.innerHTML = `
            <div class="epg-grid-container">
                <div class="epg-header">
                    <div class="epg-channel-header-spacer"></div>
                    <div class="epg-timeline" id="epg-timeline">
                        <div class="epg-timeline-track" id="epg-timeline-track">
                            ${this._renderTimelineLabels()}
                        </div>
                    </div>
                </div>
                <div class="epg-body">
                    <div class="epg-channels" id="epg-channels">
                        <div class="epg-channels-track" id="epg-channels-track" style="height: ${this.channels.length * this.ROW_HEIGHT}px;"></div>
                    </div>
                    <div class="epg-programs" id="epg-programs">
                        <div class="epg-programs-track" id="epg-programs-track" style="height: ${this.channels.length * this.ROW_HEIGHT}px; width: ${24 * this.PIXELS_PER_HOUR}px;"></div>
                        <div class="epg-indicator" id="epg-now-indicator"></div>
                    </div>
                </div>
            </div>
        `;
        
        this.timelineTrack = this.container.querySelector('#epg-timeline-track');
        this.channelsTrack = this.container.querySelector('#epg-channels-track');
        this.programsTrack = this.container.querySelector('#epg-programs-track');
        this.nowIndicator = this.container.querySelector('#epg-now-indicator');
    }

    _renderTimelineLabels() {
        const labels = [];
        let time = new Date(this.startTime);
        while (time < this.endTime) {
            const timeStr = time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
            labels.push(`<div class="epg-time-slot" style="width: ${30 * this.PIXELS_PER_MINUTE}px;">${timeStr}</div>`);
            time = new Date(time.getTime() + 30 * 60 * 1000); // 30 min increments
        }
        return labels.join('');
    }

    _startRenderLoop() {
        const tick = () => {
            if (this._isDestroyed) return;
            this._updateIndicator();
            this._renderVirtualGrid();
            requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
    }

    _renderVirtualGrid() {
        // 1. Calculate window
        const startRow = Math.floor(this.scrollY / this.ROW_HEIGHT);
        const endRow = Math.min(this.channels.length - 1, Math.ceil((this.scrollY + this.visibleHeight) / this.ROW_HEIGHT));
        
        const startTimeInPx = this.scrollX;
        const endTimeInPx = this.scrollX + this.visibleWidth;
        
        // 2. Clear nodes outside window
        for (const [channelId, data] of this.domNodes.entries()) {
            const channelIndex = this.channels.findIndex(c => c.Id === channelId);
            if (channelIndex < startRow || channelIndex > endRow) {
                if (data.rowEl.parentNode) this.programsTrack.removeChild(data.rowEl);
                if (data.channelEl.parentNode) this.channelsTrack.removeChild(data.channelEl);
                this.domNodes.delete(channelId);
            }
        }
        
        // 3. Render/Update visible rows
        for (let i = startRow; i <= endRow; i++) {
            const channel = this.channels[i];
            if (!this.domNodes.has(channel.Id)) {
                this._renderRow(i, channel);
            }
        }
        
        // 4. Sync transforms
        const scrollX = -this.scrollX;
        const scrollY = -this.scrollY;
        
        this.timelineTrack.style.transform = `translate3d(${scrollX}px, 0, 0)`;
        this.channelsTrack.style.transform = `translate3d(0, ${scrollY}px, 0)`;
        this.programsTrack.style.transform = `translate3d(${scrollX}px, ${scrollY}px, 0)`;
    }

    _renderRow(index, channel) {
        // Render Channel Node
        const channelEl = document.createElement('div');
        channelEl.className = 'epg-channel-row';
        channelEl.style.position = 'absolute';
        channelEl.style.top = `${index * this.ROW_HEIGHT}px`;
        channelEl.style.width = '100%';
        
        const logoUrl = imageService.getItemImageUrl(channel, { type: 'Primary', width: 80 });
        channelEl.innerHTML = `
            <img class="epg-channel-logo" src="${logoUrl}" />
            <div class="epg-channel-info">
                <div class="epg-channel-name">${channel.Name}</div>
                <div class="epg-channel-number">${channel.Number || ''}</div>
            </div>
        `;
        this.channelsTrack.appendChild(channelEl);
        
        // Render Row Node for programs
        const rowEl = document.createElement('div');
        rowEl.className = 'epg-row';
        rowEl.dataset.channelIndex = index;
        rowEl.style.top = `${index * this.ROW_HEIGHT}px`;
        this.programsTrack.appendChild(rowEl);
        
        const data = {
            rowEl,
            channelEl,
            programNodes: new Map()
        };
        this.domNodes.set(channel.Id, data);
        
        // Immediate program render for the row
        this._renderProgramsInRow(channel.Id, rowEl, index);
    }

    _renderProgramsInRow(channelId, rowEl, rowIndex) {
        const programs = this.programsMap.get(channelId) || [];
        programs.forEach(program => {
            const left = this._getTimeOffset(new Date(program.StartDate));
            const width = this._getTimeDuration(new Date(program.StartDate), new Date(program.EndDate));
            
            const progEl = document.createElement('div');
            progEl.className = 'epg-program';
            progEl.tabIndex = 0;
            progEl.style.left = `${left}px`;
            progEl.style.width = `${width}px`;
            progEl.dataset.programId = program.Id;
            progEl.dataset.channelId = channelId;
            progEl.dataset.rowIndex = rowIndex;
            // Store raw program data for focus logic
            progEl.__programData = program;
            
            progEl.innerHTML = `
                <div class="epg-program-title">${program.Name}</div>
                <div class="epg-program-time">${this._formatProgramTime(program)}</div>
            `;
            
            progEl.onclick = () => this._handleProgramClick(program);
            progEl.onfocus = () => this._handleProgramFocus(progEl);
            
            rowEl.appendChild(progEl);
        });
    }

    // =========================================================================
    // Focus & Interaction
    // =========================================================================

    _setupFocus() {
        focusManager.registerSection('epg-grid', this.container.querySelector('.epg-grid-container'), {
            selector: '.epg-program',
            orientation: 'both',
            indices: false
        });

        // Custom handlers for EPG-specific movement
        focusManager.setHandler('epg-grid', 'left', () => this._handleMove('left'));
        focusManager.setHandler('epg-grid', 'right', () => this._handleMove('right'));
        focusManager.setHandler('epg-grid', 'up', () => this._handleMove('up'));
        focusManager.setHandler('epg-grid', 'down', () => this._handleMove('down'));
    }

    _setupEventListeners() {
        window.addEventListener('resize', () => this._updateVisibleDimensions());
    }

    _handleMove(direction) {
        const current = focusManager.getCurrentElement();
        if (!current || !current.classList.contains('epg-program')) return null;

        const program = current.__programData;
        const channelId = current.dataset.channelId;
        const rowIndex = parseInt(current.dataset.rowIndex, 10);
        
        let nextEl = null;

        if (direction === 'left' || direction === 'right') {
            // Find next/prev program in the same row
            const programs = this.programsMap.get(channelId);
            const idx = programs.findIndex(p => p.Id === program.Id);
            const nextIdx = direction === 'right' ? idx + 1 : idx - 1;
            
            if (nextIdx >= 0 && nextIdx < programs.length) {
                nextEl = this._findProgramEl(channelId, programs[nextIdx].Id);
            }
        } else {
            // Moving Up/Down
            const nextRowIndex = direction === 'down' ? rowIndex + 1 : rowIndex - 1;
            if (nextRowIndex >= 0 && nextRowIndex < this.channels.length) {
                const nextChannel = this.channels[nextRowIndex];
                // Find program in next row that overlaps with current time
                const nextRowPrograms = this.programsMap.get(nextChannel.Id) || [];
                const currentTime = new Date(program.StartDate).getTime() + (new Date(program.EndDate).getTime() - new Date(program.StartDate).getTime()) / 2;
                
                const overlapping = nextRowPrograms.find(p => {
                    const start = new Date(p.StartDate).getTime();
                    const end = new Date(p.EndDate).getTime();
                    return currentTime >= start && currentTime < end;
                });
                
                if (overlapping) {
                    nextEl = this._findProgramEl(nextChannel.Id, overlapping.Id);
                }
            }
        }

        if (nextEl) {
            this._scrollIntoView(nextEl);
            return nextEl;
        }

        return null;
    }

    _findProgramEl(channelId, programId) {
        // Since it's virtualized, it might not be in DOM yet
        // However, for horizontal movement, if we are in the row, 
        // all its programs are rendered (our simple virtualization renders full rows).
        const data = this.domNodes.get(channelId);
        if (data) {
            return data.rowEl.querySelector(`[data-program-id="${programId}"]`);
        }
        return null;
    }

    _handleProgramFocus(el) {
        // Optional: Update some side panel or footer with program details
        const program = el.__programData;
        eventBus.emit('epg:programFocused', program);
    }

    _scrollIntoView(el) {
        const left = parseInt(el.style.left, 10);
        const width = parseInt(el.style.width, 10);
        const rowIndex = parseInt(el.dataset.rowIndex, 10);
        const top = rowIndex * this.ROW_HEIGHT;

        const paddingX = 100;
        const paddingY = 100;

        // Horizontal scroll
        if (left < this.scrollX + paddingX) {
            this.scrollX = Math.max(0, left - paddingX);
        } else if (left + width > this.scrollX + this.visibleWidth - paddingX) {
            this.scrollX = left + width - this.visibleWidth + paddingX;
        }

        // Vertical scroll
        if (top < this.scrollY) {
            this.scrollY = top;
        } else if (top + this.ROW_HEIGHT > this.scrollY + this.visibleHeight) {
            this.scrollY = top + this.ROW_HEIGHT - this.visibleHeight;
        }
    }

    _focusNow() {
        // Find the program covering "now" in the first visible channel
        const now = new Date();
        const startRow = Math.floor(this.scrollY / this.ROW_HEIGHT);
        const channel = this.channels[startRow] || this.channels[0];
        
        const programs = this.programsMap.get(channel.Id) || [];
        const current = programs.find(p => {
            const start = new Date(p.StartDate).getTime();
            const end = new Date(p.EndDate).getTime();
            return now.getTime() >= start && now.getTime() < end;
        });

        if (current) {
            const el = this._findProgramEl(channel.Id, current.Id);
            if (el) focusManager.focusElement(el);
        }
    }

    // =========================================================================
    // Data Management
    // =========================================================================

    async _loadPrograms() {
        // Fetch programs for all channels for the next 24 hours
        // In a real app, I'd fetch this in chunks, but for now 24h for all is fine
        const channelIds = this.channels.map(c => c.Id).join(',');
        const result = await api.getLiveTvPrograms({
            userId: api.userId,
            channelIds: channelIds,
            hasStartDate: true,
            hasEndDate: true,
            startDate: this.startTime.toISOString(),
            endDate: this.endTime.toISOString(),
            fields: 'Overview,PrimaryImageAspectRatio'
        });
        
        // Group by channel
        this.programsMap.clear();
        result.Items.forEach(item => {
            if (!this.programsMap.has(item.ChannelId)) {
                this.programsMap.set(item.ChannelId, []);
            }
            this.programsMap.get(item.ChannelId).push(item);
        });
    }

    // =========================================================================
    // Helpers
    // =========================================================================

    _getRoundStartTime() {
        // Round current time down to the nearest 30 mins
        const now = new Date();
        now.setMinutes(now.getMinutes() >= 30 ? 30 : 0);
        now.setSeconds(0);
        now.setMilliseconds(0);
        return new Date(now.getTime() - 2 * 60 * 60 * 1000); // buffer 2 hours back
    }

    _scrollToNow() {
        const now = new Date();
        const offset = this._getTimeOffset(now);
        this.scrollX = Math.max(0, offset - 300); // Center "now" a bit
    }

    _updateIndicator() {
        if (!this.nowIndicator) return;
        const now = new Date();
        const offset = this._getTimeOffset(now);
        this.nowIndicator.style.left = `${offset}px`;
        this.nowIndicator.style.transform = `translate3d(${-this.scrollX}px, 0, 0)`;
    }

    _getTimeOffset(date) {
        const diffMs = date.getTime() - this.startTime.getTime();
        const diffMins = diffMs / 1000 / 60;
        return diffMins * this.PIXELS_PER_MINUTE;
    }

    _getTimeDuration(start, end) {
        const diffMs = end.getTime() - start.getTime();
        const diffMins = diffMs / 1000 / 60;
        return diffMins * this.PIXELS_PER_MINUTE;
    }

    _updateVisibleDimensions() {
        const container = this.container.querySelector('.epg-grid-container');
        if (container) {
            this.visibleHeight = container.clientHeight - 60; // Less header
            this.visibleWidth = container.clientWidth - 250; // Less channels sidebar
        }
    }

    _formatProgramTime(program) {
        const start = new Date(program.StartDate).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
        const end = new Date(program.EndDate).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
        return `${start} - ${end}`;
    }

    _handleProgramClick(program) {
        log.info('Program clicked:', program.Name);
        // Play channel
        eventBus.emit('player:play', {
            item: {
                Id: program.ChannelId,
                Type: 'TvChannel'
            }
        });
    }
}

export default EpgGrid;
