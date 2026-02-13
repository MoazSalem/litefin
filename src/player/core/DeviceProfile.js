/**
 * DeviceProfile - Browser/Device Capability Detection
 *
 * Simplified device profile for capability reporting to Jellyfin server.
 * Determines supported codecs, containers, and transcoding requirements.
 *
 * @module core/DeviceProfile
 */

// ============================================================================
// Imports — uses litefin's centralized Logger
// ============================================================================

import { logger } from '../../utils/Logger.js';
import { storage } from '../../utils/StorageService.js';

const log = logger.create('DeviceProfile');

// ============================================================================
// DeviceProfile Class
// ============================================================================

export class DeviceProfile {
    constructor() {
        this._profile = null;
        this._videoTestElement = null;
    }

    /**
     * Get device profile for Jellyfin API
     * @returns {Object}
     */
    getProfile() {
        if (this._profile) {
            return this._profile;
        }

        this._profile = this._buildProfile();
        log.debug('Built profile:', JSON.stringify(this._profile, null, 2));
        log.debug('Is Tizen:', this._isTizen());
        return this._profile;
    }

    /**
     * Build the device profile
     * @private
     */
    _buildProfile() {
        const profile = {
            MaxStreamingBitrate: this._getMaxBitrate(),
            MaxStaticBitrate: 100000000,
            MusicStreamingTranscodingBitrate: 192000,
            DirectPlayProfiles: [],
            TranscodingProfiles: [],
            ContainerProfiles: [],
            CodecProfiles: [],
            SubtitleProfiles: []
        };

        // Add video profiles based on platform capabilities
        this._addVideoProfiles(profile);

        // Add audio profiles based on codec support
        this._addAudioProfiles(profile);

        // Add subtitle format profiles
        this._addSubtitleProfiles(profile);

        return profile;
    }

    /**
     * Get max streaming bitrate
     * @private
     */
    _getMaxBitrate() {
        // Default to 120 Mbps, can be overridden by settings
        return 120000000;
    }

    /**
     * Get video test element for codec probing
     * @private
     */
    _getVideoTestElement() {
        if (!this._videoTestElement) {
            this._videoTestElement = document.createElement('video');
        }
        return this._videoTestElement;
    }

    /**
     * Check if codec is supported via canPlayType
     * @private
     */
    _canPlayType(mimeType) {
        const video = this._getVideoTestElement();
        return !!video.canPlayType(mimeType).replace(/no/, '');
    }

    /**
     * Add video direct play and transcoding profiles
     * @private
     */
    _addVideoProfiles(profile) {
        const isTizen = this._isTizen();

        // Comprehensive audio codecs for video containers
        // Tizen AVPlay supports many more codecs natively than HTML5 video
        const standardAudioCodecs = ['aac', 'mp3', 'ac3', 'eac3', 'flac', 'alac', 'opus', 'vorbis'];

        if (isTizen) {
            // Tizen AVPlay supports these additional audio codecs
            standardAudioCodecs.push('dts', 'truehd', 'dca');
        }

        const audioCodecString = standardAudioCodecs.join(',');

        // On Tizen, use native AVPlay capabilities rather than browser detection
        if (isTizen) {
            // Tizen AVPlay supports a wide range of containers and codecs natively

            // H.264 in all common containers
            profile.DirectPlayProfiles.push({
                Container: 'mp4,m4v,mkv,avi,mov,ts,m2ts',
                Type: 'Video',
                VideoCodec: 'h264,mpeg4,mpeg2video',
                AudioCodec: audioCodecString
            });

            // HEVC/H.265
            profile.DirectPlayProfiles.push({
                Container: 'mp4,m4v,mkv,ts,m2ts',
                Type: 'Video',
                VideoCodec: 'hevc',
                AudioCodec: audioCodecString
            });

            // VP9 (supported on newer Tizen TVs)
            profile.DirectPlayProfiles.push({
                Container: 'webm,mkv',
                Type: 'Video',
                VideoCodec: 'vp9,vp8',
                AudioCodec: 'vorbis,opus,' + audioCodecString
            });
        } else {
            // Standard browser detection for non-Tizen
            const videoAudioCodecs = ['aac', 'mp3', 'ac3'];
            if (this._canPlayType('audio/mp4; codecs="ec-3"')) {
                videoAudioCodecs.push('eac3');
            }

            // H.264 - widely supported
            if (this._canPlayType('video/mp4; codecs="avc1.640029"')) {
                profile.DirectPlayProfiles.push({
                    Container: 'mp4,m4v',
                    Type: 'Video',
                    VideoCodec: 'h264',
                    AudioCodec: videoAudioCodecs.join(',')
                });
            }

            // HEVC/H.265
            if (this._canPlayType('video/mp4; codecs="hvc1.1.4.L120.B0"')) {
                profile.DirectPlayProfiles.push({
                    Container: 'mp4,m4v,mkv',
                    Type: 'Video',
                    VideoCodec: 'hevc',
                    AudioCodec: videoAudioCodecs.join(',')
                });
            }

            // VP9
            if (this._canPlayType('video/webm; codecs="vp9"')) {
                profile.DirectPlayProfiles.push({
                    Container: 'webm',
                    Type: 'Video',
                    VideoCodec: 'vp9',
                    AudioCodec: 'vorbis,opus'
                });
            }

            // AV1
            if (this._canPlayType('video/mp4; codecs="av01.0.08M.08"')) {
                profile.DirectPlayProfiles.push({
                    Container: 'mp4,webm',
                    Type: 'Video',
                    VideoCodec: 'av1',
                    AudioCodec: videoAudioCodecs.join(',')
                });
            }
        }

        // HLS transcoding profile (fallback)
        profile.TranscodingProfiles.push({
            Container: 'ts',
            Type: 'Video',
            AudioCodec: 'aac,ac3',
            VideoCodec: 'h264',
            Context: 'Streaming',
            Protocol: 'hls',
            MaxAudioChannels: '6',
            MinSegments: '2',
            BreakOnNonKeyFrames: true
        });

        // Fallback MP4 transcoding
        profile.TranscodingProfiles.push({
            Container: 'mp4',
            Type: 'Video',
            AudioCodec: 'aac',
            VideoCodec: 'h264',
            Context: 'Streaming',
            Protocol: 'http'
        });
    }

