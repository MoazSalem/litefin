/**
 * ============================================================================
 * Litefin Tizen - Settings Dropdown Configuration Map
 * ============================================================================
 * Central dictionary mapping DOM dropdown control identifiers to their
 * respective storage keys, target subsystems, and change event triggers.
 * Keeps dropdown dispatch decoupled and maintainable across tabs.
 * ============================================================================
 */

import { layoutManager } from '../../../ui/LayoutManager.js';

/**
 * Builds and returns the comprehensive dropdown settings dictionary.
 * Dynamically resolves active card scale keys based on the active layout mode.
 * @returns {Record<string, { key: string, type: 'local'|'service'|'details-service'|'player'|'debug', triggerEvent?: boolean }>}
 */
export function getSettingsDropdownMap() {
    return {
        // Core Layout & Localization Selectors
        'library-thumb-mode-select': { key: 'pref:libraryThumbMode', type: 'local' },
        'app-language-select': { key: 'app_language', type: 'local' },
        'layout-direction-select': { key: 'layout_direction', type: 'local' },
        'media-rows-layout-select': { key: 'pref:mediaRowsLayout', type: 'local', triggerEvent: true },
        'login-page-layout-select': { key: 'pref:loginPageLayout', type: 'local', triggerEvent: true },
        'alpha-picker-position-select': { key: 'pref:alphaPickerPosition', type: 'local', triggerEvent: true },
        'default-library-view-mode-select': {
            key: 'pref:defaultLibraryViewMode',
            type: 'local',
            triggerEvent: true
        },
        'default-library-columns-select': {
            key: 'pref:defaultLibraryGridColumns',
            type: 'local',
            triggerEvent: true
        },
        'sidebar-layout-select': { key: 'pref:sidebarLayoutMode', type: 'local', triggerEvent: true },
        'classic-card-size-scale-select': {
            key: (() => {
                const layout = layoutManager.getMediaRowsLayout();
                if (layout === 'expanded') return 'pref:expandedCardSizeScale';
                if (layout === 'modern-posters') return 'pref:modernPostersCardSizeScale';
                if (layout === 'modern') return 'pref:modernCardSizeScale';
                if (layout === 'expanding') return 'pref:expandingCardSizeScale';
                return 'pref:classicCardSizeScale';
            })(),
            type: 'local',
            triggerEvent: true
        },

        // Visual Theming & Design System Presets
        'display-scale-select': { key: 'pref:displayScale', type: 'local' },
        'text-scale-select': { key: 'litefin:textScale', type: 'local' },
        'home-rows-limit-select': { key: 'pref:homeRowsLimit', type: 'local', triggerEvent: true },
        'next-up-max-days-select': { key: 'pref:nextUpMaxDays', type: 'local' },
        'badge-style-select': { key: 'litefin:badgeStyle', type: 'local' },
        'button-style-select': { key: 'litefin:buttonStyle', type: 'local' },
        'focus-border-style-select': { key: 'litefin:focusBorderStyle', type: 'local' },
        'card-label-style-select': { key: 'pref:cardLabelStyle', type: 'local' },
        'card-label-align-select': { key: 'pref:cardLabelAlign', type: 'local' },
        'card-label-scale-select': { key: 'pref:cardLabelScale', type: 'local' },
        'theme-mode-select': { key: 'themeMode', type: 'local', triggerEvent: true },
        'ui-font-select': { key: 'uiFont', type: 'local' },
        'jellyfin-fallback-font-select': { key: 'pref:jellyfinFallbackFont', type: 'local', triggerEvent: true },
        'image-quality-select': { key: 'imageQuality', type: 'service' },
        'details-image-quality-select': { key: 'detailsImageQuality', type: 'details-service' },

        // Video Player & Playback Pipeline Controls
        'max-resolution-select': { key: 'maxResolution', type: 'player' },
        'player-backend-select': { key: 'playerBackend', type: 'player' },
        'max-bitrate-select': { key: 'maxBitrateInternet', type: 'player' },
        'trailer-playback-select': { key: 'trailerPlaybackMode', type: 'player' },
        'audio-lang-select': { key: 'pref:audioLang', type: 'local' },
        'audio-fallback-lang-1-select': { key: 'pref:audioLangFallback1', type: 'local' },
        'audio-fallback-lang-2-select': { key: 'pref:audioLangFallback2', type: 'local' },
        'audio-fallback-lang-3-select': { key: 'pref:audioLangFallback3', type: 'local' },
        'subtitle-lang-select': { key: 'pref:subtitleLang', type: 'local' },
        'skip-forward-select': { key: 'skipForwardLength', type: 'player' },
        'skip-back-select': { key: 'skipBackLength', type: 'player' },
        'resume-rewind-select': { key: 'resumeRewindLength', type: 'player' },

        // Subtitle Engine, Font Casing, and Ass Renderer Tuning
        'subtitle-mode-select': { key: 'subtitleMode', type: 'player' },
        'subtitle-burn-in-select': { key: 'subtitleBurnIn', type: 'player' },
        'pgs-playback-mode-select': { key: 'pgsPlaybackMode', type: 'player' },
        'subtitle-size-select': { key: 'subtitleSize', type: 'player' },
        'subtitle-weight-select': { key: 'subtitleWeight', type: 'player' },
        'subtitle-font-select': { key: 'subtitleFont', type: 'player' },
        'subtitle-font-ass-select': { key: 'subtitleFontAss', type: 'player' },
        'ass-renderer-select': { key: 'assRenderer', type: 'player' },
        'ass-prescale-factor-select': { key: 'subtitleAssPrescaleFactor', type: 'player' },
        'subtitle-color-select': { key: 'subtitleTextColor', type: 'player' },
        'subtitle-color-select-hdr': { key: 'subtitleTextColorHdr', type: 'player' },
        'subtitle-shadow-select': { key: 'subtitleDropShadow', type: 'player' },
        'subtitle-shadow-color-select': { key: 'subtitleDropShadowColor', type: 'player' },
        'subtitle-bg-select': { key: 'subtitleTextBackground', type: 'player' },
        'subtitle-position-select': { key: 'subtitleVerticalPosition', type: 'player' },
        'subtitle-custom-size': { key: 'subtitleSizeCustomValue', type: 'player' },
        'subtitle-border-width': { key: 'subtitleBorderWidth', type: 'player' },
        'subtitle-font-scale': { key: 'subtitleFontScale', type: 'player' },
        'subtitle-outline-thickness': { key: 'subtitleOutlineThickness', type: 'player' },
        'subtitle-shadow-thickness': { key: 'subtitleShadowThickness', type: 'player' },
        'subtitle-line-height': { key: 'subtitleLineHeight', type: 'player' },
        'subtitle-letter-spacing': { key: 'subtitleLetterSpacing', type: 'player' },
        'subtitle-bottom-offset': { key: 'subtitleBottomOffset', type: 'player' },
        'subtitle-force-text-toggle': { key: 'disableAssStyling', type: 'player' },
        'subtitle-override-colors-toggle': { key: 'subtitleOverrideColors', type: 'player' },

        // Developer Debugging & Overlay Dimensions
        'debug-width-select': { key: 'debug_width', type: 'debug' },
        'debug-height-select': { key: 'debug_height', type: 'debug' },
        'debug-position-select': { key: 'debug_position', type: 'debug' },

        // Screensaver & Ambient Backdrop Control
        'screensaver-delay-select': { key: 'pref:screensaverDelay', type: 'local', triggerEvent: true },
        'screensaver-type-select': { key: 'pref:screensaverType', type: 'local', triggerEvent: true },
        'backdrop-dimmer-select': { key: 'pref:backdropDimmer', type: 'local', triggerEvent: true },

        // TV Physics & Smooth Scroll Dynamics
        'vertical-scroll-mode-select': { key: 'pref:verticalScrollMode', type: 'local', triggerEvent: true },
        'horizontal-scroll-mode-select': { key: 'pref:horizontalScrollMode', type: 'local', triggerEvent: true },
        'scroll-smoothing-duration-select': {
            key: 'pref:scrollSmoothingDuration',
            type: 'local',
            triggerEvent: true
        },
        'scroll-physics-select': {
            key: 'pref:scrollPhysics',
            type: 'local',
            triggerEvent: true
        },
        'vertical-scroll-alignment-select': {
            key: 'pref:verticalScrollAlignment',
            type: 'local',
            triggerEvent: true
        },

        // Hardware TV Remote Color Button Actions
        'remote-red-select': { key: 'pref:remoteRedAction', type: 'local', triggerEvent: true },
        'remote-green-select': { key: 'pref:remoteGreenAction', type: 'local', triggerEvent: true },
        'remote-yellow-select': { key: 'pref:remoteYellowAction', type: 'local', triggerEvent: true },
        'remote-blue-select': { key: 'pref:remoteBlueAction', type: 'local', triggerEvent: true },

        // System Time & Clock Formats
        'time-format-select': { key: 'timeFormat', type: 'player' },
        'time-source-select': { key: 'timeSource', type: 'player', triggerEvent: true },
        'time-timezone-select': { key: 'timeZoneOffset', type: 'player', triggerEvent: true },

        // Hardware Codec Acceleration Toggles
        'force-direct-play-select': { type: 'player', key: 'forceDirectPlay' },
        'allowed-audio-channels-select': { type: 'player', key: 'allowedAudioChannels' },
        'transcode-max-audio-channels-select': { type: 'player', key: 'transcodeMaxAudioChannels' },
        'hevc-force-select': { type: 'player', key: 'enableHEVC' },
        'hdr-force-select': { type: 'player', key: 'enableHDR' },
        'dv-force-select': { type: 'player', key: 'enableDolbyVision' },
        'av1-force-select': { type: 'player', key: 'enableAV1' },
        'vp9-force-select': { type: 'player', key: 'enableVP9' },
        'dts-force-select': { type: 'player', key: 'enableDts' },
        'truehd-force-select': { type: 'player', key: 'enableTrueHd' },
        'eac3-force-select': { type: 'player', key: 'enableEac3' },
        'mp2-force-select': { type: 'player', key: 'enableMp2' },
        'transcode-audio-codec-select': { type: 'player', key: 'transcodeAudioCodec' },
        'watched-threshold-select': { type: 'player', key: 'watchedThreshold' },

        // WebOS Specific Hardware Buffer Gates
        'webos-buffer-gate-select': { type: 'player', key: 'webosBufferGate' },
        'webos-stall-recovery-select': { type: 'player', key: 'webosStallRecovery' },
        'webos-segment-length-select': { type: 'player', key: 'webosSegmentLength' },

        // Tizen & HTML5 Streaming Buffer Thresholds
        'tizen-initial-buffer-select': { type: 'player', key: 'tizenInitialBuffer' },
        'tizen-resume-buffer-select': { type: 'player', key: 'tizenResumeBuffer' },
        'tizen-segment-length-select': { type: 'player', key: 'tizenSegmentLength' },
        'html5-max-buffer-select': { type: 'player', key: 'html5MaxBufferLength' },
        'html5-max-max-buffer-select': { type: 'player', key: 'html5MaxMaxBufferLength' },
        'html5-segment-length-select': { type: 'player', key: 'html5SegmentLength' },

        // Media Details Presentation & Line Clamp Styling
        'rating-type-select': { key: 'pref:ratingType', type: 'local' },
        'rating-source-select': { key: 'pref:ratingSource', type: 'local' },
        'score-visibility-select': { key: 'pref:scoreVisibility', type: 'local' },
        'details-title-style-select': { key: 'pref:detailsTitleStyle', type: 'local' },
        'show-action-tooltips-select': { key: 'pref:showActionTooltips', type: 'local' },
        'details-overview-max-lines-select': { key: 'pref:detailsOverviewMaxLines', type: 'local' },
        'watch-provider-region-select': { key: 'pref:watchProviderRegion', type: 'local' },
        'details-layout-select': { key: 'pref:detailsLayout', type: 'local' },
        'season-episode-details-layout-select': { key: 'pref:seasonEpisodeDetailsLayout', type: 'local' },
        'episode-layout-select': { key: 'pref:episodeLayout', type: 'local' },
        'show-dates-select': { key: 'pref:showDates', type: 'local' },
        'rich-metadata-select': { key: 'pref:richMetadataStyle', type: 'local' },
        'library-page-size-select': { key: 'pref:libraryPageSize', type: 'local', triggerEvent: true },
        'play-queue-episode-limit-select': { type: 'player', key: 'playQueueEpisodeLimit' },

        // Hero Carousel Banner Styling
        'hero-carousel-style-select': { key: 'pref:heroCarouselStyle', type: 'local' },
        'hero-carousel-indicator-style-select': { key: 'pref:heroCarouselIndicatorStyle', type: 'local' },
        'hero-image-quality-select': { key: 'pref:heroImageQuality', type: 'local' },
        'hero-carousel-interval-select': { key: 'pref:heroCarouselInterval', type: 'local' },
        'hero-carousel-count-select': { key: 'pref:heroCarouselCount', type: 'local' },
        'hero-carousel-vignette-select': { key: 'pref:heroCarouselVignette', type: 'local' },

        // Navigation Sidebar Accents & Icon Variants
        'sidebar-mode-select': { key: 'pref:sidebarMode', type: 'local' },
        'icon-style-select': { key: 'pref:iconStyle', type: 'local', triggerEvent: true },
        'icon-variant-select': { key: 'pref:iconVariant', type: 'local', triggerEvent: true },
        'hover-border-style-select': { key: 'litefin:hoverBorderStyle', type: 'local' },
        'sidebar-selected-color-select': { key: 'litefin:sidebarSelectedColor', type: 'local' },
        'sidebar-unselected-color-select': { key: 'litefin:sidebarUnselectedColor', type: 'local' },
        'sidebar-logo-color-select': { key: 'litefin:sidebarLogoColor', type: 'local' },
        'osd-button-style-select': { key: 'litefin:osdButtonStyle', type: 'local' },
        'osd-focus-border-style-select': { key: 'litefin:osdFocusBorderStyle', type: 'local' },
        'osd-button-shape-select': { key: 'litefin:osdButtonShape', type: 'local' },
        'osd-unfocused-button-style-select': { key: 'litefin:osdUnfocusedButtonStyle', type: 'local' },
        'osd-focus-mode-select': { type: 'player', key: 'osdFocusRestoreMode' },
        'osd-time-display-select': { type: 'player', key: 'osdTimeDisplayMode' },
        'osd-logo-size-select': { type: 'player', key: 'osdLogoSize' },
        'osd-buttons-location-select': { type: 'player', key: 'osdButtonsLocation' },
        'osd-layout-select': { type: 'player', key: 'osdLayout' },
        'next-up-dialog-style-select': { type: 'player', key: 'nextUpDialogStyle' },
        'next-up-dialog-scale-select': { type: 'player', key: 'nextUpDialogScale' },
        'next-up-dialog-trigger-select': { type: 'player', key: 'nextUpTriggerMode' },
        'segment-source-select': { type: 'player', key: 'skipSegmentSource' },
        'segment-action-intro-select': { type: 'player', key: 'skipActionIntro' },
        'segment-action-outro-select': { type: 'player', key: 'skipActionOutro' },
        'segment-action-recap-select': { type: 'player', key: 'skipActionRecap' },
        'segment-action-preview-select': { type: 'player', key: 'skipActionPreview' },
        'osd-seekbar-thumb-color-select': { key: 'litefin:osdSeekBarThumbColor', type: 'local' },
        'osd-seekbar-progress-color-select': { key: 'litefin:osdSeekBarProgressColor', type: 'local' },
        'theme-song-volume-select': { key: 'pref:themeSongVolume', type: 'local' },
        'collapsed-sidebar-color-select': { key: 'pref:collapsedSidebarColor', type: 'local', triggerEvent: true },
        'expanded-sidebar-color-select': { key: 'pref:expandedSidebarColor', type: 'local', triggerEvent: true },
        'bottom-nav-bar-color-select': { key: 'pref:bottomNavBarColor', type: 'local', triggerEvent: true },
        'sidebar-logo-settings-select': { key: 'pref:logoSettings', type: 'local', triggerEvent: true },
        'sidebar-back-button-select': { key: 'pref:sidebarBackButton', type: 'local', triggerEvent: true },
        'sidebar-icon-shadows-select': { key: 'pref:sidebarIconShadows', type: 'local', triggerEvent: true },
        'sidebar-items-align-select': { key: 'pref:sidebarItemsAlign', type: 'local', triggerEvent: true },
        'trending-movies-collection-select': {
            key: 'pref:trendingMoviesCollection',
            type: 'local',
            triggerEvent: true
        },
        'trending-series-collection-select': {
            key: 'pref:trendingSeriesCollection',
            type: 'local',
            triggerEvent: true
        },
        'default-livetv-tab-select': { key: 'pref:defaultLiveTvTab', type: 'local' }
    };
}
