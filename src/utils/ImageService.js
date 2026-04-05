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
                // card-backdrop: sized for a ~400px card slot, not the full screen.
                // 360px is plenty at low quality (cards are small, sharp detail wasted).
                'card-backdrop': 360,
                thumb: 320,
                banner: 480,
                avatar: 160,
                quality: 70
            },
            medium: {
                poster: 360,
                backdrop: 1080,
                // card-backdrop: 600px is 1.5× the 400px card slot for retina sharpness.
                // Compared to 1080, this cuts per-image payload by ~66% — major for
                // Tizen hardware that struggles with large JPEG decode on the main thread.
                'card-backdrop': 600,
                thumb: 480,
                banner: 800,
                avatar: 240,
                quality: 80
            },
            high: {
                poster: 500,
                backdrop: 1920,
                // card-backdrop: 800px covers 2× the card slot at high quality,
                // which is more than enough even on high-DPI TV panels.
                'card-backdrop': 800,
                thumb: 640,
                banner: 1280,
                avatar: 320,
                quality: 95
            },
            ultra: {
                poster: 800,
                backdrop: 3840, // 4K
                // card-backdrop at ultra quality: match the high-quality landscape card
                // CSS width precisely (1280px ~ 1.5× of 880px scaled card on 4K panel).
                'card-backdrop': 1280,
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
