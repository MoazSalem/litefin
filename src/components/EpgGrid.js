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
import { eventBus } from '../core/EventBus.js';
import { imageService } from '../utils/ImageService.js';
import { escapeHtml } from '../utils/Utils.js';
import CardRenderer from '../utils/CardRenderer.js';

const log = logger.create('EpgGrid');

class EpgGrid {
    /**
     * Constructs the EPG grid component.
     * Aligns with Apple Human Interface Guidelines for TV interfaces with smooth layout and spatial clarity.
     * @param {HTMLElement} container - The container element to mount the EPG grid in
     * @param {Object} options - Configuration options for navigation and callbacks
     */
    constructor(container, options = {}) {
        // Parent container reference
        this.container = container;
        this.options = options;

        // Visual layout constants (in pixels)
        this.CHANNEL_WIDTH = 250;
        this.ROW_HEIGHT = 100;
        this.PIXELS_PER_MINUTE = 10; // 1 hour = 600px
        this.PIXELS_PER_HOUR = this.PIXELS_PER_MINUTE * 60;

        // Core data structures
        this.channels = [];
        // Hash map mapping channel ID to index for fast O(1) lookups during virtualization
        this.channelIndexMap = new Map();
        // Programs schedule data mapped by channel ID
        this.programsMap = new Map();

        // Timeframe initialization
        // Set initial EPG timeframe to 8 hours (2 hours back to 6 hours forward)
        // Drastically reduces network payload and JSON parsing overhead on low-spec hardware
        this.startTime = this._getRoundStartTime();
        this.endTime = new Date(this.startTime.getTime() + 8 * 60 * 60 * 1000);

        // Virtual scroll state
        this.scrollX = 0;
        this.scrollY = 0;
        this.visibleRows = 0;
        this.visibleWidth = 0;
        // Default height fallback before layout measurement completes
        this.visibleHeight = 600;

        // On-demand rendering state tracking
        this._needsRender = true;
        this._lastRenderScrollX = -1;
        this._lastRenderScrollY = -1;
        this._isProgramsLoading = false;

        // Active DOM nodes mapping (channelId -> { rowEl, channelEl, programNodes })
        this.domNodes = new Map();

        // Track internal focus element pointer for spatial D-pad routing
        this._focusedEl = null;

        // Component lifecycle flags
        this._isMounted = false;
        this._isDestroyed = false;
    }

    /**
     * Initializes the EPG grid component using an Interaction-First architecture.
     * Renders channels and makes navigation active immediately before fetching program schedule data asynchronously.
     */
    async init() {
        this._isMounted = true;
        this._renderSkeleton();

        try {
            // =================================================================
            // 1. Fetch channel metadata (Fast, lightweight request)
            // =================================================================
            const channelsResult = await api.getLiveTvChannels({ userId: api.userId });
            this.channels = channelsResult.Items || [];

            if (this._isDestroyed) return;

            // Build O(1) hash index map for channels to optimize virtualization window checks
            this.channelIndexMap.clear();
            this.channels.forEach((channel, idx) => {
                this.channelIndexMap.set(channel.Id, idx);
            });

            // =================================================================
            // 2. Render initial structure immediately (Interaction-First Pattern)
            // =================================================================
            this._renderStructure();

            // =================================================================
            // 3. Setup Focus & Event Listeners
            // =================================================================
            this._setupFocus();
            this._setupEventListeners();

            // Measure visible area after DOM layout paint frame completes
            await new Promise((resolve) => requestAnimationFrame(resolve));
            this._updateVisibleDimensions();

            // Scroll timeline view to the current time slot
            this._scrollToNow();

            // =================================================================
            // 4. Synchronous Initial Virtual Render & Instant Interaction
            // Render visible channel rows immediately so focus can land instantly
            // =================================================================
            this._renderVirtualGrid();
            this._focusNow();

            // Start on-demand render loop
            this._startRenderLoop();

            // =================================================================
            // 5. Asynchronous Program Data Load (Non-blocking background flow)
            // =================================================================
            this._isProgramsLoading = true;
            this._loadPrograms()
                .then(() => {
                    this._isProgramsLoading = false;
                    if (this._isDestroyed) return;

                    // Re-render programs for visible rows once schedule data arrives
                    this._reRenderAllVisibleRows();
                    this.requestRender();
                })
                .catch((err) => {
                    this._isProgramsLoading = false;
                    log.error('EPG Async program fetch failed:', err);
                });
        } catch (err) {
            log.error('EPG Init failed:', err);
            this.container.innerHTML = `<div class="epg-error">${i18n.t('ErrorLoadingData')}</div>`;
        }
    }

