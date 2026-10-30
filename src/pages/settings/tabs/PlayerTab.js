/**
 * ============================================================================
 * Litefin Tizen - Player Tab Controller
 * ============================================================================
 * Orchestrates playback settings, video backends, hardware codec passthrough,
 * bitrate/resolution caps, audio stream selection, OSD options, and buffering.
 * ============================================================================
 */

import { PlayerSettings } from '../../../utils/PlayerSettings.js';
import { platformInfo } from '../../../utils/PlatformInfo.js';
import { i18n } from '../../../utils/i18n.js';
import { logger } from '../../../utils/Logger.js';
import { getDeviceCapabilities, clearCapabilitiesCache } from '../../../api/DeviceProfile.js';

const log = logger.create('PlayerTab');

/** Helper to generate seconds dropdown options */
const SEC_OPTS = (arr) => arr.map((s) => ({ value: s, label: i18n.t('Seconds', [s]) || `${s}s` }));

/** Helper to generate seconds dropdown options for settings stored in milliseconds */
const MS_OPTS = (arr) => arr.map((s) => ({ value: s * 1000, label: i18n.t('Seconds', [s]) || `${s}s` }));

/** Segment skip action options */
const SEGMENT_ACTION_OPTS = [
    { value: 'None', label: i18n.t('SegmentActionNone') || 'Disabled' },
    { value: 'AskToSkip', label: i18n.t('SegmentActionAskToSkip') || 'Show Skip Button' },
    { value: 'Skip', label: i18n.t('SegmentActionSkip') || 'Auto-Skip' }
];

/** Advanced codec override definitions */
const CODEC_ITEMS = [
    { id: 'hevc-force-select', key: 'enableHEVC', cap: 'hevc', name: 'EnableHEVC', desc: 'HEVCDescription' },
    { id: 'hdr-force-select', key: 'enableHDR', cap: 'hdr10', name: 'EnableHDR', desc: 'HDRDescription' },
    { id: 'dv-force-select', key: 'enableDolbyVision', cap: 'dolbyVision', name: 'EnableDV', desc: 'DolbyVisionDescription' },
    { id: 'av1-force-select', key: 'enableAV1', cap: 'av1', name: 'EnableAV1', desc: 'AV1Description' },
    { id: 'vp9-force-select', key: 'enableVP9', cap: 'vp9', name: 'EnableVP9', desc: 'VP9Description' },
    { id: 'dts-force-select', key: 'enableDts', cap: 'dts', name: 'DTSPassthrough', desc: 'DTSPassthroughDescription' },
    { id: 'truehd-force-select', key: 'enableTrueHd', cap: 'truehd', name: 'TrueHDPassthrough', desc: 'TrueHDPassthroughDescription' },
    { id: 'eac3-force-select', key: 'enableEac3', cap: 'eac3', name: 'EnableEAC3', desc: 'EnableEAC3Description' },
    { id: 'mp2-force-select', key: 'enableMp2', cap: 'mp2', name: 'EnableMP2', desc: 'EnableMP2Description' }
];

/** Settings that invalidate hardware capability cache when toggled */
const CLEAR_CAPS_KEYS = new Set([
    'preferDirectPlayAudio', 'enableFlacInVideo', 'enablePcmInVideo',
    'enableFmp4HlsContainer', 'forceFmp4HlsContainer', 'forceTranscode',
    'remuxMkvToMp4', 'autoTranscodeOnError', 'enableBackgroundService',
    'interlacedBackendFallback', 'enablePrewarm', 'awaitTracksBeforePlayback'
]);

/**
 * Controller for the Settings Player / Playback tab.
 */
export class PlayerTab {
    /**
     * Initializes a new instance of PlayerTab.
     * @param {Object} pageContext The parent SettingsPage instance
     */
    constructor(pageContext) {
        // Parent SettingsPage reference for common dropdowns and modals
        this.page = pageContext;
        // Event listeners tracked for deterministic cleanup
        this._listeners = [];
    }

    /** Helper to render dropdown markup via parent page facade */
    _drop(id, options, current) {
        return this.page?._renderDropdown ? this.page._renderDropdown(id, options, current) : '';
    }

    /** Register and track an event listener on a target element */
    _listen(element, event, handler) {
        if (!element) return;
        element.addEventListener(event, handler);
        this._listeners.push({ element, event, handler });
    }

    /**
     * Helper to render backend selection dropdown.
     * @private
     */
    _renderBackendDropdown(currentBackend) {
        const recommendedBackend = typeof PlayerSettings.getRecommendedBackend === 'function'
            ? PlayerSettings.getRecommendedBackend()
            : (platformInfo.isAndroid ? 'exoplayer' : platformInfo.isTizen ? 'avplay' : platformInfo.isWebOS ? 'webos' : ((platformInfo.isDesktop || platformInfo.isWeb) && platformInfo.hasWebCodecsSupport) ? 'movi' : 'html5');

        const autoRec = i18n.t('AutoRecommended') || '';
        const recMatch = autoRec.match(/\((.+?)\)|（(.+?)）/);
        const recWord = (recMatch && (recMatch[1] || recMatch[2])) || 'Recommended';
        const recSuffix = ` (${recWord})`;

        const options = [{ value: 'auto', label: autoRec || `Auto (${recWord})` }];
        const hasExoBridge = typeof window !== 'undefined' && Boolean(window.LitefinExoPlayer || window.LitefinAndroid || window.__TAURI_INTERNALS__?.invoke || window.__TAURI__?.core?.invoke);

        if (platformInfo.isAndroid && (hasExoBridge || platformInfo._platform === 'android')) {
            const base = i18n.t('BackendExoPlayer') || 'Media3 ExoPlayer (Android Native)';
            options.push({ value: 'exoplayer', label: recommendedBackend === 'exoplayer' ? `${base}${recSuffix}` : base });
        } else if (platformInfo.isTizen) {
            const base = i18n.t('BackendTizen') || 'Tizen Native (Avplay)';
            options.push({ value: 'avplay', label: recommendedBackend === 'avplay' ? `${base}${recSuffix}` : base });
        } else if (platformInfo.isWebOS) {
            const base = i18n.t('BackendWebOS') || 'LG Native (webOS Player)';
            options.push({ value: 'webos', label: recommendedBackend === 'webos' ? `${base}${recSuffix}` : base });
        }

        if (platformInfo.hasWebCodecsSupport && !platformInfo.isTizen && !platformInfo.isWebOS) {
            const base = i18n.t('BackendMovi') || 'Movi Player (MKV/WebCodecs)';
            options.push({ value: 'movi', label: recommendedBackend === 'movi' ? `${base}${recSuffix}` : base });
        }

        const html5Base = i18n.t('BackendWeb') || 'Web (HTML5 Player)';
        options.push({ value: 'html5', label: recommendedBackend === 'html5' ? `${html5Base}${recSuffix}` : html5Base });

        const effectiveBackend = (currentBackend === 'movi' && (!platformInfo.hasWebCodecsSupport || platformInfo.isTizen || platformInfo.isWebOS))
            ? 'html5'
            : (currentBackend === 'exoplayer' && !hasExoBridge && !platformInfo.isAndroid)
                ? 'html5'
                : (currentBackend === 'auto' || !currentBackend || !options.some((o) => o.value === currentBackend))
                    ? recommendedBackend
                    : currentBackend;

        if (currentBackend === 'auto' || (currentBackend && currentBackend !== effectiveBackend && !options.some((o) => o.value === currentBackend))) {
            PlayerSettings.set('playerBackend', effectiveBackend);
        }

        return this._drop('player-backend-select', options, effectiveBackend);
    }

