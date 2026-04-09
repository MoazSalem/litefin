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
     * @param {string} preset - low | medium | high | ultra
     */
    setPreset(preset) {
        if (['low', 'medium', 'high', 'ultra'].includes(preset)) {
            storage.setItem('pref:imageQuality', preset);
            return true;
        }
        return false;
    }

    /**
     * Get optimization parameters for a specific image usage
     * @param {string} type - 'poster' | 'backdrop' | 'thumb' | 'avatar'
     * @returns {Object} { maxLimit, quality }
     */
    getParams(type) {
        const presets = {
            low: {
                poster: 240,
                backdrop: 640,
                'card-backdrop': 360,
                'hero-banner': 800,
                'hero-immersive': 960,
                thumb: 320,
                banner: 480,
                avatar: 160,
                quality: 70
            },
            medium: {
                poster: 360,
                backdrop: 1080,
                'card-backdrop': 600,
                'hero-banner': 1280,
                'hero-immersive': 1440,
                thumb: 480,
                banner: 800,
                avatar: 240,
                quality: 80
            },
            high: {
                poster: 500,
                backdrop: 1920,
                'card-backdrop': 800,
                'hero-banner': 1662,
                'hero-immersive': 1820,
                thumb: 640,
                banner: 1280,
                avatar: 320,
                quality: 95
            },
            ultra: {
                poster: 800,
                backdrop: 3840,
                'card-backdrop': 1280,
                'hero-banner': 1920,
                'hero-immersive': 2560,
                thumb: 1280,
                banner: 1920,
                avatar: 600,
                quality: 100
            }
        };

        const currentScale = presets[this.getPreset()] || presets.medium;

        let maxWidth = 300; // Default safety
        if (type === 'poster') maxWidth = currentScale.poster;
        else if (type === 'backdrop') maxWidth = currentScale.backdrop;
        else if (type === 'card-backdrop') maxWidth = currentScale['card-backdrop'];
        else if (type === 'thumb') maxWidth = currentScale.thumb;
        else if (type === 'banner') maxWidth = currentScale.banner;
        else if (type === 'avatar') maxWidth = currentScale.avatar;

        return {
            maxWidth,
            quality: currentScale.quality
        };
    }
}

export const imageService = new ImageService();
