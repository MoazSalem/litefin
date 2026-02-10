/**
 * ============================================================================
 * Litefin Tizen - Device Profile
 * ============================================================================
 * Defines the device capabilities for transcoding negotiation with Jellyfin.
 * Tells the server what formats/codecs the device can play natively.
 * ============================================================================
 */

import { logger } from '../utils/Logger.js';

const log = logger.create('DeviceProfile');

/**
 * Get device profile based on detected capabilities
 * @param {Object} [options] - Profile options
 * @param {boolean} [options.enableHEVC=true] - Enable HEVC/H.265
 * @param {boolean} [options.enable4K=true] - Enable 4K resolution
 * @param {boolean} [options.enableHDR=false] - Enable HDR
 * @returns {Object} Device profile
 */
export function getDeviceProfile(options = {}) {
    const { enableHEVC = true, enable4K = true, enable8K = false, enableHDR = false } = options;

    // Max bitrate based on resolution
    let maxBitrate = 40000000; // Default 1080p (40 Mbps)
    if (enable8K) {
        maxBitrate = 200000000; // 200 Mbps for 8K
    } else if (enable4K) {
        maxBitrate = 120000000; // 120 Mbps for 4K
    }

    // ========================================================================
    // Video codecs
    // ========================================================================
    const videoCodecs = ['h264'];
    if (enableHEVC) {
        videoCodecs.push('hevc', 'h265');
    }
    videoCodecs.push('vp8', 'vp9');

    // Video profiles for H.264
    const h264Profiles = 'high|main|baseline|constrained baseline';
    const h264Levels = enable4K ? '52' : '42'; // 5.2 for 4K, 4.2 for 1080p

    // ========================================================================
    // Audio codecs
    // ========================================================================
    const audioCodecs = ['aac', 'mp3', 'opus', 'flac', 'vorbis', 'ac3', 'eac3'];

    // ========================================================================
    // Build transcoding profiles
    // ========================================================================
    const transcodingProfiles = [
        // Video transcoding - prefer HLS
        {
            Container: 'ts',
            Type: 'Video',
            AudioCodec: 'aac,mp3,ac3,eac3',
            VideoCodec: enableHEVC ? 'h264,hevc' : 'h264',
            Context: 'Streaming',
            Protocol: 'hls',
            MaxAudioChannels: '6',
            MinSegments: '1',
            BreakOnNonKeyFrames: true
        },
        // Audio transcoding
        {
            Container: 'mp3',
            Type: 'Audio',
            AudioCodec: 'mp3',
            Context: 'Streaming',
            Protocol: 'http',
            MaxAudioChannels: '2'
        }
    ];

    // ========================================================================
    // Build direct play profiles
    // ========================================================================
    const directPlayProfiles = [
        // Video containers
        {
            Container: 'mp4,m4v',
            Type: 'Video',
            VideoCodec: videoCodecs.join(','),
            AudioCodec: audioCodecs.join(',')
        },
        {
            Container: 'mkv',
            Type: 'Video',
            VideoCodec: videoCodecs.join(','),
            AudioCodec: audioCodecs.join(',')
        },
        {
            Container: 'webm',
            Type: 'Video',
            VideoCodec: 'vp8,vp9,av1',
            AudioCodec: 'opus,vorbis'
        },
        // Audio containers
        {
            Container: 'mp3',
            Type: 'Audio'
        },
        {
            Container: 'aac',
            Type: 'Audio'
        },
        {
            Container: 'flac',
            Type: 'Audio'
        }
    ];

    // ========================================================================
    // Build codec profiles (capability conditions)
    // ========================================================================
    const codecProfiles = [
        // H.264 conditions
        {
            Type: 'Video',
            Codec: 'h264',
            Conditions: [
                {
                    Condition: 'NotEquals',
                    Property: 'IsAnamorphic',
                    Value: 'true',
                    IsRequired: false
                },
                {
                    Condition: 'EqualsAny',
                    Property: 'VideoProfile',
                    Value: h264Profiles,
                    IsRequired: false
                },
                {
                    Condition: 'LessThanEqual',
                    Property: 'VideoLevel',
                    Value: h264Levels,
                    IsRequired: false
                },
                {
                    Condition: 'LessThanEqual',
                    Property: 'VideoBitrate',
                    Value: String(maxBitrate),
                    IsRequired: false
                }
            ]
        }
    ];

    // Add HEVC conditions if enabled
    if (enableHEVC) {
        const hevcConditions = [
            {
                Condition: 'LessThanEqual',
                Property: 'VideoBitrate',
                Value: String(maxBitrate),
                IsRequired: false
            }
        ];

        // Add HDR conditions if not supported
        if (!enableHDR) {
            hevcConditions.push({
                Condition: 'NotEquals',
                Property: 'VideoRangeType',
                Value: 'HDR10',
                IsRequired: false
            });
            hevcConditions.push({
                Condition: 'NotEquals',
                Property: 'VideoRangeType',
                Value: 'HLG',
                IsRequired: false
            });
            hevcConditions.push({
                Condition: 'NotEquals',
                Property: 'VideoRangeType',
                Value: 'DOVIWithHDR10',
                IsRequired: false
            });
        }

        codecProfiles.push({
            Type: 'Video',
            Codec: 'hevc',
            Conditions: hevcConditions
        });
    }

    // Audio codec conditions
    codecProfiles.push({
        Type: 'VideoAudio',
        Codec: 'aac',
        Conditions: [
            {
                Condition: 'LessThanEqual',
                Property: 'AudioChannels',
                Value: '8',
                IsRequired: false
            }
        ]
    });

    // ========================================================================
    // Build subtitle profiles
    // ========================================================================
    const subtitleProfiles = [
        // Text-based subtitles (external)
        { Format: 'srt', Method: 'External' },
        { Format: 'ass', Method: 'External' },
        { Format: 'ssa', Method: 'External' },
        { Format: 'vtt', Method: 'External' },
        { Format: 'sub', Method: 'External' },
        { Format: 'smi', Method: 'External' },

        // Embedded subtitles via HLS
        { Format: 'vtt', Method: 'Hls' }
    ];

    // ========================================================================
    // Assemble final profile
    // ========================================================================
    return {
        Name: 'Litefin Tizen',
        MaxStaticBitrate: maxBitrate,
        MaxStreamingBitrate: maxBitrate,
        MusicStreamingTranscodingBitrate: 192000,

        DirectPlayProfiles: directPlayProfiles,
        TranscodingProfiles: transcodingProfiles,
        CodecProfiles: codecProfiles,
        SubtitleProfiles: subtitleProfiles,

        // Response profiles (for non-supported containers)
        ResponseProfiles: [
            {
                Type: 'Video',
                Container: 'm4v',
                MimeType: 'video/mp4'
            }
        ]
    };
}