    /**
     * Renders buffering section HTML according to active backend and platform.
     * @private
    /**
     * Renders buffering section HTML according to active backend and platform.
     * @private
     */
    _renderBufferingSection(currentBackend) {
        const isWebos = currentBackend === 'webos' || (currentBackend === 'auto' && platformInfo.isWebOS);
        const isTizen = currentBackend === 'avplay' || (currentBackend === 'auto' && platformInfo.isTizen);
        const isHtml5 = currentBackend === 'html5' || (currentBackend === 'auto' && !platformInfo.isTizen && !platformInfo.isWebOS);
        if (!isWebos && !isTizen && !isHtml5) return '';

        let html = `<h3 class="setting-section-title" data-i18n="PlaybackBuffering">${i18n.t('PlaybackBuffering') || 'Playback Buffering'}</h3>`;
        if (isWebos) {
            html += `
                <div class="setting-item"><div class="setting-label"><span class="setting-name" data-i18n="WebosBufferGate">${i18n.t('WebosBufferGate') || 'Buffer Gate'}</span><span class="setting-description" data-i18n="WebosBufferGateDesc">${i18n.t('WebosBufferGateDesc') || 'Threshold in seconds for micro-stall recovery.'}</span></div><div class="setting-control">${this._drop('webos-buffer-gate-select', [0.05, 0.1, 0.3, 0.5, 1.0, 2.0, 3.0, 5.0].map((v) => ({ value: v, label: `${v}s` })), PlayerSettings.get('webosBufferGate') || 0.3)}</div></div>
                <div class="setting-item"><div class="setting-label"><span class="setting-name" data-i18n="WebosStallRecovery">${i18n.t('WebosStallRecovery') || 'Stall Recovery Timeout'}</span><span class="setting-description" data-i18n="WebosStallRecoveryDesc">${i18n.t('WebosStallRecoveryDesc') || 'Timeout in milliseconds before a recovery kick is applied.'}</span></div><div class="setting-control">${this._drop('webos-stall-recovery-select', [250, 500, 1000, 2000, 3000, 5000, 8000, 10000].map((v) => ({ value: v, label: `${v}ms` })), PlayerSettings.get('webosStallRecovery') || 8000)}</div></div>
                <div class="setting-item"><div class="setting-label"><span class="setting-name" data-i18n="TranscodingSegmentLength">${i18n.t('TranscodingSegmentLength') || 'Segment Length'}</span><span class="setting-description" data-i18n="TranscodingSegmentLengthDesc">${i18n.t('TranscodingSegmentLengthDesc') || 'Length of HLS segments generated by the server. Only applied when the video is transcoded.'}</span></div><div class="setting-control">${this._drop('webos-segment-length-select', SEC_OPTS([1, 2, 3, 4, 5, 6, 8, 10, 12, 15]), PlayerSettings.get('webosSegmentLength') || 3)}</div></div>`;
        } else if (isTizen) {
            html += `
                <div class="setting-item"><div class="setting-label"><span class="setting-name" data-i18n="TizenInitialBuffer">${i18n.t('TizenInitialBuffer') || 'Initial Buffer'}</span><span class="setting-description" data-i18n="TizenInitialBufferDesc">${i18n.t('TizenInitialBufferDesc') || 'Seconds of video to buffer before playback begins.'}</span></div><div class="setting-control">${this._drop('tizen-initial-buffer-select', SEC_OPTS([1, 2, 4, 6, 8, 10, 15, 20, 30, 60]), PlayerSettings.get('tizenInitialBuffer') || 6)}</div></div>
                <div class="setting-item"><div class="setting-label"><span class="setting-name" data-i18n="TizenResumeBuffer">${i18n.t('TizenResumeBuffer') || 'Resume Buffer'}</span><span class="setting-description" data-i18n="TizenResumeBufferDesc">${i18n.t('TizenResumeBufferDesc') || 'Seconds of video to buffer after a seek or underflow.'}</span></div><div class="setting-control">${this._drop('tizen-resume-buffer-select', SEC_OPTS([1, 2, 4, 6, 8, 10, 15, 20, 30, 60]), PlayerSettings.get('tizenResumeBuffer') || 4)}</div></div>
                <div class="setting-item"><div class="setting-label"><span class="setting-name" data-i18n="TranscodingSegmentLength">${i18n.t('TranscodingSegmentLength') || 'Segment Length'}</span><span class="setting-description" data-i18n="TranscodingSegmentLengthDesc">${i18n.t('TranscodingSegmentLengthDesc') || 'Length of HLS segments generated by the server. Only applied when the video is transcoded.'}</span></div><div class="setting-control">${this._drop('tizen-segment-length-select', SEC_OPTS([1, 2, 3, 4, 5, 6, 8, 10, 12, 15]), PlayerSettings.get('tizenSegmentLength') || 6)}</div></div>`;
        } else if (isHtml5) {
            html += `
                <div class="setting-item"><div class="setting-label"><span class="setting-name" data-i18n="Html5MaxBufferLength">${i18n.t('Html5MaxBufferLength') || 'Max Buffer Length'}</span><span class="setting-description" data-i18n="Html5MaxBufferLengthDesc">${i18n.t('Html5MaxBufferLengthDesc') || 'Maximum length of video to keep in the forward buffer (seconds).'}</span></div><div class="setting-control">${this._drop('html5-max-buffer-select', SEC_OPTS([15, 30, 45, 60, 90, 120, 180, 300, 600, 900]), PlayerSettings.get('html5MaxBufferLength') || 60)}</div></div>
                <div class="setting-item"><div class="setting-label"><span class="setting-name" data-i18n="Html5MaxMaxBufferLength">${i18n.t('Html5MaxMaxBufferLength') || 'Max Max Buffer Length'}</span><span class="setting-description" data-i18n="Html5MaxMaxBufferLengthDesc">${i18n.t('Html5MaxMaxBufferLengthDesc') || 'Maximum length of video buffer allowed when bitrates are low.'}</span></div><div class="setting-control">${this._drop('html5-max-max-buffer-select', SEC_OPTS([30, 60, 90, 120, 180, 240, 300, 480, 600, 900, 1200]), PlayerSettings.get('html5MaxMaxBufferLength') || 120)}</div></div>
                <div class="setting-item"><div class="setting-label"><span class="setting-name" data-i18n="TranscodingSegmentLength">${i18n.t('TranscodingSegmentLength') || 'Segment Length'}</span><span class="setting-description" data-i18n="TranscodingSegmentLengthDesc">${i18n.t('TranscodingSegmentLengthDesc') || 'Length of HLS segments generated by the server. Only applied when the video is transcoded.'}</span></div><div class="setting-control">${this._drop('html5-segment-length-select', SEC_OPTS([1, 2, 3, 4, 5, 6, 8, 10, 12, 15]), PlayerSettings.get('html5SegmentLength') || 2)}</div></div>`;
        }
        return html;
    }

