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
     * @returns {Object} { maxWidth, quality }
     */
    getParams(type) {
        const presets = {
            low: {
                poster: 180,
                'details-poster': 472,
                'small-poster': 120,
                backdrop: 640,
                'details-backdrop': 1280, // High-quality baseline for details page backdrop
                'card-backdrop': 280,
                'hero-banner': 554,
                'hero-immersive': 607,
                thumb: 280,
                square: 180,
                banner: 640,
                avatar: 140,
                logo: 280,
                quality: 80
            },
            'medium-low': {
                poster: 216,
                'details-poster': 567,
                'small-poster': 144,
                backdrop: 972,
                'details-backdrop': 1728,
                'card-backdrop': 360,
                'hero-banner': 1100,
                'hero-immersive': 1200,
                thumb: 360,
                square: 216,
                banner: 900,
                avatar: 180,
                logo: 360,
                quality: 85
            },
            medium: {
                /*
                 * BASELINE (1.0x Rendered Size)
                 */
                poster: 240,
                'details-poster': 630,
                'small-poster': 160,
                backdrop: 1080,
                'details-backdrop': 1920, // Full 1080p width for Details Page
                'card-backdrop': 400,
                'hero-banner': 1662,
                'hero-immersive': 1820,
                thumb: 400,
                square: 240,
                banner: 1000,
                avatar: 200,
                logo: 400,
                quality: 90
            },
            'medium-high': {
                poster: 264,
                'details-poster': 693,
                'small-poster': 176,
                backdrop: 1188,
                'details-backdrop': 2112,
                'card-backdrop': 440,
                'hero-banner': 1790,
                'hero-immersive': 1870,
                thumb: 440,
                square: 264,
                banner: 1100,
                avatar: 220,
                logo: 440,
                quality: 90
            },
            high: {
                poster: 288,
                'details-poster': 756,
                'small-poster': 192,
                backdrop: 1296,
                'details-backdrop': 2304,
                'card-backdrop': 480,
                'hero-banner': 1920,
                'hero-immersive': 1920,
                thumb: 480,
                square: 288,
                banner: 1200,
                avatar: 240,
                logo: 480,
                quality: 95
            },
            'very-high': {
                poster: 360,
                'details-poster': 945,
                'small-poster': 240,
                backdrop: 1620,
                'details-backdrop': 2880,
                'card-backdrop': 600,
                'hero-banner': 2560,
                'hero-immersive': 2560,
                thumb: 600,
                square: 360,
                banner: 1500,
                avatar: 300,
                logo: 600,
                quality: 95
            },
            ultra: {
                poster: 480,
                'details-poster': 1260,
                'small-poster': 320,
                backdrop: 2160,
                'details-backdrop': 3840, // 4K width for Ultra Details Backdrop
                'card-backdrop': 800,
                'hero-banner': 3840,
                'hero-immersive': 3840,
                thumb: 800,
                square: 480,
                banner: 2000,
                avatar: 400,
                logo: 800,
                quality: 99
            },
            original: {
                poster: null,
                'details-poster': null,
                'small-poster': null,
                backdrop: null,
                'details-backdrop': null,
                'card-backdrop': null,
                'hero-banner': null,
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

        if (type.startsWith('hero-')) {
            const heroPreset = this.getHeroPreset();
            if (heroPreset !== 'default') {
                targetPreset = heroPreset;
            }
            if (type === 'hero-logo') {
                type = 'logo';
            }
        } else if (type.startsWith('details-')) {
            const detailsPreset = this.getDetailsPreset();
            if (detailsPreset !== 'default') {
                targetPreset = detailsPreset;
            }

            const currentPresetMap = presets[targetPreset] || presets.medium;
            if (currentPresetMap[type] === undefined) {
                type = type.replace('details-', '');
            }
        }

        const currentScale = presets[targetPreset] || presets.medium;

        const maxWidth = currentScale[type] !== undefined ? currentScale[type] : 300;

        return {
            maxWidth,
            quality: currentScale.quality
        };
    }
}

export const imageService = new ImageService();
