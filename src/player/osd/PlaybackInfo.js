import BaseMenu from './BaseMenu.js';
import { osdIcons } from '../../utils/Icons.js';
import { MediaHelper } from '../core/MediaHelper.js';
import { PlayerSettings } from '../../utils/PlayerSettings.js';
import { i18n } from '../../utils/i18n.js';
import { platformInfo } from '../../utils/PlatformInfo.js';

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
        // ====================================================================
        // Close Icon Mapping
        // ====================================================================
        // We reference the unified close icon directly.
        const closeIcon = osdIcons.close;
        const html = `
            <div id="osdPlaybackInfoOverlay" class="playback-info-overlay">
                <div class="playback-info-header">
                    <span class="playback-info-title">${i18n.t('LabelPlaybackInfo')}</span>
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
            this.$el.querySelector('.playback-info-close').addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
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
        if (this.player.backendType === 'webos' || platformInfo.isWebOS) {
            playerType = 'WebOS Player';
        } else if (this.player.backendType === 'tizen') {
            playerType = 'Tizen AVPlayer';
        } else if (this.player.backendType === 'html5') {
            playerType = 'Html Player';
        } else {
            playerType = this.player.useTizenPlayer ? 'Tizen AVPlayer' : 'Html Player';
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

        // Frame rate — prefer AverageFrameRate; fall back to RealFrameRate
        const frameRateRaw = videoStream?.AverageFrameRate || videoStream?.RealFrameRate;
        const frameRateDisplay = frameRateRaw
            ? parseFloat(frameRateRaw).toFixed(3) + ' fps'
            : i18n.t('None');

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
        let displayPlayMethod = playMethod;
        if (playMethod === 'DirectPlay') {
            displayPlayMethod = i18n.t('DirectPlaying');
        } else if (playMethod === 'Remux') {
            displayPlayMethod = i18n.t('Remuxing');
        } else if (playMethod === 'DirectStream') {
            displayPlayMethod = i18n.t('DirectStreaming');
        } else if (playMethod === 'Transcode') {
            displayPlayMethod = i18n.t('Transcoding');
        }
        
        // Fetch the user-friendly name of the current active subtitle renderer engine
        const subtitleRenderer = this.player.getSubtitleRendererName ? this.player.getSubtitleRendererName() : i18n.t('None');

        html += createSection('', [
            { label: i18n.t('LabelPlayer'), value: playerType },
            { label: i18n.t('LabelPlayMethod'), value: displayPlayMethod },
            { label: i18n.t('LabelProtocol'), value: protocol },
            { label: i18n.t('LabelStreamType'), value: streamType },
            // Display the current subtitle rendering pipeline as a dedicated field
            { label: i18n.t('LabelSubtitleRenderer') || 'Subtitle Renderer', value: subtitleRenderer }
        ]);

        html += createSection(i18n.t('LabelVideoInfo'), [
            { label: i18n.t('LabelPlayerDimensions'), value: playerDimensions },
            { label: i18n.t('LabelVideoResolution'), value: videoRes },
            { label: i18n.t('LabelFrameRate'), value: frameRateDisplay },
            { label: i18n.t('LabelDroppedFrames'), value: droppedFrames },
            { label: i18n.t('LabelCorruptedFrames'), value: corruptedFrames }
        ]);

        if (playMethod !== 'DirectPlay') {
            const { isVideoDirect, isAudioDirect } = MediaHelper.getTranscodeStatus(mediaSource);

            // Parse output codec and bitrate from the TranscodingUrl query string.
            // The server always includes these params, so we use them to show what
            // the stream is actually being transcoded TO (e.g. DTS → AAC @ 256 kbps).
            const transUrl = mediaSource?.TranscodingUrl || '';
            const outVideoCodec  = (transUrl.match(/[?&]VideoCodec=([^&]+)/) || [])[1]?.split(',')[0]?.toUpperCase();
            const outAudioCodec  = (transUrl.match(/[?&]AudioCodec=([^&]+)/) || [])[1]?.split(',')[0]?.toUpperCase();
            const outAudioBpsRaw = parseFloat((transUrl.match(/[?&]AudioBitrate=([^&]+)/) || [])[1]);
            const outAudioBps    = outAudioBpsRaw ? (outAudioBpsRaw / 1000).toFixed(0) + ' kbps' : null;

            // Build human-readable codec strings: "SRC (copy)" or "SRC → OUT @ BITRATE"
            const srcVideo = videoStream?.Codec?.toUpperCase() || i18n.t('None');
            const srcAudio = activeAudioStream?.Codec?.toUpperCase() || i18n.t('None');
            const vCodecLabel = isVideoDirect
                ? `${srcVideo} (copy)`
                : `${srcVideo} → ${outVideoCodec || '?'}`;
            const aCodecLabel = isAudioDirect
                ? `${srcAudio} (copy)`
                : `${srcAudio} → ${outAudioCodec || '?'}${outAudioBps ? ' @ ' + outAudioBps : ''}`;

            // Show the bitrate cap that triggered transcoding (or manual user override)
            const manualBitrate = this.player.getMaxBitrate();
            const globalBitrate = PlayerSettings.get('maxBitrateInternet');
            const effectiveLimit = manualBitrate || globalBitrate;
            const limitDisplay = effectiveLimit ? (effectiveLimit / 1000000).toFixed(1) + ' Mbps' : i18n.t('Unlimited');

            // Parse and display the exact transcode reasons from the server
            const reasonsMatch = transUrl.match(/[?&]TranscodeReasons=([^&]+)/);
            const reasonsDisplay = reasonsMatch
                ? decodeURIComponent(reasonsMatch[1])
                    .split(',')
                    .map(r => r.trim())
                    .join(', ')
                : null;

            const transFields = [
                { label: i18n.t('LabelVideoCodec'), value: vCodecLabel },
                { label: i18n.t('LabelAudioCodec'), value: aCodecLabel },
                { label: i18n.t('LabelRemoteClientBitrateLimit'), value: limitDisplay }
            ];

            if (reasonsDisplay) {
                transFields.push({
                    label: i18n.t('LabelTranscodeReasons') || 'Transcode Reason',
                    value: reasonsDisplay
                });
            }

            html += createSection(i18n.t('LabelTranscodingInfo'), transFields);
        }

        if (mediaSource) {
            const sizeMb = mediaSource.Size ? (mediaSource.Size / (1024 * 1024)).toFixed(1) + ' MiB' : i18n.t('None');
            const totalBitrateVal = getBitrate(mediaSource);
            const totalBitrate = totalBitrateVal ? (totalBitrateVal / 1000000).toFixed(1) + ' Mbps' : i18n.t('None');
            
            const vBitrateVal = getBitrate(videoStream) || totalBitrateVal;
            const videoBitrate = vBitrateVal ? (vBitrateVal / 1000000).toFixed(1) + ' Mbps' : i18n.t('None');

            const aBitrateVal = getBitrate(activeAudioStream);
            const audioBitrate = aBitrateVal ? (aBitrateVal / 1000).toFixed(0) + ' kbps' : i18n.t('None');
            
            html += createSection(i18n.t('LabelOriginalMediaInfo'), [
                { label: i18n.t('LabelProfileContainer'), value: mediaSource.Container || i18n.t('None') },
                { label: i18n.t('LabelSize'), value: sizeMb },
                { label: i18n.t('LabelBitrate'), value: totalBitrate },
                { label: i18n.t('LabelVideoCodec'), value: (videoStream?.Codec?.toUpperCase() || i18n.t('None')) + (videoStream?.Profile ? ' ' + videoStream.Profile : '') },
                { label: i18n.t('LabelVideoBitrate'), value: videoBitrate },
                // VideoRangeType is the detailed string ("HDR10", "HDR10Plus", "DOVI",
                // "DOVIWithHDR10Plus", etc.) reported by the server from the file's codec
                // metadata. VideoRange is a coarse integer enum that only resolves to
                // "HDR" or "SDR" — useless for diagnosing which HDR format is active.
                { label: i18n.t('LabelVideoRangeType'), value: videoStream?.VideoRangeType || videoStream?.VideoRange || 'SDR' },
                { label: i18n.t('LabelAudioCodec'), value: (activeAudioStream?.Codec?.toUpperCase() || i18n.t('None')) + (activeAudioStream?.Profile ? ' ' + activeAudioStream.Profile : '') },
                { label: i18n.t('LabelAudioBitrate'), value: audioBitrate },
                { label: i18n.t('LabelAudioChannels'), value: activeAudioStream?.Channels || i18n.t('None') },
                { label: i18n.t('LabelAudioSampleRate'), value: activeAudioStream?.SampleRate ? activeAudioStream.SampleRate + ' Hz' : i18n.t('None') }
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
            case 'back':
                this.osd.togglePlaybackInfo(false);
                return true;
        }
        return true; 
    }
}