    /**
     * Renders the complete HTML markup for the Player / Playback tab.
     * @returns {string} Serialized HTML template
     */
    render() {
        const currentBackend = PlayerSettings.get('playerBackend') || 'auto';
        const currentAudioNorm = PlayerSettings.get('audioNormalization') || 'TrackGain';
        const caps = getDeviceCapabilities();
        const supportStatus = (sup) => `(${i18n.t('DeviceSupports') || 'Device supports'}: ${i18n.t(sup ? 'Yes' : 'No')})`;

        const forceStateOptions = [
            { value: 'auto', label: i18n.t('ForceStateDefault') || 'Default' },
            { value: 'enable', label: i18n.t('ForceStateEnable') || 'Force Enable' },
            { value: 'disable', label: i18n.t('ForceStateDisable') || 'Force Disable' }
        ];

        const audioFallbackLabel = this.page?._getAudioPreferencesSummaryLabel ? this.page._getAudioPreferencesSummaryLabel() : (i18n.t('Default') || 'Default');

        return `
            <div class="settings-tab-content">
                <h2 class="content-title" data-i18n="Playback">${i18n.t('Playback')}</h2>
                <p class="content-subtitle" data-i18n="PlaybackTabDescription">${i18n.t('PlaybackTabDescription') || 'Configure video quality, audio streams, playback compatibility, and player behavior.'}</p>

                <div class="setting-item">
                    <div class="setting-label"><span class="setting-name" data-i18n="PlayerBackend">${i18n.t('PlayerBackend')}</span><span class="setting-description" data-i18n="PlayerBackendDescription">${i18n.t('PlayerBackendDescription')}</span></div>
                    <div class="setting-control">${this._renderBackendDropdown(currentBackend)}</div>
                </div>

                <div class="setting-item">
                    <div class="setting-label"><span class="setting-name" data-i18n="LabelInstantPlayback">${i18n.t('LabelInstantPlayback')}</span><span class="setting-description" data-i18n="LabelInstantPlaybackDescription">${i18n.t('LabelInstantPlaybackDescription')}</span></div>
                    <div class="setting-control"><button class="toggle-switch ${PlayerSettings.get('enablePrewarm') !== false ? 'active' : ''}" id="toggle-instant-playback" data-setting="enablePrewarm" tabindex="0"></button></div>
                </div>

                <div class="setting-item">
                    <div class="setting-label"><span class="setting-name" data-i18n="AwaitTracksBeforePlayback">${i18n.t('AwaitTracksBeforePlayback') || 'Await Tracks Before Playback'}</span><span class="setting-description" data-i18n="AwaitTracksBeforePlaybackDescription">${i18n.t('AwaitTracksBeforePlaybackDescription') || 'Fully await audio and subtitle tracks to load before starting playback and hiding the loading screen.'}</span></div>
                    <div class="setting-control"><button class="toggle-switch ${PlayerSettings.get('awaitTracksBeforePlayback') ? 'active' : ''}" id="toggle-await-tracks-before-playback" data-setting="awaitTracksBeforePlayback" tabindex="0"></button></div>
                </div>

                <div class="setting-item">
                    <div class="setting-label"><span class="setting-name" data-i18n="PreferDirectPlayAudio">${i18n.t('PreferDirectPlayAudio') || 'Prefer Direct Play Audio'}</span><span class="setting-description" data-i18n="PreferDirectPlayAudioDescription">${i18n.t('PreferDirectPlayAudioDescription') || 'Automatically select an audio track that plays directly without transcoding when the default track (e.g. TrueHD or DTS) is unsupported by hardware.'}</span></div>
                    <div class="setting-control"><button class="toggle-switch ${PlayerSettings.get('preferDirectPlayAudio') ? 'active' : ''}" id="toggle-prefer-direct-play-audio" data-setting="preferDirectPlayAudio" tabindex="0"></button></div>
                </div>

                ${platformInfo.isAndroid ? `
                <div class="setting-item"><div class="setting-label"><span class="setting-name" data-i18n="EnableTunneling">${i18n.t('EnableTunneling') || 'Tunneled Video Playback'}</span><span class="setting-description" data-i18n="EnableTunnelingDescription">${i18n.t('EnableTunnelingDescription') || 'Enables hardware A/V clock tunneling in ExoPlayer for smoother 4K HDR playback and reduced CPU jitter.'}</span></div><div class="setting-control"><button class="toggle-switch ${PlayerSettings.get('enableTunneling') === true ? 'active' : ''}" id="toggle-enable-tunneling" data-setting="enableTunneling" tabindex="0"></button></div></div>
                <div class="setting-item"><div class="setting-label"><span class="setting-name" data-i18n="EnableAudioOffload">${i18n.t('EnableAudioOffload') || 'Audio Offload'}</span><span class="setting-description" data-i18n="EnableAudioOffloadDescription">${i18n.t('EnableAudioOffloadDescription') || 'Directs audio decoding to the dedicated hardware DSP to reduce CPU power consumption and prevent audio stalls.'}</span></div><div class="setting-control"><button class="toggle-switch ${PlayerSettings.get('enableAudioOffload') !== false ? 'active' : ''}" id="toggle-enable-audio-offload" data-setting="enableAudioOffload" tabindex="0"></button></div></div>
                <div class="setting-item"><div class="setting-label"><span class="setting-name" data-i18n="AutoRefreshRate">${i18n.t('AutoRefreshRate') || 'Match Display Refresh Rate'}</span><span class="setting-description" data-i18n="AutoRefreshRateDescription">${i18n.t('AutoRefreshRateDescription') || 'Automatically matches TV / HDMI display refresh rate to video frame rate to eliminate judder.'}</span></div><div class="setting-control"><button class="toggle-switch ${PlayerSettings.get('autoRefreshRate') === true ? 'active' : ''}" id="toggle-auto-refresh-rate" data-setting="autoRefreshRate" tabindex="0"></button></div></div>
                ` : ''}

                ${platformInfo.isTizen ? `
                <div class="setting-item"><div class="setting-label"><span class="setting-name" data-i18n="InterlacedBackendFallback">${i18n.t('InterlacedBackendFallback') || 'Auto-Switch for Interlaced Content'}</span><span class="setting-description" data-i18n="InterlacedBackendFallbackDescription">${i18n.t('InterlacedBackendFallbackDescription') || 'Automatically use the HTML5 player for interlaced video (1080i) when AVPlay is active.'}</span></div><div class="setting-control"><button class="toggle-switch ${PlayerSettings.get('interlacedBackendFallback') ? 'active' : ''}" id="toggle-interlaced-backend-fallback" data-setting="interlacedBackendFallback" tabindex="0"></button></div></div>
                ` : ''}

                <div class="setting-item"><div class="setting-label"><span class="setting-name" data-i18n="ConfirmExitPlayer">${i18n.t('ConfirmExitPlayer') || 'Confirm before exiting player'}</span><span class="setting-description" data-i18n="ConfirmExitPlayerDescription">${i18n.t('ConfirmExitPlayerDescription') || 'Show a confirmation dialog when pressing back to prevent accidentally closing playback.'}</span></div><div class="setting-control"><button class="toggle-switch ${PlayerSettings.get('confirmExitPlayer') ? 'active' : ''}" id="toggle-confirm-exit-player" data-setting="confirmExitPlayer" tabindex="0"></button></div></div>
                <div class="setting-item"><div class="setting-label"><span class="setting-name" data-i18n="ConfirmSeekWithOK">${i18n.t('ConfirmSeekWithOK')}</span><span class="setting-description" data-i18n="ConfirmSeekWithOKDescription">${i18n.t('ConfirmSeekWithOKDescription')}</span></div><div class="setting-control"><button class="toggle-switch ${PlayerSettings.get('confirmSeekWithOK') ? 'active' : ''}" id="toggle-confirm-seek" data-setting="confirmSeekWithOK" tabindex="0"></button></div></div>
                <div class="setting-item"><div class="setting-label"><span class="setting-name" data-i18n="PausePlaybackOnScrub">${i18n.t('PausePlaybackOnScrub') || 'Pause playback while scrubbing'}</span><span class="setting-description" data-i18n="PausePlaybackOnScrubDescription">${i18n.t('PausePlaybackOnScrubDescription') || 'Pause playback when scrubbing the seek bar and resume when finished.'}</span></div><div class="setting-control"><button class="toggle-switch ${PlayerSettings.get('pausePlaybackOnScrub') ? 'active' : ''}" id="toggle-pause-on-scrub" data-setting="pausePlaybackOnScrub" tabindex="0"></button></div></div>
                <div class="setting-item"><div class="setting-label"><span class="setting-name" data-i18n="EnableSeekAcceleration">${i18n.t('EnableSeekAcceleration') || 'Accelerate seek speed'}</span><span class="setting-description" data-i18n="EnableSeekAccelerationDescription">${i18n.t('EnableSeekAccelerationDescription') || 'Gradually increase seek speed (up to 10x) when holding directional buttons on the timeline.'}</span></div><div class="setting-control"><button class="toggle-switch ${PlayerSettings.get('enableSeekAcceleration') ? 'active' : ''}" id="toggle-enable-seek-acceleration" data-setting="enableSeekAcceleration" tabindex="0"></button></div></div>
                <div class="setting-item"><div class="setting-label"><span class="setting-name" data-i18n="ResetSeekSpeedOnDirectionChange">${i18n.t('ResetSeekSpeedOnDirectionChange') || 'Reset seek speed on direction change'}</span><span class="setting-description" data-i18n="ResetSeekSpeedOnDirectionChangeDescription">${i18n.t('ResetSeekSpeedOnDirectionChangeDescription') || 'Reset accelerated seek speed back to 1x when reversing direction during timeline scrubbing.'}</span></div><div class="setting-control"><button class="toggle-switch ${PlayerSettings.get('resetSeekSpeedOnDirectionChange') ? 'active' : ''}" id="toggle-reset-seek-speed-on-direction-change" data-setting="resetSeekSpeedOnDirectionChange" tabindex="0"></button></div></div>

                <div class="setting-item"><div class="setting-label"><span class="setting-name" data-i18n="LabelAudioLanguagePreference">${i18n.t('LabelAudioLanguagePreference')}</span><span class="setting-description" data-i18n="AudioLanguageFallbackDescription">${i18n.t('AudioLanguageFallbackDescription')}</span></div><div class="setting-control"><button class="setting-action-btn audio-fallback-select-btn" id="audio-fallback-languages-btn" tabindex="0" data-focusable="true"><span class="btn-label">${audioFallbackLabel}</span></button></div></div>
                <div class="setting-item"><div class="setting-label"><span class="setting-name" data-i18n="LabelSkipForwardLength">${i18n.t('LabelSkipForwardLength')}</span><span class="setting-description" data-i18n="SkipForwardDurationDescription">${i18n.t('SkipForwardDurationDescription')}</span></div><div class="setting-control">${this._drop('skip-forward-select', MS_OPTS([5, 10, 15, 20, 30, 60]), PlayerSettings.get('skipForwardLength') || 30000)}</div></div>
                <div class="setting-item"><div class="setting-label"><span class="setting-name" data-i18n="LabelSkipBackLength">${i18n.t('LabelSkipBackLength')}</span><span class="setting-description" data-i18n="SkipBackDurationDescription">${i18n.t('SkipBackDurationDescription')}</span></div><div class="setting-control">${this._drop('skip-back-select', MS_OPTS([5, 10, 15, 20, 30, 60]), PlayerSettings.get('skipBackLength') || 10000)}</div></div>
                <div class="setting-item"><div class="setting-label"><span class="setting-name" data-i18n="LabelResumeRewindLength">${i18n.t('LabelResumeRewindLength') || 'Resume rewind'}</span><span class="setting-description" data-i18n="ResumeRewindDurationDescription">${i18n.t('ResumeRewindDurationDescription') || 'Rewind playback slightly when resuming an in-progress video to review the previous scene.'}</span></div><div class="setting-control">${this._drop('resume-rewind-select', [{ value: 0, label: i18n.t('None') || 'None' }, ...MS_OPTS([5, 10, 15, 20, 30])], PlayerSettings.get('resumeRewindLength') || 0)}</div></div>

                <div class="setting-item"><div class="setting-label"><span class="setting-name" data-i18n="PlayNextEpisodeAutomatically">${i18n.t('PlayNextEpisodeAutomatically')}</span><span class="setting-description" data-i18n="AutoPlayNextDescription">${i18n.t('AutoPlayNextDescription')}</span></div><div class="setting-control"><button class="toggle-switch ${PlayerSettings.get('enableNextEpisodeAutoPlay') ? 'active' : ''}" id="toggle-auto-next" data-setting="enableNextEpisodeAutoPlay" tabindex="0"></button></div></div>
                <div class="setting-item"><div class="setting-label"><span class="setting-name" data-i18n="WatchedThreshold">${i18n.t('WatchedThreshold') || 'Mark as Watched Threshold'}</span><span class="setting-description" data-i18n="WatchedThresholdDescription">${i18n.t('WatchedThresholdDescription') || 'Choose the completion percentage required to mark an item as watched. Litefin defaults to 80% to accommodate credit and ending sequences, or you can respect your Jellyfin server setting.'}</span></div><div class="setting-control">${this._drop('watched-threshold-select', [{ value: 'server', label: i18n.t('OptionWatchedThresholdServer') || 'Server Setting (MaxResumePct)' }, { value: '80', label: i18n.t('OptionWatchedThreshold80') || '80% (Litefin Default - Credits friendly)' }, { value: '85', label: i18n.t('OptionWatchedThreshold85') || '85%' }, { value: '90', label: i18n.t('OptionWatchedThreshold90') || '90%' }, { value: '95', label: i18n.t('OptionWatchedThreshold95') || '95%' }, { value: '100', label: i18n.t('OptionWatchedThreshold100') || '100% (Strict Completion)' }], PlayerSettings.get('watchedThreshold') || '80')}</div></div>

                <div class="setting-item"><div class="setting-label"><span class="setting-name" data-i18n="PlayNextUpDialog">${i18n.t('PlayNextUpDialog') || 'Show Up Next dialog'}</span><span class="setting-description" data-i18n="PlayNextUpDialogDescription">${i18n.t('PlayNextUpDialogDescription') || 'Show the countdown dialog for the next episode before the current one ends'}</span></div><div class="setting-control"><button class="toggle-switch ${PlayerSettings.get('enableNextUpDialog') ? 'active' : ''}" id="toggle-next-up-dialog" data-setting="enableNextUpDialog" tabindex="0"></button></div></div>
                <div class="setting-item"><div class="setting-label"><span class="setting-name" data-i18n="LabelNextUpTriggerMode">${i18n.t('LabelNextUpTriggerMode') || 'Up Next Trigger Point'}</span><span class="setting-description" data-i18n="NextUpTriggerModeDescription">${i18n.t('NextUpTriggerModeDescription') || 'Choose when the next episode card should appear.'}</span></div><div class="setting-control">${this._drop('next-up-dialog-trigger-select', [{ value: 'default', label: i18n.t('OptionTriggerDefault') || 'Chapters (if available) / Time-based' }, { value: 'time_fallback', label: i18n.t('OptionTriggerTimeFallback') || 'Time-based only' }, { value: 'seconds_20', label: i18n.t('OptionTrigger20s') || 'Last 20 seconds' }, { value: 'seconds_30', label: i18n.t('OptionTrigger30s') || 'Last 30 seconds' }], PlayerSettings.get('nextUpTriggerMode') || 'default')}</div></div>
                <div class="setting-item"><div class="setting-label"><span class="setting-name" data-i18n="EnableTrickplay">${i18n.t('EnableTrickplay') || 'Thumbnail Preview'}</span><span class="setting-description" data-i18n="EnableTrickplayDescription">${i18n.t('EnableTrickplayDescription') || 'Show video frame previews when scrubbing through a video'}</span></div><div class="setting-control"><button class="toggle-switch ${PlayerSettings.get('enableTrickplay') ? 'active' : ''}" id="toggle-trickplay" data-setting="enableTrickplay" tabindex="0"></button></div></div>
                <div class="setting-item"><div class="setting-label"><span class="setting-name" data-i18n="SeekWithArrows">${i18n.t('SeekWithArrows') || 'Seek with Arrows'}</span><span class="setting-description" data-i18n="SeekWithArrowsDescription">${i18n.t('SeekWithArrowsDescription') || 'When the player controls are hidden, pressing Left or Right will instantly seek instead of just showing the controls.'}</span></div><div class="setting-control"><button class="toggle-switch ${PlayerSettings.get('seekWithArrows') ? 'active' : ''}" id="toggle-seek-with-arrows" data-setting="seekWithArrows" tabindex="0"></button></div></div>
                <div class="setting-item"><div class="setting-label"><span class="setting-name" data-i18n="OsdFocusRestoreMode">${i18n.t('OsdFocusRestoreMode') || 'OSD Focus Restore'}</span><span class="setting-description" data-i18n="OsdFocusRestoreModeDescription">${i18n.t('OsdFocusRestoreModeDescription') || 'Where the remote cursor lands when the player controls reappear after being auto-hidden.'}</span></div><div class="setting-control">${this._drop('osd-focus-mode-select', [{ value: 'always', label: i18n.t('OsdFocusAlways') || 'Always return to Play/Pause' }, { value: 'timeout', label: i18n.t('OsdFocusTimeout') || 'Return to Play/Pause after 10 s' }, { value: 'remember', label: i18n.t('OsdFocusRemember') || 'Remember last position' }, { value: 'seekbar', label: i18n.t('OsdFocusSeekbar') || 'Always return to Seekbar' }], PlayerSettings.get('osdFocusRestoreMode') || 'always')}</div></div>

                <div class="setting-item"><div class="setting-label"><span class="setting-name" data-i18n="OkShowOsdOnly">${i18n.t('OkShowOsdOnly') || 'OK Shows OSD Only'}</span><span class="setting-description" data-i18n="OkShowOsdOnlyDescription">${i18n.t('OkShowOsdOnlyDescription') || 'When the player controls are hidden, pressing OK will only show them instead of also running the focused action.'}</span></div><div class="setting-control"><button class="toggle-switch ${PlayerSettings.get('okShowOsdOnly') ? 'active' : ''}" id="toggle-ok-show-osd-only" data-setting="okShowOsdOnly" tabindex="0"></button></div></div>
                <div class="setting-item"><div class="setting-label"><span class="setting-name" data-i18n="OsdColorButtonsReveal">${i18n.t('OsdColorButtonsReveal') || 'Colored Buttons Reveal OSD'}</span><span class="setting-description" data-i18n="OsdColorButtonsRevealDescription">${i18n.t('OsdColorButtonsRevealDescription') || 'Allow pressing colored remote buttons to instantly reveal controls in stealth mode instead of holding Down.'}</span></div><div class="setting-control"><button class="toggle-switch ${PlayerSettings.get('osdColorButtonsReveal') !== false ? 'active' : ''}" id="toggle-osd-color-buttons-reveal" data-setting="osdColorButtonsReveal" tabindex="0"></button></div></div>
                <div class="setting-item"><div class="setting-label"><span class="setting-name" data-i18n="KeepFocusOnSubtitleOffset">${i18n.t('KeepFocusOnSubtitleOffset') || 'Pin Subtitle Offset'}</span><span class="setting-description" data-i18n="KeepFocusOnSubtitleOffsetDescription">${i18n.t('KeepFocusOnSubtitleOffsetDescription') || 'Prevent the player controls from auto-hiding while the subtitle offset menu is open.'}</span></div><div class="setting-control"><button class="toggle-switch ${PlayerSettings.get('keepFocusOnSubtitleOffset') ? 'active' : ''}" id="toggle-keep-focus-subtitle-offset" data-setting="keepFocusOnSubtitleOffset" tabindex="0"></button></div></div>
                <div class="setting-item"><div class="setting-label"><span class="setting-name" data-i18n="LabelOsdHideUnfocusedProgress">${i18n.t('LabelOsdHideUnfocusedProgress') || 'Hide Progress and Time on Seekbar'}</span><span class="setting-description" data-i18n="OsdHideUnfocusedProgressDescription">${i18n.t('OsdHideUnfocusedProgressDescription') || "Hides the progress bar, times, and ends-at time when the seekbar is not focused."}</span></div><div class="setting-control"><button class="toggle-switch ${PlayerSettings.get('osdHideUnfocusedProgress') ? 'active' : ''}" id="toggle-osd-hide-unfocused-progress" data-setting="osdHideUnfocusedProgress" tabindex="0"></button></div></div>

                <h3 class="setting-section-title" data-i18n="VideoQuality">${i18n.t('VideoQuality')}</h3>
                <div class="setting-item"><div class="setting-label"><span class="setting-name" data-i18n="LabelMaxVideoResolution">${i18n.t('LabelMaxVideoResolution')}</span><span class="setting-description" data-i18n="MaxResolutionDescription">${i18n.t('MaxResolutionDescription')}</span></div><div class="setting-control">${this._drop('max-resolution-select', [{ value: 'auto', label: i18n.t('AutoRecommended') }, { value: '7680x4320', label: i18n.t('ResolutionValue', ['7680', '4320', '8K']) }, { value: '3840x2160', label: i18n.t('ResolutionValue', ['3840', '2160', '4K']) }, { value: '1920x1080', label: i18n.t('ResolutionValue', ['1920', '1080', 'FHD']) }, { value: '1280x720', label: i18n.t('ResolutionValue', ['1280', '720', 'HD']) }], PlayerSettings.get('maxResolution') || 'auto')}</div></div>
                <div class="setting-item"><div class="setting-label"><span class="setting-name" data-i18n="MaxStreamingBitrate">${i18n.t('MaxStreamingBitrate')}</span><span class="setting-description" data-i18n="MaxStreamingBitrateDescription">${i18n.t('MaxStreamingBitrateDescription')}</span></div><div class="setting-control">${this._drop('max-bitrate-select', [{ value: 0, label: i18n.t('AutoRecommended') }, ...[120, 80, 60, 40, 30, 20, 15, 10, 8, 6, 4, 3, 2, 1.5, 1].map((mb) => ({ value: mb * 1000000, label: i18n.t('BitrateMbps', [String(mb)]) })), { value: 750000, label: i18n.t('BitrateKbps', ['750']) }, { value: 500000, label: i18n.t('BitrateKbps', ['500']) }], PlayerSettings.get('maxBitrateInternet') || 0)}</div></div>

                <h3 class="setting-section-title" data-i18n="AudioSettings">${i18n.t('AudioSettings') || 'Audio'}</h3>
                <div class="setting-item"><div class="setting-label"><span class="setting-name" data-i18n="AllowedAudioChannels">${i18n.t('AllowedAudioChannels') || 'Maximum Audio Channels'}</span><span class="setting-description" data-i18n="AllowedAudioChannelsDescription">${i18n.t('AllowedAudioChannelsDescription') || 'Maximum audio channels allowed for Direct Play. Tracks with more channels will be transcoded.'}</span></div><div class="setting-control">${this._drop('allowed-audio-channels-select', [{ value: -1, label: i18n.t('AudioChannelsAuto') || 'Auto (No Limit)' }, { value: 8, label: i18n.t('AudioChannels71') || '7.1 Channels' }, { value: 6, label: i18n.t('AudioChannels51') || '5.1 Channels' }, { value: 2, label: i18n.t('AudioChannels20') || 'Stereo 2.0' }, { value: 1, label: i18n.t('AudioChannels10') || 'Mono 1.0' }], PlayerSettings.get('allowedAudioChannels') ?? -1)}</div></div>
                <div class="setting-item"><div class="setting-label"><span class="setting-name" data-i18n="TranscodeMaxAudioChannels">${i18n.t('TranscodeMaxAudioChannels') || 'Transcoding Max Audio Channels'}</span><span class="setting-description" data-i18n="TranscodeMaxAudioChannelsDescription">${i18n.t('TranscodeMaxAudioChannelsDescription') || 'Maximum audio channels output by the server when audio is transcoded.'}</span></div><div class="setting-control">${this._drop('transcode-max-audio-channels-select', [{ value: -1, label: i18n.t('AudioChannelsAutoTranscode') || 'Auto (Match Max Channels)' }, { value: 8, label: i18n.t('AudioChannels71') || '7.1 Channels' }, { value: 6, label: i18n.t('AudioChannels51') || '5.1 Channels' }, { value: 2, label: i18n.t('AudioChannels20') || 'Stereo 2.0' }, { value: 1, label: i18n.t('AudioChannels10') || 'Mono 1.0' }], PlayerSettings.get('transcodeMaxAudioChannels') ?? -1)}</div></div>

                ${currentBackend !== 'tizen' ? `
                <div class="setting-item"><div class="setting-label"><span class="setting-name" data-i18n="LabelDisableVbrAudioEncoding">${i18n.t('LabelDisableVbrAudioEncoding') || 'Disable VBR audio encoding'}</span><span class="setting-description" data-i18n="DisableVbrAudioEncodingHelp">${i18n.t('DisableVbrAudioEncodingHelp') || 'Prevent the server from encoding audio with VBR for this client.'}</span></div><div class="setting-control"><button class="toggle-switch ${PlayerSettings.get('disableVbrAudio') ? 'active' : ''}" id="toggle-disable-vbr-audio" data-setting="disableVbrAudio" tabindex="0"></button></div></div>
                <div class="setting-item"><div class="setting-label"><span class="setting-name" data-i18n="LabelSelectAudioNormalization">${i18n.t('LabelSelectAudioNormalization') || 'Audio Normalization'}</span><span class="setting-description" data-i18n="SelectAudioNormalizationHelp">${i18n.t('SelectAudioNormalizationHelp') || 'Track gain adjusts each track to play at the same loudness. Album gain preserves the dynamic range of an album.'}</span></div><div class="setting-control"><button class="btn btn-option" id="btn-audio-normalization" tabindex="0">${currentAudioNorm === 'Off' ? i18n.t('Off') || 'Off' : currentAudioNorm === 'TrackGain' ? i18n.t('LabelTrackGain') || 'Track Gain' : i18n.t('LabelAlbumGain') || 'Album Gain'}</button></div></div>
                ` : ''}

                <h3 class="setting-section-title" data-i18n="SegmentSkipping" style="margin-top: 40px;">${i18n.t('SegmentSkipping') || 'Segment Skipping'}</h3>
                <div class="setting-item"><div class="setting-label"><span class="setting-name" data-i18n="LabelSkipSegmentSource">${i18n.t('LabelSkipSegmentSource') || 'Segment Data Source'}</span><span class="setting-description" data-i18n="SkipSegmentSourceDescription">${i18n.t('SkipSegmentSourceDescription') || 'Choose whether to use the intro-skipper server plugin, video chapter markers, or combine both.'}</span></div><div class="setting-control">${this._drop('segment-source-select', [{ value: 'both', label: i18n.t('SegmentSourceBoth') || 'Server Plugin & Chapters (Merged)' }, { value: 'server', label: i18n.t('SegmentSourceServer') || 'Server Plugin Only (intro-skipper)' }, { value: 'chapters', label: i18n.t('SegmentSourceChapters') || 'Chapters Only (Disable Server Plugin)' }], PlayerSettings.get('skipSegmentSource') || 'both')}</div></div>
                <div class="setting-item"><div class="setting-label"><span class="setting-name" data-i18n="LabelSegmentActionIntro">${i18n.t('LabelSegmentActionIntro') || 'Intro Segment'}</span></div><div class="setting-control">${this._drop('segment-action-intro-select', SEGMENT_ACTION_OPTS, PlayerSettings.get('skipActionIntro') || 'AskToSkip')}</div></div>
                <div class="setting-item"><div class="setting-label"><span class="setting-name" data-i18n="LabelSegmentActionOutro">${i18n.t('LabelSegmentActionOutro') || 'Credits Segment'}</span></div><div class="setting-control">${this._drop('segment-action-outro-select', SEGMENT_ACTION_OPTS, PlayerSettings.get('skipActionOutro') || 'AskToSkip')}</div></div>
                <div class="setting-item"><div class="setting-label"><span class="setting-name" data-i18n="LabelSegmentActionRecap">${i18n.t('LabelSegmentActionRecap') || 'Recap Segment'}</span></div><div class="setting-control">${this._drop('segment-action-recap-select', SEGMENT_ACTION_OPTS, PlayerSettings.get('skipActionRecap') || 'None')}</div></div>
                <div class="setting-item"><div class="setting-label"><span class="setting-name" data-i18n="LabelSegmentActionPreview">${i18n.t('LabelSegmentActionPreview') || 'Preview Segment'}</span></div><div class="setting-control">${this._drop('segment-action-preview-select', SEGMENT_ACTION_OPTS, PlayerSettings.get('skipActionPreview') || 'None')}</div></div>

                <h3 class="setting-section-title" data-i18n="PlaybackCompatibility">${i18n.t('PlaybackCompatibility')}</h3>
                ${CODEC_ITEMS.slice(0, 3).map((c) => `
                <div class="setting-item"><div class="setting-label"><span class="setting-name" data-i18n="${c.name}">${i18n.t(c.name)}</span><span class="setting-description">${supportStatus(caps[c.cap])} — ${i18n.t(c.desc)}</span></div><div class="setting-control">${this._drop(c.id, forceStateOptions, PlayerSettings.get(c.key) || 'auto')}</div></div>
                `).join('')}

                <h3 class="setting-section-title" data-i18n="AdvancedCodecSettings">${i18n.t('AdvancedCodecSettings')}</h3>
                ${CODEC_ITEMS.slice(3, 7).map((c) => `
                <div class="setting-item"><div class="setting-label"><span class="setting-name" data-i18n="${c.name}">${i18n.t(c.name)}</span><span class="setting-description">${supportStatus(caps[c.cap])} — ${i18n.t(c.desc)}</span></div><div class="setting-control">${this._drop(c.id, forceStateOptions, PlayerSettings.get(c.key) || 'auto')}</div></div>
                `).join('')}

                <div class="setting-item">
                    <div class="setting-label"><span class="setting-name">${i18n.t('TranscodeAudioCodec') || 'Transcode Audio Codec'}</span><span class="setting-description">${i18n.t('TranscodeAudioCodecDescription') || 'When audio must be transcoded (e.g. DTS is unsupported), use this codec.'}</span></div>
                    <div class="setting-control">${this._drop('transcode-audio-codec-select', [{ value: 'auto', label: i18n.t('TranscodeCodecAuto') || 'Auto (Prefer E-AC3)' }, { value: 'prefer_ac3', label: i18n.t('TranscodeCodecPreferAc3') || 'Prefer AC3 (with AAC fallback)' }, { value: 'prefer_aac', label: i18n.t('TranscodeCodecPreferAac') || 'Prefer AAC' }, { value: 'force_eac3', label: i18n.t('TranscodeCodecForceEac3') || 'Only E-AC3' }, { value: 'force_ac3', label: i18n.t('TranscodeCodecForceAc3') || 'Only AC3' }, { value: 'force_aac', label: i18n.t('TranscodeCodecForceAac') || 'Only AAC' }, { value: 'force_mp3', label: i18n.t('TranscodeCodecForceMp3') || 'Only MP3' }], PlayerSettings.get('transcodeAudioCodec') || 'auto')}</div>
                </div>

                ${CODEC_ITEMS.slice(7).map((c) => `
                <div class="setting-item"><div class="setting-label"><span class="setting-name" data-i18n="${c.name}">${i18n.t(c.name) || c.name}</span><span class="setting-description" data-i18n="${c.desc}">${supportStatus(caps[c.cap])} — ${i18n.t(c.desc) || c.desc}</span></div><div class="setting-control">${this._drop(c.id, forceStateOptions, PlayerSettings.get(c.key) || 'auto')}</div></div>
                `).join('')}

                ${platformInfo.isTizen ? `
                <div class="setting-item"><div class="setting-label"><span class="setting-name" data-i18n="FLACPassthrough">${i18n.t('FLACPassthrough') || 'FLAC in Video Passthrough'}</span><span class="setting-description" data-i18n="FLACPassthroughDescription">${i18n.t('FLACPassthroughDescription') || 'Allow FLAC audio tracks in video files to play directly.'}</span></div><div class="setting-control"><button class="toggle-switch ${PlayerSettings.get('enableFlacInVideo') ? 'active' : ''}" id="toggle-enable-flac-in-video" data-setting="enableFlacInVideo" tabindex="0"></button></div></div>
                <div class="setting-item"><div class="setting-label"><span class="setting-name" data-i18n="PCMPassthrough">${i18n.t('PCMPassthrough') || 'PCM in Video Passthrough'}</span><span class="setting-description" data-i18n="PCMPassthroughDescription">${i18n.t('PCMPassthroughDescription') || 'Force uncompressed PCM audio tracks in video files to play directly on Tizen AVPlay.'}</span></div><div class="setting-control"><button class="toggle-switch ${PlayerSettings.get('enablePcmInVideo') ? 'active' : ''}" id="toggle-enable-pcm-in-video" data-setting="enablePcmInVideo" tabindex="0"></button></div></div>
                ` : ''}

                <div class="setting-item"><div class="setting-label"><span class="setting-name" data-i18n="EnableFmp4HlsContainer">${i18n.t('EnableFmp4HlsContainer') || 'Prefer fMP4 HLS Container'}</span><span class="setting-description" data-i18n="EnableFmp4HlsContainerDescription">${i18n.t('EnableFmp4HlsContainerDescription')}</span></div><div class="setting-control"><button class="toggle-switch ${PlayerSettings.get('enableFmp4HlsContainer') ? 'active' : ''}" id="toggle-enable-fmp4-hls" data-setting="enableFmp4HlsContainer" tabindex="0"></button></div></div>
                <div class="setting-item"><div class="setting-label"><span class="setting-name" data-i18n="ForceFmp4HlsContainer">${i18n.t('ForceFmp4HlsContainer') || 'Force fMP4 HLS Container'}</span><span class="setting-description" data-i18n="ForceFmp4HlsContainerDescription">${i18n.t('ForceFmp4HlsContainerDescription')}</span></div><div class="setting-control"><button class="toggle-switch ${PlayerSettings.get('forceFmp4HlsContainer') ? 'active' : ''}" id="toggle-force-fmp4-hls" data-setting="forceFmp4HlsContainer" tabindex="0"></button></div></div>
                <div class="setting-item"><div class="setting-label"><span class="setting-name" data-i18n="ForceTranscode">${i18n.t('ForceTranscode')}</span><span class="setting-description" data-i18n="ForceTranscodeDescription">${i18n.t('ForceTranscodeDescription')}</span></div><div class="setting-control"><button class="toggle-switch ${PlayerSettings.get('forceTranscode') ? 'active' : ''}" id="toggle-force-transcode" data-setting="forceTranscode" tabindex="0"></button></div></div>
                <div class="setting-item"><div class="setting-label"><span class="setting-name" data-i18n="RemuxMkvToMp4">${i18n.t('RemuxMkvToMp4') || 'Remux MKV to MP4'}</span><span class="setting-description" data-i18n="RemuxMkvToMp4Description">${i18n.t('RemuxMkvToMp4Description') || 'Always remux MKV containers to MP4. Streams are copied losslessly.'}</span></div><div class="setting-control"><button class="toggle-switch ${PlayerSettings.get('remuxMkvToMp4') ? 'active' : ''}" id="toggle-remux-mkv-to-mp4" data-setting="remuxMkvToMp4" tabindex="0"></button></div></div>
                <div class="setting-item"><div class="setting-label"><span class="setting-name" data-i18n="ForceDirectPlay">${i18n.t('ForceDirectPlay') || 'Force Direct Play'}</span><span class="setting-description" data-i18n="ForceDirectPlayDescription">${i18n.t('ForceDirectPlayDescription') || 'Forces direct play for all media formats.'}</span></div><div class="setting-control">${this._drop('force-direct-play-select', [{ value: 'off', label: i18n.t('ForceDirectPlayDisabled') || 'Disabled' }, { value: 'video', label: i18n.t('ForceDirectPlayVideoOnly') || 'Force Direct Play Video Codecs Only' }, { value: 'audio', label: i18n.t('ForceDirectPlayAudioOnly') || 'Force Direct Play Audio Codecs Only' }, { value: 'all', label: i18n.t('ForceDirectPlayAll') || 'Force Direct Play Everything' }], PlayerSettings.get('forceDirectPlay') || 'off')}</div></div>
                <div class="setting-item"><div class="setting-label"><span class="setting-name" data-i18n="AutoTranscodeOnError">${i18n.t('AutoTranscodeOnError') || 'Auto-Fallback to Transcode'}</span><span class="setting-description" data-i18n="AutoTranscodeOnErrorDescription">${i18n.t('AutoTranscodeOnErrorDescription') || 'Automatically escalate to server-side transcoding if DirectPlay or Remux fails.'}</span></div><div class="setting-control"><button class="toggle-switch ${PlayerSettings.get('autoTranscodeOnError') !== false ? 'active' : ''}" id="toggle-auto-transcode-on-error" data-setting="autoTranscodeOnError" tabindex="0"></button></div></div>

                <h3 class="setting-section-title" data-i18n="TrailersSettings">${i18n.t('TrailersSettings')}</h3>
                <div class="setting-item"><div class="setting-label"><span class="setting-name" data-i18n="TrailerPlayback">${i18n.t('TrailerPlayback') || 'Trailer Playback'}</span><span class="setting-description" data-i18n="TrailerPlaybackDescription">${i18n.t('TrailerPlaybackDescription') || 'Choose how remote trailers are opened'}</span></div><div class="setting-control">${this._drop('trailer-playback-select', [{ value: 'internal_proxy', label: i18n.t('InternalPlayerNew') || 'Internal Player (New)' }, { value: 'internal_iframe', label: i18n.t('InternalPlayerLegacy') || 'Internal Player (Legacy Iframe)' }, { value: 'external', label: i18n.t('ExternalApp') || 'External App' }], PlayerSettings.get('trailerPlaybackMode'))}</div></div>
                <div class="setting-item"><div class="setting-label"><span class="setting-name" data-i18n="TrailerAutoChain">${i18n.t('TrailerAutoChain') || 'Auto-play local, then online'}</span><span class="setting-description" data-i18n="TrailerAutoChainDescription">${i18n.t('TrailerAutoChainDescription') || 'Plays the server-side trailer first, then jumps straight to online trailer.'}</span></div><div class="setting-control"><button class="toggle-switch ${PlayerSettings.get('trailerAutoChain') ? 'active' : ''}" id="toggle-trailer-auto-chain" data-setting="trailerAutoChain" tabindex="0"></button></div></div>
                <div class="setting-item"><div class="setting-label"><span class="setting-name" data-i18n="EnableBackgroundService">${i18n.t('EnableBackgroundService') || 'Enable Background Service'}</span><span class="setting-description" data-i18n="EnableBackgroundServiceDescription">${i18n.t('EnableBackgroundServiceDescription') || 'Enable background Node.js service for Discovery and Proxy playback.'}</span></div><div class="setting-control"><button class="toggle-switch ${PlayerSettings.get('enableBackgroundService') ? 'active' : ''}" id="toggle-background-service" data-setting="enableBackgroundService" tabindex="0"></button></div></div>

                ${this._renderBufferingSection(currentBackend)}
            </div>
        `;
    }

