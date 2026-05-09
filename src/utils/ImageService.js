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
        return storage.getItem('pref:heroImageQuality') || 'medium-low';
    }

    /**
     * Set hero-specific quality preset and save to storage
     * @param {string} preset - default | low | medium-low | medium | medium-high | high | ultra
     */
    setHeroPreset(preset) {
        if (['default', 'low', 'medium-low', 'medium', 'medium-high', 'high', 'very-high', 'ultra', 'original'].includes(preset)) {
            storage.setItem('pref:heroImageQuality', preset);
            return true;
        }
        return false;
    }

    /**
     * Get optimization parameters for a specific image usage
     * @param {string} type - 'poster' | 'small-poster' | 'backdrop' | 'thumb' | 'avatar'
     * @returns {Object} { maxLimit, quality }
     */
    getParams(type) {
        const presets = {
            low: {
                poster: 180,
                'small-poster': 120,
                backdrop: 640,
                'card-backdrop': 280,
                'hero-banner': 554,
                'hero-immersive': 607,
                thumb: 280,
                square: 180,
                banner: 640,
                avatar: 140,
                quality: 80
            },
            'medium-low': {
                poster: 216, // 0.9x
                'small-poster': 144, // 0.9x
                backdrop: 972, // 0.9x
                'card-backdrop': 360, // 0.9x
                'hero-banner': 1100,
                'hero-immersive': 1200,
                thumb: 360, // 0.9x
                square: 216, // 0.9x
                banner: 900, // 0.9x
                avatar: 180, // 0.9x
                quality: 85
            },
            medium: {
                /*
                 * BASELINE (1.0x Rendered Size)
                 * These values match the exact CSS widths used in the UI.
                 */
                poster: 240,
                'small-poster': 160,
                backdrop: 1080,
                'card-backdrop': 400,
                'hero-banner': 1662, // Exception: keep high for premium feel
                'hero-immersive': 1820, // Exception: keep high for premium feel
                thumb: 400,
                square: 240,
                banner: 1000,
                avatar: 200,
                quality: 90
            },
            'medium-high': {
                poster: 264, // 1.1x
                'small-poster': 176, // 1.1x
                backdrop: 1188, // 1.1x
                'card-backdrop': 440, // 1.1x
                'hero-banner': 1790,
                'hero-immersive': 1870,
                thumb: 440, // 1.1x
                square: 264, // 1.1x
                banner: 1100, // 1.1x
                avatar: 220, // 1.1x
                quality: 95
            },
            high: {
                poster: 288, // 1.2x
                'small-poster': 192, // 1.2x
                backdrop: 1296, // 1.2x
                'card-backdrop': 480, // 1.2x
                'hero-banner': 1920,
                'hero-immersive': 1920,
                thumb: 480, // 1.2x
                square: 288, // 1.2x
                banner: 1200, // 1.2x
                avatar: 240, // 1.2x
                quality: 100
            },
            'very-high': {
                poster: 360, // 1.5x
                'small-poster': 240, // 1.5x
                backdrop: 1620, // 1.5x
                'card-backdrop': 600, // 1.5x
                'hero-banner': 2560,
                'hero-immersive': 2560,
                thumb: 600, // 1.5x
                square: 360, // 1.5x
                banner: 1500, // 1.5x
                avatar: 300, // 1.5x
                quality: 100
            },
            ultra: {
                poster: 480, // 2.0x
                'small-poster': 320, // 2.0x
                backdrop: 2160, // 2.0x
                'card-backdrop': 800, // 2.0x
                'hero-banner': 3840,
                'hero-immersive': 3840,
                thumb: 800, // 2.0x
                square: 480, // 2.0x
                banner: 2000, // 2.0x
                avatar: 400, // 2.0x
                quality: 100
            },
            original: {
                poster: null,
                'small-poster': null,
                backdrop: null,
                'card-backdrop': null,
                'hero-banner': null,
                'hero-immersive': null,
                thumb: null,
                square: null,
                banner: null,
                avatar: null,
                quality: null
            }
        };

        let targetPreset = this.getPreset();
        if (type.startsWith('hero-')) {
            const heroPreset = this.getHeroPreset();
            if (heroPreset !== 'default') {
                targetPreset = heroPreset;
            }
        }

        const currentScale = presets[targetPreset] || presets.medium;

        const maxWidth = (currentScale[type] !== undefined) ? currentScale[type] : 300;

        return {
            maxWidth,
            quality: currentScale.quality
        };
    }
}

export const imageService = new ImageService();