    /**
     * Add audio profiles
     * @private
     */
    _addAudioProfiles(profile) {
        const audioCodecs = ['mp3', 'aac', 'flac', 'wav'];

        if (this._canPlayType('audio/ogg; codecs="opus"')) {
            audioCodecs.push('opus');
        }
        if (this._canPlayType('audio/ogg; codecs="vorbis"')) {
            audioCodecs.push('vorbis');
        }

        profile.DirectPlayProfiles.push({
            Container: audioCodecs.join(','),
            Type: 'Audio'
        });

        // Audio transcoding
        profile.TranscodingProfiles.push({
            Container: 'mp3',
            Type: 'Audio',
            AudioCodec: 'mp3',
            Context: 'Streaming',
            Protocol: 'http'
        });
    }

    /**
     * Add subtitle profiles
     * @private
     */
    _addSubtitleProfiles(profile) {
        // External subtitles
        profile.SubtitleProfiles.push({ Format: 'vtt', Method: 'External' });
        profile.SubtitleProfiles.push({ Format: 'srt', Method: 'External' });

        // Embedded subtitles (will be extracted)
        profile.SubtitleProfiles.push({ Format: 'ass', Method: 'External' });
        profile.SubtitleProfiles.push({ Format: 'ssa', Method: 'External' });

        // PGS subtitles (burn-in required on most platforms)
        profile.SubtitleProfiles.push({ Format: 'pgssub', Method: 'Encode' });

        // SUP/PGS as external (for custom rendering)
        profile.SubtitleProfiles.push({ Format: 'sub', Method: 'External' });
    }

    /**
     * Check if running on Tizen
     * @private
     */
    _isTizen() {
        return !!(window.tizen || /Tizen/i.test(navigator.userAgent));
    }

    /**
     * Check if running on webOS
     * @private
     */
    _isWebOS() {
        return !!window.webOS;
    }

    /**
     * Get device ID for session tracking
     * @returns {string}
     */
    getDeviceId() {
        let deviceId = storage.getItem('jellyfin-player-device-id');

        if (!deviceId) {
            deviceId = this._generateDeviceId();
            storage.setItem('jellyfin-player-device-id', deviceId);
        }

        return deviceId;
    }

    /**
     * Generate unique device ID
     * @private
     */
    _generateDeviceId() {
        return 'jellyfin-player-' + Date.now().toString(36) + Math.random().toString(36).substring(2, 15);
    }

    /**
     * Get device name
     * @returns {string}
     */
    getDeviceName() {
        if (this._isTizen()) {
            return 'Samsung Tizen TV';
        }
        if (this._isWebOS()) {
            return 'LG webOS TV';
        }
        return 'Jellyfin Web Player';
    }

    /**
     * Get client name
     * @returns {string}
     */
    getClientName() {
        return 'Jellyfin Player';
    }

    /**
     * Get client version
     * @returns {string}
     */
    getClientVersion() {
        return '0.1.0';
    }
}