    /**
     * Cleans up listeners and resources upon component destruction.
     */
    destroy() {
        this._isDestroyed = true;
        this._isMounted = false;
    }

    // =========================================================================
    // Core Rendering
    // =========================================================================

    /**
     * Renders initial loading placeholder skeleton.
     * @private
     */
    _renderSkeleton() {
        this.container.innerHTML = `
            <div class="epg-grid-container">
                <div class="page-loading"><div class="loading-spinner"></div></div>
            </div>
        `;
    }

    /**
     * Renders the overall DOM structure of the EPG grid.
     * @private
     */
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
                        <div class="epg-programs-track" id="epg-programs-track" style="height: ${this.channels.length * this.ROW_HEIGHT}px; width: ${8 * this.PIXELS_PER_HOUR}px;"></div>
                        <div class="epg-indicator" id="epg-now-indicator"></div>
                    </div>
                </div>
            </div>
        `;

        // Cache track element references
        this.timelineTrack = this.container.querySelector('#epg-timeline-track');
        this.channelsTrack = this.container.querySelector('#epg-channels-track');
        this.programsTrack = this.container.querySelector('#epg-programs-track');
        this.nowIndicator = this.container.querySelector('#epg-now-indicator');
    }

    /**
     * Renders time slot labels across the timeline track.
     * @private
     * @returns {string} Compiled HTML string of timeline time slots
     */
    _renderTimelineLabels() {
        const labels = [];
        let time = new Date(this.startTime);
        while (time < this.endTime) {
            const timeStr = time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
            labels.push(`<div class="epg-time-slot" style="width: ${30 * this.PIXELS_PER_MINUTE}px;">${timeStr}</div>`);
            time = new Date(time.getTime() + 30 * 60 * 1000); // 30 minute increments
        }
        return labels.join('');
    }

    /**
     * Starts the on-demand render loop driven by state and scroll position changes.
     * Prevents continuous 60 FPS DOM updates when the grid is static.
     * @private
     */
    _startRenderLoop() {
        const tick = () => {
            if (this._isDestroyed) return;

            // Check if scroll position has changed by at least 1 pixel
            const scrollXChanged = Math.abs(this.scrollX - this._lastRenderScrollX) >= 1;
            const scrollYChanged = Math.abs(this.scrollY - this._lastRenderScrollY) >= 1;

            // Execute render step only when needed
            if (this._needsRender || scrollXChanged || scrollYChanged) {
                this._lastRenderScrollX = this.scrollX;
                this._lastRenderScrollY = this.scrollY;
                this._needsRender = false;

                this._updateIndicator();
                this._renderVirtualGrid();
            }

            requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
    }

    /**
     * Flags the component as needing a virtual grid recalculation and re-render.
     */
    requestRender() {
        this._needsRender = true;
    }

    /**
     * Virtualizes and renders channel rows and program blocks within the visible window.
     * @private
     */
    _renderVirtualGrid() {
        // 1. Calculate row window bounds with OVERSCAN to ensure smooth navigation
        const OVERSCAN = 3;
        const startRow = Math.max(0, Math.floor(this.scrollY / this.ROW_HEIGHT) - OVERSCAN);
        const endRow = Math.min(
            this.channels.length - 1,
            Math.ceil((this.scrollY + this.visibleHeight) / this.ROW_HEIGHT) + OVERSCAN
        );

        // 2. Clear virtual nodes outside the visible window using O(1) hash map lookup
        for (const [channelId, data] of this.domNodes.entries()) {
            const channelIndex = this.channelIndexMap.get(channelId);
            if (channelIndex === undefined || channelIndex < startRow || channelIndex > endRow) {
                if (data.rowEl.parentNode) this.programsTrack.removeChild(data.rowEl);
                if (data.channelEl.parentNode) this.channelsTrack.removeChild(data.channelEl);
                this.domNodes.delete(channelId);
            }
        }

        // 3. Render visible rows
        for (let i = startRow; i <= endRow; i++) {
            const channel = this.channels[i];
            if (channel && !this.domNodes.has(channel.Id)) {
                this._renderRow(i, channel);
            }
        }

        // 4. Update GPU-accelerated CSS transforms
        const scrollX = -this.scrollX;
        const scrollY = -this.scrollY;

        this.timelineTrack.style.transform = `translate3d(${scrollX}px, 0, 0)`;
        this.channelsTrack.style.transform = `translate3d(0, ${scrollY}px, 0)`;
        this.programsTrack.style.transform = `translate3d(${scrollX}px, ${scrollY}px, 0)`;

        // Update sticky title transforms
        this._updateStickyTitles();
    }

    /**
     * Updates sticky offsets for program titles so text remains readable when starting off-screen.
     * Incorporates dirty-checking to eliminate redundant inline style mutations.
     * @private
     */
    _updateStickyTitles() {
        const scrollX = this.scrollX;

        for (const data of this.domNodes.values()) {
            const programNodes = data.rowEl.children;
            for (let i = 0; i < programNodes.length; i++) {
                const progEl = programNodes[i];
                const contentEl = progEl._contentNode;
                if (!contentEl) continue;

                const left = progEl._epgLeft;
                const width = progEl._epgWidth;

                // Calculate hidden amount off-screen
                const hiddenAmount = Math.max(0, scrollX - left);
                const maxShift = Math.max(0, width - 60);
                const shift = Math.min(hiddenAmount, maxShift);

                // Dirty check: skip inline style mutation if offset is identical to previous frame
                if (progEl._lastShift !== shift) {
                    progEl._lastShift = shift;
                    if (shift > 0) {
                        contentEl.style.transform = `translate3d(${shift}px, 0, 0)`;
                        progEl._prefixNode?.classList.remove('hidden');
                    } else {
                        contentEl.style.transform = '';
                        progEl._prefixNode?.classList.add('hidden');
                    }
                }
            }
        }
    }

    /**
     * Renders a single channel row and its corresponding program track.
     * @private
     * @param {number} index - Channel row index
     * @param {Object} channel - Channel object
     */
    _renderRow(index, channel) {
        // =====================================================================
        // Channel Label Cell (Left Column)
        // =====================================================================
        const channelEl = document.createElement('div');
        channelEl.className = 'epg-channel-row';
        channelEl.style.position = 'absolute';
        channelEl.style.top = `${index * this.ROW_HEIGHT}px`;
        channelEl.style.width = '100%';
        channelEl.tabIndex = 0;
        channelEl.dataset.channelId = channel.Id;
        channelEl.dataset.rowIndex = String(index);
        
        channelEl.onclick = () => this._handleChannelClick(channel);
        channelEl.onfocus = () => this._handleChannelFocus(channelEl);

        // Logo selection priority
        let logoUrl = '';
        let logoTag = '';
        let imageType = 'Primary';

        if (channel.ImageTags) {
            if (channel.ImageTags.Logo) {
                logoTag = channel.ImageTags.Logo;
                imageType = 'Logo';
            } else if (channel.ImageTags.Primary) {
                logoTag = channel.ImageTags.Primary;
                imageType = 'Primary';
            }
        }

        if (logoTag) {
            const params = imageService.getParams('avatar', 'livetv');
            logoUrl = api.getImageUrl(channel.Id, imageType, {
                maxWidth: params.maxWidth,
                quality: params.quality,
                tag: logoTag
            });
        }

        const fallbackData = CardRenderer.getFallbackData(channel.Name);

        channelEl.innerHTML = `
            ${
                logoUrl
                    ? `<img class="epg-channel-logo" src="${logoUrl}" 
                        onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';" />`
                    : ''
            }
            <div class="epg-channel-logo-fallback grad-${fallbackData.gradNum}" 
                 style="${logoUrl ? 'display: none;' : 'display: flex;'}">
                ${escapeHtml(fallbackData.initials)}
            </div>
            <div class="epg-channel-info">
                <div class="epg-channel-name">${escapeHtml(channel.Name)}</div>
                <div class="epg-channel-number">${escapeHtml(channel.Number || '')}</div>
            </div>
        `;
        this.channelsTrack.appendChild(channelEl);

        // =====================================================================
        // Programs Row Container
        // =====================================================================
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

        // Render programs inside row
        this._renderProgramsInRow(channel.Id, rowEl, index);
    }

    /**
     * Renders program cells for a given channel row.
     * Incorporates horizontal virtualization to render only visible program elements.
     * @private
     * @param {string} channelId - Target channel ID
     * @param {HTMLElement} rowEl - Row DOM element container
     * @param {number} rowIndex - Channel row index
     */
    _renderProgramsInRow(channelId, rowEl, rowIndex) {
        rowEl.innerHTML = '';

        const programs = this.programsMap.get(channelId) || [];

        // Horizontal virtualization bounds with 400px overscan (~40 mins)
        const minX = this.scrollX - 400;
        const maxX = this.scrollX + (this.visibleWidth || 1280) + 400;

        programs.forEach((program) => {
            const left = this._getTimeOffset(new Date(program.StartDate));
            const width = this._getTimeDuration(new Date(program.StartDate), new Date(program.EndDate));

            // Skip DOM creation for programs outside the visible horizontal window
            if (left + width < minX || left > maxX) {
                return;
            }

            const progEl = document.createElement('div');
            progEl.className = 'epg-program';
            progEl.tabIndex = 0;
            progEl.style.left = `${left}px`;
            progEl.style.width = `${width}px`;
            progEl.dataset.programId = program.Id;
            progEl.dataset.channelId = channelId;
            progEl.dataset.rowIndex = rowIndex;
            
            progEl.__programData = program;
            progEl._epgLeft = left;
            progEl._epgWidth = width;

            progEl.innerHTML = `
                <div class="epg-program-content">
                    <div class="epg-program-title">
                        <span class="epg-program-prefix hidden">‹</span>
                        <span class="title-text">${escapeHtml(program.Name)}</span>
                    </div>
                    <div class="epg-program-time">${this._formatProgramTime(program)}</div>
                </div>
            `;

            progEl._contentNode = progEl.querySelector('.epg-program-content');
            progEl._prefixNode = progEl.querySelector('.epg-program-prefix');

            progEl.onclick = () => this._handleProgramClick(program);
            progEl.onfocus = () => this._handleProgramFocus(progEl);

            rowEl.appendChild(progEl);
        });
    }

    /**
     * Re-renders program cells for all currently visible virtual rows.
     * Called when background program loading completes.
     * @private
     */
    _reRenderAllVisibleRows() {
        for (const [channelId, data] of this.domNodes.entries()) {
            const rowIndex = this.channelIndexMap.get(channelId);
            if (rowIndex !== undefined && data.rowEl) {
                this._renderProgramsInRow(channelId, data.rowEl, rowIndex);
            }
        }
    }

    // =========================================================================
    // Focus & Interaction
    // =========================================================================

    /**
     * Registers the EPG section with FocusManager and wires navigation hooks.
     * @private
     */
    _setupFocus() {
        focusManager.register('epg-grid', this.container.querySelector('.epg-grid-container'), {
            selector: '.epg-program, .epg-channel-row',
            orientation: 'both',
            leaveUp: this.options.leaveUp || null,
            leaveLeft: this.options.leaveLeft || null,
            onMove: (direction) => {
                const nextEl = this._handleMove(direction);
                if (nextEl) {
                    this._focusedEl = nextEl;
                    // CRITICAL FIX: Pass skipScroll: true so FocusManager does NOT trigger outer
                    // page smooth scrolling on #livetv-scroll-container. EpgGrid manages its own
                    // virtual scrolling via transforms — outer scroll causes double-scrolling lockup!
                    focusManager.focusElement(nextEl, { skipScroll: true });
                    return true;
                }
                return false;
            }
        });
    }

    /**
     * Registers resize and wheel event handlers.
     * @private
     */
    _setupEventListeners() {
        window.addEventListener('resize', () => {
            this._updateVisibleDimensions();
            this.requestRender();
        });

        const gridContainer = this.container.querySelector('.epg-grid-container');
        if (gridContainer) {
            gridContainer.addEventListener(
                'wheel',
                (e) => {
                    e.preventDefault();
                    e.stopPropagation();

                    let deltaY = e.deltaY;
                    let deltaX = e.deltaX;

                    if (e.deltaMode === 1) {
                        deltaY *= 40;
                        deltaX *= 40;
                    } else if (e.deltaMode === 2) {
                        deltaY *= 800;
                        deltaX *= 800;
                    }

                    if (deltaY !== 0) {
                        const maxScrollY = Math.max(0, this.channels.length * this.ROW_HEIGHT - this.visibleHeight);
                        this.scrollY = Math.max(0, Math.min(this.scrollY + deltaY, maxScrollY));
                    }

                    if (deltaX !== 0) {
                        const maxScrollX = Math.max(0, 8 * this.PIXELS_PER_HOUR - this.visibleWidth);
                        this.scrollX = Math.max(0, Math.min(this.scrollX + deltaX, maxScrollX));
                    }

                    this.requestRender();
                },
                { passive: false }
            );
        }
    }

    /**
     * Handles spatial movement calculations when navigating via D-pad.
     * @private
     * @param {string} direction - Nav direction ('up', 'down', 'left', 'right')
     * @returns {HTMLElement|null} Target element to receive focus
     */
    _handleMove(direction) {
        const current = this._focusedEl;
        if (!current) return null;

        const isChannelRow = current.classList.contains('epg-channel-row');
        const isProgram = current.classList.contains('epg-program');

        if (!isChannelRow && !isProgram) return null;

        const channelId = current.dataset.channelId;
        const rowIndex = parseInt(current.dataset.rowIndex, 10);

        // =================================================================
        // Movement from Left Channel Column
        // =================================================================
        if (isChannelRow) {
            if (direction === 'up' || direction === 'down') {
                const nextRowIndex = direction === 'down' ? rowIndex + 1 : rowIndex - 1;

                if (nextRowIndex < 0) {
                    if (this.options.leaveUp) {
                        focusManager.setActiveSection(this.options.leaveUp);
                    }
                    return null;
                }

                if (nextRowIndex < this.channels.length) {
                    this._scrollChannelIntoView(nextRowIndex);

                    const nextChannel = this.channels[nextRowIndex];
                    if (!this.domNodes.has(nextChannel.Id)) {
                        this._renderRow(nextRowIndex, nextChannel);
                    }

                    const data = this.domNodes.get(nextChannel.Id);
                    if (data && data.channelEl) {
                        return data.channelEl;
                    }
                }
            } else if (direction === 'right') {
                const programs = this.programsMap.get(channelId) || [];
                const now = Date.now();
                const target =
                    programs.find(
                        (p) => now >= new Date(p.StartDate).getTime() && now < new Date(p.EndDate).getTime()
                    ) ||
                    programs.find((p) => new Date(p.StartDate).getTime() > now) ||
                    programs[0];

                if (target) {
                    const el = this._findProgramEl(channelId, target.Id);
                    if (el) {
                        this._scrollIntoView(el);
                        return el;
                    }
                }
                return null;
            } else if (direction === 'left') {
                if (this.options.leaveLeft) {
                    focusManager.setActiveSection(this.options.leaveLeft);
                }
                return null;
            }
            return null;
        }

        // =================================================================
        // Movement from Program Grid
        // =================================================================
        const program = current.__programData;
        let nextEl = null;

        if (direction === 'left') {
            const programs = this.programsMap.get(channelId) || [];
            const idx = programs.findIndex((p) => p.Id === program.Id);
            if (idx > 0) {
                nextEl = this._findProgramEl(channelId, programs[idx - 1].Id);
            } else {
                const data = this.domNodes.get(channelId);
                if (data && data.channelEl) {
                    this._scrollChannelIntoView(rowIndex);
                    return data.channelEl;
                }
            }
        } else if (direction === 'right') {
            const programs = this.programsMap.get(channelId) || [];
            const idx = programs.findIndex((p) => p.Id === program.Id);
            if (idx >= 0 && idx + 1 < programs.length) {
                nextEl = this._findProgramEl(channelId, programs[idx + 1].Id);
            }
        } else {
            const nextRowIndex = direction === 'down' ? rowIndex + 1 : rowIndex - 1;
            if (nextRowIndex >= 0 && nextRowIndex < this.channels.length) {
                const nextChannel = this.channels[nextRowIndex];

                this._scrollChannelIntoView(nextRowIndex);
                if (!this.domNodes.has(nextChannel.Id)) {
                    this._renderRow(nextRowIndex, nextChannel);
                }

                const nextRowPrograms = this.programsMap.get(nextChannel.Id) || [];
                const midTime =
                    new Date(program.StartDate).getTime() +
                    (new Date(program.EndDate).getTime() - new Date(program.StartDate).getTime()) / 2;

                const overlapping = nextRowPrograms.find((p) => {
                    const start = new Date(p.StartDate).getTime();
                    const end = new Date(p.EndDate).getTime();
                    return midTime >= start && midTime < end;
                });

                if (overlapping) {
                    nextEl = this._findProgramEl(nextChannel.Id, overlapping.Id);
                } else if (nextRowPrograms.length === 0) {
                    const data = this.domNodes.get(nextChannel.Id);
                    if (data && data.channelEl) {
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

    /**
     * Finds the DOM element for a given channel and program ID.
     * @private
     */
    _findProgramEl(channelId, programId) {
        const data = this.domNodes.get(channelId);
        if (data) {
            return data.rowEl.querySelector(`[data-program-id="${programId}"]`);
        }
        return null;
    }

    /**
     * Handles program focus event.
     * @private
     */
    _handleProgramFocus(el) {
        this._focusedEl = el;
        const program = el.__programData;
        eventBus.emit('epg:programFocused', program);
    }

    /**
     * Handles channel cell focus event.
     * @private
     */
    _handleChannelFocus(el) {
        this._focusedEl = el;
        const channelIndex = parseInt(el.dataset.rowIndex, 10);
        const channel = this.channels[channelIndex];
        if (channel) {
            eventBus.emit('epg:channelFocused', channel);
        }
    }

    /**
     * Handles channel cell click or enter key press to trigger channel playback.
     * @private
     */
    _handleChannelClick(channel) {
        log.info('Channel clicked from EPG column:', channel.Name);
        eventBus.emit('player:play', {
            item: { Id: channel.Id, Type: 'TvChannel' }
        });
    }

    /**
     * Scrolls the virtual view vertically to center the specified channel row index.
     * @private
     */
    _scrollChannelIntoView(rowIndex) {
        const top = rowIndex * this.ROW_HEIGHT;

        if (top < this.scrollY + 50) {
            this.scrollY = Math.max(0, top - 50);
            this.requestRender();
        } else if (top + this.ROW_HEIGHT > this.scrollY + this.visibleHeight - 50) {
            this.scrollY = top + this.ROW_HEIGHT - this.visibleHeight + 50;
            this.requestRender();
        }
    }

    /**
     * Scrolls the virtual view to make the specified program element visible.
     * @private
     */
    _scrollIntoView(el) {
        const left = parseInt(el.style.left, 10);
        const width = parseInt(el.style.width, 10);
        const rowIndex = parseInt(el.dataset.rowIndex, 10);
        const top = rowIndex * this.ROW_HEIGHT;

        const paddingX = 100;

        if (left < this.scrollX + paddingX) {
            this.scrollX = Math.max(0, left - paddingX);
            this.requestRender();
        } else if (left + width > this.scrollX + this.visibleWidth - paddingX) {
            this.scrollX = left + width - this.visibleWidth + paddingX;
            this.requestRender();
        }

        if (top < this.scrollY) {
            this.scrollY = top;
            this.requestRender();
        } else if (top + this.ROW_HEIGHT > this.scrollY + this.visibleHeight) {
            this.scrollY = top + this.ROW_HEIGHT - this.visibleHeight;
            this.requestRender();
        }
    }

    /**
     * Sets initial focus onto the currently airing program or channel cell.
     * @private
     */
    _focusNow() {
        const now = new Date();
        const startRow = Math.floor(this.scrollY / this.ROW_HEIGHT);
        const channel = this.channels[startRow] || this.channels[0];
        if (!channel) return;

        const programs = this.programsMap.get(channel.Id) || [];
        const current = programs.find((p) => {
            const start = new Date(p.StartDate).getTime();
            const end = new Date(p.EndDate).getTime();
            return now.getTime() >= start && now.getTime() < end;
        });

        if (current) {
            const el = this._findProgramEl(channel.Id, current.Id);
            if (el) {
                this._focusedEl = el;
                focusManager.focusElement(el, { skipScroll: true });
                return;
            }
        }

        const data = this.domNodes.get(channel.Id);
        if (data && data.channelEl) {
            this._focusedEl = data.channelEl;
            focusManager.focusElement(data.channelEl, { skipScroll: true });
        }
    }

    // =========================================================================
    // Data Management
    // =========================================================================

    /**
     * Fetches Live TV programs for all channels in parallel batches.
     * @private
     */
    async _loadPrograms() {
        const BATCH_SIZE = 50;
        const allChannelIds = this.channels.map((c) => c.Id);

        const batches = [];
        for (let i = 0; i < allChannelIds.length; i += BATCH_SIZE) {
            batches.push(allChannelIds.slice(i, i + BATCH_SIZE));
        }

        log.debug(
            `[EPG] Fetching programs for ${allChannelIds.length} channels in ${batches.length} batch(es) of ${BATCH_SIZE}`
        );

        const batchResults = await Promise.all(
            batches.map((batchIds) =>
                api.getLiveTvPrograms({
                    userId: api.userId,
                    channelIds: batchIds.join(','),
                    hasStartDate: true,
                    hasEndDate: true,
                    startDate: this.startTime.toISOString(),
                    endDate: this.endTime.toISOString(),
                    fields: 'Overview'
                })
            )
        );

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

    /**
     * Computes rounded start time for timeline headers.
     * @private
     */
    _getRoundStartTime() {
        const now = new Date();
        now.setMinutes(now.getMinutes() >= 30 ? 30 : 0);
        now.setSeconds(0);
        now.setMilliseconds(0);
        return new Date(now.getTime() - 2 * 60 * 60 * 1000); // 2 hours back
    }

    /**
     * Centers horizontal view offset around current time.
     * @private
     */
    _scrollToNow() {
        const now = new Date();
        const offset = this._getTimeOffset(now);
        this.scrollX = Math.max(0, offset - 300);
    }

    /**
     * Updates indicator position for current time line.
     * @private
     */
    _updateIndicator() {
        if (!this.nowIndicator) return;
        const now = new Date();
        const offset = this._getTimeOffset(now);
        this.nowIndicator.style.left = `${offset}px`;
        this.nowIndicator.style.transform = `translate3d(${-this.scrollX}px, 0, 0)`;
    }

    /**
     * Calculates pixel offset from start time for a given date.
     * @private
     */
    _getTimeOffset(date) {
        const diffMs = date.getTime() - this.startTime.getTime();
        const diffMins = diffMs / 1000 / 60;
        return diffMins * this.PIXELS_PER_MINUTE;
    }

    /**
     * Calculates duration in pixels for a start and end date range.
     * @private
     */
    _getTimeDuration(start, end) {
        const diffMs = end.getTime() - start.getTime();
        const diffMins = diffMs / 1000 / 60;
        return diffMins * this.PIXELS_PER_MINUTE;
    }

    /**
     * Updates viewport dimensions for virtualization bounds calculations.
     * @private
     */
    _updateVisibleDimensions() {
        const gridContainer = this.container.querySelector('.epg-grid-container');
        const el = gridContainer || this.container;
        if (el) {
            this.visibleHeight = (el.clientHeight || 600) - 60;
            this.visibleWidth = (el.clientWidth || 1280) - 250;
        }
    }

    /**
     * Formats start and end times into a readable time range string.
     * @private
     */
    _formatProgramTime(program) {
        const start = new Date(program.StartDate).toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit',
            hour12: false
        });
        const end = new Date(program.EndDate).toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit',
            hour12: false
        });
        return `${start} - ${end}`;
    }

    /**
     * Emits play event when program block is selected.
     * @private
     */
    _handleProgramClick(program) {
        log.info('Program clicked:', program.Name);
        eventBus.emit('player:play', {
            item: {
                Id: program.ChannelId,
                Type: 'TvChannel'
            }
        });
    }
}

export default EpgGrid;
