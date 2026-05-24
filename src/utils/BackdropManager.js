/**
 * ============================================================================
 * Litefin Tizen - Backdrop Manager
 * ============================================================================
 * Centralized utility for handling backdrop images.
 * Manages fetching URLs, smart selection (e.g. for persons), and preloading.
 * ============================================================================
 */

import { api } from '../api/index.js';
import { imageService } from './ImageService.js';

import { storage } from './StorageService.js';

import { logger } from './Logger.js';

const log = logger.create('BackdropManager');

class BackdropManager {
    /**
     * Get the backdrop URL for an item.
     * Handles fallback to parent backdrop if the item itself has none.
     * @param {Object} item - The media item
     * @param {Object} options - Options for image URL generation (maxWidth, etc.)
     * @returns {string|null} The backdrop URL or null if none found
     */
    static getBackdropUrl(item, options = null) {
        if (!item) return null;

        // Default options from ImageService if not provided
        if (!options) {
            const params = imageService.getParams('backdrop');
            options = { maxWidth: params.maxWidth, quality: params.quality };
        }

        const backdropId =
            item.BackdropImageTags && item.BackdropImageTags.length > 0 ? item.Id : item.ParentBackdropItemId;

        if (backdropId) {
            return api.getImageUrl(backdropId, 'Backdrop', options);
        }

        return null;
    }

    /**
     * Get a 'smart' backdrop URL for a person.
     * Tries the person's own backdrop first, then falls back to the backdrop
     * of their most significant work (Movie or Series).
     * @param {Object} person - The person object
     * @param {Array} works - List of works (items) associated with the person
     * @param {Object} options - Options for image URL generation
     * @returns {string|null} The backdrop URL
     */
    static getPersonBackdropUrl(person, works = [], options = null) {
        // Default options from ImageService if not provided
        if (!options) {
            const params = imageService.getParams('backdrop');
            options = { maxWidth: params.maxWidth, quality: params.quality };
        }
        // 1. Try Person's own backdrop
        if (person.BackdropImageTags && person.BackdropImageTags.length > 0) {
            return api.getImageUrl(person.Id, 'Backdrop', options);
        }

        // 2. Fallback: Try most recent Movie/Series with a backdrop
        if (works && works.length > 0) {
            const bestWork = works.find(
                (i) =>
                    (i.Type === 'Movie' || i.Type === 'Series') && i.BackdropImageTags && i.BackdropImageTags.length > 0
            );

            if (bestWork) {
                return api.getImageUrl(bestWork.Id, 'Backdrop', options);
            }
        }

        return null;
    }

