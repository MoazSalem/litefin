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
     * @returns {string} low | medium | high | ultra
     */
    getPreset() {
        return storage.getItem('pref:imageQuality') || 'medium';
    }

    /**
     * Set quality preset and save to storage
     * @param {string} preset - low | medium-low | medium | medium-high | high | ultra
     */
    setPreset(preset) {
        if (['low', 'medium-low', 'medium', 'medium-high', 'high', 'ultra'].includes(preset)) {
            storage.setItem('pref:imageQuality', preset);
            return true;
        }
        return false;
    }

    /**
     * Get hero-specific quality preset dynamically.
     * @returns {string} default | low | medium-low | medium | medium-high | high | ultra
     */
    getHeroPreset() {
        return storage.getItem('pref:heroImageQuality') || 'medium-low';
    }

    /**
     * Set hero-specific quality preset and save to storage
     * @param {string} preset - default | low | medium-low | medium | medium-high | high | ultra
     */
    setHeroPreset(preset) {
        if (['default', 'low', 'medium-low', 'medium', 'medium-high', 'high', 'ultra'].includes(preset)) {
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
                poster: 240,
                'small-poster': 160,
                backdrop: 640,
                'card-backdrop': 360,
                'hero-banner': 554,
                'hero-immersive': 607,
                thumb: 320,
                banner: 480,
                avatar: 160,
                quality: 70
            },
            'medium-low': {
                poster: 300,
                'small-poster': 200,
                backdrop: 860,
                'card-backdrop': 480,
                'hero-banner': 1100,
                'hero-immersive': 1200,
                thumb: 400,
                banner: 640,
                avatar: 200,
                quality: 75
            },
            medium: {
                poster: 360,
                'small-poster': 240,
                backdrop: 1080,
                'card-backdrop': 600,
                'hero-banner': 1662,
                'hero-immersive': 1820,
                thumb: 480,
                banner: 800,
                avatar: 240,
                quality: 80
            },
            'medium-high': {
                poster: 430,
                'small-poster': 280,
                backdrop: 1500,
                'card-backdrop': 700,
                'hero-banner': 1790,
                'hero-immersive': 1870,
                thumb: 560,
                banner: 1040,
                avatar: 280,
                quality: 85
            },
            high: {
                poster: 500,
                'small-poster': 340,
                backdrop: 1920,
                'card-backdrop': 800,
                'hero-banner': 1920,
                'hero-immersive': 1920,
                thumb: 640,
                banner: 1280,
                avatar: 320,
                quality: 95
            },
            ultra: {
                poster: 800,
                'small-poster': 480,
                backdrop: 3840,
                'card-backdrop': 1280,
                'hero-banner': 3840,
                'hero-immersive': 3840,
                thumb: 1280,
                banner: 1920,
                avatar: 600,
                quality: 100
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

        const maxWidth = currentScale[type] || 300;

        return {
            maxWidth,
            quality: currentScale.quality
        };
    }
}

export const imageService = new ImageService();
