/**
 * ============================================================================
 * Litefin Tizen - Image Service
 * ============================================================================
 * Centralized utility for managing image optimization and quality settings.
 * ============================================================================
 */

import { storage } from './StorageService.js';

class ImageService {
    /**
     * Get current quality preset dynamically.
     * Prevents race conditions with storage.init() during app boot.
     * @returns {string} low | medium | high | very-high | ultra | original
     */
    getPreset() {
        return storage.getItem('pref:imageQuality') || 'medium';
    }

    /**
     * Set quality preset and save to storage
     * @param {string} preset - low | medium-low | medium | medium-high | high | ultra
     */
    setPreset(preset) {
        if (['low', 'medium-low', 'medium', 'medium-high', 'high', 'very-high', 'ultra', 'original'].includes(preset)) {
            storage.setItem('pref:imageQuality', preset);
            return true;
        }
        return false;
    }

    /**
     * Get hero-specific quality preset dynamically.
     * @returns {string} default | low | medium-low | medium | medium-high | high | very-high | ultra | original
     */
    getHeroPreset() {
        return storage.getItem('pref:heroImageQuality') || 'default';
    }

    /**
     * Set hero-specific quality preset and save to storage
     * @param {string} preset - default | low | medium-low | medium | medium-high | high | ultra
     */
    setHeroPreset(preset) {
        if (
            [
                'default',
                'low',
                'medium-low',
                'medium',
                'medium-high',
                'high',
                'very-high',
                'ultra',
                'original'
            ].includes(preset)
        ) {
            storage.setItem('pref:heroImageQuality', preset);
            return true;
        }
        return false;
    }

    /**
     * Get details-page specific quality preset dynamically.
     * @returns {string} default | low | medium-low | medium | medium-high | high | very-high | ultra | original
     */
    getDetailsPreset() {
        return storage.getItem('pref:detailsImageQuality') || 'very-high';
    }

    /**
     * Set details-page specific quality preset and save to storage
     * @param {string} preset - default | low | medium-low | medium | medium-high | high | very-high | ultra | original
     */
    setDetailsPreset(preset) {
        if (
            [
                'default',
                'low',
                'medium-low',
                'medium',
                'medium-high',
                'high',
                'very-high',
                'ultra',
                'original'
            ].includes(preset)
        ) {
            storage.setItem('pref:detailsImageQuality', preset);
            return true;
        }
        return false;
    }