    /**
     * Binds DOM event listeners for the player tab controls.
     * @param {HTMLElement} root The settings content container
     */
    mount(root) {
        const container = root || this.page?.el || this.page?.element || document;
        if (!container) return;
        this.destroy();
        const $ = (sel) => container.querySelector(sel);

        // Wire all data-setting toggle switches
        const toggles = container.querySelectorAll('.toggle-switch[data-setting]');
        toggles.forEach((btn) => {
            this._listen(btn, 'click', () => {
                const settingKey = btn.dataset.setting;
                const nextValue = !PlayerSettings.get(settingKey);
                PlayerSettings.set(settingKey, nextValue);
                btn.classList.toggle('active', nextValue);
                if (CLEAR_CAPS_KEYS.has(settingKey)) {
                    clearCapabilitiesCache();
                }
                log.info(`Player setting changed: ${settingKey} = ${nextValue}`);
            });
        });

        // Wire Preferred and Fallback Audio Languages modal trigger
        const btnAudioFallbacks = $('#audio-fallback-languages-btn');
        if (btnAudioFallbacks) {
            this._listen(btnAudioFallbacks, 'click', async (e) => {
                e.preventDefault();
                e.stopPropagation();
                if (this.page?._openAudioFallbackModal) {
                    await this.page._openAudioFallbackModal();
                }
            });
        }

        // Wire Audio Normalization modal trigger
        const audioNormBtn = $('#btn-audio-normalization');
        if (audioNormBtn) {
            this._listen(audioNormBtn, 'click', () => {
                const currentValue = PlayerSettings.get('audioNormalization') || 'TrackGain';
                if (this.page?._renderSelectionModal) {
                    this.page._renderSelectionModal(
                        i18n.t('LabelSelectAudioNormalization') || 'Audio Normalization',
                        [
                            { value: 'Off', label: i18n.t('Off') || 'Off' },
                            { value: 'TrackGain', label: i18n.t('LabelTrackGain') || 'Track Gain' },
                            { value: 'AlbumGain', label: i18n.t('LabelAlbumGain') || 'Album Gain' }
                        ],
                        currentValue,
                        (selected) => {
                            PlayerSettings.set('audioNormalization', selected);
                            audioNormBtn.textContent = selected === 'Off' ? i18n.t('Off') || 'Off' : selected === 'TrackGain' ? i18n.t('LabelTrackGain') || 'Track Gain' : i18n.t('LabelAlbumGain') || 'Album Gain';
                        }
                    );
                }
            });
        }
    }

    /**
     * Cleans up all attached event listeners to prevent memory leaks.
     */
    destroy() {
        for (const { element, event, handler } of this._listeners) {
            try {
                element.removeEventListener(event, handler);
            } catch (err) {
                log.warn('Failed to remove listener', err);
            }
        }
        this._listeners = [];
    }
}

export default PlayerTab;
