/**
 * ============================================================================
 * Litefin Tizen - About Device Specifications Reader
 * ============================================================================
 * Extracts hardware capabilities, display resolution tier, and video/audio
 * codec compatibility matrices for the Settings About tab.
 * ============================================================================
 */

import { getDeviceCapabilities } from '../../../api/DeviceProfile.js';
import { platformInfo } from '../../../utils/PlatformInfo.js';
import { PlayerSettings } from '../../../utils/PlayerSettings.js';
import { i18n } from '../../../utils/i18n.js';
import { logger } from '../../../utils/Logger.js';

const log = logger.create('AboutDeviceSpecs');

/**
 * Resolves current display hardware, platform specifications, and active codec matrix.
 * @returns {Object} Structured device specifications
 */
export function getDeviceSpecsData() {
    const caps = getDeviceCapabilities();

    // 1. Resolve host platform display string
    let platformStr = i18n.t('BrowserValue', [caps.browserVersion]);
    if (platformInfo.isAndroid) {
        const ver = caps.androidVersion || platformInfo.androidVersion;
        platformStr = ver ? `Android ${ver}` : 'Android';
    } else if (platformInfo.isWebOS) {
        platformStr = i18n.t('WebOSValue', [caps.webosVersion]);
    } else if (platformInfo.isTizen) {
        platformStr = i18n.t('TizenValue', [caps.tizenVersion]);
    } else if (platformInfo.isDesktop) {
        platformStr = `Desktop (${platformInfo.operatingSystem || 'Native'})`;
    }

    // 2. Resolve target screen geometry and resolution tier
    const screenW =
        caps.screenWidth ||
        (typeof window !== 'undefined' ? window.screen?.width || window.innerWidth || 1920 : 1920);
    const screenH =
        caps.screenHeight ||
        (typeof window !== 'undefined' ? window.screen?.height || window.innerHeight || 1080 : 1080);
    const resTier = caps.uhd8K ? i18n.t('UHD8K') : caps.uhd ? i18n.t('UHD') : i18n.t('FHD');
    const resStr = i18n.t('ResolutionValue', [screenW, screenH, resTier]);

    // 3. Resolve user player overrides against hardware capabilities
    const resolveOverride = (key, hwSupport) => {
        const val = PlayerSettings.get(key);
        return val === 'enable' ? true : val === 'disable' ? false : hwSupport;
    };

    const userHdr = resolveOverride('enableHDR', !!caps.hdr10);
    const hwHdr = [
        caps.hdr10 ? 'HDR10' : null,
        caps.hdr10Plus ? 'HDR10+' : null,
        caps.hlg ? 'HLG' : null,
        caps.dolbyVision ? i18n.t('DolbyVision') : null
    ].filter(Boolean);

    let hdrStr = i18n.t('SDROnly');
    if (hwHdr.length > 0) {
        hdrStr = userHdr ? hwHdr.join(', ') : `${hwHdr.join(', ')} (${i18n.t('Disabled')})`;
    }

    // 4. Video Codecs Matrix with HW support & user toggle states
    const videoCodecs = [
        { name: 'H.264', hw: true, user: true },
        { name: 'HEVC', hw: caps.hevc, user: resolveOverride('enableHEVC', caps.hevc) },
        { name: 'VP9', hw: caps.vp9, user: resolveOverride('enableVP9', caps.vp9) },
        { name: 'VP8', hw: caps.vp8 !== false, user: true },
        { name: 'MPEG-2', hw: caps.mpeg2video !== false, user: true },
        { name: 'AV1', hw: caps.av1, user: resolveOverride('enableAV1', caps.av1) }
    ];

    // 5. Audio Codecs Matrix with HW support & user toggle states
    const audioCodecs = [
        { name: 'AAC', hw: true, user: true },
        { name: 'AC-3', hw: caps.ac3 !== false, user: true },
        { name: 'E-AC-3', hw: caps.eac3 !== false, user: resolveOverride('enableEac3', caps.eac3 !== false) },
        { name: 'TrueHD', hw: caps.truehd !== false, user: resolveOverride('enableTrueHd', caps.truehd !== false) },
        { name: 'DTS', hw: caps.dts !== false, user: resolveOverride('enableDts', caps.dts !== false) },
        { name: 'FLAC', hw: true, user: true },
        { name: 'Opus', hw: true, user: true },
        { name: 'MP3', hw: true, user: true }
    ];

    return {
        modelName: caps.modelName || 'Standard Display',
        platform: platformStr,
        resolution: resStr,
        hdr: hdrStr,
        videoCodecs,
        audioCodecs
    };
}

/**
 * Dispatches an external URL using platform-native shells or browser window bridges.
 * @param {string} url Target URL
 */
export function openExternalUrl(url) {
    log.info(`Opening external link: ${url}`);

    // Tauri Desktop bridge
    if (typeof window !== 'undefined' && window.__TAURI_INTERNALS__?.invoke) {
        window.__TAURI_INTERNALS__.invoke('plugin:opener|open_url', { url }).catch(() => {
            try {
                window.open(url, '_blank');
            } catch (_) {}
        });
        return;
    }

    if (typeof window !== 'undefined' && window.__TAURI__?.core?.invoke) {
        window.__TAURI__.core.invoke('plugin:opener|open_url', { url }).catch(() => {
            try {
                window.open(url, '_blank');
            } catch (_) {}
        });
        return;
    }

    // Generic browser window fallback
    try {
        window.open(url, '_blank');
    } catch (err) {
        log.warn('Could not launch window.open:', err);
    }
}
