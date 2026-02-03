/**
 * ============================================================================
 * Litefin Tizen - Image Service
 * ============================================================================
 * Centralized utility for managing image optimization and quality settings.
 * ============================================================================
 */

class ImageService {
    constructor() {
        this._quality = localStorage.getItem('pref:imageQuality') || 'medium';
    }

    /**
     * Get current quality preset
     * @returns {string} low | medium | high | ultra
     */
    getPreset() {
        return this._quality;
    }

    /**
     * Set quality preset and save to storage
     * @param {string} preset - low | medium | high | ultra
     */
    setPreset(preset) {
        if (['low', 'medium', 'high', 'ultra'].includes(preset)) {
            this._quality = preset;
            localStorage.setItem('pref:imageQuality', preset);
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
                thumb: 320,
                avatar: 160,
                quality: 70
            },
            medium: {
                poster: 360,
                backdrop: 1080,
                thumb: 480,
                avatar: 240,
                quality: 80
            },
            high: {
                poster: 500,
                backdrop: 1920,
                thumb: 640,
                avatar: 320,
                quality: 95
            },
            ultra: {
                poster: 800,
                backdrop: 3840, // 4K
                thumb: 1280,
                avatar: 600,
                quality: 100
            }
        };

        const currentScale = presets[this._quality] || presets.medium;

        let maxWidth = 300; // Default safety
        if (type === 'poster') maxWidth = currentScale.poster;
        else if (type === 'backdrop') maxWidth = currentScale.backdrop;
        else if (type === 'thumb') maxWidth = currentScale.thumb;
        else if (type === 'avatar') maxWidth = currentScale.avatar;

        return {
            maxWidth,
            quality: currentScale.quality
        };
    }
}

export const imageService = new ImageService();