    /**
     * Get optimization parameters for a specific image usage
     * @param {string} type - 'poster' | 'details-poster' | 'small-poster' | 'backdrop' | 'details-backdrop' | 'thumb' | 'avatar' | 'logo'
     * @param {string} [context] - 'home' | 'search' | 'library' | 'music' | 'player' | 'details'
     * @returns {Object} { maxWidth, quality }
     */
    getParams(type, context = null) {
        const presets = {
            low: {
                poster: 180,
                'details-poster': 315, // 420 * 0.75
                'details-thumb': 291, // 388 * 0.75
                'details-logo': 210, // 280 * 0.75
                'details-episode': 315, // 420 * 0.75
                'details-backdrop': 1280,
                'home-poster': 171, // 228 * 0.75
                'home-thumb': 291, // 388 * 0.75
                'home-square': 171, // 228 * 0.75
                'search-poster': 215, // 286 * 0.75
                'search-thumb': 377, // 502 * 0.75
                'search-square': 215, // 286 * 0.75
                'library-poster': 231, // 308 * 0.75
                'library-small': 111, // 148 * 0.75
                'library-thumb': 284, // 378 * 0.75
                'library-square': 231, // 308 * 0.75
                'library-banner': 400, // 533 * 0.75
                'library-list': 52, // 69 * 0.75
                'music-square': 291, // 388 * 0.75
                'music-small': 111, // 148 * 0.75
                'music-artist': 231, // 308 * 0.75
                'music-genre': 171, // 228 * 0.75
                'player-cover': 375, // 500 * 0.75
                'modern-poster': 169, // 225 * 0.75
                'modern-thumb': 450, // 600 * 0.75
                'modern-square': 254, // 338 * 0.75
                'modern-expanded': 450, // 600 * 0.75
                backdrop: 640,
                'card-backdrop': 280,
                'hero-banner': 554,
                'hero-semi-immersive': 607,
                'hero-immersive': 607,
                avatar: 140,
                logo: 280,
                episode: 315, // 420 * 0.75
                thumb: 291, // 388 * 0.75
                quality: 80
            },
            'medium-low': {
                poster: 216,
                'details-poster': 378, // 420 * 0.9
                'details-thumb': 349, // 388 * 0.9
                'details-logo': 252, // 280 * 0.9
                'details-episode': 378, // 420 * 0.9
                'details-backdrop': 1728,
                'home-poster': 205, // 228 * 0.9
                'home-thumb': 349, // 388 * 0.9
                'home-square': 205, // 228 * 0.9
                'search-poster': 257, // 286 * 0.9
                'search-thumb': 452, // 502 * 0.9
                'search-square': 257, // 286 * 0.9
                'library-poster': 277, // 308 * 0.9
                'library-small': 133, // 148 * 0.9
                'library-thumb': 340, // 378 * 0.9
                'library-square': 277, // 308 * 0.9
                'library-banner': 480, // 533 * 0.9
                'library-list': 62, // 69 * 0.9
                'music-square': 349, // 388 * 0.9
                'music-small': 133, // 148 * 0.9
                'music-artist': 277, // 308 * 0.9
                'music-genre': 205, // 228 * 0.9
                'player-cover': 450, // 500 * 0.9
                'modern-poster': 203, // 225 * 0.9
                'modern-thumb': 540, // 600 * 0.9
                'modern-square': 304, // 338 * 0.9
                'modern-expanded': 540, // 600 * 0.9
                backdrop: 972,
                'card-backdrop': 360,
                'hero-banner': 1100,
                'hero-semi-immersive': 1200,
                'hero-immersive': 1200,
                avatar: 180,
                logo: 360,
                episode: 378, // 420 * 0.9
                thumb: 349, // 388 * 0.9
                quality: 85
            },
            medium: {
                poster: 240,
                'details-poster': 420,
                'details-thumb': 388,
                'details-logo': 280,
                'details-episode': 420,
                'details-backdrop': 1920,
                'home-poster': 228,
                'home-thumb': 388,
                'home-square': 228,
                'search-poster': 286,
                'search-thumb': 502,
                'search-square': 286,
                'library-poster': 308,
                'library-small': 148,
                'library-thumb': 378,
                'library-square': 308,
                'library-banner': 533,
                'library-list': 69,
                'music-square': 388,
                'music-small': 148,
                'music-artist': 308,
                'music-genre': 228,
                'player-cover': 500,
                'modern-poster': 225,
                'modern-thumb': 600,
                'modern-square': 338,
                'modern-expanded': 600,
                backdrop: 1080,
                'card-backdrop': 400,
                'hero-banner': 1662,
                'hero-semi-immersive': 1820,
                'hero-immersive': 1820,
                avatar: 200,
                logo: 400,
                episode: 420,
                thumb: 388,
                quality: 90
            },
            'medium-high': {
                poster: 264,
                'details-poster': 462, // 420 * 1.1
                'details-thumb': 427, // 388 * 1.1
                'details-logo': 308, // 280 * 1.1
                'details-episode': 462, // 420 * 1.1
                'details-backdrop': 2112,
                'home-poster': 251, // 228 * 1.1
                'home-thumb': 427, // 388 * 1.1
                'home-square': 251, // 228 * 1.1
                'search-poster': 315, // 286 * 1.1
                'search-thumb': 552, // 502 * 1.1
                'search-square': 315, // 286 * 1.1
                'library-poster': 339, // 308 * 1.1
                'library-small': 163, // 148 * 1.1
                'library-thumb': 416, // 378 * 1.1
                'library-square': 339, // 308 * 1.1
                'library-banner': 586, // 533 * 1.1
                'library-list': 76, // 69 * 1.1
                'music-square': 427, // 388 * 1.1
                'music-small': 163, // 148 * 1.1
                'music-artist': 339, // 308 * 1.1
                'music-genre': 251, // 228 * 1.1
                'player-cover': 550, // 500 * 1.1
                'modern-poster': 248, // 225 * 1.1
                'modern-thumb': 660, // 600 * 1.1
                'modern-square': 372, // 338 * 1.1
                'modern-expanded': 660, // 600 * 1.1
                backdrop: 1188,
                'card-backdrop': 440,
                'hero-banner': 1790,
                'hero-semi-immersive': 1870,
                'hero-immersive': 1870,
                avatar: 220,
                logo: 440,
                episode: 462, // 420 * 1.1
                thumb: 427, // 388 * 1.1
                quality: 90
            },
            high: {
                poster: 288,
                'details-poster': 504, // 420 * 1.2
                'details-thumb': 466, // 388 * 1.2
                'details-logo': 336, // 280 * 1.2
                'details-episode': 504, // 420 * 1.2
                'details-backdrop': 2304,
                'home-poster': 274, // 228 * 1.2
                'home-thumb': 466, // 388 * 1.2
                'home-square': 274, // 228 * 1.2
                'search-poster': 343, // 286 * 1.2
                'search-thumb': 602, // 502 * 1.2
                'search-square': 343, // 286 * 1.2
                'library-poster': 370, // 308 * 1.2
                'library-small': 178, // 148 * 1.2
                'library-thumb': 454, // 378 * 1.2
                'library-square': 370, // 308 * 1.2
                'library-banner': 640, // 533 * 1.2
                'library-list': 83, // 69 * 1.2
                'music-square': 466, // 388 * 1.2
                'music-small': 178, // 148 * 1.2
                'music-artist': 370, // 308 * 1.2
                'music-genre': 274, // 228 * 1.2
                'player-cover': 600, // 500 * 1.2
                'modern-poster': 270, // 225 * 1.2
                'modern-thumb': 720, // 600 * 1.2
                'modern-square': 406, // 338 * 1.2
                'modern-expanded': 720, // 600 * 1.2
                backdrop: 1296,
                'card-backdrop': 480,
                'hero-banner': 1920,
                'hero-semi-immersive': 1920,
                'hero-immersive': 1920,
                avatar: 240,
                logo: 480,
                episode: 504, // 420 * 1.2
                thumb: 466, // 388 * 1.2
                quality: 95
            },
            'very-high': {
                poster: 360,
                'details-poster': 630, // 420 * 1.5
                'details-thumb': 582, // 388 * 1.5
                'details-logo': 420, // 280 * 1.5
                'details-episode': 630, // 420 * 1.5
                'details-backdrop': 2880,
                'home-poster': 342, // 228 * 1.5
                'home-thumb': 582, // 388 * 1.5
                'home-square': 342, // 228 * 1.5
                'search-poster': 429, // 286 * 1.5
                'search-thumb': 753, // 502 * 1.5
                'search-square': 429, // 286 * 1.5
                'library-poster': 462, // 308 * 1.5
                'library-small': 222, // 148 * 1.5
                'library-thumb': 567, // 378 * 1.5
                'library-square': 462, // 308 * 1.5
                'library-banner': 800, // 533 * 1.5
                'library-list': 104, // 69 * 1.5
                'music-square': 582, // 388 * 1.5
                'music-small': 222, // 148 * 1.5
                'music-artist': 462, // 308 * 1.5
                'music-genre': 342, // 228 * 1.5
                'player-cover': 750, // 500 * 1.5
                'modern-poster': 338, // 225 * 1.5
                'modern-thumb': 900, // 600 * 1.5
                'modern-square': 507, // 338 * 1.5
                'modern-expanded': 900, // 600 * 1.5
                backdrop: 1620,
                'card-backdrop': 600,
                'hero-banner': 2560,
                'hero-semi-immersive': 2560,
                'hero-immersive': 2560,
                avatar: 300,
                logo: 600,
                episode: 630, // 420 * 1.5
                thumb: 582, // 388 * 1.5
                quality: 95
            },
            ultra: {
                poster: 480,
                'details-poster': 840, // 420 * 2.0
                'details-thumb': 776, // 388 * 2.0
                'details-logo': 560, // 280 * 2.0
                'details-episode': 840, // 420 * 2.0
                'details-backdrop': 3840,
                'home-poster': 456, // 228 * 2.0
                'home-thumb': 776, // 388 * 2.0
                'home-square': 456, // 228 * 2.0
                'search-poster': 572, // 286 * 2.0
                'search-thumb': 1004, // 502 * 2.0
                'search-square': 572, // 286 * 2.0
                'library-poster': 616, // 308 * 2.0
                'library-small': 296, // 148 * 2.0
                'library-thumb': 756, // 378 * 2.0
                'library-square': 616, // 308 * 2.0
                'library-banner': 1066, // 533 * 2.0
                'library-list': 138, // 69 * 2.0
                'music-square': 776, // 388 * 2.0
                'music-small': 296, // 148 * 2.0
                'music-artist': 616, // 308 * 2.0
                'music-genre': 456, // 228 * 2.0
                'player-cover': 1000, // 500 * 2.0
                'modern-poster': 450, // 225 * 2.0
                'modern-thumb': 1200, // 600 * 2.0
                'modern-square': 676, // 338 * 2.0
                'modern-expanded': 1200, // 600 * 2.0
                backdrop: 2160,
                'card-backdrop': 800,
                'hero-banner': 3840,
                'hero-semi-immersive': 3840,
                'hero-immersive': 3840,
                avatar: 400,
                logo: 800,
                episode: 840, // 420 * 2.0
                thumb: 776, // 388 * 2.0
                quality: 99
            },
            original: {
                poster: null,
                'details-poster': null,
                'details-thumb': null,
                'details-logo': null,
                'details-episode': null,
                'details-backdrop': null,
                'home-poster': null,
                'home-thumb': null,
                'home-square': null,
                'search-poster': null,
                'search-thumb': null,
                'search-square': null,
                'library-poster': null,
                'library-small': null,
                'library-thumb': null,
                'library-square': null,
                'library-banner': null,
                'library-list': null,
                'music-square': null,
                'music-small': null,
                'music-artist': null,
                'music-genre': null,
                'player-cover': null,
                'modern-poster': null,
                'modern-thumb': null,
                'modern-square': null,
                'modern-expanded': null,
                backdrop: null,
                'card-backdrop': null,
                'hero-banner': null,
                'hero-semi-immersive': null,
                'hero-immersive': null,
                thumb: null,
                square: null,
                banner: null,
                avatar: null,
                logo: null,
                quality: null
            }
        };

        let targetPreset = this.getPreset();

        // 1. Resolve context if provided
        // If we have a context (e.g., 'home'), and the type isn't already prefixed,
        // we try to resolve the context-prefixed version first.
        if (context && !type.includes('-')) {
            // Map specific home and library row contexts to the general 'home' prefix for unified resolution (e.g. 228px posters)
            const resolutionContext = [
                'resume',
                'nextUp',
                'latest',
                'favorite',
                'favorites',
                'upcoming',
                'suggestion',
                'genre',
                'details-row',
                'person',
                'livetv',
                'login',
                'profiles'
            ].includes(context)
                ? 'home'
                : context;
            const contextType = `${resolutionContext}-${type}`;

            // If the prefixed version exists in ANY preset group, we switch to it.
            // We check the 'medium' group as a representative for existence.
            if (presets.medium[contextType] !== undefined) {
                type = contextType;
            }
        }

        // 1.5 Intercept and map to modern layout card sizes if modern layout is active
        const isModern =
            typeof document !== 'undefined' &&
            document.documentElement &&
            document.documentElement.getAttribute('data-layout-media-rows') === 'modern';
        if (isModern && !type.startsWith('details-') && !type.startsWith('hero-')) {
            if (type === 'expanded-poster') {
                type = 'modern-expanded';
            } else if (type.endsWith('poster')) {
                type = 'modern-poster';
            } else if (type.endsWith('thumb') || type === 'card-backdrop') {
                type = 'modern-thumb';
            } else if (type.endsWith('square') || type.endsWith('artist') || type.endsWith('small')) {
                type = 'modern-square';
            }
        }

        // 2. Handle special override-able presets (Hero and Details)
        // Note: These triggers happen AFTER context resolution so they can override it.
        if (type.startsWith('hero-')) {
            const heroPreset = this.getHeroPreset();
            if (heroPreset !== 'default') {
                targetPreset = heroPreset;
            }
            // Hero logo uses the generic logo size unless we have a specific hero-logo (we don't yet)
            if (type === 'hero-logo') {
                type = 'logo';
            }
        } else if (type.startsWith('details-')) {
            const detailsPreset = this.getDetailsPreset();
            if (detailsPreset !== 'default') {
                targetPreset = detailsPreset;
            }
        }

        // 2.5 Adjust preset scale dynamically in layout modes
        if (targetPreset !== 'original') {
            const isRowCard =
                !type.startsWith('details-') &&
                !type.startsWith('hero-') &&
                type !== 'avatar' &&
                type !== 'logo' &&
                type !== 'backdrop';
            if (isRowCard) {
                const layoutDefaultScale = isModern ? 1.3 : 1.0;
                const scale =
                    parseFloat(storage.getItem(isModern ? 'pref:modernCardSizeScale' : 'pref:classicCardSizeScale')) ||
                    layoutDefaultScale;
                if (scale !== layoutDefaultScale) {
                    const scaleMap = {
                        'low': 0.75,
                        'medium-low': 0.90,
                        'medium': 1.00,
                        'medium-high': 1.10,
                        'high': 1.20,
                        'very-high': 1.50,
                        'ultra': 2.00
                    };
                    const currentPresetScale = scaleMap[targetPreset] || 1.0;
                    const targetScale = currentPresetScale + (scale - layoutDefaultScale);
                    let bestPreset = targetPreset;
                    let minDiff = Infinity;
                    for (const [presetName, presetScale] of Object.entries(scaleMap)) {
                        const diff = Math.abs(presetScale - targetScale);
                        if (diff < minDiff) {
                            minDiff = diff;
                            bestPreset = presetName;
                        }
                    }
                    targetPreset = bestPreset;
                }
            }
        }

        const currentScale = presets[targetPreset] || presets.medium;

        // 3. Robust Fallback (Prefix Stripping)
        // If the current scale group doesn't have the specific (prefixed) type,
        // we strip the prefix and try to find the base type.
        if (currentScale[type] === undefined) {
            const knownPrefixes = ['home-', 'search-', 'library-', 'music-', 'player-', 'details-'];
            for (const prefix of knownPrefixes) {
                if (type.startsWith(prefix)) {
                    const baseType = type.replace(prefix, '');
                    if (currentScale[baseType] !== undefined) {
                        type = baseType;
                    }
                    break;
                }
            }
        }

        const maxWidth = currentScale[type] !== undefined ? currentScale[type] : 300;

        return {
            maxWidth,
            quality: currentScale.quality
        };
    }
}

export const imageService = new ImageService();
