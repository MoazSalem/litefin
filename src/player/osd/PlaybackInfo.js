import BaseMenu from './BaseMenu.js';
import { ICONS } from './icons.js';
import { MediaHelper } from '../core/MediaHelper.js';
import { PlayerSettings } from '../../utils/PlayerSettings.js';
import { i18n } from '../../utils/i18n.js';

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
            
            // Force update to ensure fresh data
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
                    <span class="playback-info-title">${i18n.t('PlaybackInfo')}</span>
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

        // Auto-update on relevant player events
        this._onPlayerUpdate = () => {
             if (this.isVisible) this.update();
        };

        if (this.player) {
            this.player.on('playbackstart', this._onPlayerUpdate);
            this.player.on('mediastreamschange', this._onPlayerUpdate);
        }
    }

    destroy() {
        if (this.player && this._onPlayerUpdate) {
            this.player.off('playbackstart', this._onPlayerUpdate);
            this.player.off('mediastreamschange', this._onPlayerUpdate);
        }
        if (this.$el && this.$el.parentNode) {
            this.$el.parentNode.removeChild(this.$el);
        }
    }

    update() {
        if (!this.isVisible || !this.player || !this.$el) return;

        const contentEl = this.$el.querySelector('#playbackInfoContent');
        if (!contentEl) return;

        const mediaSource = this.player.getCurrentMediaSource();
        const playMethod = mediaSource ? MediaHelper.getPlayMethod(mediaSource) : 'DirectPlay';
        
        // Use actual backend type if available, otherwise fall back to config
        let playerType = i18n.t('Unknown');
        if (this.player.backendType === 'tizen') {
            playerType = 'Tizen AVPlayer';
        } else if (this.player.backendType === 'html5') {
            playerType = 'Html Video Player';
        } else {
            playerType = this.player.useTizenPlayer ? 'Tizen AVPlayer' : 'Html Video Player';
        }

        const api = this.osd.api;
        const protocol = api?.serverUrl?.startsWith('https') ? 'https' : 'http';
        const streamType = this.player.getStreamType ? this.player.getStreamType() : i18n.t('Video');

        const getBitrate = (obj) => obj?.Bitrate || obj?.bitrate || obj?.AverageBitrate || obj?.averageBitrate || obj?.BitRate || 0;

        // Video Info
        const containerRect = this.player.container?.getBoundingClientRect();
        const playerDimensions = containerRect ? `${Math.round(containerRect.width)}x${Math.round(containerRect.height)}` : i18n.t('None');
        
        let videoRes = i18n.t('None');
        let droppedFrames = 0;
        let corruptedFrames = 0;

        const streams = mediaSource?.MediaStreams || [];
        const videoStream = streams.find(s => s.Type?.toLowerCase() === 'video');
        
        const audioIndex = this.player.getCurrentAudioStreamIndex ? this.player.getCurrentAudioStreamIndex() : -1;
        let activeAudioStream = streams.find(s => s.Type?.toLowerCase() === 'audio' && s.Index === audioIndex) 
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
            { label: i18n.t('Player'), value: playerType },
            { label: i18n.t('PlayMethod'), value: displayPlayMethod },
            { label: i18n.t('Protocol'), value: protocol },
            { label: i18n.t('StreamType'), value: streamType }
        ]);

        html += createSection(i18n.t('VideoInfo'), [
            { label: i18n.t('PlayerDimensions'), value: playerDimensions },
            { label: i18n.t('VideoResolution'), value: videoRes },
            { label: i18n.t('DroppedFrames'), value: droppedFrames },
            { label: i18n.t('CorruptedFrames'), value: corruptedFrames }
        ]);

        if (playMethod !== 'DirectPlay') {
            const vMethod = playMethod === 'DirectStream' ? 'direct' : 'transcode';
            const aMethod = playMethod === 'DirectStream' ? 'direct' : 'transcode';
            
            // Show the limit that triggered transcoding (or the manual override)
            const manualBitrate = this.player.getMaxBitrate(); 
            const globalBitrate = PlayerSettings.get('maxBitrateInternet');
            const effectiveLimit = manualBitrate || globalBitrate;
            const limitDisplay = effectiveLimit ? (effectiveLimit / 1000000).toFixed(1) + ' Mbps' : i18n.t('Unlimited');

            html += createSection(i18n.t('TrackIndex', displayPlayMethod) + ` ${i18n.t('Information')}`, [ // Reusing TrackIndex format if it fits, or just title
                { label: i18n.t('VideoCodec'), value: `${videoStream?.Codec?.toUpperCase() || i18n.t('None')} (${vMethod})` },
                { label: i18n.t('AudioCodec'), value: `${activeAudioStream?.Codec?.toUpperCase() || i18n.t('None')} (${aMethod})` },
                { label: i18n.t('BitrateLimit'), value: limitDisplay }
            ]);
        }

        if (mediaSource) {
            const sizeMb = mediaSource.Size ? (mediaSource.Size / (1024 * 1024)).toFixed(1) + ' MiB' : i18n.t('None');
            const totalBitrateVal = getBitrate(mediaSource);
            const totalBitrate = totalBitrateVal ? (totalBitrateVal / 1000000).toFixed(1) + ' Mbps' : i18n.t('None');
            
            const vBitrateVal = getBitrate(videoStream) || totalBitrateVal;
            const videoBitrate = vBitrateVal ? (vBitrateVal / 1000000).toFixed(1) + ' Mbps' : i18n.t('None');

            const aBitrateVal = getBitrate(activeAudioStream);
            const audioBitrate = aBitrateVal ? (aBitrateVal / 1000).toFixed(0) + ' kbps' : i18n.t('None');
            
            html += createSection(i18n.t('OriginalMediaInfo'), [
                { label: i18n.t('Container'), value: mediaSource.Container || i18n.t('None') },
                { label: i18n.t('Size'), value: sizeMb },
                { label: i18n.t('Bitrate'), value: totalBitrate },
                { label: i18n.t('VideoCodec'), value: (videoStream?.Codec?.toUpperCase() || i18n.t('None')) + (videoStream?.Profile ? ' ' + videoStream.Profile : '') },
                { label: i18n.t('VideoBitrate'), value: videoBitrate },
                { label: i18n.t('VideoRangeType'), value: videoStream?.VideoRange || 'SDR' },
                { label: i18n.t('AudioCodec'), value: (activeAudioStream?.Codec?.toUpperCase() || i18n.t('None')) + (activeAudioStream?.Profile ? ' ' + activeAudioStream.Profile : '') },
                { label: i18n.t('AudioBitrate'), value: audioBitrate },
                { label: i18n.t('AudioChannels'), value: activeAudioStream?.Channels || i18n.t('None') },
                { label: i18n.t('AudioSampleRate'), value: activeAudioStream?.SampleRate ? activeAudioStream.SampleRate + ' Hz' : i18n.t('None') }
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
            case 'right': {
                const isRTL = document.documentElement.dir === 'rtl';
                const isEscapeKey = (isRTL && key === 'right') || (!isRTL && key === 'left');

                if (isEscapeKey && isClose) {
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
            }
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