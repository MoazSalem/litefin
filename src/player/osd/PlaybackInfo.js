import BaseMenu from './BaseMenu.js';
import { ICONS } from './icons.js';

/**
 * PlaybackInfo
 * 
 * Displays technical details about the current media playback.
 * Renders an overlay containing:
 * - Player source type (DirectPlay, Transcoding, etc.).
 * - Video/Audio stream details (Codec, Bitrate, Resolution).
 * - Original media container info.
 * - Dropped frames and player dimensions.
 */
export default class PlaybackInfo extends BaseMenu {
    constructor(osdController) {
        super(osdController);
        this.isModal = false; // Persistent widget
    }

    toggle(show) {
        if (show) {
            this.isVisible = true;

            // Render if missing
            if (!this.$el) {
                this.render();
            }

            this.$el.classList.add('visible');
            this.update();
            this.ignoreInputUntil = Date.now() + 300; // Debounce input to prevent immediate close on open
        } else {
            this.isVisible = false;
            if (this.$el) {
                this.$el.classList.remove('visible');
            }
        }
    }

    render() {
        const closeIcon = ICONS.close;
        const html = `
            <div id="osdPlaybackInfoOverlay" class="playback-info-overlay">
                <div class="playback-info-header">
                    <span class="playback-info-title">Playback Info</span>
                    <button class="playback-info-close" data-action="closePlaybackInfo" tabindex="0">${closeIcon}</button>
                </div>
                <div class="playback-info-content" id="playbackInfoContent">
                    <!-- Sections will be rendered here -->
                </div>
            </div>
        `;
        
        const overlays = this.osd._osdEl.querySelector('.osd-overlays');
        if (overlays) {
            const temp = document.createElement('div');
            temp.innerHTML = html;
            this.$el = temp.firstElementChild;
            overlays.appendChild(this.$el);

            // Bind close button
            this.$el.querySelector('.playback-info-close').addEventListener('click', () => {
                this.osd.togglePlaybackInfo(false);
            });
        }
    }

