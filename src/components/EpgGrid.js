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
import { scrollController } from '../ui/ScrollController.js';

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
        // Set a sane default height so the grid renders even before layout is measured
        this.visibleHeight = 600;
        
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
            
            // 4. Measure visible area AFTER DOM is painted, then load and render
            // requestAnimationFrame ensures the container has been laid out by the browser
            await new Promise(resolve => requestAnimationFrame(resolve));
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
        // =====================================================================
        // Channel Node (left column)
        // Made focusable so the user can navigate to channels that have no
        // programs in the schedule yet. Pressing Right from a channel row
        // will jump to the current/next program; Enter/OK will play the channel.
        // =====================================================================
        const channelEl = document.createElement('div');
        channelEl.className = 'epg-channel-row';
        channelEl.style.position = 'absolute';
        channelEl.style.top = `${index * this.ROW_HEIGHT}px`;
        channelEl.style.width = '100%';
        // Make the channel cell keyboard/D-pad focusable
        channelEl.tabIndex = 0;
        channelEl.dataset.channelId = channel.Id;
        channelEl.dataset.rowIndex = String(index);
        // Clicking/pressing OK on a channel plays it directly
        channelEl.onclick = () => this._handleChannelClick(channel);
        channelEl.onfocus = () => this._handleChannelFocus(channelEl);
        
        let logoUrl = '';
        if (channel.ImageTags && channel.ImageTags.Primary) {
            logoUrl = api.getImageUrl(channel.Id, 'Primary', { maxWidth: 80, quality: 70, tag: channel.ImageTags.Primary });
        }
        
        channelEl.innerHTML = `
            ${logoUrl ? `<img class="epg-channel-logo" src="${logoUrl}" loading="lazy" />` : '<div class="epg-channel-logo fallback-logo"></div>'}
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
        focusManager.register('epg-grid', this.container.querySelector('.epg-grid-container'), {
            // Include both program cells AND channel-column items in the selector so
            // FocusManager is aware of both types of focusable nodes in this section.
            selector: '.epg-program, .epg-channel-row',
            orientation: 'both',
            // Wire up boundary exits using options passed from LiveTvPage
            leaveUp: this.options.leaveUp || null,
            // Channel rows handle their own leaveLeft (to sidebar) via _handleMove
            leaveLeft: this.options.leaveLeft || null,
            onMove: (direction) => {
                const nextEl = this._handleMove(direction);
                if (nextEl) {
                    focusManager.focusElement(nextEl);
                    
                    // Since we return 'true' to handle focus internally, FocusManager's 
                    // default scrollIntoView is skipped. We must manually trigger 
                    // the parent page-content to scroll so the header pushes out.
                    scrollController.scrollIntoView(this.container); 

                    return true; 
                }
                return false;
            }
        });
    }

    _setupEventListeners() {
        window.addEventListener('resize', () => this._updateVisibleDimensions());
    }

    _handleMove(direction) {
        const current = document.activeElement;
        if (!current) return null;

        const isChannelRow = current.classList.contains('epg-channel-row');
        const isProgram = current.classList.contains('epg-program');

        if (!isChannelRow && !isProgram) return null;

        const channelId = current.dataset.channelId;
        const rowIndex = parseInt(current.dataset.rowIndex, 10);

        // =================================================================
        // Movement from the LEFT CHANNEL COLUMN
        // =================================================================
        if (isChannelRow) {
            if (direction === 'up' || direction === 'down') {
                // Navigate between channel rows
                const nextRowIndex = direction === 'down' ? rowIndex + 1 : rowIndex - 1;
                if (nextRowIndex >= 0 && nextRowIndex < this.channels.length) {
                    const nextChannel = this.channels[nextRowIndex];
                    const data = this.domNodes.get(nextChannel.Id);
                    if (data && data.channelEl) {
                        this._scrollChannelIntoView(nextRowIndex);
                        return data.channelEl;
                    }
                }
            } else if (direction === 'right') {
                // Jump into the program grid — find the current or next program
                // for this same channel row so focus lands on something sensible.
                const programs = this.programsMap.get(channelId) || [];
                const now = Date.now();
                const target =
                    // First: prefer the program airing right now
                    programs.find(p => now >= new Date(p.StartDate).getTime() && now < new Date(p.EndDate).getTime()) ||
                    // Second: the next upcoming program
                    programs.find(p => new Date(p.StartDate).getTime() > now) ||
                    // Last resort: the very first program in the list
                    programs[0];

                if (target) {
                    const el = this._findProgramEl(channelId, target.Id);
                    if (el) {
                        this._scrollIntoView(el);
                        return el;
                    }
                }
                // No programs at all — stay on the channel element (don't move)
                return null;
            }
            // 'left' from a channel row — let FocusManager handle leaveLeft (→ sidebar)
            return null;
        }

        // =================================================================
        // Movement from the PROGRAM GRID
        // =================================================================
        const program = current.__programData;
        let nextEl = null;

        if (direction === 'left') {
            // Find prev program in the same row
            const programs = this.programsMap.get(channelId) || [];
            const idx = programs.findIndex(p => p.Id === program.Id);
            if (idx > 0) {
                nextEl = this._findProgramEl(channelId, programs[idx - 1].Id);
            } else {
                // At the leftmost program — jump back to the channel column
                const data = this.domNodes.get(channelId);
                if (data && data.channelEl) {
                    this._scrollChannelIntoView(rowIndex);
                    return data.channelEl;
                }
            }
        } else if (direction === 'right') {
            // Find next program in the same row
            const programs = this.programsMap.get(channelId) || [];
            const idx = programs.findIndex(p => p.Id === program.Id);
            if (idx >= 0 && idx + 1 < programs.length) {
                nextEl = this._findProgramEl(channelId, programs[idx + 1].Id);
            }
        } else {
            // Up / Down — move to program in adjacent row that overlaps current time
            const nextRowIndex = direction === 'down' ? rowIndex + 1 : rowIndex - 1;
            if (nextRowIndex >= 0 && nextRowIndex < this.channels.length) {
                const nextChannel = this.channels[nextRowIndex];
                const nextRowPrograms = this.programsMap.get(nextChannel.Id) || [];
                const midTime = new Date(program.StartDate).getTime()
                    + (new Date(program.EndDate).getTime() - new Date(program.StartDate).getTime()) / 2;

                const overlapping = nextRowPrograms.find(p => {
                    const start = new Date(p.StartDate).getTime();
                    const end = new Date(p.EndDate).getTime();
                    return midTime >= start && midTime < end;
                });

                if (overlapping) {
                    nextEl = this._findProgramEl(nextChannel.Id, overlapping.Id);
                } else if (nextRowPrograms.length === 0) {
                    // No programs in that row — skip to the channel label instead
                    const data = this.domNodes.get(nextChannel.Id);
                    if (data && data.channelEl) {
                        this._scrollChannelIntoView(nextRowIndex);
                        return data.channelEl;
                    }
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
        // Broadcast program details in case any side panel wants to display them
        const program = el.__programData;
        eventBus.emit('epg:programFocused', program);
    }

    // Called when a channel label cell receives focus
    _handleChannelFocus(el) {
        const channel = this.channels[parseInt(el.dataset.rowIndex, 10)];
        if (channel) {
            // Let any listener (e.g. an info panel) know which channel is highlighted
            eventBus.emit('epg:channelFocused', channel);
        }
    }

    // Emit a play event for a channel when the user presses OK on its label
    _handleChannelClick(channel) {
        log.info('Channel clicked from EPG column:', channel.Name);
        eventBus.emit('player:play', {
            item: { Id: channel.Id, Type: 'TvChannel' }
        });
    }

    /**
     * Scroll the virtual grid so the requested channel row index is visible.
     * Used when focus moves to a channel label in the left column.
     */
    _scrollChannelIntoView(rowIndex) {
        const top = rowIndex * this.ROW_HEIGHT;
        const paddingY = 50;

        if (top < this.scrollY + paddingY) {
            this.scrollY = Math.max(0, top - paddingY);
        } else if (top + this.ROW_HEIGHT > this.scrollY + this.visibleHeight - paddingY) {
            this.scrollY = top + this.ROW_HEIGHT - this.visibleHeight + paddingY;
        }
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
        // Find the program covering "now" in the first visible channel.
        // If no programs are loaded (e.g. sparse schedules or API gaps), fall
        // back to focusing the channel label itself so the user isn't left
        // with nothing focusable in the guide.
        const now = new Date();
        const startRow = Math.floor(this.scrollY / this.ROW_HEIGHT);
        const channel = this.channels[startRow] || this.channels[0];
        if (!channel) return;

        const programs = this.programsMap.get(channel.Id) || [];
        const current = programs.find(p => {
            const start = new Date(p.StartDate).getTime();
            const end = new Date(p.EndDate).getTime();
            return now.getTime() >= start && now.getTime() < end;
        });

        if (current) {
            const el = this._findProgramEl(channel.Id, current.Id);
            if (el) {
                focusManager.focusElement(el);
                return;
            }
        }

        // No current program found — focus the channel label in the left column
        // so the user can at least navigate and play the channel directly.
        const data = this.domNodes.get(channel.Id);
        if (data && data.channelEl) {
            focusManager.focusElement(data.channelEl);
        }
    }

    // =========================================================================
    // Data Management
    // =========================================================================

    async _loadPrograms() {
        // =====================================================================
        // Batched Programs Fetch
        //
        // The naive approach — joining ALL channel IDs into a single URL — causes
        // net::ERR_FAILED on large installations with 100+ channels. HTTP has a
        // practical URL length limit of ~8KB (enforced by browsers and reverse
        // proxies). With 500+ channel IDs, the query string alone can exceed 20KB.
        //
        // Fix: split channels into chunks of BATCH_SIZE and fire them concurrently
        // with Promise.all(). This keeps each URL within safe limits while keeping
        // the total load time the same as a single request (parallel execution).
        // =====================================================================
        const BATCH_SIZE = 50;
        const allChannelIds = this.channels.map(c => c.Id);

        // Slice the array into batches of BATCH_SIZE
        const batches = [];
        for (let i = 0; i < allChannelIds.length; i += BATCH_SIZE) {
            batches.push(allChannelIds.slice(i, i + BATCH_SIZE));
        }

        log.debug(`[EPG] Fetching programs for ${allChannelIds.length} channels in ${batches.length} batch(es) of ${BATCH_SIZE}`);

        // Fire all batch requests concurrently — much faster than sequential
        const batchResults = await Promise.all(
            batches.map(batchIds =>
                api.getLiveTvPrograms({
                    userId: api.userId,
                    channelIds: batchIds.join(','),
                    hasStartDate: true,
                    hasEndDate: true,
                    startDate: this.startTime.toISOString(),
                    endDate: this.endTime.toISOString(),
                    fields: 'Overview,PrimaryImageAspectRatio'
                })
            )
        );

        // Merge all batch results into the programs map, grouped by channelId
        this.programsMap.clear();
        for (const result of batchResults) {
            if (!result || !result.Items) continue;
            for (const item of result.Items) {
                if (!this.programsMap.has(item.ChannelId)) {
                    this.programsMap.set(item.ChannelId, []);
                }
                this.programsMap.get(item.ChannelId).push(item);
            }
        }

        log.debug(`[EPG] Programs loaded. ${this.programsMap.size} channels have program data.`);
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
        // The container can be nested—measure from the direct epg-grid-container child
        const gridContainer = this.container.querySelector('.epg-grid-container');
        const el = gridContainer || this.container;
        if (el) {
            this.visibleHeight = (el.clientHeight || 600) - 60; // Subtract timeline header
            this.visibleWidth = (el.clientWidth || 1280) - 250;   // Subtract channels sidebar
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