    /**
     * Preloads and applies a backdrop to a DOM element.
     * Sets the element's backgroundImage and handles fade-in opacity.
     * Also supports optional BlurHash decoding to display a color-accurate background instantly.
     * @param {HTMLElement} element - The target DOM element
     * @param {string} url - The backdrop image URL
     * @param {string} [blurHash=''] - Optional BlurHash string
     */
    static applyBackdrop(element, url, blurHash = '') {
        if (!element || !url) return;

        // Check if BlurHash is disabled globally
        const isBlurHashDisabled = storage.getItem('litefin:disableBlurhash') === 'true';
        let canvas = null;

        // Check if only BlurHash backdrop mode is active
        const isOnlyBlurHashActive = storage.getItem('litefin:onlyBlurHashBackdrop') === 'true';

        if (isOnlyBlurHashActive && blurHash && !isBlurHashDisabled) {
            // Remove any pre-existing blurhash canvas to avoid stacking duplicates
            const oldCanvas = element.querySelector('.backdrop-blurhash');
            if (oldCanvas) oldCanvas.parentNode.removeChild(oldCanvas);

            // Make sure any pre-existing high-resolution background image is cleared
            element.style.backgroundImage = 'none';

            canvas = document.createElement('canvas');
            canvas.className = 'backdrop-blurhash blurhash-canvas';
            canvas.style.position = 'absolute';
            canvas.style.top = '0';
            canvas.style.left = '0';
            canvas.style.width = '100%';
            canvas.style.height = '100%';
            canvas.style.objectFit = 'cover';
            canvas.style.zIndex = '0';
            canvas.style.pointerEvents = 'none';
            canvas.style.opacity = '1';

            // Insert at the bottom to remain underneath layout overlays
            if (element.firstChild) {
                element.insertBefore(canvas, element.firstChild);
            } else {
                element.appendChild(canvas);
            }

            // Immediately make backdrop container visible so the blurhash shows
            element.style.opacity = '1';

            // Decodes the backdrop blurhash at low resolution asynchronously
            import('./BlurHashDecoder.js').then(({ default: BlurHashDecoder }) => {
                const pixels = BlurHashDecoder.decode(blurHash, 64, 36);
                if (pixels && canvas) {
                    canvas.width = 64;
                    canvas.height = 36;
                    const ctx = canvas.getContext('2d');
                    const imageData = ctx.createImageData(64, 36);
                    imageData.data.set(pixels);
                    ctx.putImageData(imageData, 0, 0);
                }
            }).catch(err => log.error('Failed to decode backdrop blurhash', err));

            // Return immediately — DO NOT load the actual high-resolution image!
            return;
        }

        // Render BlurHash placeholder canvas if enabled
        if (blurHash && !isBlurHashDisabled) {
            // Remove any pre-existing blurhash canvas to avoid stacking duplicates
            const oldCanvas = element.querySelector('.backdrop-blurhash');
            if (oldCanvas) oldCanvas.parentNode.removeChild(oldCanvas);

            canvas = document.createElement('canvas');
            canvas.className = 'backdrop-blurhash blurhash-canvas';
            canvas.style.position = 'absolute';
            canvas.style.top = '0';
            canvas.style.left = '0';
            canvas.style.width = '100%';
            canvas.style.height = '100%';
            canvas.style.objectFit = 'cover';
            canvas.style.zIndex = '0';
            canvas.style.transition = 'opacity 500ms ease-out';
            canvas.style.pointerEvents = 'none';
            canvas.style.opacity = '1';

            // Insert at the bottom to remain underneath layout overlays
            if (element.firstChild) {
                element.insertBefore(canvas, element.firstChild);
            } else {
                element.appendChild(canvas);
            }

            // Immediately make backdrop container visible so the blurhash shows
            element.style.opacity = '1';

            // Decodes the backdrop blurhash at low resolution asynchronously
            import('./BlurHashDecoder.js').then(({ default: BlurHashDecoder }) => {
                const pixels = BlurHashDecoder.decode(blurHash, 64, 36);
                if (pixels && canvas) {
                    canvas.width = 64;
                    canvas.height = 36;
                    const ctx = canvas.getContext('2d');
                    const imageData = ctx.createImageData(64, 36);
                    imageData.data.set(pixels);
                    ctx.putImageData(imageData, 0, 0);
                }
            }).catch(err => log.error('Failed to decode backdrop blurhash', err));
        }

        // Preload image
        const img = new Image();
        img.onload = () => {
            element.style.backgroundImage = `url('${url}')`;
            
            requestAnimationFrame(() => {
                // Ensure backdrop container is fully visible
                element.style.opacity = '1';
                
                // Fade out and remove the BlurHash canvas cleanly
                if (canvas) {
                    canvas.style.opacity = '0';
                    setTimeout(() => {
                        if (canvas && canvas.parentNode) canvas.parentNode.removeChild(canvas);
                    }, 500);
                }
            });
        };
        img.onerror = () => {
            log.warn(`Failed to load backdrop from ${url}`);
        };
        img.src = url;
    }

    /**
     * Clears the backdrop from an element (resets opacity and image).
     * @param {HTMLElement} element
     */
    static clearBackdrop(element) {
        if (!element) return;
        element.style.opacity = '0';
        // Optional: clear image after transition to avoid flash?
        // For now just clearing opacity is visually sufficient for fade-out.
        // We can clear the image after a timeout if needed.
        setTimeout(() => {
            element.style.backgroundImage = 'none';
        }, 500); // Match CSS transition time
    }
}

export default BackdropManager;