    update() {
        if (!this.isVisible || !this.player || !this.$el) return;

        const contentEl = this.$el.querySelector('#playbackInfoContent');
        if (!contentEl) return;

        const mediaSource = this.player.getCurrentMediaSource();
        const playMethod = mediaSource?.PlayMethod || 'DirectPlay';
        const playerType = this.player.useTizenPlayer ? 'Tizen AVPlayer' : 'Html Video Player';
        const api = this.osd.api;
        const protocol = api?.serverUrl?.startsWith('https') ? 'https' : 'http';
        const streamType = this.player.getStreamType ? this.player.getStreamType() : 'Video';

        const getBitrate = (obj) => obj?.Bitrate || obj?.bitrate || obj?.AverageBitrate || obj?.averageBitrate || obj?.BitRate || 0;

        // Video Info
        const containerRect = this.player.container?.getBoundingClientRect();
        const playerDimensions = containerRect ? `${Math.round(containerRect.width)}x${Math.round(containerRect.height)}` : 'N/A';
        
        let videoRes = 'N/A';
        let droppedFrames = 0;
        let corruptedFrames = 0;

        const streams = mediaSource?.MediaStreams || [];
        const videoStream = streams.find(s => s.Type?.toLowerCase() === 'video');
        
        const audioIndex = this.player.getCurrentAudioStreamIndex ? this.player.getCurrentAudioStreamIndex() : -1;
        let activeAudioStream = streams.find(s => s.Type?.toLowerCase() === 'audio' && s.Index == audioIndex) 
                             || streams.find(s => s.Type?.toLowerCase() === 'audio');

        if (activeAudioStream && !getBitrate(activeAudioStream)) {
            const streamWithBitrate = streams.find(s => s.Type?.toLowerCase() === 'audio' && getBitrate(s));
            if (streamWithBitrate) activeAudioStream = streamWithBitrate;
        }

        if (!this.player.useTizenPlayer) {
            const video = this.player._backend?._videoElement; 
            if (video) {
                videoRes = `${video.videoWidth}x${video.videoHeight}`;
                if (video.getVideoPlaybackQuality) {
                    const quality = video.getVideoPlaybackQuality();
                    droppedFrames = quality.droppedVideoFrames;
                    corruptedFrames = quality.corruptedVideoFrames || 0;
                }
            }
        } else {
            if (videoStream) {
                videoRes = `${videoStream.Width || videoStream.width || '?' }x${videoStream.Height || videoStream.height || '?'}`;
            }
        }

        const createSection = (title, fields) => `
            <div class="pi-section">
                ${title ? `<div class="pi-section-title">${title}</div>` : ''}
                ${fields.map(f => `
                    <div class="pi-row">
                        <span class="pi-label">${f.label}</span>
                        <span class="pi-value">${f.value}</span>
                    </div>
                `).join('')}
            </div>
        `;

        let html = '';
        const displayPlayMethod = playMethod === 'DirectStream' ? 'Remuxing' : playMethod;
        
        html += createSection('', [
            { label: 'Player', value: playerType },
            { label: 'Play method', value: displayPlayMethod },
            { label: 'Protocol', value: protocol },
            { label: 'Stream type', value: streamType }
        ]);

        html += createSection('Video Info', [
            { label: 'Player dimensions', value: playerDimensions },
            { label: 'Video resolution', value: videoRes },
            { label: 'Dropped frames', value: droppedFrames },
            { label: 'Corrupted frames', value: corruptedFrames }
        ]);

        if (playMethod !== 'DirectPlay') {
            const vMethod = playMethod === 'DirectStream' ? 'direct' : 'transcode';
            const aMethod = playMethod === 'DirectStream' ? 'direct' : 'transcode';
            
            html += createSection(`${displayPlayMethod} Info`, [
                { label: 'Video codec', value: `${videoStream?.Codec?.toUpperCase() || 'N/A'} (${vMethod})` },
                { label: 'Audio codec', value: `${activeAudioStream?.Codec?.toUpperCase() || 'N/A'} (${aMethod})` }
            ]);
        }

        if (mediaSource) {
            const sizeMb = mediaSource.Size ? (mediaSource.Size / (1024 * 1024)).toFixed(1) + ' MiB' : 'N/A';
            const totalBitrateVal = getBitrate(mediaSource);
            const totalBitrate = totalBitrateVal ? (totalBitrateVal / 1000000).toFixed(1) + ' Mbps' : 'N/A';
            
            const vBitrateVal = getBitrate(videoStream) || totalBitrateVal;
            const videoBitrate = vBitrateVal ? (vBitrateVal / 1000000).toFixed(1) + ' Mbps' : 'N/A';

            const aBitrateVal = getBitrate(activeAudioStream);
            const audioBitrate = aBitrateVal ? (aBitrateVal / 1000).toFixed(0) + ' kbps' : 'N/A';
            
            html += createSection('Original Media Info', [
                { label: 'Container', value: mediaSource.Container || 'N/A' },
                { label: 'Size', value: sizeMb },
                { label: 'Bitrate', value: totalBitrate },
                { label: 'Video codec', value: videoStream?.Codec?.toUpperCase() + (videoStream?.Profile ? ' ' + videoStream.Profile : '') },
                { label: 'Video bitrate', value: videoBitrate },
                { label: 'Video range type', value: videoStream?.VideoRange || 'SDR' },
                { label: 'Audio codec', value: activeAudioStream?.Codec?.toUpperCase() + (activeAudioStream?.Profile ? ' ' + activeAudioStream.Profile : '') },
                { label: 'Audio bitrate', value: audioBitrate },
                { label: 'Audio channels', value: activeAudioStream?.Channels || 'N/A' },
                { label: 'Audio sample rate', value: activeAudioStream?.SampleRate ? activeAudioStream.SampleRate + ' Hz' : 'N/A' }
            ]);
        }

        contentEl.innerHTML = html;
    }

    handleKey(key) {
        if (!this.isVisible) return false;
        if (this.ignoreInputUntil && Date.now() < this.ignoreInputUntil) return true;

        const currentEl = this.osd._cachedOverlayRow[this.osd._currentFocusIndex];
        const isClose = currentEl?.classList.contains('playback-info-close');

        switch (key) {
            case 'left':
                if (isClose) {
                    // 1. Try Offset Close
                    const idx = this.osd._cachedOverlayRow.findIndex(el => el.classList.contains('osd-offset-close'));
                    if (idx !== -1) {
                        this.osd._currentFocusIndex = idx;
                        this.osd.activeMenu = this.osd.subtitleOffset; // Switch control to SubtitleOffset
                        this.osd._updateFocus();
                        return true;
                    }
                    // 2. Go to Player Close (Header)
                    this.osd._currentFocusRow = 0;
                    this.osd._currentFocusIndex = 0;
                    this.osd.activeMenu = null; // Return to main OSD
                    this.osd.show(); // Ensure OSD is visible
                    this.osd._updateFocus();
                    return true;
                }
                return true;
            case 'down': {
                // Go to Play/Pause (Controls Row 1), usually index ~2
                this.osd._currentFocusRow = 1;
                // Find index of togglePlay
                const playIdx = this.osd._findActionIndex('togglePlay');
                this.osd._currentFocusIndex = playIdx !== -1 ? playIdx : 2; 
                this.osd.show(); // Ensure OSD is visible
                this.osd._updateFocus();
                return true;
            }
            case 'enter':
                if (isClose) {
                    this.osd.togglePlaybackInfo(false);
                }
                return true;
            case 'back':
                this.osd.togglePlaybackInfo(false);
                return true;
        }
        return true; 
    }
}