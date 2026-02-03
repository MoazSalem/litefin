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

        const backdropId = (item.BackdropImageTags && item.BackdropImageTags.length > 0)
            ? item.Id
            : item.ParentBackdropItemId;

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
            const bestWork = works.find(i =>
                (i.Type === 'Movie' || i.Type === 'Series') &&
                i.BackdropImageTags &&
                i.BackdropImageTags.length > 0
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
     * @param {HTMLElement} element - The target DOM element
     * @param {string} url - The backdrop image URL
     */
    static applyBackdrop(element, url) {
        if (!element || !url) return;

        // Preload image
        const img = new Image();
        img.onload = () => {
            element.style.backgroundImage = `url('${url}')`;
            // Force reflow/repaint might be needed in some cases, but usually direct style set is fine
            requestAnimationFrame(() => {
                element.style.opacity = '1';
            });
        };
        img.onerror = () => {
            console.warn(`BackdropManager: Failed to load backdrop from ${url}`);
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