/**
 * Detect device capabilities based on Tizen platform
 * @returns {Object} Detected capabilities
 */
export function detectCapabilities() {
    const capabilities = {
        enableHEVC: true,
        enable4K: true,
        enableHDR: false
    };

    // Check for Manual Resolution Setting (Default to 4K if not set)
    const manualRes = localStorage.getItem('litefin_max_resolution') || '2160p';

    if (manualRes !== 'auto') {
        log.info(`Using manual resolution setting: ${manualRes}`);
        switch (manualRes) {
            case '720p':
                capabilities.enable4K = false;
                capabilities.enableHEVC = false; // Usually safe to disable HEVC for lower end
                break;
            case '1080p':
                capabilities.enable4K = false;
                capabilities.enableHEVC = true;
                break;
            case '2160p': // 4K
                capabilities.enable4K = true;
                capabilities.enableHEVC = true;
                break;
            case '4320p': // 8K
                capabilities.enable4K = true;
                capabilities.enable8K = true;
                capabilities.enableHEVC = true;
                break;
        }
        return capabilities;
    }

    // Detect from Tizen APIs if available
    if (typeof webapis !== 'undefined' && webapis.productinfo) {
        try {
            // Check 4K support
            if (webapis.productinfo.isUdPanelSupported) {
                capabilities.enable4K = webapis.productinfo.isUdPanelSupported();
            }

            // Check HDR support (only for newer TVs)
            // Note: Most Tizen TVs don't expose this directly
        } catch (e) {
            log.warn('Could not detect capabilities', e);
        }
    }

    // Final logging of what we are sending
    log.info('Final Capabilities determined:', JSON.stringify(capabilities, null, 2));

    return capabilities;
}

/**
 * Get profile with auto-detected capabilities
 * @returns {Object} Device profile
 */
export function getAutoProfile() {
    const capabilities = detectCapabilities();
    return getDeviceProfile(capabilities);
}

export default {
    getDeviceProfile,
    detectCapabilities,
    getAutoProfile
};
