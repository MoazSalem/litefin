/**
 * ============================================================================
 * Litefin Tizen - Shared Icons Utility (Style-Based)
 * ============================================================================
 * Centralized SVG definitions and mappings for the entire application.
 * Supports multiple style themes for icons (default, future custom styles).
 * Resolves icon definitions dynamically based on the active icon style.
 * ============================================================================
 */

import { storage } from './StorageService.js';
import { eventBus } from '../core/EventBus.js';

/**
 * Global dynamic configuration for icon styling.
 * Retrieves preference from local storage or defaults to 'default'.
 */
let currentIconStyle = null;

function getActiveStyle() {
    if (!currentIconStyle) {
        currentIconStyle = storage.getItem('pref:iconStyle') || 'default';
    }
    return currentIconStyle;
}

/**
 * ============================================================================
 * Icon Styles Registry
 * ============================================================================
 * Houses SVG definitions grouped by visual style themes and categories.
 * Add new styles (e.g., 'round', 'sharp', 'colored') as sibling objects.
 * ============================================================================
 */
const iconStyles = {
    // ------------------------------------------------------------------------
    // DEFAULT STYLE (Original/Classic Outline & Filled SVG paths)
    // ------------------------------------------------------------------------
    default: {
        sidebarIcons: {
            logo: `
                <svg viewBox="0 0 100 100" width="40" height="40" class="sidebar-logo-svg" preserveAspectRatio="xMidYMid meet">
                    <path class="logo-path-outer" d="M19.57,91c-2.24,0-4.73-0.44-6.87-2.02c-2.07-1.53-3.32-3.6-3.62-5.97c-0.51-4.01,1.81-7.59,3.24-9.37c4.82-5.97,9.41-12.5,10.36-19.76c0.8-6.13-1-12.33-2.9-18.9c-0.59-2.04-1.21-4.16-1.73-6.27
                    c-0.8-3.17-1.42-6.59-0.53-10.08c1.8-7.06,9.11-10.26,21.74-9.53c10.63,0.62,21.35,5.21,30.19,12.91
                    C82.12,33.08,93.56,53.11,90.5,72.93c-0.23,1.54-0.58,2.97-1.04,4.26c-1.28,3.66-3.47,6.32-6.34,7.68
                    c-3.63,1.71-7.38,1.01-10.39,0.44c-2.45-0.46-5.35-0.99-8.34-1.37c-6.72-0.86-12.12-0.79-17.02,0.21
                    c-3.5,0.71-6.9,1.8-10.49,2.95c-4.51,1.44-9.17,2.94-14.09,3.64C21.84,90.88,20.74,91,19.57,91z M35.69,16
                    c-5.23,0-10.52,0.9-11.4,4.36c-0.5,1.98-0.04,4.37,0.53,6.65c0.5,1.99,1.09,4.04,1.67,6.02c2.02,6.97,4.11,14.17,3.12,21.75
                    c-1.17,8.98-6.38,16.48-11.85,23.25c-1.19,1.47-1.87,3.08-1.75,4.08c0.04,0.31,0.17,0.73,0.85,1.23
                    c0.89,0.66,2.51,0.81,4.95,0.46c4.34-0.62,8.53-1.96,12.95-3.38c3.61-1.16,7.35-2.35,11.22-3.14c5.67-1.16,11.81-1.26,19.31-0.3
                    c3.17,0.41,6.2,0.95,8.74,1.43c2.32,0.44,4.52,0.85,6.1,0.11c1.15-0.54,2.07-1.78,2.72-3.66l0-0.01c0.31-0.87,0.55-1.88,0.72-3
                    c2.65-17.2-7.5-34.78-18.74-44.57c-7.68-6.69-16.92-10.67-26-11.2C37.81,16.04,36.75,16,35.69,16z" />
                    <path class="logo-path-inner" d="M69.3,63.51c0.19-0.64,0.32-1.3,0.41-1.95
                    c1.26-9.44-3.2-19.55-9.22-25.63c-3.64-3.67-8.19-6.14-13.02-6.47c-2.7-0.18-7.56-0.15-8.41,3.7c-0.32,1.47-0.07,3.03,0.25,4.49
                    c1.01,4.7,2.72,9.41,2.18,14.21C41,56.22,38.72,60,36.34,63.41c-1.14,1.63-1.9,4.02-0.12,5.54c0.97,0.83,2.3,0.8,3.49,0.6
                    c3.88-0.64,7.47-2.62,11.3-3.52c2.77-0.66,5.63-0.55,8.42-0.14c1.33,0.2,2.64,0.47,3.96,0.75c1.25,0.27,2.62,0.57,3.82-0.09
                    C68.26,65.98,68.91,64.81,69.3,63.51z" />
                </svg>
            `,
            syncplay: `
                <svg class="icon-outline" width="30" height="30" viewBox="0 0 24 24"><!-- Icon from Remix Icon --><path fill="currentColor" d="M2 22a8 8 0 1 1 16 0h-2a6 6 0 0 0-12 0zm8-9c-3.315 0-6-2.685-6-6s2.685-6 6-6s6 2.685 6 6s-2.685 6-6 6m0-2c2.21 0 4-1.79 4-4s-1.79-4-4-4s-4 1.79-4 4s1.79 4 4 4m8.284 3.703A8 8 0 0 1 23 22h-2a6 6 0 0 0-3.537-5.473zm-.688-11.29A5.5 5.5 0 0 1 21 8.5a5.5 5.5 0 0 1-5 5.478v-2.013a3.5 3.5 0 0 0 1.041-6.609z"/></svg>
                <svg class="icon-filled" width="30" height="30" viewBox="0 0 24 24"><!-- Icon from Remix Icon --><path fill="currentColor" d="M2 22a8 8 0 1 1 16 0zm8-9c-3.315 0-6-2.685-6-6s2.685-6 6-6s6 2.685 6 6s-2.685 6-6 6m7.363 2.233A7.505 7.505 0 0 1 22.983 22H20c0-2.61-1-4.986-2.637-6.767m-2.023-2.276A7.98 7.98 0 0 0 18 7a7.96 7.96 0 0 0-1.015-3.903A5 5 0 0 1 21 8a5 5 0 0 1-5.66 4.957"/></svg>    
            `,
            home: `
                <svg class="icon-outline" width="32" height="32" viewBox="0 0 24 24"><!-- Icon from Remix Icon --><path fill="currentColor" d="M19 21H5a1 1 0 0 1-1-1v-9H1l10.327-9.388a1 1 0 0 1 1.346 0L23 11h-3v9a1 1 0 0 1-1 1m-6-2h5V9.157l-6-5.454l-6 5.454V19h5v-6h2z"/></svg>
                <svg class="icon-filled" width="32" height="32" viewBox="0 0 24 24"><!-- Icon from Remix Icon --><path fill="currentColor" d="M20 20a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-9H1l10.327-9.388a1 1 0 0 1 1.346 0L23 11h-3zm-9-7v6h2v-6z"/></svg>
            `,
            livetv: `
                <svg class="icon-outline" width="32" height="32" viewBox="0 0 24 24"><!-- Icon from Remix Icon --><path fill="currentColor" d="m4.929 2.929l1.414 1.414A7.98 7.98 0 0 0 4 10c0 2.21.895 4.21 2.343 5.657L4.93 17.07A9.97 9.97 0 0 1 2 10a9.97 9.97 0 0 1 2.929-7.071m14.142 0A9.97 9.97 0 0 1 22 10a9.97 9.97 0 0 1-2.929 7.071l-1.414-1.414A7.98 7.98 0 0 0 20 10c0-2.21-.895-4.21-2.343-5.657zM7.757 5.757l1.415 1.415A4 4 0 0 0 8 10c0 1.105.448 2.105 1.172 2.829l-1.415 1.414A5.98 5.98 0 0 1 6 10c0-1.657.672-3.157 1.757-4.243m8.486 0A5.98 5.98 0 0 1 18 10a5.98 5.98 0 0 1-1.757 4.243l-1.415-1.415A4 4 0 0 0 16 10a4 4 0 0 0-1.172-2.828zM12 12a2 2 0 1 1 0-4a2 2 0 0 1 0 4m-1 2h2v8h-2z"/></svg>
                <svg class="icon-filled" width="32" height="32" viewBox="0 0 24 24"><!-- Icon from Remix Icon --><path fill="currentColor" d="m4.929 2.929l1.414 1.414A7.98 7.98 0 0 0 4 10c0 2.21.895 4.21 2.343 5.657L4.93 17.07A9.97 9.97 0 0 1 2 10a9.97 9.97 0 0 1 2.929-7.071m14.142 0A9.97 9.97 0 0 1 22 10a9.97 9.97 0 0 1-2.929 7.071l-1.414-1.414A7.98 7.98 0 0 0 20 10c0-2.21-.895-4.21-2.343-5.657zM7.757 5.757l1.415 1.415A4 4 0 0 0 8 10c0 1.105.448 2.105 1.172 2.829l-1.415 1.414A5.98 5.98 0 0 1 6 10c0-1.657.672-3.157 1.757-4.243m8.486 0A5.98 5.98 0 0 1 18 10a5.98 5.98 0 0 1-1.757 4.243l-1.415-1.415A4 4 0 0 0 16 10a4 4 0 0 0-1.172-2.828zM12 12a2 2 0 1 1 0-4a2 2 0 0 1 0 4m0 2c.58 0 1.077.413 1.184.983L14.5 22h-5l1.316-7.017c.107-.57.604-.983 1.184-.983"/></svg>
            `,
            random: `
                <svg class="icon-outline" width="32" height="32" viewBox="0 0 24 24"><!-- Icon from Remix Icon --><path fill="currentColor" d="M5 5v14h14V5zM3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zm12.5 12a1.5 1.5 0 1 0 0-3a1.5 1.5 0 0 0 0 3M10 15.5a1.5 1.5 0 1 1-3 0a1.5 1.5 0 0 1 3 0M8.5 10a1.5 1.5 0 1 0 0-3a1.5 1.5 0 0 0 0 3M17 8.5a1.5 1.5 0 1 1-3 0a1.5 1.5 0 0 1 3 0m-5 5a1.5 1.5 0 1 0 0-3a1.5 1.5 0 0 0 0 3"/></svg>
                <svg class="icon-filled" width="32" height="32" viewBox="0 0 24 24"><!-- Icon from Remix Icon --><path fill="currentColor" d="M5 3a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2zm5 5.5a1.5 1.5 0 1 1-3 0a1.5 1.5 0 0 1 3 0M8.5 17a1.5 1.5 0 1 1 0-3a1.5 1.5 0 0 1 0 3m7 0a1.5 1.5 0 1 1 0-3a1.5 1.5 0 0 1 0 3m0-7a1.5 1.5 0 1 1 0-3a1.5 1.5 0 0 1 0 3m-2 2a1.5 1.5 0 1 1-3 0a1.5 1.5 0 0 1 3 0"/></svg>
            `,
            favorites: `
                <svg class="icon-outline" width="32" height="32" viewBox="0 0 24 24"><!-- Icon from Remix Icon --><path fill="currentColor" d="M16.5 3C19.538 3 22 5.5 22 9c0 7-7.5 11-10 12.5C9.5 20 2 16 2 9c0-3.5 2.5-6 5.5-6C9.36 3 11 4 12 5c1-1 2.64-2 4.5-2m-3.566 15.604a27 27 0 0 0 2.42-1.701C18.335 14.533 20 11.943 20 9c0-2.36-1.537-4-3.5-4c-1.076 0-2.24.57-3.086 1.414L12 7.828l-1.414-1.414C9.74 5.57 8.576 5 7.5 5C5.56 5 4 6.657 4 9c0 2.944 1.666 5.533 4.645 7.903c.745.593 1.54 1.146 2.421 1.7c.299.189.595.37.934.572c.339-.202.635-.383.934-.571"/></svg>        
                <svg class="icon-filled" width="32" height="32" viewBox="0 0 24 24"><!-- Icon from Remix Icon --><path fill="currentColor" d="M16.5 3C19.538 3 22 5.5 22 9c0 7-7.5 11-10 12.5C9.5 20 2 16 2 9c0-3.5 2.5-6 5.5-6C9.36 3 11 4 12 5c1-1 2.64-2 4.5-2"/></svg>    `,
            search: `
                <svg class="icon-outline" width="32" height="32" viewBox="0 0 24 24"><!-- Icon from Remix Icon --><path fill="currentColor" d="M11 2c4.968 0 9 4.032 9 9s-4.032 9-9 9s-9-4.032-9-9s4.032-9 9-9m0 16c3.867 0 7-3.133 7-7s-3.133-7-7-7s-7 3.133-7 7s3.133 7 7 7m8.485.071l2.829 2.828l-1.415 1.415l-2.828-2.829z"/></svg>
                <svg class="icon-filled" width="32" height="32" viewBox="0 0 24 24"><!-- Icon from Remix Icon --><path fill="currentColor" d="M11 2c4.968 0 9 4.032 9 9s-4.032 9-9 9s-9-4.032-9-9s4.032-9 9-9m8.485 16.071l2.829 2.828l-1.415 1.415l-2.828-2.829z"/></svg>    
            `,
            settings: `
                <svg class="icon-outline" width="32" height="32" viewBox="0 0 24 24"><!-- Icon from Remix Icon --><path fill="currentColor" d="M2 12c0-.865.11-1.704.316-2.504A3 3 0 0 0 4.99 4.867a10 10 0 0 1 4.335-2.506a3 3 0 0 0 5.348 0a10 10 0 0 1 4.335 2.506a3 3 0 0 0 2.675 4.63c.206.8.316 1.638.316 2.503c0 .864-.11 1.703-.316 2.503a3 3 0 0 0-2.675 4.63a10 10 0 0 1-4.335 2.505a3 3 0 0 0-5.348 0a10 10 0 0 1-4.335-2.505a3 3 0 0 0-2.675-4.63C2.11 13.703 2 12.864 2 12m4.804 3c.63 1.091.81 2.346.564 3.524q.613.436 1.297.75A5 5 0 0 1 12 18c1.26 0 2.438.471 3.335 1.274q.684-.314 1.297-.75A5 5 0 0 1 17.196 15a5 5 0 0 1 2.77-2.25a8 8 0 0 0 0-1.5A5 5 0 0 1 17.196 9a5 5 0 0 1-.564-3.524a8 8 0 0 0-1.297-.75A5 5 0 0 1 12 6a5 5 0 0 1-3.335-1.274a8 8 0 0 0-1.297.75A5 5 0 0 1 6.804 9a5 5 0 0 1-2.77 2.25a8 8 0 0 0 0 1.5A5 5 0 0 1 6.805 15M12 15a3 3 0 1 1 0-6a3 3 0 0 1 0 6m0-2a1 1 0 1 0 0-2a1 1 0 0 0 0 2"/></svg>
                <svg class="icon-filled" width="32" height="32" viewBox="0 0 24 24"><!-- Icon from Remix Icon --><path fill="currentColor" d="M5.334 4.545a10 10 0 0 1 3.542-2.048A4 4 0 0 0 12 4a4 4 0 0 0 3.124-1.502a10 10 0 0 1 3.542 2.048A4 4 0 0 0 18.928 8a4 4 0 0 0 2.863 1.955a10 10 0 0 1 0 4.09c-1.16.178-2.23.86-2.863 1.955a4 4 0 0 0-.262 3.455a10 10 0 0 1-3.542 2.047A4 4 0 0 0 12 20a4 4 0 0 0-3.124 1.503a10 10 0 0 1-3.542-2.048A4 4 0 0 0 5.072 16a4 4 0 0 0-2.863-1.954a10 10 0 0 1 0-4.091A4 4 0 0 0 5.072 8a4 4 0 0 0 .262-3.454M13.5 14.597a3 3 0 1 0-3-5.196a3 3 0 0 0 3 5.196"/></svg>
            `,
            userDefault: `
                <svg class="icon-outline" width="32" height="32" viewBox="0 0 24 24"><!-- Icon from Remix Icon --><path fill="currentColor" d="M12 2c5.523 0 10 4.477 10 10s-4.477 10-10 10S2 17.523 2 12S6.477 2 12 2m.16 14a6.98 6.98 0 0 0-5.147 2.256A7.97 7.97 0 0 0 12 20a7.97 7.97 0 0 0 5.167-1.892A6.98 6.98 0 0 0 12.16 16M12 4a8 8 0 0 0-6.384 12.821A8.98 8.98 0 0 1 12.16 14a8.97 8.97 0 0 1 6.362 2.634A8 8 0 0 0 12 4m0 1a4 4 0 1 1 0 8a4 4 0 0 1 0-8m0 2a2 2 0 1 0 0 4a2 2 0 0 0 0-4"/></svg>
                <svg class="icon-filled" width="32" height="32" viewBox="0 0 24 24"><!-- Icon from Remix Icon --><path fill="currentColor" d="M12 2c5.52 0 10 4.48 10 10s-4.48 10-10 10S2 17.52 2 12S6.48 2 12 2M6.023 15.416C7.491 17.606 9.695 19 12.16 19s4.669-1.393 6.136-3.584A8.97 8.97 0 0 0 12.16 13a8.97 8.97 0 0 0-6.137 2.416M12 11a3 3 0 1 0 0-6a3 3 0 0 0 0 6"/></svg>
            `
        },
        settingsIcons: {
            appearance: `
                <svg class="icon-outline" width="32" height="32" viewBox="0 0 24 24"><!-- Icon from Remix Icon --><path fill="currentColor" d="M2 4c0-.552.455-1 .992-1h18.016c.548 0 .992.445.992 1v14c0 .552-.455 1-.992 1H2.992A.994.994 0 0 1 2 18zm2 1v12h16V5zm1 15h14v2H5z"/></svg>
                <svg class="icon-filled" width="32" height="32" viewBox="0 0 24 24"><!-- Icon from Remix Icon --><path fill="currentColor" d="M2 4c0-.552.455-1 .992-1h18.016c.548 0 .992.445.992 1v14c0 .552-.455 1-.992 1H2.992A.994.994 0 0 1 2 18zm3 16h14v2H5z"/></svg>
            `,
            layout: `
                <svg class="icon-outline" width="32" height="32" viewBox="0 0 24 24"><!-- Icon from Remix Icon --><path fill="currentColor" d="M4 21a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h16a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1zm4-11H5v9h3zm11 0h-9v9h9zm0-5H5v3h14z"/></svg>
                <svg class="icon-filled" width="32" height="32" viewBox="0 0 24 24"><!-- Icon from Remix Icon --><path fill="currentColor" d="M8 10v11H4a1 1 0 0 1-1-1V10zm13 0v10a1 1 0 0 1-1 1H10V10zm-1-7a1 1 0 0 1 1 1v4H3V4a1 1 0 0 1 1-1z"/></svg>
            `,
            sidebar: `
                <svg class="icon-outline" width="32" height="32" viewBox="0 0 24 24"><!-- Icon from Remix Icon --><path fill="currentColor" d="M3 3h18a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1m5 2H4v14h4zm2 0v14h10V5z"/></svg>
                <svg class="icon-filled" width="32" height="32" viewBox="0 0 24 24"><!-- Icon from Remix Icon --><path fill="currentColor" d="M3 3h18a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1m6 2v14h11V5z"/></svg>
            `,
            controls: `
                <svg class="icon-outline" width="32" height="32" viewBox="0 0 24 24"><!-- Icon from Remix Icon --><path fill="currentColor" d="M18 2a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1zm-1 2H7v16h10zm-2 11v2h-2v-2zm-4 0v2H9v-2zm2-9v2h2v2h-2.001L13 12h-2l-.001-2H9V8h2V6z"/></svg>
                <svg class="icon-filled" width="32" height="32" viewBox="0 0 24 24"><!-- Icon from Remix Icon --><path fill="currentColor" d="M18 2a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1zm-3 13h-2v2h2zm-4 0H9v2h2zm2-9h-2v2H9v2h1.999L11 12h2l-.001-2H15V8h-2z"/></svg>
            `,
            player: `
                <svg class="icon-outline" width="32" height="32" viewBox="0 0 24 24"><!-- Icon from Remix Icon --><path fill="currentColor" d="M8 18.392V5.608L18.226 12zM6 3.804v16.392a1 1 0 0 0 1.53.848l13.113-8.196a1 1 0 0 0 0-1.696L7.53 2.956A1 1 0 0 0 6 3.804"/></svg>
                <svg class="icon-filled" width="32" height="32" viewBox="0 0 24 24"><!-- Icon from Remix Icon --><path fill="currentColor" d="M6 20.196V3.804a1 1 0 0 1 1.53-.848l13.113 8.196a1 1 0 0 1 0 1.696L7.53 21.044A1 1 0 0 1 6 20.196"/></svg>
            `,
            subtitles: `
                <svg class="icon-outline" width="32" height="32" viewBox="0 0 24 24"><!-- Icon from Material Symbols --><path fill="currentColor" d="M6 16h8v-2H6zm10 0h2v-2h-2zM6 12h2v-2H6zm4 0h8v-2h-8zm-6 8q-.825 0-1.412-.587T2 18V6q0-.825.588-1.412T4 4h16q.825 0 1.413.588T22 6v12q0 .825-.587 1.413T20 20zm0-2h16V6H4zm0 0V6z"/></svg>
                <svg class="icon-filled" width="32" height="32" viewBox="0 0 24 24"><!-- Icon from Material Symbols --><path fill="currentColor" d="M4 20q-.825 0-1.412-.587T2 18V6q0-.825.588-1.412T4 4h16q.825 0 1.413.588T22 6v12q0 .825-.587 1.413T20 20zm3-4h6q.425 0 .713-.288T14 15t-.288-.712T13 14H7q-.425 0-.712.288T6 15t.288.713T7 16m4-4h6q.425 0 .713-.288T18 11t-.288-.712T17 10h-6q-.425 0-.712.288T10 11t.288.713T11 12m-3.287-.288Q8 11.426 8 11t-.288-.712T7 10t-.712.288T6 11t.288.713T7 12t.713-.288m10 4Q18 15.426 18 15t-.288-.712T17 14t-.712.288T16 15t.288.713T17 16t.713-.288"/></svg>
            `,
            plugins: `
                <svg class="icon-outline" width="32" height="32" viewBox="0 0 24 24"><!-- Icon from Remix Icon --><path fill="currentColor" d="M6.94 14.033a30 30 0 0 0-.606 1.783c.96-.697 2.101-1.14 3.418-1.304c2.513-.314 4.746-1.973 5.876-4.058l-1.456-1.455l1.413-1.415l1-1.002c.43-.429.915-1.224 1.428-2.367c-5.593.867-9.018 4.291-11.074 9.818M17 8.997l1 1c-1 3-4 6-8 6.5q-4.003.5-5.002 5.5H3c1-6 3-20 18-20q-1.5 4.496-2.997 5.997z"/></svg>
                <svg class="icon-filled" width="32" height="32" viewBox="0 0 24 24"><!-- Icon from Remix Icon --><path fill="currentColor" d="M21 1.997c-15 0-17 14-18 20h1.998q.999-5 5.002-5.5c4-.5 7-4 8-7l-1.5-1l1-1c1-1 2.004-2.5 3.5-5.5"/></svg>
            `,
            account: `
                <svg class="icon-outline" width="32" height="32" viewBox="0 0 24 24"><!-- Icon from Remix Icon --><path fill="currentColor" d="M20 22h-2v-2a3 3 0 0 0-3-3H9a3 3 0 0 0-3 3v2H4v-2a5 5 0 0 1 5-5h6a5 5 0 0 1 5 5zm-8-9a6 6 0 1 1 0-12a6 6 0 0 1 0 12m0-2a4 4 0 1 0 0-8a4 4 0 0 0 0 8"/></svg>
                <svg class="icon-filled" width="32" height="32" viewBox="0 0 24 24"><!-- Icon from Remix Icon --><path fill="currentColor" d="M20 22H4v-2a5 5 0 0 1 5-5h6a5 5 0 0 1 5 5zm-8-9a6 6 0 1 1 0-12a6 6 0 0 1 0 12"/></svg>
            `,
            about: `
                <svg class="icon-outline" width="32" height="32" viewBox="0 0 24 24"><!-- Icon from Remix Icon --><path fill="currentColor" d="M12 22C6.477 22 2 17.523 2 12S6.477 2 12 2s10 4.477 10 10s-4.477 10-10 10m0-2a8 8 0 1 0 0-16a8 8 0 0 0 0 16m1-9.5V15h1v2h-4v-2h1v-2.5h-1v-2zm.5-2.5a1.5 1.5 0 1 1-3 0a1.5 1.5 0 0 1 3 0"/></svg>
                <svg class="icon-filled" width="32" height="32" viewBox="0 0 24 24"><!-- Icon from Remix Icon --><path fill="currentColor" d="M12 22C6.477 22 2 17.523 2 12S6.477 2 12 2s10 4.477 10 10s-4.477 10-10 10m0-12.5a1.5 1.5 0 1 0 0-3a1.5 1.5 0 0 0 0 3m2 5.5h-1v-4.5h-3v2h1V15h-1v2h4z"/></svg>
            `,
            debug: `
                <svg class="icon-outline" width="32" height="32" viewBox="0 0 24 24"><!-- Icon from Remix Icon --><path fill="currentColor" d="M10.562 4.148a7 7 0 0 1 2.876 0l1.683-1.684l1.414 1.415l-1.05 1.05A7.03 7.03 0 0 1 18.327 8H21v2h-2.07q.07.49.07 1v1h2v2h-2v1q0 .51-.07 1H21v2h-2.674a7 7 0 0 1-12.652 0H3v-2h2.07A7 7 0 0 1 5 15v-1H3v-2h2v-1q0-.51.07-1H3V8h2.674a7.03 7.03 0 0 1 2.84-3.072l-1.05-1.05L8.88 2.465zM12 6a5 5 0 0 0-5 5v4a5 5 0 0 0 10 0v-4a5 5 0 0 0-5-5m-3 8h6v2H9zm0-4h6v2H9z"/></svg>
                <svg class="icon-filled" width="32" height="32" viewBox="0 0 24 24"><!-- Icon from Remix Icon --><path fill="currentColor" d="M5.07 16A7 7 0 0 1 5 15v-1H3v-2h2v-1q0-.51.07-1H3V8h2.674a7.03 7.03 0 0 1 2.84-3.072l-1.05-1.05L8.88 2.465l1.683 1.684a7 7 0 0 1 2.876 0l1.683-1.684l1.414 1.415l-1.05 1.05A7.03 7.03 0 0 1 18.327 8H21v2h-2.07q.07.49.07 1v1h2v2h-2v1q0 .51-.07 1H21v2h-2.674a7 7 0 0 1-12.652 0H3v-2zM9 10v2h6v-2zm0 4v2h6v-2z"/></svg>
            `
        },
        detailsIcons: {
            play: `<svg width="32" height="32" viewBox="0 0 24 24"><!-- Icon from Remix Icon --><path fill="currentColor" d="M6 20.196V3.804a1 1 0 0 1 1.53-.848l13.113 8.196a1 1 0 0 1 0 1.696L7.53 21.044A1 1 0 0 1 6 20.196"/></svg>`,
            playLarge: `<svg width="32" height="32" viewBox="0 0 24 24"><!-- Icon from Remix Icon --><path fill="currentColor" d="M12 22C6.477 22 2 17.523 2 12S6.477 2 12 2s10 4.477 10 10s-4.477 10-10 10M10.622 8.415a.4.4 0 0 0-.622.332v6.506a.4.4 0 0 0 .622.332l4.879-3.252a.4.4 0 0 0 0-.666z"/></svg>`,
            reset: `<svg width="32" height="32" viewBox="0 0 24 24"><!-- Icon from Remix Icon --><path fill="currentColor" d="M22 12c0 5.523-4.477 10-10 10S2 17.523 2 12S6.477 2 12 2v2a8 8 0 1 0 5.135 1.865L15 8V2h6l-2.447 2.447A9.98 9.98 0 0 1 22 12"/></svg>`,
            trailer: `<svg width="32" height="32" viewBox="0 0 24 24"><!-- Icon from Material Design Icons --><path fill="currentColor" d="M18 14.5V11a1 1 0 0 0-1-1h-1c2.24-1.61 2.76-4.73 1.15-7a5.02 5.02 0 0 0-6.98-1.13C9.5 2.35 8.96 3 8.6 3.73a4.985 4.985 0 0 0-6.88 1.64a5 5 0 0 0 1.64 6.88c.21.12.42.25.64.33V21a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-3.5l4 4v-11zM13 4a2 2 0 0 1 2 2a2 2 0 0 1-2 2a2 2 0 0 1-2-2a2 2 0 0 1 2-2M6 6a2 2 0 0 1 2 2a2 2 0 0 1-2 2a2 2 0 0 1-2-2a2 2 0 0 1 2-2"/></svg>`,
            shuffle: `<svg width="32" height="32" viewBox="0 0 24 24"><!-- Icon from Remix Icon --><path fill="currentColor" d="M18 17.883V16l5 3l-5 3v-2.09a9 9 0 0 1-6.997-5.365L11 14.54l-.003.006A9 9 0 0 1 2.725 20H2v-2h.725a7 7 0 0 0 6.434-4.243L9.912 12l-.753-1.757A7 7 0 0 0 2.725 6H2V4h.725a9 9 0 0 1 8.272 5.455L11 9.46l.003-.006A9 9 0 0 1 18 4.09V2l5 3l-5 3V6.117a7 7 0 0 0-5.159 4.126L12.088 12l.753 1.757A7 7 0 0 0 18 17.883"/></svg>`,
            watchedOutline: `<svg width="32" height="32" viewBox="0 0 24 24"><!-- Icon from Remix Icon --><path fill="currentColor" d="m9.343 18.782l-1.932-.518l.787-2.939a11 11 0 0 1-3.237-1.872l-2.153 2.154l-1.414-1.414l2.153-2.154a10.96 10.96 0 0 1-2.371-5.07l1.968-.359a9.002 9.002 0 0 0 17.713 0l1.968.358a10.96 10.96 0 0 1-2.372 5.071l2.154 2.154l-1.414 1.414l-2.154-2.154a11 11 0 0 1-3.237 1.872l.788 2.94l-1.932.517l-.788-2.94a11 11 0 0 1-3.74 0z"/></svg>`,
            watchedFilled: `<svg width="32" height="32" viewBox="0 0 24 24"><!-- Icon from Remix Icon --><path fill="currentColor" d="M1.182 12C2.122 6.88 6.608 3 12 3s9.878 3.88 10.819 9c-.94 5.12-5.427 9-10.819 9s-9.878-3.88-10.818-9M12 17a5 5 0 1 0 0-10a5 5 0 0 0 0 10m0-2a3 3 0 1 1 0-6a3 3 0 0 1 0 6"/></svg>`,
            audio: `<svg width="32" height="32" viewBox="0 0 24 24"><!-- Icon from Material Design Icons --><path fill="currentColor" d="M3 3c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h5v2h4v-4H3V5h18v2h2V5c0-1.1-.9-2-2-2zm18 6h-5c-1.1 0-2 .9-2 2v9c0 1.1.9 2 2 2h5c1.1 0 2-.9 2-2v-9c0-1.1-.9-2-2-2m-2.5 1.5c.8 0 1.5.7 1.5 1.5s-.7 1.5-1.5 1.5S17 12.8 17 12s.7-1.5 1.5-1.5m0 10c-1.7 0-3-1.3-3-3c0-1.6 1.3-3 2.9-3h.1c1.7 0 3 1.3 3 3s-1.3 3-3 3m0-4.5c-.8 0-1.5.7-1.5 1.5s.7 1.5 1.5 1.5s1.5-.7 1.5-1.5s-.7-1.5-1.5-1.5"/></svg>`,
            subtitle: `<svg width="32" height="32" viewBox="0 0 24 24"><!-- Icon from Material Symbols --><path fill="currentColor" d="M4 20q-.825 0-1.412-.587T2 18V6q0-.825.588-1.412T4 4h16q.825 0 1.413.588T22 6v12q0 .825-.587 1.413T20 20zm3-4h6q.425 0 .713-.288T14 15t-.288-.712T13 14H7q-.425 0-.712.288T6 15t.288.713T7 16m4-4h6q.425 0 .713-.288T18 11t-.288-.712T17 10h-6q-.425 0-.712.288T10 11t.288.713T11 12m-3.287-.288Q8 11.426 8 11t-.288-.712T7 10t-.712.288T6 11t.288.713T7 12t.713-.288m10 4Q18 15.426 18 15t-.288-.712T17 14t-.712.288T16 15t.288.713T17 16t.713-.288"/></svg>`,
            more: `<svg width="32" height="32" viewBox="0 0 24 24"><!-- Icon from Remix Icon --><path fill="currentColor" d="M12 3c-1.1 0-2 .9-2 2s.9 2 2 2s2-.9 2-2s-.9-2-2-2m0 14c-1.1 0-2 .9-2 2s.9 2 2 2s2-.9 2-2s-.9-2-2-2m0-7c-1.1 0-2 .9-2 2s.9 2 2 2s2-.9 2-2s-.9-2-2-2"/></svg>`,
            photo: `<svg width="32" height="32" viewBox="0 0 24 24"><!-- Icon from Remix Icon --><path fill="currentColor" d="m5 11.1l2-2l5.5 5.5l3.5-3.5l3 3V5H5zM4 3h16a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1m11.5 7a1.5 1.5 0 1 1 0-3a1.5 1.5 0 0 1 0 3"/></svg>`,
            check: `<svg width="32" height="32" viewBox="0 0 24 24"><!-- Icon from Material Design Icons --><path fill="currentColor" d="M21 7L9 19l-5.5-5.5l1.41-1.41L9 16.17L19.59 5.59z"/></svg>`,
            favoriteOutline: `<svg width="32" height="32" viewBox="0 0 24 24"><!-- Icon from Material Design Icons --><path fill="currentColor" d="m12.1 18.55l-.1.1l-.11-.1C7.14 14.24 4 11.39 4 8.5C4 6.5 5.5 5 7.5 5c1.54 0 3.04 1 3.57 2.36h1.86C13.46 6 14.96 5 16.5 5c2 0 3.5 1.5 3.5 3.5c0 2.89-3.14 5.74-7.9 10.05M16.5 3c-1.74 0-3.41.81-4.5 2.08C10.91 3.81 9.24 3 7.5 3C4.42 3 2 5.41 2 8.5c0 3.77 3.4 6.86 8.55 11.53L12 21.35l1.45-1.32C18.6 15.36 22 12.27 22 8.5C22 5.41 19.58 3 16.5 3"/></svg>`,
            favoriteFilled: `<svg width="32" height="32" viewBox="0 0 24 24"><!-- Icon from Material Design Icons --><path fill="currentColor" d="m12 21.35l-1.45-1.32C5.4 15.36 2 12.27 2 8.5C2 5.41 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.08C13.09 3.81 14.76 3 16.5 3C19.58 3 22 5.41 22 8.5c0 3.77-3.4 6.86-8.55 11.53z"/></svg>`,
            ghost: `<svg width="32" height="32" viewBox="0 0 24 24"><!-- Icon from Remix Icon --><path fill="currentColor" d="M12 2c3.5 0 6 3 7 6c3 1 4 3.73 4 6l-2.775.793a1 1 0 0 0-.725.961v1.496A1.75 1.75 0 0 1 17.75 19h-.596a2 2 0 0 0-1.668.896Q14.094 22 12 22t-3.486-2.104A2 2 0 0 0 6.846 19H6.25a1.75 1.75 0 0 1-1.75-1.75v-1.496a1 1 0 0 0-.725-.961L1 14c0-2.266 1-5 4-6c1-3 3.5-6 7-6m0 10c-.828 0-1.5 1.12-1.5 2.5S11.172 17 12 17s1.5-1.12 1.5-2.5S12.828 12 12 12M9.5 8a1.5 1.5 0 1 0 0 3a1.5 1.5 0 0 0 0-3m5 0a1.5 1.5 0 1 0 0 3a1.5 1.5 0 0 0 0-3"/></svg>`,
            ratingStar: `<svg class="rating-star-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><!-- Icon from Remix Icon --><path fill="currentColor" d="m12 18.26l-7.053 3.948l1.575-7.928L.588 8.792l8.027-.952L12 .5l3.385 7.34l8.027.952l-5.934 5.488l1.575 7.928z"/></svg>`
        },
        osdIcons: {
            arrowBack: `
                <svg class="osd-icon icon-outline" width="32" height="32" viewBox="0 0 24 24"><!-- Icon from Tabler Icons --><path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M20 15h-8v3.586a1 1 0 0 1-1.707.707l-6.586-6.586a1 1 0 0 1 0-1.414l6.586-6.586A1 1 0 0 1 12 5.414V9h8a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1"/></svg>
                <svg class="osd-icon icon-filled" width="32" height="32" viewBox="0 0 24 24"><!-- Icon from Tabler Icons --><path fill="currentColor" d="M9.586 4L3 10.586a2 2 0 0 0 0 2.828L9.586 20a2 2 0 0 0 2.18.434l.145-.068A2 2 0 0 0 13 18.586V16h7a2 2 0 0 0 2-2v-4l-.005-.15A2 2 0 0 0 20 8l-7-.001V5.414A2 2 0 0 0 9.586 4"/></svg>
            `,
            skipPrevious: `
                <svg class="osd-icon icon-outline" width="32" height="32" viewBox="0 0 24 24"><!-- Icon from Remix Icon --><path fill="currentColor" d="M7 4a1 1 0 0 1 1 1v6.333l10.223-6.815a.5.5 0 0 1 .777.416v14.132a.5.5 0 0 1-.777.416L8 12.667V19a1 1 0 1 1-2 0V5a1 1 0 0 1 1-1m10 3.737L10.606 12L17 16.263z"/></svg>
                <svg class="osd-icon icon-filled" width="32" height="32" viewBox="0 0 24 24"><!-- Icon from Remix Icon --><path fill="currentColor" d="m8 11.333l10.223-6.815a.5.5 0 0 1 .777.416v14.132a.5.5 0 0 1-.777.416L8 12.667V19a1 1 0 1 1-2 0V5a1 1 0 0 1 2 0z"/></svg>
            `,
            skipNext: `
                <svg class="osd-icon icon-outline" width="32" height="32" viewBox="0 0 24 24"><!-- Icon from Remix Icon --><path fill="currentColor" d="M16 12.667L5.777 19.482A.5.5 0 0 1 5 19.066V4.934a.5.5 0 0 1 .777-.416L16 11.333V5a1 1 0 1 1 2 0v14a1 1 0 1 1-2 0zm-9-4.93v8.526L13.394 12z"/></svg>
                <svg class="osd-icon icon-filled" width="32" height="32" viewBox="0 0 24 24"><!-- Icon from Remix Icon --><path fill="currentColor" d="M16 12.667L5.777 19.482A.5.5 0 0 1 5 19.066V4.934a.5.5 0 0 1 .777-.416L16 11.333V5a1 1 0 1 1 2 0v14a1 1 0 1 1-2 0z"/></svg>
            `,
            fastRewind: `
                <svg class="osd-icon icon-outline" width="32" height="32" viewBox="0 0 24 24"><!-- Icon from Remix Icon --><path fill="currentColor" d="m12 10.667l9.223-6.149a.5.5 0 0 1 .777.416v14.132a.5.5 0 0 1-.777.416L12 13.333v5.733a.5.5 0 0 1-.777.416L.624 12.416a.5.5 0 0 1 0-.832l10.599-7.066a.5.5 0 0 1 .777.416zm-2 5.596V7.737L3.606 12zm10 0V7.737L13.606 12z"/></svg>
                <svg class="osd-icon icon-filled" width="32" height="32" viewBox="0 0 24 24"><!-- Icon from Remix Icon --><path fill="currentColor" d="m12 10.667l9.223-6.149a.5.5 0 0 1 .777.416v14.132a.5.5 0 0 1-.777.416L12 13.333v5.733a.5.5 0 0 1-.777.416L.624 12.416a.5.5 0 0 1 0-.832l10.599-7.066a.5.5 0 0 1 .777.416z"/></svg>
            `,
            fastForward: `
                <svg class="osd-icon icon-outline" width="32" height="32" viewBox="0 0 24 24"><!-- Icon from Remix Icon --><path fill="currentColor" d="m12 13.333l-9.223 6.149A.5.5 0 0 1 2 19.066V4.934a.5.5 0 0 1 .777-.416L12 10.667V4.934a.5.5 0 0 1 .777-.416l10.599 7.066a.5.5 0 0 1 0 .832l-10.599 7.066a.5.5 0 0 1-.777-.416zM10.394 12L4 7.737v8.526zM14 7.737v8.526L20.394 12z"/></svg>
                <svg class="osd-icon icon-filled" width="32" height="32" viewBox="0 0 24 24"><!-- Icon from Remix Icon --><path fill="currentColor" d="m12 13.333l-9.223 6.149A.5.5 0 0 1 2 19.066V4.934a.5.5 0 0 1 .777-.416L12 10.667V4.934a.5.5 0 0 1 .777-.416l10.599 7.066a.5.5 0 0 1 0 .832l-10.599 7.066a.5.5 0 0 1-.777-.416z"/></svg>
            `,
            play: `
                <svg class="osd-icon icon-outline" width="32" height="32" viewBox="0 0 24 24"><!-- Icon from Remix Icon --><path fill="currentColor" d="M8 18.392V5.608L18.226 12zM6 3.804v16.392a1 1 0 0 0 1.53.848l13.113-8.196a1 1 0 0 0 0-1.696L7.53 2.956A1 1 0 0 0 6 3.804"/></svg>
                <svg class="osd-icon icon-filled" width="32" height="32" viewBox="0 0 24 24"><!-- Icon from Remix Icon --><path fill="currentColor" d="M6 20.196V3.804a1 1 0 0 1 1.53-.848l13.113 8.196a1 1 0 0 1 0 1.696L7.53 21.044A1 1 0 0 1 6 20.196"/></svg>
            `,
            pause: `
                <svg class="osd-icon icon-outline" width="32" height="32" viewBox="0 0 24 24"><!-- Icon from Remix Icon --><path fill="currentColor" d="M6 3h2v18H6zm10 0h2v18h-2z"/></svg>
                <svg class="osd-icon icon-filled" width="32" height="32" viewBox="0 0 24 24"><!-- Icon from Remix Icon --><path fill="currentColor" d="M6 3h2v18H6zm10 0h2v18h-2z"/></svg>
            `,
            sync: `
                <svg class="osd-icon icon-outline" width="32" height="32" viewBox="0 0 24 24"><!-- Icon from Material Design Icons --><path fill="currentColor" d="M14.47 15.08L11 13V7h1.5v5.25l3.08 1.83c-.41.28-.79.62-1.11 1m-1.39 4.84c-.36.05-.71.08-1.08.08c-4.42 0-8-3.58-8-8s3.58-8 8-8s8 3.58 8 8c0 .37-.03.72-.08 1.08c.69.1 1.33.32 1.92.64c.1-.56.16-1.13.16-1.72c0-5.5-4.5-10-10-10S2 6.5 2 12s4.47 10 10 10c.59 0 1.16-.06 1.72-.16c-.32-.59-.54-1.23-.64-1.92M18 15v3h-3v2h3v3h2v-3h3v-2h-3v-3z"/></svg>
                <svg class="osd-icon icon-filled" width="32" height="32" viewBox="0 0 24 24"><!-- Icon from Material Design Icons --><path fill="currentColor" d="M13.72 21.84c-.56.1-1.13.16-1.72.16c-5.5 0-10-4.5-10-10S6.5 2 12 2s10 4.5 10 10c0 .59-.06 1.16-.16 1.72A5.9 5.9 0 0 0 19 13c-1.26 0-2.43.39-3.4 1.06l-3.1-1.86V7H11v6l3.43 2.11A5.96 5.96 0 0 0 13 19c0 1.03.26 2 .72 2.84M18 15v3h-3v2h3v3h2v-3h3v-2h-3v-3z"/></svg>
            `,
            closedCaption: `
                <svg class="osd-icon icon-outline" width="32" height="32" viewBox="0 0 24 24"><!-- Icon from Material Symbols --><path fill="currentColor" d="M6 16h8v-2H6zm10 0h2v-2h-2zM6 12h2v-2H6zm4 0h8v-2h-8zm-6 8q-.825 0-1.412-.587T2 18V6q0-.825.588-1.412T4 4h16q.825 0 1.413.588T22 6v12q0 .825-.587 1.413T20 20zm0-2h16V6H4zm0 0V6z"/></svg>
                <svg class="osd-icon icon-filled" width="32" height="32" viewBox="0 0 24 24"><!-- Icon from Material Symbols --><path fill="currentColor" d="M4 20q-.825 0-1.412-.587T2 18V6q0-.825.588-1.412T4 4h16q.825 0 1.413.588T22 6v12q0 .825-.587 1.413T20 20zm3-4h6q.425 0 .713-.288T14 15t-.288-.712T13 14H7q-.425 0-.712.288T6 15t.288.713T7 16m4-4h6q.425 0 .713-.288T18 11t-.288-.712T17 10h-6q-.425 0-.712.288T10 11t.288.713T11 12m-3.287-.288Q8 11.426 8 11t-.288-.712T7 10t-.712.288T6 11t.288.713T7 12t.713-.288m10 4Q18 15.426 18 15t-.288-.712T17 14t-.712.288T16 15t.288.713T17 16t.713-.288"/></svg>
            `,
            audiotrack: `
                <svg class="osd-icon icon-outline" width="32" height="32" viewBox="0 0 24 24"><!-- Icon from Material Design Icons --><path fill="currentColor" d="M3 2c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h7v2H8v2h4v-6H3V4h18v3h2V4c0-1.1-.9-2-2-2zm18 7h-5c-1.1 0-2 .9-2 2v9c0 1.1.9 2 2 2h5c1.1 0 2-.9 2-2v-9c0-1.1-.9-2-2-2m-2.5 1.5c.8 0 1.5.7 1.5 1.5s-.7 1.5-1.5 1.5S17 12.8 17 12s.7-1.5 1.5-1.5m0 10c-1.7 0-3-1.3-3-3c0-1.6 1.3-3 2.9-3h.1c1.7 0 3 1.3 3 3s-1.3 3-3 3m0-4.5c-.8 0-1.5.7-1.5 1.5s.7 1.5 1.5 1.5s1.5-.7 1.5-1.5s-.7-1.5-1.5-1.5"/></svg>
                <svg class="osd-icon icon-filled" width="32" height="32" viewBox="0 0 24 24"><!-- Icon from Material Design Icons --><path fill="currentColor" d="M3 3c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h5v2h4v-4H3V5h18v2h2V5c0-1.1-.9-2-2-2zm18 6h-5c-1.1 0-2 .9-2 2v9c0 1.1.9 2 2 2h5c1.1 0 2-.9 2-2v-9c0-1.1-.9-2-2-2m-2.5 1.5c.8 0 1.5.7 1.5 1.5s-.7 1.5-1.5 1.5S17 12.8 17 12s.7-1.5 1.5-1.5m0 10c-1.7 0-3-1.3-3-3c0-1.6 1.3-3 2.9-3h.1c1.7 0 3 1.3 3 3s-1.3 3-3 3m0-4.5c-.8 0-1.5.7-1.5 1.5s.7 1.5 1.5 1.5s1.5-.7 1.5-1.5s-.7-1.5-1.5-1.5"/></svg>
            `,
            settings: `
                <svg class="osd-icon icon-outline" width="32" height="32" viewBox="0 0 24 24"><!-- Icon from Remix Icon --><path fill="currentColor" d="M2 12c0-.865.11-1.704.316-2.504A3 3 0 0 0 4.99 4.867a10 10 0 0 1 4.335-2.506a3 3 0 0 0 5.348 0a10 10 0 0 1 4.335 2.506a3 3 0 0 0 2.675 4.63c.206.8.316 1.638.316 2.503c0 .864-.11 1.703-.316 2.503a3 3 0 0 0-2.675 4.63a10 10 0 0 1-4.335 2.505a3 3 0 0 0-5.348 0a10 10 0 0 1-4.335-2.505a3 3 0 0 0-2.675-4.63C2.11 13.703 2 12.864 2 12m4.804 3c.63 1.091.81 2.346.564 3.524q.613.436 1.297.75A5 5 0 0 1 12 18c1.26 0 2.438.471 3.335 1.274q.684-.314 1.297-.75A5 5 0 0 1 17.196 15a5 5 0 0 1 2.77-2.25a8 8 0 0 0 0-1.5A5 5 0 0 1 17.196 9a5 5 0 0 1-.564-3.524a8 8 0 0 0-1.297-.75A5 5 0 0 1 12 6a5 5 0 0 1-3.335-1.274a8 8 0 0 0-1.297.75A5 5 0 0 1 6.804 9a5 5 0 0 1-2.77 2.25a8 8 0 0 0 0 1.5A5 5 0 0 1 6.805 15M12 15a3 3 0 1 1 0-6a3 3 0 0 1 0 6m0-2a1 1 0 1 0 0-2a1 1 0 0 0 0 2"/></svg>
                <svg class="osd-icon icon-filled" width="32" height="32" viewBox="0 0 24 24"><!-- Icon from Remix Icon --><path fill="currentColor" d="M5.334 4.545a10 10 0 0 1 3.542-2.048A4 4 0 0 0 12 4a4 4 0 0 0 3.124-1.502a10 10 0 0 1 3.542 2.048A4 4 0 0 0 18.928 8a4 4 0 0 0 2.863 1.955a10 10 0 0 1 0 4.09c-1.16.178-2.23.86-2.863 1.955a4 4 0 0 0-.262 3.455a10 10 0 0 1-3.542 2.047A4 4 0 0 0 12 20a4 4 0 0 0-3.124 1.503a10 10 0 0 1-3.542-2.048A4 4 0 0 0 5.072 16a4 4 0 0 0-2.863-1.954a10 10 0 0 1 0-4.091A4 4 0 0 0 5.072 8a4 4 0 0 0 .262-3.454M13.5 14.597a3 3 0 1 0-3-5.196a3 3 0 0 0 3 5.196"/></svg>
            `,
            favorite: `
                <!-- State 1: Not Favorite, Unfocused (Remix Heart Line) -->
                <svg class="osd-icon icon-outline icon-unfavorite" width="32" height="32" viewBox="0 0 24 24"><!-- Icon from Remix Icon --><path fill="currentColor" d="M16.5 3C19.538 3 22 5.5 22 9c0 7-7.5 11-10 12.5C9.5 20 2 16 2 9c0-3.5 2.5-6 5.5-6C9.36 3 11 4 12 5c1-1 2.64-2 4.5-2m-3.566 15.604a27 27 0 0 0 2.42-1.701C18.335 14.533 20 11.943 20 9c0-2.36-1.537-4-3.5-4c-1.076 0-2.24.57-3.086 1.414L12 7.828l-1.414-1.414C9.74 5.57 8.576 5 7.5 5C5.56 5 4 6.657 4 9c0 2.944 1.666 5.533 4.645 7.903c.745.593 1.54 1.146 2.421 1.7c.299.189.595.37.934.572c.339-.202.635-.383.934-.571"/></svg>
                
                <!-- State 2: Not Favorite, Focused (Remix Heart Line Accent) -->
                <svg class="osd-icon icon-filled icon-unfavorite" width="32" height="32" viewBox="0 0 24 24"><!-- Icon from Remix Icon --><path fill="currentColor" d="M12.001 4.529a6 6 0 0 1 8.242.228a6 6 0 0 1 .236 8.236l-8.48 8.492l-8.478-8.492a6 6 0 0 1 8.48-8.464m6.826 1.641a4 4 0 0 0-5.49-.153l-1.335 1.198l-1.336-1.197a4 4 0 0 0-5.686 5.605L12 18.654l7.02-7.03a4 4 0 0 0-.193-5.454"/></svg>
                
                <!-- State 3: Favorite, Unfocused (Remix Heart Fill) -->
                <svg class="osd-icon icon-outline icon-favorite" width="32" height="32" viewBox="0 0 24 24"><!-- Icon from Remix Icon --><path fill="currentColor" d="M16.5 3C19.538 3 22 5.5 22 9c0 7-7.5 11-10 12.5C9.5 20 2 16 2 9c0-3.5 2.5-6 5.5-6C9.36 3 11 4 12 5c1-1 2.64-2 4.5-2"/></svg>

                <!-- State 4: Favorite, Focused (Material Heart Bold/Thicker Fill) -->
                <svg class="osd-icon icon-filled icon-favorite" width="32" height="32" viewBox="0 0 24 24"><!-- Icon from Remix Icon --><path fill="currentColor" d="M12.001 4.529a6 6 0 0 1 8.242.228a6 6 0 0 1 .236 8.236l-8.48 8.492l-8.478-8.492a6 6 0 0 1 8.48-8.464"/></svg>
            `,
            palette: `
                <svg class="osd-icon icon-outline" width="32" height="32" viewBox="0 0 24 24"><!-- Icon from Material Symbols --><path fill="currentColor" d="m15.85 19.2l-.15-.7q-.3-.125-.562-.262T14.6 17.9l-.725.225q-.325.1-.637-.025t-.488-.4l-.2-.35q-.175-.3-.125-.65t.325-.575l.55-.475q-.05-.35-.05-.65t.05-.65l-.55-.475q-.275-.225-.325-.562t.125-.638l.225-.375q.175-.275.475-.4t.625-.025l.725.225q.275-.2.538-.337t.562-.263l.15-.725q.075-.35.338-.562T16.8 10h.4q.35 0 .613.225t.337.575l.15.7q.3.125.562.275t.538.375l.675-.225q.35-.125.675 0t.5.425l.2.35q.175.3.125.65t-.325.575l-.55.475q.05.3.05.625t-.05.625l.55.475q.275.225.325.563t-.125.637l-.225.375q-.175.275-.475.4t-.625.025L19.4 17.9q-.275.2-.538.337t-.562.263l-.15.725q-.075.35-.337.563T17.2 20h-.4q-.35 0-.612-.225t-.338-.575M4 18V6zm6.725-6.05q.275-.575.625-1.05t.8-.9H11q-.425 0-.712.288T10 11q0 .35.2.6t.525.35M10.1 16q-.05-.25-.062-.488T10.025 15t.013-.513T10.1 14H7q-.425 0-.712.288T6 15t.288.713T7 16zM4 20q-.825 0-1.412-.587T2 18V6q0-.825.588-1.412T4 4h16q.825 0 1.413.588T22 6v2.425q0 .425-.288.713T21 9.425t-.712-.288T20 8.426V6H4v12h6.425q.425 0 .713.288t.287.712t-.288.713t-.712.287zm13-3q.825 0 1.413-.587T19 15t-.587-1.412T17 13t-1.412.588T15 15t.588 1.413T17 17m-9.287-5.287Q8 11.425 8 11t-.288-.712T7 10t-.712.288T6 11t.288.713T7 12t.713-.288"/></svg>
                <svg class="osd-icon icon-filled" width="32" height="32" viewBox="0 0 24 24"><!-- Icon from Material Symbols --><path fill="currentColor" d="m15.85 19.2l-.15-.7q-.3-.125-.562-.262T14.6 17.9l-.725.225q-.325.1-.637-.025t-.488-.4l-.2-.35q-.175-.3-.125-.65t.325-.575l.55-.475q-.05-.35-.05-.65t.05-.65l-.55-.475q-.275-.225-.325-.562t.125-.638l.225-.375q.175-.275.475-.4t.625-.025l.725.225q.275-.2.538-.337t.562-.263l.15-.725q.075-.35.338-.562T16.8 10h.4q.35 0 .613.225t.337.575l.15.7q.3.125.562.275t.538.375l.675-.225q.35-.125.675 0t.5.425l.2.35q.175.3.125.65t-.325.575l-.55.475q.05.3.05.625t-.05.625l.55.475q.275.225.325.563t-.125.637l-.225.375q-.175.275-.475.4t-.625.025L19.4 17.9q-.275.2-.538.337t-.562.263l-.15.725q-.075.35-.337.563T17.2 20h-.4q-.35 0-.612-.225t-.338-.575M17 17q.825 0 1.413-.587T19 15t-.587-1.412T17 13t-1.412.588T15 15t.588 1.413T17 17M4 20q-.825 0-1.412-.587T2 18V6q0-.825.588-1.412T4 4h16q.825 0 1.413.588T22 6v2.625q0 .425-.413.625t-.762-.075q-.85-.575-1.812-.862T17 8.025q-1.425 0-2.662.525T12.15 10H11q-.425 0-.712.288T10 11q0 .35.2.6t.5.35q-.225.475-.375.988T10.1 14H7q-.425 0-.712.288T6 15t.288.713T7 16h3.1q.125.725.363 1.413t.637 1.312q.275.425.063.85T10.5 20zm3.713-8.287Q8 11.425 8 11t-.288-.712T7 10t-.712.288T6 11t.288.713T7 12t.713-.288"/></svg>
            `,
            check: `
                <svg class="osd-icon icon-outline" width="32" height="32" viewBox="0 0 24 24"><!-- Icon from Remix Icon --><path fill="currentColor" d="m10 15.17l9.192-9.191l1.414 1.414L10 17.999l-6.364-6.364l1.414-1.414z"/></svg>
                <svg class="osd-icon icon-filled" width="32" height="32" viewBox="0 0 24 24"><!-- Icon from Remix Icon --><path fill="currentColor" d="m10 15.17l9.192-9.191l1.414 1.414L10 17.999l-6.364-6.364l1.414-1.414z"/></svg>
            `,
            close: `
                <svg class="osd-icon icon-outline" width="32" height="32" viewBox="0 0 24 24"><!-- Icon from Remix Icon --><path fill="currentColor" d="m12 10.587l4.95-4.95l1.414 1.414l-4.95 4.95l4.95 4.95l-1.415 1.414l-4.95-4.95l-4.949 4.95l-1.414-1.415l4.95-4.95l-4.95-4.95L7.05 5.638z"/></svg>
                <svg class="osd-icon icon-filled" width="32" height="32" viewBox="0 0 24 24"><!-- Icon from Remix Icon --><path fill="currentColor" d="m12 10.587l4.95-4.95l1.414 1.414l-4.95 4.95l4.95 4.95l-1.415 1.414l-4.95-4.95l-4.949 4.95l-1.414-1.415l4.95-4.95l-4.95-4.95L7.05 5.638z"/></svg>
            `,
            info: `
                <svg class="osd-icon icon-outline" width="32" height="32" viewBox="0 0 24 24"><!-- Icon from Remix Icon --><path fill="currentColor" d="M12 22C6.477 22 2 17.523 2 12S6.477 2 12 2s10 4.477 10 10s-4.477 10-10 10m0-2a8 8 0 1 0 0-16a8 8 0 0 0 0 16m1-9.5V15h1v2h-4v-2h1v-2.5h-1v-2zm.5-2.5a1.5 1.5 0 1 1-3 0a1.5 1.5 0 0 1 3 0"/></svg>
                <svg class="osd-icon icon-filled" width="32" height="32" viewBox="0 0 24 24"><!-- Icon from Remix Icon --><path fill="currentColor" d="M12 22C6.477 22 2 17.523 2 12S6.477 2 12 2s10 4.477 10 10s-4.477 10-10 10m0-12.5a1.5 1.5 0 1 0 0-3a1.5 1.5 0 0 0 0 3m2 5.5h-1v-4.5h-3v2h1V15h-1v2h4z"/></svg>
            `,
            aspectRatio: `
                <svg class="osd-icon icon-outline"  width="32" height="32" viewBox="0 0 24 24"><!-- Icon from Material Design Icons --><path fill="currentColor" d="M21 15h2v2h-2zm0-4h2v2h-2zm2 8h-2v2c1 0 2-1 2-2M13 3h2v2h-2zm8 4h2v2h-2zm0-4v2h2c0-1-1-2-2-2M1 7h2v2H1zm16-4h2v2h-2zm0 16h2v2h-2zM3 3C2 3 1 4 1 5h2zm6 0h2v2H9zM5 3h2v2H5zm-4 8v8a2 2 0 0 0 2 2h12V11zm2 8l2.5-3.21l1.79 2.15l2.5-3.22L13 19z"/></svg>
                <svg class="osd-icon icon-filled" width="32" height="32" viewBox="0 0 24 24"><!-- Icon from Material Design Icons --><path fill="currentColor" d="M21 3H3C2 3 1 4 1 5v14a2 2 0 0 0 2 2h18c1 0 2-1 2-2V5c0-1-1-2-2-2M5 17l3.5-4.5l2.5 3l3.5-4.5l4.5 6z"/></svg>
            `,
            chapterPrevious: `
                <svg class="osd-icon icon-outline" width="32" height="32" viewBox="0 0 24 24"><!-- Icon from Remix Icon --><path fill="currentColor" d="M2 4a1 1 0 0 0-1 1v14a1 1 0 1 0 2 0v-5.667l9.223 6.149a.5.5 0 0 0 .777-.416v-5.733l9.223 6.149a.5.5 0 0 0 .777-.416V4.934a.5.5 0 0 0-.777-.416L13 10.666V4.934a.5.5 0 0 0-.777-.416L3 10.667V5a1 1 0 0 0-1-1m9 3.737v8.526L4.606 12zm10 0v8.526L14.606 12z"/></svg>
                <svg class="osd-icon icon-filled" width="32" height="32" viewBox="0 0 24 24"><!-- Icon from Remix Icon --><path fill="currentColor" d="M2 4a1 1 0 0 0-1 1v14a1 1 0 1 0 2 0v-5.667l9.223 6.149a.5.5 0 0 0 .777-.416v-5.733l9.223 6.149a.5.5 0 0 0 .777-.416V4.934a.5.5 0 0 0-.777-.416L13 10.666V4.934a.5.5 0 0 0-.777-.416L3 10.667V5a1 1 0 0 0-1-1"/></svg>
            `,
            chapterNext: `
                <svg class="osd-icon icon-outline" width="32" height="32" viewBox="0 0 24 24"><!-- Icon from Remix Icon --><path fill="currentColor" d="M22 4a1 1 0 0 0-1 1v5.666l-9.223-6.148a.5.5 0 0 0-.777.416v5.732L1.777 4.518A.5.5 0 0 0 1 4.934v14.132a.5.5 0 0 0 .777.416L11 13.333v5.733a.5.5 0 0 0 .777.416L21 13.333V19a1 1 0 1 0 2 0V5a1 1 0 0 0-1-1M3 7.737L9.394 12L3 16.263zm10 8.526V7.737L19.394 12z"/></svg>
                <svg class="osd-icon icon-filled" width="32" height="32" viewBox="0 0 24 24"><!-- Icon from Remix Icon --><path fill="currentColor" d="M22 4a1 1 0 0 0-1 1v5.666l-9.223-6.148a.5.5 0 0 0-.777.416v5.732L1.777 4.518A.5.5 0 0 0 1 4.934v14.132a.5.5 0 0 0 .777.416L11 13.333v5.733a.5.5 0 0 0 .777.416L21 13.333V19a1 1 0 1 0 2 0V5a1 1 0 0 0-1-1"/></svg>
            `,
            speed: `
                <svg class="osd-icon icon-outline" width="32" height="32" viewBox="0 0 24 24"><!-- Icon from Material Design Icons --><path fill="currentColor" d="M12 16c1.66 0 3-1.34 3-3c0-1.12-.61-2.1-1.5-2.61L3.79 4.77l5.53 9.58c.5.98 1.51 1.65 2.68 1.65m0-13c-1.81 0-3.5.5-4.97 1.32l2.1 1.21C10 5.19 11 5 12 5c4.42 0 8 3.58 8 8c0 2.21-.89 4.21-2.34 5.65h-.01a.996.996 0 0 0 0 1.41c.39.39 1.03.39 1.42.01A9.97 9.97 0 0 0 22 13c0-5.5-4.5-10-10-10M2 13c0 2.76 1.12 5.26 2.93 7.07c.39.38 1.02.38 1.41-.01a.996.996 0 0 0 0-1.41A7.95 7.95 0 0 1 4 13c0-1 .19-2 .54-2.9L3.33 8C2.5 9.5 2 11.18 2 13"/></svg>
                <svg class="osd-icon icon-filled" width="32" height="32" viewBox="0 0 24 24"><!-- Icon from Material Design Icons --><path fill="currentColor" d="M12 16a3 3 0 0 1-3-3c0-1.12.61-2.1 1.5-2.61l9.71-5.62l-5.53 9.58c-.5.98-1.51 1.65-2.68 1.65m0-13c1.81 0 3.5.5 4.97 1.32l-2.1 1.21C14 5.19 13 5 12 5a8 8 0 0 0-8 8c0 2.21.89 4.21 2.34 5.65h.01c.39.39.39 1.02 0 1.41s-1.03.39-1.42.01A9.97 9.97 0 0 1 2 13A10 10 0 0 1 12 3m10 10c0 2.76-1.12 5.26-2.93 7.07c-.39.38-1.02.38-1.41-.01a.996.996 0 0 1 0-1.41A7.95 7.95 0 0 0 20 13c0-1-.19-2-.54-2.9L20.67 8C21.5 9.5 22 11.18 22 13"/></svg>
            `,
            quality: `
                <svg class="osd-icon icon-outline" xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24"><!-- Icon from Material Symbols --><path fill="currentColor" d="M14.75 16.5h1.5V15H17q.425 0 .713-.288T18 14v-4q0-.425-.288-.712T17 9h-3q-.425 0-.712.288T13 10v4q0 .425.288.713T14 15h.75zM6 15h1.5v-2h2v2H11V9H9.5v2.5h-2V9H6zm8.5-1.5v-3h2v3zM4 20q-.825 0-1.412-.587T2 18V6q0-.825.588-1.412T4 4h16q.825 0 1.413.588T22 6v12q0 .825-.587 1.413T20 20zm0-2h16V6H4zm0 0V6z"/></svg>
                <svg class="osd-icon icon-filled" width="32" height="32" viewBox="0 0 24 24"><!-- Icon from Material Symbols --><path fill="currentColor" d="M14.75 16.5h1.5V15H17q.425 0 .713-.288T18 14v-4q0-.425-.288-.712T17 9h-3q-.425 0-.712.288T13 10v4q0 .425.288.713T14 15h.75zM6 15h1.5v-2h2v2H11V9H9.5v2.5h-2V9H6zm8.5-1.5v-3h2v3zM4 20q-.825 0-1.412-.587T2 18V6q0-.825.588-1.412T4 4h16q.825 0 1.413.588T22 6v12q0 .825-.587 1.413T20 20z"/></svg>
            `,
            layers: `
                <svg class="osd-icon icon-outline" width="32" height="32" viewBox="0 0 24 24"><!-- Icon from Material Symbols --><path fill="currentColor" d="M7.5 15H9v-4H7.5v1.25H6v1.5h1.5zm2.5-1.25h8v-1.5h-8zM15 11h1.5V9.75H18v-1.5h-1.5V7H15zM6 9.75h8v-1.5H6zM8 21v-2H4q-.825 0-1.412-.587T2 17V5q0-.825.588-1.412T4 3h16q.825 0 1.413.588T22 5v12q0 .825-.587 1.413T20 19h-4v2zm-4-4h16V5H4zm0 0V5z"/></svg>
                <svg class="osd-icon icon-filled" width="32" height="32" viewBox="0 0 24 24"><!-- Icon from Material Symbols --><path fill="currentColor" d="M7.5 15H9v-4H7.5v1.25H6v1.5h1.5zm2.5-1.25h8v-1.5h-8zM15 11h1.5V9.75H18v-1.5h-1.5V7H15zM6 9.75h8v-1.5H6zM8 21v-2H4q-.825 0-1.412-.587T2 17V5q0-.825.588-1.412T4 3h16q.825 0 1.413.588T22 5v12q0 .825-.587 1.413T20 19h-4v2z"/></svg>
            `,
            queue: `
                <svg class="osd-icon icon-outline" width="32" height="32" viewBox="0 0 24 24"><!-- Icon from Remix Icon --><path fill="currentColor" d="M22 18v2H2v-2zM2 3.5l8 5l-8 5zM22 11v2H12v-2zM4 7.109v2.783L6.226 8.5zM22 4v2H12V4z"/></svg>
                <svg class="osd-icon icon-filled" width="32" height="32" viewBox="0 0 24 24"><!-- Icon from Remix Icon --><path fill="currentColor" d="M22 18v2H2v-2zM2 3.5l8 5l-8 5zM22 11v2H12v-2zm0-7v2H12V4z"/></svg>
            `,
            viewList: `
                <svg class="osd-icon icon-outline" width="32" height="32" viewBox="0 0 24 24"><!-- Icon from Material Symbols --><path fill="currentColor" d="M11 17.05V7.2q-1.025-.6-2.175-.9T6.5 6q-.9 0-1.788.175T3 6.7v9.9q.875-.3 1.738-.45T6.5 16q1.175 0 2.288.263T11 17.05M12 20q-1.2-.95-2.6-1.475T6.5 18q-1.05 0-2.062.275T2.5 19.05q-.525.275-1.012-.025T1 18.15V6.1q0-.275.138-.525T1.55 5.2q1.15-.6 2.4-.9T6.5 4q1.85 0 3.15.425t2.8 1.3q.275.15.413.35T13 6.6v10.45q1.1-.525 2.213-.788T17.5 16q.9 0 1.763.15T21 16.6V4.575q.375.125.738.275t.712.35q.275.125.413.375T23 6.1v12.05q0 .575-.488.875t-1.012.025q-.925-.5-1.937-.775T17.5 18q-1.5 0-2.9.525T12 20m3.5-6V3l3-1v11zM7 11.525"/></svg>
                <svg class="osd-icon icon-filled" width="32" height="32" viewBox="0 0 24 24"><!-- Icon from Material Symbols --><path fill="currentColor" d="M12 20q-1.2-.95-2.6-1.475T6.5 18q-1.05 0-2.062.275T2.5 19.05q-.525.275-1.012-.025T1 18.15V6.1q0-.275.138-.525T1.55 5.2q1.15-.6 2.4-.9T6.5 4q1.85 0 3.15.425t2.8 1.3q.275.15.413.35T13 6.6v10.45q1.1-.525 2.213-.788T17.5 16q.9 0 1.763.15T21 16.6V4.575q.375.125.738.275t.712.35q.275.125.413.375T23 6.1v12.05q0 .575-.488.875t-1.012.025q-.925-.5-1.937-.775T17.5 18q-1.5 0-2.9.525T12 20m3.5-6V3l3-1v11z"/></svg>
            `,
            lyrics: `
                <svg class="osd-icon icon-outline" width="32" height="32" viewBox="0 0 24 24"><!-- Icon from Material Symbols --><path fill="currentColor" d="M2 22V4q0-.825.588-1.412T4 2h11q.825 0 1.413.588T17 4v.425q-.6.275-1.1.675T15 6V4H4v13.175L5.175 16H15v-4q.4.5.9.9t1.1.675V16q0 .825-.587 1.413T15 18H6zm4-8h4v-2H6zm13-2q-1.25 0-2.125-.875T16 9t.875-2.125T19 6q.275 0 .525.05t.475.125V1h4v2h-2v6q0 1.25-.875 2.125T19 12M6 11h7V9H6zm0-3h7V6H6zm-2 8V4z"/></svg>
                <svg class="osd-icon icon-filled"  width="32" height="32" viewBox="0 0 24 24"><!-- Icon from Material Symbols --><path fill="currentColor" d="M6 14h4v-2H6zm10.875-2.875Q16 10.25 16 9t.875-2.125T19 6q.275 0 .513.05t.487.125V1h4v2h-2v6q0 1.25-.875 2.125T19 12t-2.125-.875M6 11h7V9H6zm0-3h7V6H6zm0 10l-4 4V4q0-.825.588-1.412T4 2h11q.825 0 1.413.588T17 4v.425q-1.375.6-2.187 1.838T14 9t.813 2.738T17 13.575V16q0 .825-.587 1.413T15 18z"/></svg>
            `,
            group: `
                <svg class="osd-icon icon-outline" width="30" height="30" viewBox="0 0 24 24"><!-- Icon from Remix Icon --><path fill="currentColor" d="M2 22a8 8 0 1 1 16 0h-2a6 6 0 0 0-12 0zm8-9c-3.315 0-6-2.685-6-6s2.685-6 6-6s6 2.685 6 6s-2.685 6-6 6m0-2c2.21 0 4-1.79 4-4s-1.79-4-4-4s-4 1.79-4 4s1.79 4 4 4m8.284 3.703A8 8 0 0 1 23 22h-2a6 6 0 0 0-3.537-5.473zm-.688-11.29A5.5 5.5 0 0 1 21 8.5a5.5 5.5 0 0 1-5 5.478v-2.013a3.5 3.5 0 0 0 1.041-6.609z"/></svg>
                <svg class="osd-icon icon-filled" width="30" height="30" viewBox="0 0 24 24"><!-- Icon from Remix Icon --><path fill="currentColor" d="M2 22a8 8 0 1 1 16 0zm8-9c-3.315 0-6-2.685-6-6s2.685-6 6-6s6 2.685 6 6s-2.685 6-6 6m7.363 2.233A7.505 7.505 0 0 1 22.983 22H20c0-2.61-1-4.986-2.637-6.767m-2.023-2.276A7.98 7.98 0 0 0 18 7a7.96 7.96 0 0 0-1.015-3.903A5 5 0 0 1 21 8a5 5 0 0 1-5.66 4.957"/></svg>
            `,
            repeat: `
                <svg class="osd-icon icon-outline" width="32" height="32" viewBox="0 0 24 24"><!-- Icon from Remix Icon --><path fill="currentColor" d="M8 20v1.932a.5.5 0 0 1-.82.385l-4.12-3.433A.5.5 0 0 1 3.382 18H18a2 2 0 0 0 2-2V8h2v8a4 4 0 0 1-4 4zm8-16V2.068a.5.5 0 0 1 .82-.385l4.12 3.433a.5.5 0 0 1-.321.884H6a2 2 0 0 0-2 2v8H2V8a4 4 0 0 1 4-4z"/></svg>
                <svg class="osd-icon icon-filled" width="32" height="32" viewBox="0 0 24 24"><!-- Icon from Remix Icon --><path fill="currentColor" d="M8 20v1.933a.5.5 0 0 1-.82.384l-4.12-3.433A.5.5 0 0 1 3.382 18H18a2 2 0 0 0 2-2V8h2v8a4 4 0 0 1-4 4zm8-16V2.068a.5.5 0 0 1 .82-.385l4.12 3.433a.5.5 0 0 1-.321.884H6a2 2 0 0 0-2 2v8H2V8a4 4 0 0 1 4-4zm-5 4h2v8h-2v-6H9V9z"/></svg>
            `
        },
        libraryIcons: {
            movies: `
                <svg class="icon-outline" viewBox="0 0 24 24" width="32" height="32" fill="none"><path fill="currentColor" d="M12 20h8v2h-8C6.477 22 2 17.523 2 12S6.477 2 12 2s10 4.477 10 10a9.96 9.96 0 0 1-2 6h-2.708A8 8 0 1 0 12 20m0-10a2 2 0 1 1 0-4a2 2 0 0 1 0 4m-4 4a2 2 0 1 1 0-4a2 2 0 0 1 0 4m8 0a2 2 0 1 1 0-4a2 2 0 0 1 0 4m-4 4a2 2 0 1 1 0-4a2 2 0 0 1 0 4"/></svg>
                <svg class="icon-filled" viewBox="0 0 24 24" width="32" height="32" fill="none"><path fill="currentColor" d="M18.001 20H20v2h-8C6.477 22 2 17.523 2 12S6.477 2 12 2s10 4.477 10 10a9.99 9.99 0 0 1-3.999 8M12 10a2 2 0 1 0 0-4a2 2 0 0 0 0 4m-4 4a2 2 0 1 0 0-4a2 2 0 0 0 0 4m8 0a2 2 0 1 0 0-4a2 2 0 0 0 0 4m-4 4a2 2 0 1 0 0-4a2 2 0 0 0 0 4"/></svg>
            `,
            tvshows: `
                <svg class="icon-outline" viewBox="0 0 24 24" width="32" height="32" fill="none"><path fill="currentColor" d="M2 4c0-.552.455-1 .992-1h18.016c.548 0 .992.445.992 1v14c0 .552-.455 1-.992 1H2.992A.994.994 0 0 1 2 18zm2 1v12h16V5zm1 15h14v2H5z"/></svg>
                <svg class="icon-filled" viewBox="0 0 24 24" width="32" height="32" fill="none"><path fill="currentColor" d="M2 4c0-.552.455-1 .992-1h18.016c.548 0 .992.445.992 1v14c0 .552-.455 1-.992 1H2.992A.994.994 0 0 1 2 18zm3 16h14v2H5z"/></svg>
            `,
            music: `
                <svg class="icon-outline" viewBox="0 0 24 24" width="32" height="32" fill="none"><path fill="currentColor" d="M20 3v14a4 4 0 1 1-2-3.465V5H9v12a4 4 0 1 1-2-3.465V3zM5 19a2 2 0 1 0 0-4a2 2 0 0 0 0 4m11 0a2 2 0 1 0 0-4a2 2 0 0 0 0 4"/></svg>
                <svg class="icon-filled" viewBox="0 0 24 24" width="32" height="32" fill="none"><path fill="currentColor" d="M20 3v14a4 4 0 1 1-2-3.465V6H9v11a4 4 0 1 1-2-3.465V3z"/></svg>
            `,
            photos: `
                <svg class="icon-outline" viewBox="0 0 24 24" width="32" height="32" fill="none"><path fill="currentColor" d="m5 11.1l2-2l5.5 5.5l3.5-3.5l3 3V5H5zm0 2.829V19h3.1l2.986-2.985L7 11.929zM10.929 19H19v-2.071l-3-3zM4 3h16a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1m11.5 7a1.5 1.5 0 1 1 0-3a1.5 1.5 0 0 1 0 3"/></svg>
                <svg class="icon-filled" viewBox="0 0 24 24" width="32" height="32" fill="none"><path fill="currentColor" d="m5 11.1l2-2l5.5 5.5l3.5-3.5l3 3V5H5zM4 3h16a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1m11.5 7a1.5 1.5 0 1 1 0-3a1.5 1.5 0 0 1 0 3"/></svg>
            `,
            books: `
                <svg class="icon-outline" viewBox="0 0 24 24" width="32" height="32" fill="none"><path fill="currentColor" d="M3 18.5V5a3 3 0 0 1 3-3h14a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H6.5A3.5 3.5 0 0 1 3 18.5M19 20v-3H6.5a1.5 1.5 0 0 0 0 3zM10 4H6a1 1 0 0 0-1 1v10.337A3.5 3.5 0 0 1 6.5 15H19V4h-2v8l-3.5-2l-3.5 2z"/></svg>
                <svg class="icon-filled" viewBox="0 0 24 24" width="32" height="32" fill="none"><path fill="currentColor" d="M20 22H6.5A3.5 3.5 0 0 1 3 18.5V5a3 3 0 0 1 3-3h14a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1m-1-2v-3H6.5a1.5 1.5 0 0 0 0 3zM10 4v8l3.5-2l3.5 2V4z"/></svg>
            `,
            homevideos: `
                <svg class="icon-outline" viewBox="0 0 24 24" width="32" height="32" fill="none"><path fill="currentColor" d="M2 3.993A1 1 0 0 1 2.992 3h18.016c.548 0 .992.445.992.993v16.014a1 1 0 0 1-.992.993H2.992A.993.993 0 0 1 2 20.007zM8 5v14h8V5zM4 5v2h2V5zm14 0v2h2V5zM4 9v2h2V9zm14 0v2h2V9zM4 13v2h2v-2zm14 0v2h2v-2zM4 17v2h2v-2zm14 0v2h2v-2z"/></svg>
                <svg class="icon-filled" viewBox="0 0 24 24" width="32" height="32" fill="none"><path fill="currentColor" d="M2 3.993A1 1 0 0 1 2.992 3h18.016c.548 0 .992.445.992.993v16.014a1 1 0 0 1-.992.993H2.992A.993.993 0 0 1 2 20.007zM4 5v2h2V5zm14 0v2h2V5zM4 9v2h2V9zm14 0v2h2V9zM4 13v2h2v-2zm14 0v2h2v-2zM4 17v2h2v-2zm14 0v2h2v-2z"/></svg>
            `,
            boxsets: `
                <svg class="icon-outline" viewBox="0 0 24 24" width="32" height="32" fill="none"><path fill="currentColor" d="M4 3a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1v-4.703L16 20a1 1 0 0 0 1.186.77l3.912-.832a1 1 0 0 0 .77-1.186l-2.91-13.694a1 1 0 0 0-1.186-.77l-2.78.59A1 1 0 0 0 14 4h-4a1 1 0 0 0-1-1zm6 3h3v8h-3zm0 13v-3h3v3zM8 5v10H5V5zm0 12v2H5v-2zm9.332-.35l1.956-.416l.416 1.956l-1.956.416zm-.416-1.957l-1.663-7.825l1.956-.416l1.664 7.826z"/></svg>
                <svg class="icon-filled" viewBox="0 0 24 24" width="32" height="32" fill="none"><path fill="currentColor" d="M4 3a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1v-9.303l2.021 9.51a1 1 0 0 0 1.186.77l2.935-.623a1 1 0 0 0 .77-1.186l-2.91-13.694a1 1 0 0 0-1.187-.77L15 5.302V5a1 1 0 0 0-1-1H9a1 1 0 0 0-1-1zm5 3h4v8H9zm4 10v3H9v-3zm-6 1v2H5v-2zm11.77 1.814l-.416-1.956l.978-.208l.416 1.956z"/></svg>
            `,
            playlists: `
                <svg class="icon-outline" viewBox="0 0 24 24" width="32" height="32" fill="none"><path d="M12 12H3M16 6H3M12 18H3M16 12l5 3-5 3v-6z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
                <svg class="icon-filled" viewBox="0 0 24 24" width="32" height="32" fill="none"><path d="M3 10h11v2H3zm0-4h11v2H3zm0 8h7v2H3zm13-1v6l5-3-5-3z" fill="currentColor"/></svg>
            `,
            livetv: `
                <svg class="icon-outline" viewBox="0 0 24 24" width="32" height="32" fill="none"><path fill="currentColor" d="M22 18v2H2v-2zM2 3.5l8 5l-8 5zM22 11v2H12v-2zM4 7.109v2.783L6.226 8.5zM22 4v2H12V4z"/></svg>
                <svg class="icon-filled" viewBox="0 0 24 24" width="32" height="32" fill="none"><path fill="currentColor" d="M22 18v2H2v-2zM2 3.5l8 5l-8 5zM22 11v2H12v-2zm0-7v2H12V4z"/></svg>
            `,
            folders: `
                <svg class="icon-outline" viewBox="0 0 24 24" width="32" height="32" fill="none"><path fill="currentColor" d="M3.087 9h17.826a1 1 0 0 1 .997 1.083l-.833 10a1 1 0 0 1-.997.917H3.92a1 1 0 0 1-.996-.917l-.834-10A1 1 0 0 1 3.087 9M4.84 19h14.32l.667-8H4.174zm8.574-14H20a1 1 0 0 1 1 1v1H3V4a1 1 0 0 1 1-1h7.414z"/></svg>
                <svg class="icon-filled" viewBox="0 0 24 24" width="32" height="32" fill="none"><path fill="currentColor" d="M13.414 5H20a1 1 0 0 1 1 1v1H3V4a1 1 0 0 1 1-1h7.414zM3.087 9h17.826a1 1 0 0 1 .997 1.083l-.833 10a1 1 0 0 1-.997.917H3.92a1 1 0 0 1-.996-.917l-.834-10A1 1 0 0 1 3.087 9"/></svg>
            `,
            default: `
                <svg class="icon-outline" viewBox="0 0 24 24" width="32" height="32" fill="none"><path fill="currentColor" d="M3.087 9h17.826a1 1 0 0 1 .997 1.083l-.833 10a1 1 0 0 1-.997.917H3.92a1 1 0 0 1-.996-.917l-.834-10A1 1 0 0 1 3.087 9M4.84 19h14.32l.667-8H4.174zm8.574-14H20a1 1 0 0 1 1 1v1H3V4a1 1 0 0 1 1-1h7.414z"/></svg>
                <svg class="icon-filled" viewBox="0 0 24 24" width="32" height="32" fill="none"><path fill="currentColor" d="M13.414 5H20a1 1 0 0 1 1 1v1H3V4a1 1 0 0 1 1-1h7.414zM3.087 9h17.826a1 1 0 0 1 .997 1.083l-.833 10a1 1 0 0 1-.997.917H3.92a1 1 0 0 1-.996-.917l-.834-10A1 1 0 0 1 3.087 9"/></svg>
            `
        }
    },
    material3: {
        detailsIcons: {
            play: `<svg  width="32" height="32" viewBox="3 3 18 18"><!-- Icon from Material 3 --><path fill="currentColor" d="M8 6.82v10.36c0 .79.87 1.27 1.54.84l8.14-5.18a1 1 0 0 0 0-1.69L9.54 5.98A.998.998 0 0 0 8 6.82"/></svg>`,
            playLarge: `<svg  width="32" height="32" viewBox="1.55 1.55 20.9 20.9"><!-- Icon from Material 3 --><path fill="currentColor" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10s10-4.48 10-10S17.52 2 12 2M9.5 14.67V9.33c0-.79.88-1.27 1.54-.84l4.15 2.67a1 1 0 0 1 0 1.68l-4.15 2.67c-.66.43-1.54-.05-1.54-.84"/></svg>`,
            reset: `<svg  width="32" height="32" viewBox="1.55 1.55 20.9 20.9"><!-- Icon from Material 3 --><path fill="currentColor" d="M12 5V2.21c0-.45-.54-.67-.85-.35l-3.8 3.79c-.2.2-.2.51 0 .71l3.79 3.79c.32.31.86.09.86-.36V7c3.73 0 6.68 3.42 5.86 7.29c-.47 2.27-2.31 4.1-4.57 4.57c-3.57.75-6.75-1.7-7.23-5.01a1 1 0 0 0-.98-.85c-.6 0-1.08.53-1 1.13c.62 4.39 4.8 7.64 9.53 6.72c3.12-.61 5.63-3.12 6.24-6.24C20.84 9.48 16.94 5 12 5"/></svg>`,
            trailer: `<svg  width="32" height="32" viewBox="1.55 1.55 20.9 20.9"><!-- Icon from Material 3 --><path fill="currentColor" d="M18 4v1h-2V4c0-.55-.45-1-1-1H9c-.55 0-1 .45-1 1v1H6V4c0-.55-.45-1-1-1s-1 .45-1 1v16c0 .55.45 1 1 1s1-.45 1-1v-1h2v1c0 .55.45 1 1 1h6c.55 0 1-.45 1-1v-1h2v1c0 .55.45 1 1 1s1-.45 1-1V4c0-.55-.45-1-1-1s-1 .45-1 1M8 17H6v-2h2zm0-4H6v-2h2zm0-4H6V7h2zm10 8h-2v-2h2zm0-4h-2v-2h2zm0-4h-2V7h2z"/></svg>`,
            shuffle: `<svg  width="32" height="32" viewBox="1.55 1.55 20.9 20.9"><!-- Icon from Material 3 --><path fill="currentColor" d="M21 1H3c-1.1 0-2 .9-2 2v18c0 1.1.9 2 2 2h18c1.1 0 2-.9 2-2V3c0-1.1-.9-2-2-2M4.3 4.7a.996.996 0 0 1 1.41 0l4.47 4.47l-1.42 1.4L4.3 6.11a.996.996 0 0 1 0-1.41m15.29 14.8c0 .28-.22.5-.5.5H15.3a.5.5 0 0 1-.36-.85l1.2-1.2l-3.13-3.13l1.41-1.41l3.13 3.14l1.19-1.19c.31-.32.85-.1.85.35zm0-11.21a.5.5 0 0 1-.85.36l-1.19-1.19L5.7 19.29a.996.996 0 1 1-1.41-1.41L16.13 6.04l-1.19-1.19A.5.5 0 0 1 15.3 4h3.79c.28 0 .5.22.5.5z"/></svg>`,
            watchedOutline: `<svg  width="32" height="32" viewBox="1.55 1.55 20.9 20.9"><!-- Icon from Material 3 --><path fill="currentColor" d="M9 16.17L5.53 12.7a.996.996 0 1 0-1.41 1.41l4.18 4.18c.39.39 1.02.39 1.41 0L20.29 7.71a.996.996 0 1 0-1.41-1.41z"/></svg>`,
            watchedFilled: `<svg  width="32" height="32" viewBox="1.55 1.55 20.9 20.9"><!-- Icon from Material 3 --><path fill="currentColor" d="M9 16.17L5.53 12.7a.996.996 0 1 0-1.41 1.41l4.18 4.18c.39.39 1.02.39 1.41 0L20.29 7.71a.996.996 0 1 0-1.41-1.41z"/></svg>`,
            audio: `<svg  width="32" height="32" viewBox="1.55 1.55 20.9 20.9"><!-- Icon from Material 3 --><path fill="currentColor" d="M17 2H7c-1.1 0-2 .9-2 2v16c0 1.1.9 1.99 2 1.99L17 22c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2m-5 2c1.1 0 2 .9 2 2s-.9 2-2 2a2 2 0 1 1 0-4m0 16c-2.76 0-5-2.24-5-5s2.24-5 5-5s5 2.24 5 5s-2.24 5-5 5m0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3s3-1.34 3-3s-1.34-3-3-3"/></svg>`,
            subtitle: `<svg  width="32" height="32" viewBox="1.55 1.55 20.9 20.9"><!-- Icon from Material 3 --><path fill="currentColor" d="M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2M5 12h2c.55 0 1 .45 1 1s-.45 1-1 1H5c-.55 0-1-.45-1-1s.45-1 1-1m8 6H5c-.55 0-1-.45-1-1s.45-1 1-1h8c.55 0 1 .45 1 1s-.45 1-1 1m6 0h-2c-.55 0-1-.45-1-1s.45-1 1-1h2c.55 0 1 .45 1 1s-.45 1-1 1m0-4h-8c-.55 0-1-.45-1-1s.45-1 1-1h8c.55 0 1 .45 1 1s-.45 1-1 1"/></svg>`,
            more: `<svg  width="32" height="32" viewBox="1.55 1.55 20.9 20.9"><!-- Icon from Material 3 --><path fill="currentColor" d="M12 8c1.1 0 2-.9 2-2s-.9-2-2-2s-2 .9-2 2s.9 2 2 2m0 2c-1.1 0-2 .9-2 2s.9 2 2 2s2-.9 2-2s-.9-2-2-2m0 6c-1.1 0-2 .9-2 2s.9 2 2 2s2-.9 2-2s-.9-2-2-2"/></svg>`,
            photo: `<svg  width="32" height="32" viewBox="1.55 1.55 20.9 20.9"><!-- Icon from Material 3 --><path fill="currentColor" d="M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2M8.9 13.98l2.1 2.53l3.1-3.99c.2-.26.6-.26.8.01l3.51 4.68a.5.5 0 0 1-.4.8H6.02c-.42 0-.65-.48-.39-.81L8.12 14c.19-.26.57-.27.78-.02"/></svg>`,
            check: `<svg  width="32" height="32" viewBox="1.55 1.55 20.9 20.9"><!-- Icon from Material 3 --><path fill="currentColor" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10s10-4.48 10-10S17.52 2 12 2M9.29 16.29L5.7 12.7a.996.996 0 1 1 1.41-1.41L10 14.17l6.88-6.88a.996.996 0 1 1 1.41 1.41l-7.59 7.59a.996.996 0 0 1-1.41 0"/></svg>`,
            favoriteOutline: `<svg  width="32" height="32" viewBox="1.55 1.55 20.9 20.9"><!-- Icon from Material 3 --><path fill="currentColor" d="M19.66 3.99c-2.64-1.8-5.9-.96-7.66 1.1c-1.76-2.06-5.02-2.91-7.66-1.1c-1.4.96-2.28 2.58-2.34 4.29c-.14 3.88 3.3 6.99 8.55 11.76l.1.09c.76.69 1.93.69 2.69-.01l.11-.1c5.25-4.76 8.68-7.87 8.55-11.75c-.06-1.7-.94-3.32-2.34-4.28M12.1 18.55l-.1.1l-.1-.1C7.14 14.24 4 11.39 4 8.5C4 6.5 5.5 5 7.5 5c1.54 0 3.04.99 3.57 2.36h1.87C13.46 5.99 14.96 5 16.5 5c2 0 3.5 1.5 3.5 3.5c0 2.89-3.14 5.74-7.9 10.05"/></svg>`,
            favoriteFilled: `<svg  width="32" height="32" viewBox="1.55 1.55 20.9 20.9"><!-- Icon from Material 3 --><path fill="currentColor" d="M13.35 20.13c-.76.69-1.93.69-2.69-.01l-.11-.1C5.3 15.27 1.87 12.16 2 8.28c.06-1.7.93-3.33 2.34-4.29c2.64-1.8 5.9-.96 7.66 1.1c1.76-2.06 5.02-2.91 7.66-1.1c1.41.96 2.28 2.59 2.34 4.29c.14 3.88-3.3 6.99-8.55 11.76z"/></svg>`,
            ghost: `<svg  width="32" height="32" viewBox="0 0 24 24"><!-- Icon from Remix Icon --><path fill="currentColor" d="M12 2c3.5 0 6 3 7 6c3 1 4 3.73 4 6l-2.775.793a1 1 0 0 0-.725.961v1.496A1.75 1.75 0 0 1 17.75 19h-.596a2 2 0 0 0-1.668.896Q14.094 22 12 22t-3.486-2.104A2 2 0 0 0 6.846 19H6.25a1.75 1.75 0 0 1-1.75-1.75v-1.496a1 1 0 0 0-.725-.961L1 14c0-2.266 1-5 4-6c1-3 3.5-6 7-6m0 10c-.828 0-1.5 1.12-1.5 2.5S11.172 17 12 17s1.5-1.12 1.5-2.5S12.828 12 12 12M9.5 8a1.5 1.5 0 1 0 0 3a1.5 1.5 0 0 0 0-3m5 0a1.5 1.5 0 1 0 0 3a1.5 1.5 0 0 0 0-3"/></svg>`,
            ratingStar: `<svg class="rating-star-icon" viewBox="1.55 1.55 20.9 20.9"><!-- Icon from Material 3 --><path fill="currentColor" d="m12 17.27l4.15 2.51c.76.46 1.69-.22 1.49-1.08l-1.1-4.72l3.67-3.18c.67-.58.31-1.68-.57-1.75l-4.83-.41l-1.89-4.46c-.34-.81-1.5-.81-1.84 0L9.19 8.63l-4.83.41c-.88.07-1.24 1.17-.57 1.75l3.67 3.18l-1.1 4.72c-.2.86.73 1.54 1.49 1.08z"/></svg>`
        },
        osdIcons: {
            arrowBack: `
                <svg class="osd-icon icon-outline" width="32" height="32" viewBox="3 1.55 20.9 20.9"><!-- Icon from Material 3 --><path fill="currentColor" d="M16.62 2.99a1.25 1.25 0 0 0-1.77 0L6.54 11.3a.996.996 0 0 0 0 1.41l8.31 8.31c.49.49 1.28.49 1.77 0s.49-1.28 0-1.77L9.38 12l7.25-7.25c.48-.48.48-1.28-.01-1.76"/></svg>
                <svg class="osd-icon icon-filled" width="32" height="32" viewBox="3 1.55 20.9 20.9"><!-- Icon from Material 3 --><path fill="currentColor" d="M16.62 2.99a1.25 1.25 0 0 0-1.77 0L6.54 11.3a.996.996 0 0 0 0 1.41l8.31 8.31c.49.49 1.28.49 1.77 0s.49-1.28 0-1.77L9.38 12l7.25-7.25c.48-.48.48-1.28-.01-1.76"/></svg>
            `,
            skipPrevious: `
                <svg class="osd-icon icon-outline" width="32" height="32" viewBox="2 2 20 20"><!-- Icon from Material 3 --><path fill="currentColor" d="M7 6c.55 0 1 .45 1 1v10c0 .55-.45 1-1 1s-1-.45-1-1V7c0-.55.45-1 1-1m3.66 6.82l5.77 4.07c.66.47 1.58-.01 1.58-.82V7.93c0-.81-.91-1.28-1.58-.82l-5.77 4.07a1 1 0 0 0 0 1.64"/></svg>
                <svg class="osd-icon icon-filled" width="32" height="32" viewBox="2 2 20 20"><!-- Icon from Material 3 --><path fill="currentColor" d="M7 6c.55 0 1 .45 1 1v10c0 .55-.45 1-1 1s-1-.45-1-1V7c0-.55.45-1 1-1m3.66 6.82l5.77 4.07c.66.47 1.58-.01 1.58-.82V7.93c0-.81-.91-1.28-1.58-.82l-5.77 4.07a1 1 0 0 0 0 1.64"/></svg>
            `,
            skipNext: `
                <svg class="osd-icon icon-outline" width="32" height="32" viewBox="2 2 20 20"><!-- Icon from Material 3 --><path fill="currentColor" d="m7.58 16.89l5.77-4.07c.56-.4.56-1.24 0-1.63L7.58 7.11C6.91 6.65 6 7.12 6 7.93v8.14c0 .81.91 1.28 1.58.82M16 7v10c0 .55.45 1 1 1s1-.45 1-1V7c0-.55-.45-1-1-1s-1 .45-1 1"/></svg>
                <svg class="osd-icon icon-filled" width="32" height="32" viewBox="2 2 20 20"><!-- Icon from Material 3 --><path fill="currentColor" d="m7.58 16.89l5.77-4.07c.56-.4.56-1.24 0-1.63L7.58 7.11C6.91 6.65 6 7.12 6 7.93v8.14c0 .81.91 1.28 1.58.82M16 7v10c0 .55.45 1 1 1s1-.45 1-1V7c0-.55-.45-1-1-1s-1 .45-1 1"/></svg>
            `,
            fastRewind: `
                <svg class="osd-icon icon-outline" width="32" height="32" viewBox="2 2 20 20"><!-- Icon from Material 3 --><path fill="currentColor" d="M11 16.07V7.93c0-.81-.91-1.28-1.58-.82l-5.77 4.07c-.56.4-.56 1.24 0 1.63l5.77 4.07c.67.47 1.58 0 1.58-.81m1.66-3.25l5.77 4.07c.66.47 1.58-.01 1.58-.82V7.93c0-.81-.91-1.28-1.58-.82l-5.77 4.07a1 1 0 0 0 0 1.64"/></svg>
                <svg class="osd-icon icon-filled" width="32" height="32" viewBox="2 2 20 20"><!-- Icon from Material 3 --><path fill="currentColor" d="M11 16.07V7.93c0-.81-.91-1.28-1.58-.82l-5.77 4.07c-.56.4-.56 1.24 0 1.63l5.77 4.07c.67.47 1.58 0 1.58-.81m1.66-3.25l5.77 4.07c.66.47 1.58-.01 1.58-.82V7.93c0-.81-.91-1.28-1.58-.82l-5.77 4.07a1 1 0 0 0 0 1.64"/></svg>
            `,
            fastForward: `
                <svg class="osd-icon icon-outline" width="32" height="32" viewBox="1.3 2 20 20"><!-- Icon from Material 3 --><path fill="currentColor" d="m5.58 16.89l5.77-4.07c.56-.4.56-1.24 0-1.63L5.58 7.11C4.91 6.65 4 7.12 4 7.93v8.14c0 .81.91 1.28 1.58.82M13 7.93v8.14c0 .81.91 1.28 1.58.82l5.77-4.07c.56-.4.56-1.24 0-1.63l-5.77-4.07c-.67-.47-1.58 0-1.58.81"/></svg>
                <svg class="osd-icon icon-filled" width="32" height="32" viewBox="1.3 2 20 20"><!-- Icon from Material 3 --><path fill="currentColor" d="m5.58 16.89l5.77-4.07c.56-.4.56-1.24 0-1.63L5.58 7.11C4.91 6.65 4 7.12 4 7.93v8.14c0 .81.91 1.28 1.58.82M13 7.93v8.14c0 .81.91 1.28 1.58.82l5.77-4.07c.56-.4.56-1.24 0-1.63l-5.77-4.07c-.67-.47-1.58 0-1.58.81"/></svg>
            `,
            play: `
                <svg class="osd-icon icon-outline" width="32" height="32" viewBox="3 3 18 18"><!-- Icon from Material Symbols Rounded --><path fill="currentColor" d="M8 6.82v10.36c0 .79.87 1.27 1.54.84l8.14-5.18a1 1 0 0 0 0-1.69L9.54 5.98A.998.998 0 0 0 8 6.82"/></svg>
                <svg class="osd-icon icon-filled" width="32" height="32" viewBox="3 3 18 18"><!-- Icon from Material Symbols Rounded --><path fill="currentColor" d="M8 6.82v10.36c0 .79.87 1.27 1.54.84l8.14-5.18a1 1 0 0 0 0-1.69L9.54 5.98A.998.998 0 0 0 8 6.82"/></svg>
                `,
            pause: `
                <svg class="osd-icon icon-outline" width="32" height="32" viewBox="3 3 18 18"><!-- Icon from Material Symbols Rounded --><path fill="currentColor" d="M8 19c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2s-2 .9-2 2v10c0 1.1.9 2 2 2m6-12v10c0 1.1.9 2 2 2s2-.9 2-2V7c0-1.1-.9-2-2-2s-2 .9-2 2"/></svg>
                <svg class="osd-icon icon-filled" width="32" height="32" viewBox="3 3 18 18"><!-- Icon from Material Symbols Rounded --><path fill="currentColor" d="M8 19c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2s-2 .9-2 2v10c0 1.1.9 2 2 2m6-12v10c0 1.1.9 2 2 2s2-.9 2-2V7c0-1.1-.9-2-2-2s-2 .9-2 2"/></svg>
                `,
            sync: `
                <svg class="osd-icon icon-outline" width="32" height="32" viewBox="2 2 20 20"><!-- Icon from Material Symbols Rounded --><path fill="currentColor" d="M12 4V2.21c0-.45-.54-.67-.85-.35l-2.8 2.79c-.2.2-.2.51 0 .71l2.79 2.79c.32.31.86.09.86-.36V6c3.31 0 6 2.69 6 6c0 .79-.15 1.56-.44 2.25c-.15.36-.04.77.23 1.04c.51.51 1.37.33 1.64-.34c.37-.91.57-1.91.57-2.95c0-4.42-3.58-8-8-8m0 14c-3.31 0-6-2.69-6-6c0-.79.15-1.56.44-2.25c.15-.36.04-.77-.23-1.04c-.51-.51-1.37-.33-1.64.34C4.2 9.96 4 10.96 4 12c0 4.42 3.58 8 8 8v1.79c0 .45.54.67.85.35l2.79-2.79c.2-.2.2-.51 0-.71l-2.79-2.79a.5.5 0 0 0-.85.36z"/></svg>
                <svg class="osd-icon icon-filled" width="32" height="32" viewBox="2 2 20 20"><!-- Icon from Material Symbols Rounded --><path fill="currentColor" d="M12 4V2.21c0-.45-.54-.67-.85-.35l-2.8 2.79c-.2.2-.2.51 0 .71l2.79 2.79c.32.31.86.09.86-.36V6c3.31 0 6 2.69 6 6c0 .79-.15 1.56-.44 2.25c-.15.36-.04.77.23 1.04c.51.51 1.37.33 1.64-.34c.37-.91.57-1.91.57-2.95c0-4.42-3.58-8-8-8m0 14c-3.31 0-6-2.69-6-6c0-.79.15-1.56.44-2.25c.15-.36.04-.77-.23-1.04c-.51-.51-1.37-.33-1.64.34C4.2 9.96 4 10.96 4 12c0 4.42 3.58 8 8 8v1.79c0 .45.54.67.85.35l2.79-2.79c.2-.2.2-.51 0-.71l-2.79-2.79a.5.5 0 0 0-.85.36z"/></svg>
                `,
            closedCaption: `
                <svg class="osd-icon icon-outline" width="32" height="32" viewBox="1.55 1.55 20.9 20.9"><!-- Icon from Material Symbols Rounded --><path fill="currentColor" d="M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2M5 12h2c.55 0 1 .45 1 1s-.45 1-1 1H5c-.55 0-1-.45-1-1s.45-1 1-1m8 6H5c-.55 0-1-.45-1-1s.45-1 1-1h8c.55 0 1 .45 1 1s-.45 1-1 1m6 0h-2c-.55 0-1-.45-1-1s.45-1 1-1h2c.55 0 1 .45 1 1s-.45 1-1 1m0-4h-8c-.55 0-1-.45-1-1s.45-1 1-1h8c.55 0 1 .45 1 1s-.45 1-1 1"/></svg>
                <svg class="osd-icon icon-filled" width="32" height="32" viewBox="1.55 1.55 20.9 20.9"><!-- Icon from Material Symbols Rounded --><path fill="currentColor" d="M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2M5 12h2c.55 0 1 .45 1 1s-.45 1-1 1H5c-.55 0-1-.45-1-1s.45-1 1-1m8 6H5c-.55 0-1-.45-1-1s.45-1 1-1h8c.55 0 1 .45 1 1s-.45 1-1 1m6 0h-2c-.55 0-1-.45-1-1s.45-1 1-1h2c.55 0 1 .45 1 1s-.45 1-1 1m0-4h-8c-.55 0-1-.45-1-1s.45-1 1-1h8c.55 0 1 .45 1 1s-.45 1-1 1"/></svg>
                `,
            audiotrack: `
                <svg class="osd-icon icon-outline" width="32" height="32" viewBox="1.55 1.55 20.9 20.9"><!-- Icon from Material Symbols Rounded --><path fill="currentColor" d="M17 2H7c-1.1 0-2 .9-2 2v16c0 1.1.9 1.99 2 1.99L17 22c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2m-5 2c1.1 0 2 .9 2 2s-.9 2-2 2a2 2 0 1 1 0-4m0 16c-2.76 0-5-2.24-5-5s2.24-5 5-5s5 2.24 5 5s-2.24 5-5 5m0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3s3-1.34 3-3s-1.34-3-3-3"/></svg>
                <svg class="osd-icon icon-filled" width="32" height="32" viewBox="1.55 1.55 20.9 20.9"><!-- Icon from Material Symbols Rounded --><path fill="currentColor" d="M17 2H7c-1.1 0-2 .9-2 2v16c0 1.1.9 1.99 2 1.99L17 22c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2m-5 2c1.1 0 2 .9 2 2s-.9 2-2 2a2 2 0 1 1 0-4m0 16c-2.76 0-5-2.24-5-5s2.24-5 5-5s5 2.24 5 5s-2.24 5-5 5m0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3s3-1.34 3-3s-1.34-3-3-3"/></svg>
                `,
            settings: `
                <svg class="osd-icon icon-outline" width="32" height="32" viewBox="1.55 1.55 20.9 20.9"><!-- Icon from Material Symbols Rounded --><path fill="currentColor" d="M19.5 12c0-.23-.01-.45-.03-.68l1.86-1.41c.4-.3.51-.86.26-1.3l-1.87-3.23a.987.987 0 0 0-1.25-.42l-2.15.91c-.37-.26-.76-.49-1.17-.68l-.29-2.31c-.06-.5-.49-.88-.99-.88h-3.73c-.51 0-.94.38-1 .88l-.29 2.31c-.41.19-.8.42-1.17.68l-2.15-.91c-.46-.2-1-.02-1.25.42L2.41 8.62c-.25.44-.14.99.26 1.3l1.86 1.41a7.3 7.3 0 0 0 0 1.35l-1.86 1.41c-.4.3-.51.86-.26 1.3l1.87 3.23c.25.44.79.62 1.25.42l2.15-.91c.37.26.76.49 1.17.68l.29 2.31c.06.5.49.88.99.88h3.73c.5 0 .93-.38.99-.88l.29-2.31c.41-.19.8-.42 1.17-.68l2.15.91c.46.2 1 .02 1.25-.42l1.87-3.23c.25-.44.14-.99-.26-1.3l-1.86-1.41c.03-.23.04-.45.04-.68m-7.46 3.5c-1.93 0-3.5-1.57-3.5-3.5s1.57-3.5 3.5-3.5s3.5 1.57 3.5 3.5s-1.57 3.5-3.5 3.5"/></svg>
                <svg class="osd-icon icon-filled" width="32" height="32" viewBox="1.55 1.55 20.9 20.9"><!-- Icon from Material Symbols Rounded --><path fill="currentColor" d="M19.5 12c0-.23-.01-.45-.03-.68l1.86-1.41c.4-.3.51-.86.26-1.3l-1.87-3.23a.987.987 0 0 0-1.25-.42l-2.15.91c-.37-.26-.76-.49-1.17-.68l-.29-2.31c-.06-.5-.49-.88-.99-.88h-3.73c-.51 0-.94.38-1 .88l-.29 2.31c-.41.19-.8.42-1.17.68l-2.15-.91c-.46-.2-1-.02-1.25.42L2.41 8.62c-.25.44-.14.99.26 1.3l1.86 1.41a7.3 7.3 0 0 0 0 1.35l-1.86 1.41c-.4.3-.51.86-.26 1.3l1.87 3.23c.25.44.79.62 1.25.42l2.15-.91c.37.26.76.49 1.17.68l.29 2.31c.06.5.49.88.99.88h3.73c.5 0 .93-.38.99-.88l.29-2.31c.41-.19.8-.42 1.17-.68l2.15.91c.46.2 1 .02 1.25-.42l1.87-3.23c.25-.44.14-.99-.26-1.3l-1.86-1.41c.03-.23.04-.45.04-.68m-7.46 3.5c-1.93 0-3.5-1.57-3.5-3.5s1.57-3.5 3.5-3.5s3.5 1.57 3.5 3.5s-1.57 3.5-3.5 3.5"/></svg>
                `,
            favorite: `
                <!-- State 1: Not Favorite, Unfocused (Remix Heart Line) -->
                <svg class="osd-icon icon-outline icon-unfavorite" width="32" height="32" viewBox="1.55 1 20.9 20.9"><!-- Icon from Material 3 --><path fill="currentColor" d="M19.66 3.99c-2.64-1.8-5.9-.96-7.66 1.1c-1.76-2.06-5.02-2.91-7.66-1.1c-1.4.96-2.28 2.58-2.34 4.29c-.14 3.88 3.3 6.99 8.55 11.76l.1.09c.76.69 1.93.69 2.69-.01l.11-.1c5.25-4.76 8.68-7.87 8.55-11.75c-.06-1.7-.94-3.32-2.34-4.28M12.1 18.55l-.1.1l-.1-.1C7.14 14.24 4 11.39 4 8.5C4 6.5 5.5 5 7.5 5c1.54 0 3.04.99 3.57 2.36h1.87C13.46 5.99 14.96 5 16.5 5c2 0 3.5 1.5 3.5 3.5c0 2.89-3.14 5.74-7.9 10.05"/></svg>
                
                <!-- State 2: Not Favorite, Focused (Remix Heart Line Accent) -->
                <svg class="osd-icon icon-filled icon-unfavorite" width="32" height="32" viewBox="1.55 1 20.9 20.9"><!-- Icon from Material 3 --><path fill="currentColor" d="M19.66 3.99c-2.64-1.8-5.9-.96-7.66 1.1c-1.76-2.06-5.02-2.91-7.66-1.1c-1.4.96-2.28 2.58-2.34 4.29c-.14 3.88 3.3 6.99 8.55 11.76l.1.09c.76.69 1.93.69 2.69-.01l.11-.1c5.25-4.76 8.68-7.87 8.55-11.75c-.06-1.7-.94-3.32-2.34-4.28M12.1 18.55l-.1.1l-.1-.1C7.14 14.24 4 11.39 4 8.5C4 6.5 5.5 5 7.5 5c1.54 0 3.04.99 3.57 2.36h1.87C13.46 5.99 14.96 5 16.5 5c2 0 3.5 1.5 3.5 3.5c0 2.89-3.14 5.74-7.9 10.05"/></svg>
                
                <!-- State 3: Favorite, Unfocused (Remix Heart Fill) -->
                <svg class="osd-icon icon-outline icon-favorite" width="32" height="32" viewBox="1.55 1 20.9 20.9"><!-- Icon from Material 3 --><path fill="currentColor" d="M13.35 20.13c-.76.69-1.93.69-2.69-.01l-.11-.1C5.3 15.27 1.87 12.16 2 8.28c.06-1.7.93-3.33 2.34-4.29c2.64-1.8 5.9-.96 7.66 1.1c1.76-2.06 5.02-2.91 7.66-1.1c1.41.96 2.28 2.59 2.34 4.29c.14 3.88-3.3 6.99-8.55 11.76z"/></svg>

                <!-- State 4: Favorite, Focused (Material Heart Bold/Thicker Fill) -->
                <svg class="osd-icon icon-filled icon-favorite" width="32" height="32" viewBox="1.55 1 20.9 20.9"><!-- Icon from Material 3 --><path fill="currentColor" d="M13.35 20.13c-.76.69-1.93.69-2.69-.01l-.11-.1C5.3 15.27 1.87 12.16 2 8.28c.06-1.7.93-3.33 2.34-4.29c2.64-1.8 5.9-.96 7.66 1.1c1.76-2.06 5.02-2.91 7.66-1.1c1.41.96 2.28 2.59 2.34 4.29c.14 3.88-3.3 6.99-8.55 11.76z"/></svg>
            `,
            palette: `
                <svg class="osd-icon icon-outline" width="32" height="32" viewBox="1.55 1.55 20.9 20.9"><!-- Icon from Material Symbols Rounded --><path fill="currentColor" d="m15.85 19.2l-.15-.7q-.3-.125-.562-.262T14.6 17.9l-.725.225q-.325.1-.637-.025t-.488-.4l-.2-.35q-.175-.3-.125-.65t.325-.575l.55-.475q-.05-.35-.05-.65t.05-.65l-.55-.475q-.275-.225-.325-.562t.125-.638l.225-.375q.175-.275.475-.4t.625-.025l.725.225q.275-.2.538-.337t.562-.263l.15-.725q.075-.35.338-.562T16.8 10h.4q.35 0 .613.225t.337.575l.15.7q.3.125.562.275t.538.375l.675-.225q.35-.125.675 0t.5.425l.2.35q.175.3.125.65t-.325.575l-.55.475q.05.3.05.625t-.05.625l.55.475q.275.225.325.563t-.125.637l-.225.375q-.175.275-.475.4t-.625.025L19.4 17.9q-.275.2-.538.337t-.562.263l-.15.725q-.075.35-.337.563T17.2 20h-.4q-.35 0-.612-.225t-.338-.575M17 17q.825 0 1.413-.587T19 15t-.587-1.412T17 13t-1.412.588T15 15t.588 1.413T17 17M4 20q-.825 0-1.412-.587T2 18V6q0-.825.588-1.412T4 4h16q.825 0 1.413.588T22 6v2.625q0 .425-.413.625t-.762-.075q-.85-.575-1.812-.862T17 8.025q-1.425 0-2.662.525T12.15 10H11q-.425 0-.712.288T10 11q0 .35.2.6t.5.35q-.225.475-.375.988T10.1 14H7q-.425 0-.712.288T6 15t.288.713T7 16h3.1q.125.725.363 1.413t.637 1.312q.275.425.063.85T10.5 20zm3-8q.425 0 .713-.288T8 11t-.288-.712T7 10t-.712.288T6 11t.288.713T7 12"/></svg>
                <svg class="osd-icon icon-filled" width="32" height="32" viewBox="1.55 1.55 20.9 20.9"><!-- Icon from Material Symbols Rounded --><path fill="currentColor" d="m15.85 19.2l-.15-.7q-.3-.125-.562-.262T14.6 17.9l-.725.225q-.325.1-.637-.025t-.488-.4l-.2-.35q-.175-.3-.125-.65t.325-.575l.55-.475q-.05-.35-.05-.65t.05-.65l-.55-.475q-.275-.225-.325-.562t.125-.638l.225-.375q.175-.275.475-.4t.625-.025l.725.225q.275-.2.538-.337t.562-.263l.15-.725q.075-.35.338-.562T16.8 10h.4q.35 0 .613.225t.337.575l.15.7q.3.125.562.275t.538.375l.675-.225q.35-.125.675 0t.5.425l.2.35q.175.3.125.65t-.325.575l-.55.475q.05.3.05.625t-.05.625l.55.475q.275.225.325.563t-.125.637l-.225.375q-.175.275-.475.4t-.625.025L19.4 17.9q-.275.2-.538.337t-.562.263l-.15.725q-.075.35-.337.563T17.2 20h-.4q-.35 0-.612-.225t-.338-.575M17 17q.825 0 1.413-.587T19 15t-.587-1.412T17 13t-1.412.588T15 15t.588 1.413T17 17M4 20q-.825 0-1.412-.587T2 18V6q0-.825.588-1.412T4 4h16q.825 0 1.413.588T22 6v2.625q0 .425-.413.625t-.762-.075q-.85-.575-1.812-.862T17 8.025q-1.425 0-2.662.525T12.15 10H11q-.425 0-.712.288T10 11q0 .35.2.6t.5.35q-.225.475-.375.988T10.1 14H7q-.425 0-.712.288T6 15t.288.713T7 16h3.1q.125.725.363 1.413t.637 1.312q.275.425.063.85T10.5 20zm3-8q.425 0 .713-.288T8 11t-.288-.712T7 10t-.712.288T6 11t.288.713T7 12"/></svg>
                `,
            check: `
                <svg class="osd-icon icon-outline" width="32" height="32" viewBox="1.55 1.55 20.9 20.9"><!-- Icon from Material Symbols Rounded --><path fill="currentColor" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10s10-4.48 10-10S17.52 2 12 2m-2 15l-5-5l1.41-1.41L10 14.17l7.59-7.59L19 8z"/></svg>
                <svg class="osd-icon icon-filled" width="32" height="32" viewBox="1.55 1.55 20.9 20.9"><!-- Icon from Material Symbols Rounded --><path fill="currentColor" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10s10-4.48 10-10S17.52 2 12 2m-2 15l-5-5l1.41-1.41L10 14.17l7.59-7.59L19 8z"/></svg>
                `,
            close: `
                <svg class="osd-icon icon-outline" width="32" height="32" viewBox="1.55 1.55 20.9 20.9"><!-- Icon from Material Symbols Rounded --><path fill="currentColor" d="M18.3 5.71a.996.996 0 0 0-1.41 0L12 10.59L7.11 5.7A.996.996 0 1 0 5.7 7.11L10.59 12L5.7 16.89a.996.996 0 1 0 1.41 1.41L12 13.41l4.89 4.89a.996.996 0 1 0 1.41-1.41L13.41 12l4.89-4.89c.38-.38.38-1.02 0-1.4"/></svg>
                <svg class="osd-icon icon-filled" width="32" height="32" viewBox="1.55 1.55 20.9 20.9"><!-- Icon from Material Symbols Rounded --><path fill="currentColor" d="M18.3 5.71a.996.996 0 0 0-1.41 0L12 10.59L7.11 5.7A.996.996 0 1 0 5.7 7.11L10.59 12L5.7 16.89a.996.996 0 1 0 1.41 1.41L12 13.41l4.89 4.89a.996.996 0 1 0 1.41-1.41L13.41 12l4.89-4.89c.38-.38.38-1.02 0-1.4"/></svg>
                `,
            info: `
                <svg class="osd-icon icon-outline" width="32" height="32" viewBox="1.55 1.55 20.9 20.9"><!-- Icon from Material Symbols Rounded --><path fill="currentColor" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10s10-4.48 10-10S17.52 2 12 2m1 15h-2v-6h2zm0-8h-2V7h2z"/></svg>
                <svg class="osd-icon icon-filled" width="32" height="32" viewBox="1.55 1.55 20.9 20.9"><!-- Icon from Material Symbols Rounded --><path fill="currentColor" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10s10-4.48 10-10S17.52 2 12 2m1 15h-2v-6h2zm0-8h-2V7h2z"/></svg>
                `,
            aspectRatio: `
                <svg class="osd-icon icon-outline" width="32" height="32" viewBox="1.55 1.55 20.9 20.9"><!-- Icon from Material Symbols Rounded --><path fill="currentColor" d="M17 15h-2q-.425 0-.712.288T14 16t.288.713T15 17h3q.425 0 .713-.288T19 16v-3q0-.425-.288-.712T18 12t-.712.288T17 13zM7 9h2q.425 0 .713-.288T10 8t-.288-.712T9 7H6q-.425 0-.712.288T5 8v3q0 .425.288.713T6 12t.713-.288T7 11zM4 20q-.825 0-1.412-.587T2 18V6q0-.825.588-1.412T4 4h16q.825 0 1.413.588T22 6v12q0 .825-.587 1.413T20 20z"/></svg>
                <svg class="osd-icon icon-filled" width="32" height="32" viewBox="1.55 1.55 20.9 20.9"><!-- Icon from Material Symbols Rounded --><path fill="currentColor" d="M17 15h-2q-.425 0-.712.288T14 16t.288.713T15 17h3q.425 0 .713-.288T19 16v-3q0-.425-.288-.712T18 12t-.712.288T17 13zM7 9h2q.425 0 .713-.288T10 8t-.288-.712T9 7H6q-.425 0-.712.288T5 8v3q0 .425.288.713T6 12t.713-.288T7 11zM4 20q-.825 0-1.412-.587T2 18V6q0-.825.588-1.412T4 4h16q.825 0 1.413.588T22 6v12q0 .825-.587 1.413T20 20z"/></svg>
                `,
            chapterPrevious: `
                <svg class="osd-icon icon-outline" width="32" height="32" viewBox="0 0 24 24"><!-- Icon from Material 3 --><path fill="currentColor" d="M14.71 6.71a.996.996 0 0 0-1.41 0L8.71 11.3a.996.996 0 0 0 0 1.41l4.59 4.59a.996.996 0 1 0 1.41-1.41L10.83 12l3.88-3.88c.39-.39.38-1.03 0-1.41"/></svg>
                <svg class="osd-icon icon-filled" width="32" height="32" viewBox="0 0 24 24"><!-- Icon from Material 3 --><path fill="currentColor" d="M14.71 6.71a.996.996 0 0 0-1.41 0L8.71 11.3a.996.996 0 0 0 0 1.41l4.59 4.59a.996.996 0 1 0 1.41-1.41L10.83 12l3.88-3.88c.39-.39.38-1.03 0-1.41"/></svg>
            `,
            chapterNext: `
                <svg class="osd-icon icon-outline" width="32" height="32" viewBox="-1 0 24 24"><!-- Icon from Material 3 --><path fill="currentColor" d="M9.29 6.71a.996.996 0 0 0 0 1.41L13.17 12l-3.88 3.88a.996.996 0 1 0 1.41 1.41l4.59-4.59a.996.996 0 0 0 0-1.41L10.7 6.7c-.38-.38-1.02-.38-1.41.01"/></svg>
                <svg class="osd-icon icon-filled" width="32" height="32" viewBox="-1 0 24 24"><!-- Icon from Material 3 --><path fill="currentColor" d="M9.29 6.71a.996.996 0 0 0 0 1.41L13.17 12l-3.88 3.88a.996.996 0 1 0 1.41 1.41l4.59-4.59a.996.996 0 0 0 0-1.41L10.7 6.7c-.38-.38-1.02-.38-1.41.01"/></svg>
            `,    
            speed: `
                <svg class="osd-icon icon-outline" width="32" height="32" viewBox="1.55 1.55 20.9 20.9"><!-- Icon from Material Symbols Rounded --><path fill="currentColor" d="M10.45 15.5q.625.625 1.575.588T13.4 15.4l4.225-6.325q.225-.35-.062-.638t-.638-.062L10.6 12.6q-.65.45-.712 1.363t.562 1.537M5.1 20q-.55 0-1.012-.238t-.738-.712q-.65-1.175-1-2.437T2 14q0-2.075.788-3.9t2.137-3.175T8.1 4.788T12 4q2.05 0 3.85.775T19 6.888t2.15 3.125t.825 3.837q.025 1.375-.312 2.688t-1.038 2.512q-.275.475-.737.713T18.874 20z"/></svg>
                <svg class="osd-icon icon-filled" width="32" height="32" viewBox="1.55 1.55 20.9 20.9"><!-- Icon from Material Symbols Rounded --><path fill="currentColor" d="M10.45 15.5q.625.625 1.575.588T13.4 15.4l4.225-6.325q.225-.35-.062-.638t-.638-.062L10.6 12.6q-.65.45-.712 1.363t.562 1.537M5.1 20q-.55 0-1.012-.238t-.738-.712q-.65-1.175-1-2.437T2 14q0-2.075.788-3.9t2.137-3.175T8.1 4.788T12 4q2.05 0 3.85.775T19 6.888t2.15 3.125t.825 3.837q.025 1.375-.312 2.688t-1.038 2.512q-.275.475-.737.713T18.874 20z"/></svg>
                `,
            quality: `
                <svg class="osd-icon icon-outline" width="32" height="32" viewBox="1.55 1.55 20.9 20.9"><!-- Icon from Material Symbols Rounded --><path fill="currentColor" d="M19 4H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h14c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2m-8.75 11c-.41 0-.75-.34-.75-.75V13h-2v1.25c0 .41-.34.75-.75.75S6 14.66 6 14.25v-4.5c0-.41.34-.75.75-.75s.75.34.75.75v1.75h2V9.75c0-.41.34-.75.75-.75s.75.34.75.75v4.5c0 .41-.34.75-.75.75M18 14c0 .55-.45 1-1 1h-.75v.75c0 .41-.34.75-.75.75s-.75-.34-.75-.75V15H14c-.55 0-1-.45-1-1v-4c0-.55.45-1 1-1h3c.55 0 1 .45 1 1zm-3.5-.5h2v-3h-2z"/></svg>
                <svg class="osd-icon icon-filled" width="32" height="32" viewBox="1.55 1.55 20.9 20.9"><!-- Icon from Material Symbols Rounded --><path fill="currentColor" d="M19 4H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h14c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2m-8.75 11c-.41 0-.75-.34-.75-.75V13h-2v1.25c0 .41-.34.75-.75.75S6 14.66 6 14.25v-4.5c0-.41.34-.75.75-.75s.75.34.75.75v1.75h2V9.75c0-.41.34-.75.75-.75s.75.34.75.75v4.5c0 .41-.34.75-.75.75M18 14c0 .55-.45 1-1 1h-.75v.75c0 .41-.34.75-.75.75s-.75-.34-.75-.75V15H14c-.55 0-1-.45-1-1v-4c0-.55.45-1 1-1h3c.55 0 1 .45 1 1zm-3.5-.5h2v-3h-2z"/></svg>
                `,
            layers: `
                <svg class="osd-icon icon-outline" width="32" height="32" viewBox="1.55 1.55 20.9 20.9"><!-- Icon from Material Symbols Rounded --><path fill="currentColor" d="M11 20H4q-.825 0-1.412-.587T2 18V6q0-.825.588-1.412T4 4h16q.825 0 1.413.588T22 6v4q0 .425-.288.713T21 11t-.712-.288T20 10V6H4v12h7q.425 0 .713.288T12 19t-.288.713T11 20m-1.5-4.875v-6.25q0-.45.388-.663t.762.038l4.875 3.125q.35.225.35.625t-.35.625L10.65 15.75q-.375.25-.763.038t-.387-.663m8.275 7.475l-.225-1.1q-.3-.125-.563-.262t-.537-.338l-1.075.325q-.175.05-.325-.012T14.8 21l-.6-1q-.1-.15-.05-.325t.175-.3l.825-.725q-.05-.35-.05-.65t.05-.65l-.825-.725q-.125-.125-.175-.3T14.2 16l.6-1q.1-.15.25-.212t.325-.013l1.075.325q.275-.2.538-.337t.562-.263l.225-1.1q.05-.175.163-.288T18.25 13h1.2q.2 0 .313.113t.162.287l.225 1.1q.3.125.563.275t.537.375l1.05-.375q.175-.05.338.013T22.9 15l.6 1.05q.1.15.063.325t-.163.3l-.85.725q.05.3.05.625t-.05.625l.825.725q.125.125.175.3T23.5 20l-.6 1q-.1.15-.25.213t-.325.012L21.25 20.9q-.275.2-.537.338t-.563.262l-.225 1.1q-.05.175-.162.288T19.45 23h-1.2q-.2 0-.312-.112t-.163-.288M18.85 20q.825 0 1.413-.587T20.85 18t-.587-1.412T18.85 16t-1.412.588T16.85 18t.588 1.413T18.85 20"/></svg>
                <svg class="osd-icon icon-filled" width="32" height="32" viewBox="1.55 1.55 20.9 20.9"><!-- Icon from Material Symbols Rounded --><path fill="currentColor" d="M11 20H4q-.825 0-1.412-.587T2 18V6q0-.825.588-1.412T4 4h16q.825 0 1.413.588T22 6v4q0 .425-.288.713T21 11t-.712-.288T20 10V6H4v12h7q.425 0 .713.288T12 19t-.288.713T11 20m-1.5-4.875v-6.25q0-.45.388-.663t.762.038l4.875 3.125q.35.225.35.625t-.35.625L10.65 15.75q-.375.25-.763.038t-.387-.663m8.275 7.475l-.225-1.1q-.3-.125-.563-.262t-.537-.338l-1.075.325q-.175.05-.325-.012T14.8 21l-.6-1q-.1-.15-.05-.325t.175-.3l.825-.725q-.05-.35-.05-.65t.05-.65l-.825-.725q-.125-.125-.175-.3T14.2 16l.6-1q.1-.15.25-.212t.325-.013l1.075.325q.275-.2.538-.337t.562-.263l.225-1.1q.05-.175.163-.288T18.25 13h1.2q.2 0 .313.113t.162.287l.225 1.1q.3.125.563.275t.537.375l1.05-.375q.175-.05.338.013T22.9 15l.6 1.05q.1.15.063.325t-.163.3l-.85.725q.05.3.05.625t-.05.625l.825.725q.125.125.175.3T23.5 20l-.6 1q-.1.15-.25.213t-.325.012L21.25 20.9q-.275.2-.537.338t-.563.262l-.225 1.1q-.05.175-.162.288T19.45 23h-1.2q-.2 0-.312-.112t-.163-.288M18.85 20q.825 0 1.413-.587T20.85 18t-.587-1.412T18.85 16t-1.412.588T16.85 18t.588 1.413T18.85 20"/></svg>
                `,
            queue: `
                <svg class="osd-icon icon-outline" width="32" height="32" viewBox="1.5 1.5 21 21"><!-- Icon from Material Symbols Rounded --><path fill="currentColor" d="M4.616 21q-.691 0-1.153-.462T3 19.385v-8.77q0-.69.463-1.152T4.615 9h14.77q.69 0 1.152.463T21 10.616v8.769q0 .69-.463 1.153T19.385 21zm6.505-3.352l3.485-2.32q.186-.13.186-.328t-.186-.329l-3.485-2.319q-.212-.136-.416-.028q-.205.109-.205.351v4.65q0 .242.205.351t.416-.028M5 7.231q-.213 0-.357-.143T4.5 6.73t.143-.357T5 6.231h14q.214 0 .357.143t.143.357t-.143.357T19 7.23zm3-2.77q-.213 0-.357-.143T7.5 3.962t.143-.357T8 3.462h8q.214 0 .357.143t.143.357t-.143.356t-.357.144z"/></svg>
                <svg class="osd-icon icon-filled" width="32" height="32" viewBox="1.5 1.5 21 21"><!-- Icon from Material Symbols Rounded --><path fill="currentColor" d="M4.616 21q-.691 0-1.153-.462T3 19.385v-8.77q0-.69.463-1.152T4.615 9h14.77q.69 0 1.152.463T21 10.616v8.769q0 .69-.463 1.153T19.385 21zm6.505-3.352l3.485-2.32q.186-.13.186-.328t-.186-.329l-3.485-2.319q-.212-.136-.416-.028q-.205.109-.205.351v4.65q0 .242.205.351t.416-.028M5 7.231q-.213 0-.357-.143T4.5 6.73t.143-.357T5 6.231h14q.214 0 .357.143t.143.357t-.143.357T19 7.23zm3-2.77q-.213 0-.357-.143T7.5 3.962t.143-.357T8 3.462h8q.214 0 .357.143t.143.357t-.143.356t-.357.144z"/></svg>
                `,
            viewList: `
                <svg class="osd-icon icon-outline" width="32" height="32" viewBox="1.55 1.55 20.9 20.9"><!-- Icon from Material Symbols Rounded --><path fill="currentColor" d="M17.5 4.5c-1.95 0-4.05.4-5.5 1.5c-1.45-1.1-3.55-1.5-5.5-1.5c-1.45 0-2.99.22-4.28.79C1.49 5.62 1 6.33 1 7.14v11.28c0 1.3 1.22 2.26 2.48 1.94c.98-.25 2.02-.36 3.02-.36c1.56 0 3.22.26 4.56.92c.6.3 1.28.3 1.87 0c1.34-.67 3-.92 4.56-.92c1 0 2.04.11 3.02.36c1.26.33 2.48-.63 2.48-1.94V7.14c0-.81-.49-1.52-1.22-1.85c-1.28-.57-2.82-.79-4.27-.79M21 17.23c0 .63-.58 1.09-1.2.98c-.75-.14-1.53-.2-2.3-.2c-1.7 0-4.15.65-5.5 1.5V8c1.35-.85 3.8-1.5 5.5-1.5c.92 0 1.83.09 2.7.28c.46.1.8.51.8.98z" /><path fill="currentColor" d="M13.98 11.01c-.32 0-.61-.2-.71-.52c-.13-.39.09-.82.48-.94c1.54-.5 3.53-.66 5.36-.45c.41.05.71.42.66.83s-.42.71-.83.66c-1.62-.19-3.39-.04-4.73.39c-.08.01-.16.03-.23.03m0 2.66c-.32 0-.61-.2-.71-.52c-.13-.39.09-.82.48-.94c1.53-.5 3.53-.66 5.36-.45c.41.05.71.42.66.83s-.42.71-.83.66c-1.62-.19-3.39-.04-4.73.39a1 1 0 0 1-.23.03m0 2.66c-.32 0-.61-.2-.71-.52c-.13-.39.09-.82.48-.94c1.53-.5 3.53-.66 5.36-.45c.41.05.71.42.66.83s-.42.7-.83.66c-1.62-.19-3.39-.04-4.73.39a1 1 0 0 1-.23.03"/></svg>
                <svg class="osd-icon icon-filled" width="32" height="32" viewBox="1.55 1.55 20.9 20.9"><!-- Icon from Material Symbols Rounded --><path fill="currentColor" d="M17.5 4.5c-1.95 0-4.05.4-5.5 1.5c-1.45-1.1-3.55-1.5-5.5-1.5c-1.45 0-2.99.22-4.28.79C1.49 5.62 1 6.33 1 7.14v11.28c0 1.3 1.22 2.26 2.48 1.94c.98-.25 2.02-.36 3.02-.36c1.56 0 3.22.26 4.56.92c.6.3 1.28.3 1.87 0c1.34-.67 3-.92 4.56-.92c1 0 2.04.11 3.02.36c1.26.33 2.48-.63 2.48-1.94V7.14c0-.81-.49-1.52-1.22-1.85c-1.28-.57-2.82-.79-4.27-.79M21 17.23c0 .63-.58 1.09-1.2.98c-.75-.14-1.53-.2-2.3-.2c-1.7 0-4.15.65-5.5 1.5V8c1.35-.85 3.8-1.5 5.5-1.5c.92 0 1.83.09 2.7.28c.46.1.8.51.8.98z" /><path fill="currentColor" d="M13.98 11.01c-.32 0-.61-.2-.71-.52c-.13-.39.09-.82.48-.94c1.54-.5 3.53-.66 5.36-.45c.41.05.71.42.66.83s-.42.71-.83.66c-1.62-.19-3.39-.04-4.73.39c-.08.01-.16.03-.23.03m0 2.66c-.32 0-.61-.2-.71-.52c-.13-.39.09-.82.48-.94c1.53-.5 3.53-.66 5.36-.45c.41.05.71.42.66.83s-.42.71-.83.66c-1.62-.19-3.39-.04-4.73.39a1 1 0 0 1-.23.03m0 2.66c-.32 0-.61-.2-.71-.52c-.13-.39.09-.82.48-.94c1.53-.5 3.53-.66 5.36-.45c.41.05.71.42.66.83s-.42.7-.83.66c-1.62-.19-3.39-.04-4.73.39a1 1 0 0 1-.23.03"/></svg>
                `,
            lyrics: `
                <svg class="osd-icon icon-outline" width="32" height="32" viewBox="1.55 1.55 20.9 20.9"><!-- Icon from Material Symbols Rounded --><path fill="currentColor" d="M14 9c0-2.04 1.24-3.79 3-4.57V4c0-1.1-.9-2-2-2H4c-1.1 0-1.99.9-1.99 2L2 22l4-4h9c1.1 0 2-.9 2-2v-2.42c-1.76-.78-3-2.53-3-4.58m-4 5H6v-2h4zm3-3H6V9h7zm0-3H6V6h7z" /><path fill="currentColor" d="M20 6.18c-.31-.11-.65-.18-1-.18c-1.66 0-3 1.34-3 3s1.34 3 3 3s3-1.34 3-3V3h2V1h-4z"/></svg>
                <svg class="osd-icon icon-filled" width="32" height="32" viewBox="1.55 1.55 20.9 20.9"><!-- Icon from Material Symbols Rounded --><path fill="currentColor" d="M14 9c0-2.04 1.24-3.79 3-4.57V4c0-1.1-.9-2-2-2H4c-1.1 0-1.99.9-1.99 2L2 22l4-4h9c1.1 0 2-.9 2-2v-2.42c-1.76-.78-3-2.53-3-4.58m-4 5H6v-2h4zm3-3H6V9h7zm0-3H6V6h7z" /><path fill="currentColor" d="M20 6.18c-.31-.11-.65-.18-1-.18c-1.66 0-3 1.34-3 3s1.34 3 3 3s3-1.34 3-3V3h2V1h-4z"/></svg>
                `,
            group: `
                <svg class="osd-icon icon-outline" width="32" height="32" viewBox="1.55 1.55 20.9 20.9"><!-- Icon from Material Symbols Rounded --><path fill="currentColor" d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5s-3 1.34-3 3s1.34 3 3 3m-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5S5 6.34 5 8s1.34 3 3 3m0 2c-2.33 0-7 1.17-7 3.5V18c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-1.5c0-2.33-4.67-3.5-7-3.5m8 0c-.29 0-.62.02-.97.05c.02.01.03.03.04.04c1.14.83 1.93 1.94 1.93 3.41V18c0 .35-.07.69-.18 1H22c.55 0 1-.45 1-1v-1.5c0-2.33-4.67-3.5-7-3.5"/></svg>
                <svg class="osd-icon icon-filled" width="32" height="32" viewBox="1.55 1.55 20.9 20.9"><!-- Icon from Material Symbols Rounded --><path fill="currentColor" d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5s-3 1.34-3 3s1.34 3 3 3m-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5S5 6.34 5 8s1.34 3 3 3m0 2c-2.33 0-7 1.17-7 3.5V18c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-1.5c0-2.33-4.67-3.5-7-3.5m8 0c-.29 0-.62.02-.97.05c.02.01.03.03.04.04c1.14.83 1.93 1.94 1.93 3.41V18c0 .35-.07.69-.18 1H22c.55 0 1-.45 1-1v-1.5c0-2.33-4.67-3.5-7-3.5"/></svg>
                `,
            repeat: `
                <svg class="osd-icon icon-outline" width="32" height="32" viewBox="1.55 1.55 20.9 20.9"><!-- Icon from Material Symbols Rounded --><path fill="currentColor" d="M7 7h10v1.79c0 .45.54.67.85.35l2.79-2.79c.2-.2.2-.51 0-.71l-2.79-2.79a.5.5 0 0 0-.85.36V5H6c-.55 0-1 .45-1 1v4c0 .55.45 1 1 1s1-.45 1-1zm10 10H7v-1.79c0-.45-.54-.67-.85-.35l-2.79 2.79c-.2.2-.2.51 0 .71l2.79 2.79a.5.5 0 0 0 .85-.36V19h11c.55 0 1-.45 1-1v-4c0-.55-.45-1-1-1s-1 .45-1 1z"/></svg>
                <svg class="osd-icon icon-filled" width="32" height="32" viewBox="1.55 1.55 20.9 20.9"><!-- Icon from Material Symbols Rounded --><path fill="currentColor" d="M7 7h10v1.79c0 .45.54.67.85.35l2.79-2.79c.2-.2.2-.51 0-.71l-2.79-2.79a.5.5 0 0 0-.85.36V5H6c-.55 0-1 .45-1 1v4c0 .55.45 1 1 1s1-.45 1-1zm10 10H7v-1.79c0-.45-.54-.67-.85-.35l-2.79 2.79c-.2.2-.2.51 0 .71l2.79 2.79a.5.5 0 0 0 .85-.36V19h11c.55 0 1-.45 1-1v-4c0-.55-.45-1-1-1s-1 .45-1 1z"/></svg>
                `

        },
        sidebarIcons: {
            logo: `
                <svg viewBox="0 0 100 100" width="40" height="40" class="sidebar-logo-svg" preserveAspectRatio="xMidYMid meet">
                    <path class="logo-path-outer" d="M19.57,91c-2.24,0-4.73-0.44-6.87-2.02c-2.07-1.53-3.32-3.6-3.62-5.97c-0.51-4.01,1.81-7.59,3.24-9.37c4.82-5.97,9.41-12.5,10.36-19.76c0.8-6.13-1-12.33-2.9-18.9c-0.59-2.04-1.21-4.16-1.73-6.27
                    c-0.8-3.17-1.42-6.59-0.53-10.08c1.8-7.06,9.11-10.26,21.74-9.53c10.63,0.62,21.35,5.21,30.19,12.91
                    C82.12,33.08,93.56,53.11,90.5,72.93c-0.23,1.54-0.58,2.97-1.04,4.26c-1.28,3.66-3.47,6.32-6.34,7.68
                    c-3.63,1.71-7.38,1.01-10.39,0.44c-2.45-0.46-5.35-0.99-8.34-1.37c-6.72-0.86-12.12-0.79-17.02,0.21
                    c-3.5,0.71-6.9,1.8-10.49,2.95c-4.51,1.44-9.17,2.94-14.09,3.64C21.84,90.88,20.74,91,19.57,91z M35.69,16
                    c-5.23,0-10.52,0.9-11.4,4.36c-0.5,1.98-0.04,4.37,0.53,6.65c0.5,1.99,1.09,4.04,1.67,6.02c2.02,6.97,4.11,14.17,3.12,21.75
                    c-1.17,8.98-6.38,16.48-11.85,23.25c-1.19,1.47-1.87,3.08-1.75,4.08c0.04,0.31,0.17,0.73,0.85,1.23
                    c0.89,0.66,2.51,0.81,4.95,0.46c4.34-0.62,8.53-1.96,12.95-3.38c3.61-1.16,7.35-2.35,11.22-3.14c5.67-1.16,11.81-1.26,19.31-0.3
                    c3.17,0.41,6.2,0.95,8.74,1.43c2.32,0.44,4.52,0.85,6.1,0.11c1.15-0.54,2.07-1.78,2.72-3.66l0-0.01c0.31-0.87,0.55-1.88,0.72-3
                    c2.65-17.2-7.5-34.78-18.74-44.57c-7.68-6.69-16.92-10.67-26-11.2C37.81,16.04,36.75,16,35.69,16z" />
                    <path class="logo-path-inner" d="M69.3,63.51c0.19-0.64,0.32-1.3,0.41-1.95
                    c1.26-9.44-3.2-19.55-9.22-25.63c-3.64-3.67-8.19-6.14-13.02-6.47c-2.7-0.18-7.56-0.15-8.41,3.7c-0.32,1.47-0.07,3.03,0.25,4.49
                    c1.01,4.7,2.72,9.41,2.18,14.21C41,56.22,38.72,60,36.34,63.41c-1.14,1.63-1.9,4.02-0.12,5.54c0.97,0.83,2.3,0.8,3.49,0.6
                    c3.88-0.64,7.47-2.62,11.3-3.52c2.77-0.66,5.63-0.55,8.42-0.14c1.33,0.2,2.64,0.47,3.96,0.75c1.25,0.27,2.62,0.57,3.82-0.09
                    C68.26,65.98,68.91,64.81,69.3,63.51z" />
                </svg>
            `,
            syncplay: `
                <svg class="icon-outline" width="30" height="30" viewBox="1.55 1.55 20.9 20.9"><!-- Icon from Material 3 --><path fill="currentColor" d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5s-3 1.34-3 3s1.34 3 3 3m-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5S5 6.34 5 8s1.34 3 3 3m0 2c-2.33 0-7 1.17-7 3.5V18c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-1.5c0-2.33-4.67-3.5-7-3.5m8 0c-.29 0-.62.02-.97.05c.02.01.03.03.04.04c1.14.83 1.93 1.94 1.93 3.41V18c0 .35-.07.69-.18 1H22c.55 0 1-.45 1-1v-1.5c0-2.33-4.67-3.5-7-3.5"/></svg>
                <svg class="icon-filled" width="30" height="30" viewBox="1.55 1.55 20.9 20.9"><!-- Icon from Material 3 --><path fill="currentColor" d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5s-3 1.34-3 3s1.34 3 3 3m-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5S5 6.34 5 8s1.34 3 3 3m0 2c-2.33 0-7 1.17-7 3.5V18c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-1.5c0-2.33-4.67-3.5-7-3.5m8 0c-.29 0-.62.02-.97.05c.02.01.03.03.04.04c1.14.83 1.93 1.94 1.93 3.41V18c0 .35-.07.69-.18 1H22c.55 0 1-.45 1-1v-1.5c0-2.33-4.67-3.5-7-3.5"/></svg>    
            `,
            home: `
                <svg class="icon-outline" width="32" height="32" viewBox="1.55 1.55 20.9 20.9"><!-- Icon from Material 3 --><path fill="currentColor" d="M4 19v-9q0-.475.213-.9t.587-.7l6-4.5q.525-.4 1.2-.4t1.2.4l6 4.5q.375.275.588.7T20 10v9q0 .825-.588 1.413T18 21h-3q-.425 0-.712-.288T14 20v-5q0-.425-.288-.712T13 14h-2q-.425 0-.712.288T10 15v5q0 .425-.288.713T9 21H6q-.825 0-1.412-.587T4 19"/></svg>
                <svg class="icon-filled" width="32" height="32" viewBox="1.55 1.55 20.9 20.9"><!-- Icon from Material 3 --><path fill="currentColor" d="M4 19v-9q0-.475.213-.9t.587-.7l6-4.5q.525-.4 1.2-.4t1.2.4l6 4.5q.375.275.588.7T20 10v9q0 .825-.588 1.413T18 21h-3q-.425 0-.712-.288T14 20v-5q0-.425-.288-.712T13 14h-2q-.425 0-.712.288T10 15v5q0 .425-.288.713T9 21H6q-.825 0-1.412-.587T4 19"/></svg>
            `,
            livetv: `
                <svg class="icon-outline" width="32" height="32" viewBox="1.55 1.55 20.9 20.9"><!-- Icon from Material 3 --><path fill="currentColor" d="m11.05 14.5l4.15-2.65q.45-.3.45-.85t-.45-.85L11.05 7.5q-.5-.325-1.025-.05t-.525.875v5.35q0 .6.525.875t1.025-.05M4 19q-.825 0-1.412-.587T2 17V5q0-.825.588-1.412T4 3h16q.825 0 1.413.588T22 5v12q0 .825-.587 1.413T20 19h-4v1q0 .425-.288.713T15 21H9q-.425 0-.712-.288T8 20v-1z"/></svg>
                <svg class="icon-filled" width="32" height="32" viewBox="1.55 1.55 20.9 20.9"><!-- Icon from Material 3 --><path fill="currentColor" d="m11.05 14.5l4.15-2.65q.45-.3.45-.85t-.45-.85L11.05 7.5q-.5-.325-1.025-.05t-.525.875v5.35q0 .6.525.875t1.025-.05M4 19q-.825 0-1.412-.587T2 17V5q0-.825.588-1.412T4 3h16q.825 0 1.413.588T22 5v12q0 .825-.587 1.413T20 19h-4v1q0 .425-.288.713T15 21H9q-.425 0-.712-.288T8 20v-1z"/></svg>
            `,
            random: `
                <svg class="icon-outline" width="32" height="32" viewBox="0 0 24 24"><!-- Icon from Remix Icon --><path fill="currentColor" d="M5 5v14h14V5zM3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zm12.5 12a1.5 1.5 0 1 0 0-3a1.5 1.5 0 0 0 0 3M10 15.5a1.5 1.5 0 1 1-3 0a1.5 1.5 0 0 1 3 0M8.5 10a1.5 1.5 0 1 0 0-3a1.5 1.5 0 0 0 0 3M17 8.5a1.5 1.5 0 1 1-3 0a1.5 1.5 0 0 1 3 0m-5 5a1.5 1.5 0 1 0 0-3a1.5 1.5 0 0 0 0 3"/></svg>
                <svg class="icon-filled" width="32" height="32" viewBox="0 0 24 24"><!-- Icon from Remix Icon --><path fill="currentColor" d="M5 3a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2zm5 5.5a1.5 1.5 0 1 1-3 0a1.5 1.5 0 0 1 3 0M8.5 17a1.5 1.5 0 1 1 0-3a1.5 1.5 0 0 1 0 3m7 0a1.5 1.5 0 1 1 0-3a1.5 1.5 0 0 1 0 3m0-7a1.5 1.5 0 1 1 0-3a1.5 1.5 0 0 1 0 3m-2 2a1.5 1.5 0 1 1-3 0a1.5 1.5 0 0 1 3 0"/></svg>
            `,
            favorites: `
                <svg class="icon-outline" width="32" height="32" viewBox="1.55 1.55 20.9 20.9"><!-- Icon from Material 3 --><path fill="currentColor" d="M13.35 20.13c-.76.69-1.93.69-2.69-.01l-.11-.1C5.3 15.27 1.87 12.16 2 8.28c.06-1.7.93-3.33 2.34-4.29c2.64-1.8 5.9-.96 7.66 1.1c1.76-2.06 5.02-2.91 7.66-1.1c1.41.96 2.28 2.59 2.34 4.29c.14 3.88-3.3 6.99-8.55 11.76z"/></svg>        
                <svg class="icon-filled" width="32" height="32" viewBox="1.55 1.55 20.9 20.9"><!-- Icon from Material 3 --><path fill="currentColor" d="M13.35 20.13c-.76.69-1.93.69-2.69-.01l-.11-.1C5.3 15.27 1.87 12.16 2 8.28c.06-1.7.93-3.33 2.34-4.29c2.64-1.8 5.9-.96 7.66 1.1c1.76-2.06 5.02-2.91 7.66-1.1c1.41.96 2.28 2.59 2.34 4.29c.14 3.88-3.3 6.99-8.55 11.76z"/></svg>`,
            search: `
                <svg class="icon-outline" width="32" height="32" viewBox="1.55 1.55 20.9 20.9"><!-- Icon from Material 3 --><path fill="currentColor" d="M15.5 14h-.79l-.28-.27a6.5 6.5 0 0 0 1.48-5.34c-.47-2.78-2.79-5-5.59-5.34a6.505 6.505 0 0 0-7.27 7.27c.34 2.8 2.56 5.12 5.34 5.59a6.5 6.5 0 0 0 5.34-1.48l.27.28v.79l4.25 4.25c.41.41 1.08.41 1.49 0s.41-1.08 0-1.49zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5S14 7.01 14 9.5S11.99 14 9.5 14"/></svg>
                <svg class="icon-filled" width="32" height="32" viewBox="1.55 1.55 20.9 20.9"><!-- Icon from Material 3 --><path fill="currentColor" d="M15.5 14h-.79l-.28-.27a6.5 6.5 0 0 0 1.48-5.34c-.47-2.78-2.79-5-5.59-5.34a6.505 6.505 0 0 0-7.27 7.27c.34 2.8 2.56 5.12 5.34 5.59a6.5 6.5 0 0 0 5.34-1.48l.27.28v.79l4.25 4.25c.41.41 1.08.41 1.49 0s.41-1.08 0-1.49zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5S14 7.01 14 9.5S11.99 14 9.5 14"/></svg>    
            `,
            settings: `
                <svg class="icon-outline" width="32" height="32" viewBox="1.55 1.55 20.9 20.9"><!-- Icon from Material 3 --><path fill="currentColor" d="M19.5 12c0-.23-.01-.45-.03-.68l1.86-1.41c.4-.3.51-.86.26-1.3l-1.87-3.23a.987.987 0 0 0-1.25-.42l-2.15.91c-.37-.26-.76-.49-1.17-.68l-.29-2.31c-.06-.5-.49-.88-.99-.88h-3.73c-.51 0-.94.38-1 .88l-.29 2.31c-.41.19-.8.42-1.17.68l-2.15-.91c-.46-.2-1-.02-1.25.42L2.41 8.62c-.25.44-.14.99.26 1.3l1.86 1.41a7.3 7.3 0 0 0 0 1.35l-1.86 1.41c-.4.3-.51.86-.26 1.3l1.87 3.23c.25.44.79.62 1.25.42l2.15-.91c.37.26.76.49 1.17.68l.29 2.31c.06.5.49.88.99.88h3.73c.5 0 .93-.38.99-.88l.29-2.31c.41-.19.8-.42 1.17-.68l2.15.91c.46.2 1 .02 1.25-.42l1.87-3.23c.25-.44.14-.99-.26-1.3l-1.86-1.41c.03-.23.04-.45.04-.68m-7.46 3.5c-1.93 0-3.5-1.57-3.5-3.5s1.57-3.5 3.5-3.5s3.5 1.57 3.5 3.5s-1.57 3.5-3.5 3.5"/></svg>
                <svg class="icon-filled" width="32" height="32" viewBox="1.55 1.55 20.9 20.9"><!-- Icon from Material 3 --><path fill="currentColor" d="M19.5 12c0-.23-.01-.45-.03-.68l1.86-1.41c.4-.3.51-.86.26-1.3l-1.87-3.23a.987.987 0 0 0-1.25-.42l-2.15.91c-.37-.26-.76-.49-1.17-.68l-.29-2.31c-.06-.5-.49-.88-.99-.88h-3.73c-.51 0-.94.38-1 .88l-.29 2.31c-.41.19-.8.42-1.17.68l-2.15-.91c-.46-.2-1-.02-1.25.42L2.41 8.62c-.25.44-.14.99.26 1.3l1.86 1.41a7.3 7.3 0 0 0 0 1.35l-1.86 1.41c-.4.3-.51.86-.26 1.3l1.87 3.23c.25.44.79.62 1.25.42l2.15-.91c.37.26.76.49 1.17.68l.29 2.31c.06.5.49.88.99.88h3.73c.5 0 .93-.38.99-.88l.29-2.31c.41-.19.8-.42 1.17-.68l2.15.91c.46.2 1 .02 1.25-.42l1.87-3.23c.25-.44.14-.99-.26-1.3l-1.86-1.41c.03-.23.04-.45.04-.68m-7.46 3.5c-1.93 0-3.5-1.57-3.5-3.5s1.57-3.5 3.5-3.5s3.5 1.57 3.5 3.5s-1.57 3.5-3.5 3.5"/></svg>
            `,
            userDefault: `
                <svg class="icon-outline" width="32" height="32" viewBox="0 0 24 24"><!-- Icon from Remix Icon --><path fill="currentColor" d="M12 2c5.523 0 10 4.477 10 10s-4.477 10-10 10S2 17.523 2 12S6.477 2 12 2m.16 14a6.98 6.98 0 0 0-5.147 2.256A7.97 7.97 0 0 0 12 20a7.97 7.97 0 0 0 5.167-1.892A6.98 6.98 0 0 0 12.16 16M12 4a8 8 0 0 0-6.384 12.821A8.98 8.98 0 0 1 12.16 14a8.97 8.97 0 0 1 6.362 2.634A8 8 0 0 0 12 4m0 1a4 4 0 1 1 0 8a4 4 0 0 1 0-8m0 2a2 2 0 1 0 0 4a2 2 0 0 0 0-4"/></svg>
                <svg class="icon-filled" width="32" height="32" viewBox="0 0 24 24"><!-- Icon from Remix Icon --><path fill="currentColor" d="M12 2c5.52 0 10 4.48 10 10s-4.48 10-10 10S2 17.52 2 12S6.48 2 12 2M6.023 15.416C7.491 17.606 9.695 19 12.16 19s4.669-1.393 6.136-3.584A8.97 8.97 0 0 0 12.16 13a8.97 8.97 0 0 0-6.137 2.416M12 11a3 3 0 1 0 0-6a3 3 0 0 0 0 6"/></svg>
            `
        },
        libraryIcons: {
            movies: `
                <svg class="icon-outline" viewBox="1.25 1.25 21.5 21.5" width="32" height="32" fill="none"><path fill="currentColor" d="m4 4l1.625 3.25q.175.35.5.55t.7.2q.75 0 1.15-.638t.05-1.312L7 4h2l1.625 3.25q.175.35.5.55t.7.2q.75 0 1.15-.638t.05-1.312L12 4h2l1.625 3.25q.175.35.5.55t.7.2q.75 0 1.15-.638t.05-1.312L17 4h3q.825 0 1.413.587T22 6v12q0 .825-.587 1.413T20 20H4q-.825 0-1.412-.587T2 18V6q0-.825.588-1.412T4 4"/></svg>
                <svg class="icon-filled" viewBox="1.25 1.25 21.5 21.5" width="32" height="32" fill="none"><path fill="currentColor" d="m4 4l1.625 3.25q.175.35.5.55t.7.2q.75 0 1.15-.638t.05-1.312L7 4h2l1.625 3.25q.175.35.5.55t.7.2q.75 0 1.15-.638t.05-1.312L12 4h2l1.625 3.25q.175.35.5.55t.7.2q.75 0 1.15-.638t.05-1.312L17 4h3q.825 0 1.413.587T22 6v12q0 .825-.587 1.413T20 20H4q-.825 0-1.412-.587T2 18V6q0-.825.588-1.412T4 4"/></svg>
            `,
            tvshows: `
                <svg class="icon-outline" viewBox="1.25 1.25 21.5 21.5" width="32" height="32" fill="none"><path fill="currentColor" d="M4 19q-.825 0-1.412-.587T2 17V5q0-.825.588-1.412T4 3h16q.825 0 1.413.588T22 5v12q0 .825-.587 1.413T20 19h-4v1q0 .425-.288.713T15 21H9q-.425 0-.712-.288T8 20v-1z"/></svg>
                <svg class="icon-filled" viewBox="1.25 1.25 21.5 21.5" width="32" height="32" fill="none"><path fill="currentColor" d="M4 19q-.825 0-1.412-.587T2 17V5q0-.825.588-1.412T4 3h16q.825 0 1.413.588T22 5v12q0 .825-.587 1.413T20 19h-4v1q0 .425-.288.713T15 21H9q-.425 0-.712-.288T8 20v-1z"/></svg>
            `,
            music: `
                <svg class="icon-outline" viewBox="1.55 1.55 20.9 20.9" width="32" height="32" fill="none"><path fill="currentColor" d="M20 2H8c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2m-3 5h-2v5.37c0 1.27-.9 2.44-2.16 2.6a2.505 2.505 0 0 1-2.8-2.95c.2-1.1 1.18-1.95 2.3-2.02c.63-.04 1.2.16 1.66.51V6c0-.55.45-1 1-1h2c.55 0 1 .45 1 1s-.45 1-1 1M3 6c-.55 0-1 .45-1 1v13c0 1.1.9 2 2 2h13c.55 0 1-.45 1-1s-.45-1-1-1H5c-.55 0-1-.45-1-1V7c0-.55-.45-1-1-1"/></svg>
                <svg class="icon-filled" viewBox="1.55 1.55 20.9 20.9" width="32" height="32" fill="none"><path fill="currentColor" d="M20 2H8c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2m-3 5h-2v5.37c0 1.27-.9 2.44-2.16 2.6a2.505 2.505 0 0 1-2.8-2.95c.2-1.1 1.18-1.95 2.3-2.02c.63-.04 1.2.16 1.66.51V6c0-.55.45-1 1-1h2c.55 0 1 .45 1 1s-.45 1-1 1M3 6c-.55 0-1 .45-1 1v13c0 1.1.9 2 2 2h13c.55 0 1-.45 1-1s-.45-1-1-1H5c-.55 0-1-.45-1-1V7c0-.55-.45-1-1-1"/></svg>
            `,
            photos: `
                <svg class="icon-outline" viewBox="1.55 1.55 20.9 20.9" width="32" height="32" fill="none"><path fill="currentColor" d="M21 3H3C2 3 1 4 1 5v14c0 1.1.9 2 2 2h18c1 0 2-1 2-2V5c0-1-1-2-2-2M5.63 16.19l2.49-3.2a.5.5 0 0 1 .78-.01l2.1 2.53l3.1-3.99c.2-.26.6-.26.8.01l3.51 4.68a.5.5 0 0 1-.4.8H6.02c-.41-.01-.65-.49-.39-.82"/></svg>
                <svg class="icon-filled" viewBox="1.55 1.55 20.9 20.9" width="32" height="32" fill="none"><path fill="currentColor" d="M21 3H3C2 3 1 4 1 5v14c0 1.1.9 2 2 2h18c1 0 2-1 2-2V5c0-1-1-2-2-2M5.63 16.19l2.49-3.2a.5.5 0 0 1 .78-.01l2.1 2.53l3.1-3.99c.2-.26.6-.26.8.01l3.51 4.68a.5.5 0 0 1-.4.8H6.02c-.41-.01-.65-.49-.39-.82"/></svg>
            `,
            books: `
                <svg class="icon-outline" viewBox="1.55 1.55 20.9 20.9" width="32" height="32" fill="none"><path fill="currentColor" d="M11 14h2q.425 0 .713-.288T14 13t-.288-.712T13 12h-2q-.425 0-.712.288T10 13t.288.713T11 14m0-3h6q.425 0 .713-.288T18 10t-.288-.712T17 9h-6q-.425 0-.712.288T10 10t.288.713T11 11m0-3h6q.425 0 .713-.288T18 7t-.288-.712T17 6h-6q-.425 0-.712.288T10 7t.288.713T11 8M8 18q-.825 0-1.412-.587T6 16V4q0-.825.588-1.412T8 2h12q.825 0 1.413.588T22 4v12q0 .825-.587 1.413T20 18zm-4 4q-.825 0-1.412-.587T2 20V7q0-.425.288-.712T3 6t.713.288T4 7v13h13q.425 0 .713.288T18 21t-.288.713T17 22z"/></svg>
                <svg class="icon-filled" viewBox="1.55 1.55 20.9 20.9" width="32" height="32" fill="none"><path fill="currentColor" d="M11 14h2q.425 0 .713-.288T14 13t-.288-.712T13 12h-2q-.425 0-.712.288T10 13t.288.713T11 14m0-3h6q.425 0 .713-.288T18 10t-.288-.712T17 9h-6q-.425 0-.712.288T10 10t.288.713T11 11m0-3h6q.425 0 .713-.288T18 7t-.288-.712T17 6h-6q-.425 0-.712.288T10 7t.288.713T11 8M8 18q-.825 0-1.412-.587T6 16V4q0-.825.588-1.412T8 2h12q.825 0 1.413.588T22 4v12q0 .825-.587 1.413T20 18zm-4 4q-.825 0-1.412-.587T2 20V7q0-.425.288-.712T3 6t.713.288T4 7v13h13q.425 0 .713.288T18 21t-.288.713T17 22z"/></svg>
            `,
            homevideos: `
                <svg class="icon-outline" viewBox="1.55 1.55 20.9 20.9" width="32" height="32" fill="none"><path fill="currentColor" d="M17.525 10.625q.35-.225.35-.625t-.35-.625L12.65 6.25q-.375-.25-.763-.038t-.387.663v6.25q0 .45.388.663t.762-.038zM8 18q-.825 0-1.412-.587T6 16V4q0-.825.588-1.412T8 2h12q.825 0 1.413.588T22 4v12q0 .825-.587 1.413T20 18zm-4 4q-.825 0-1.412-.587T2 20V7q0-.425.288-.712T3 6t.713.288T4 7v13h13q.425 0 .713.288T18 21t-.288.713T17 22z"/></svg>
                <svg class="icon-filled" viewBox="1.55 1.55 20.9 20.9" width="32" height="32" fill="none"><path fill="currentColor" d="M17.525 10.625q.35-.225.35-.625t-.35-.625L12.65 6.25q-.375-.25-.763-.038t-.387.663v6.25q0 .45.388.663t.762-.038zM8 18q-.825 0-1.412-.587T6 16V4q0-.825.588-1.412T8 2h12q.825 0 1.413.588T22 4v12q0 .825-.587 1.413T20 18zm-4 4q-.825 0-1.412-.587T2 20V7q0-.425.288-.712T3 6t.713.288T4 7v13h13q.425 0 .713.288T18 21t-.288.713T17 22z"/></svg>
            `,
            boxsets: `
                <svg class="icon-outline" viewBox="0 0 24 24" width="32" height="32" fill="none"><path fill="currentColor" d="M4 3a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1v-4.703L16 20a1 1 0 0 0 1.186.77l3.912-.832a1 1 0 0 0 .77-1.186l-2.91-13.694a1 1 0 0 0-1.186-.77l-2.78.59A1 1 0 0 0 14 4h-4a1 1 0 0 0-1-1zm6 3h3v8h-3zm0 13v-3h3v3zM8 5v10H5V5zm0 12v2H5v-2zm9.332-.35l1.956-.416l.416 1.956l-1.956.416zm-.416-1.957l-1.663-7.825l1.956-.416l1.664 7.826z"/></svg>
                <svg class="icon-filled" viewBox="0 0 24 24" width="32" height="32" fill="none"><path fill="currentColor" d="M4 3a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1v-9.303l2.021 9.51a1 1 0 0 0 1.186.77l2.935-.623a1 1 0 0 0 .77-1.186l-2.91-13.694a1 1 0 0 0-1.187-.77L15 5.302V5a1 1 0 0 0-1-1H9a1 1 0 0 0-1-1zm5 3h4v8H9zm4 10v3H9v-3zm-6 1v2H5v-2zm11.77 1.814l-.416-1.956l.978-.208l.416 1.956z"/></svg>
            `,
            playlists: `
                <svg class="icon-outline" viewBox="1.55 1.55 20.9 20.9" width="32" height="32" fill="none"><path d="M21 3H3c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h18c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2m-10 8H4c-.55 0-1-.45-1-1s.45-1 1-1h7c.55 0 1 .45 1 1s-.45 1-1 1m0-4H4c-.55 0-1-.45-1-1s.45-1 1-1h7c.55 0 1 .45 1 1s-.45 1-1 1" fill="currentColor"/></svg>
                <svg class="icon-filled" viewBox="1.55 1.55 20.9 20.9" width="32" height="32" fill="none"><path d="M21 3H3c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h18c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2m-10 8H4c-.55 0-1-.45-1-1s.45-1 1-1h7c.55 0 1 .45 1 1s-.45 1-1 1m0-4H4c-.55 0-1-.45-1-1s.45-1 1-1h7c.55 0 1 .45 1 1s-.45 1-1 1" fill="currentColor"/></svg>
            `,
            livetv: `
                <svg class="icon-outline" viewBox="1.25 1.25 21.5 21.5" width="32" height="32" fill="none"><path fill="currentColor" d="m11.05 14.5l4.15-2.65q.45-.3.45-.85t-.45-.85L11.05 7.5q-.5-.325-1.025-.05t-.525.875v5.35q0 .6.525.875t1.025-.05M4 19q-.825 0-1.412-.587T2 17V5q0-.825.588-1.412T4 3h16q.825 0 1.413.588T22 5v12q0 .825-.587 1.413T20 19h-4v1q0 .425-.288.713T15 21H9q-.425 0-.712-.288T8 20v-1z"/></svg>
                <svg class="icon-filled" viewBox="1.25 1.25 21.5 21.5" width="32" height="32" fill="none"><path fill="currentColor" d="m11.05 14.5l4.15-2.65q.45-.3.45-.85t-.45-.85L11.05 7.5q-.5-.325-1.025-.05t-.525.875v5.35q0 .6.525.875t1.025-.05M4 19q-.825 0-1.412-.587T2 17V5q0-.825.588-1.412T4 3h16q.825 0 1.413.588T22 5v12q0 .825-.587 1.413T20 19h-4v1q0 .425-.288.713T15 21H9q-.425 0-.712-.288T8 20v-1z"/></svg>
            `,
            folders: `
                <svg class="icon-outline" viewBox="1.55 1.55 20.9 20.9" width="32" height="32" fill="none"><path fill="currentColor" d="M10.59 4.59C10.21 4.21 9.7 4 9.17 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8z"/></svg>
                <svg class="icon-filled" viewBox="1.55 1.55 20.9 20.9" width="32" height="32" fill="none"><path fill="currentColor" d="M10.59 4.59C10.21 4.21 9.7 4 9.17 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8z"/></svg>
            `,
            default: `
                <svg class="icon-outline" viewBox="0 0 24 24" width="32" height="32" fill="none"><path fill="currentColor" d="M3.087 9h17.826a1 1 0 0 1 .997 1.083l-.833 10a1 1 0 0 1-.997.917H3.92a1 1 0 0 1-.996-.917l-.834-10A1 1 0 0 1 3.087 9M4.84 19h14.32l.667-8H4.174zm8.574-14H20a1 1 0 0 1 1 1v1H3V4a1 1 0 0 1 1-1h7.414z"/></svg>
                <svg class="icon-filled" viewBox="0 0 24 24" width="32" height="32" fill="none"><path fill="currentColor" d="M13.414 5H20a1 1 0 0 1 1 1v1H3V4a1 1 0 0 1 1-1h7.414zM3.087 9h17.826a1 1 0 0 1 .997 1.083l-.833 10a1 1 0 0 1-.997.917H3.92a1 1 0 0 1-.996-.917l-.834-10A1 1 0 0 1 3.087 9"/></svg>
            `
        },
        settingsIcons: {
            appearance: `
                <svg class="icon-outline" width="32" height="32" viewBox="1.25 1.25 21.5 21.5"><!-- Icon from Material 3 --><path fill="currentColor" d="M4 19q-.825 0-1.412-.587T2 17V5q0-.825.588-1.412T4 3h16q.825 0 1.413.588T22 5v12q0 .825-.587 1.413T20 19h-4v1q0 .425-.288.713T15 21H9q-.425 0-.712-.288T8 20v-1z"/></svg>
                <svg class="icon-filled" width="32" height="32" viewBox="1.25 1.25 21.5 21.5"><!-- Icon from Material 3 --><path fill="currentColor" d="M4 19q-.825 0-1.412-.587T2 17V5q0-.825.588-1.412T4 3h16q.825 0 1.413.588T22 5v12q0 .825-.587 1.413T20 19h-4v1q0 .425-.288.713T15 21H9q-.425 0-.712-.288T8 20v-1z"/></svg>
            `,
            layout: `
                <svg class="icon-outline" width="32" height="32" viewBox="1 1 22 22"><!-- Icon from Material 3 --><path fill="currentColor" d="M3 21q-.825 0-1.412-.587T1 19v-2q0-.825.588-1.412T3 15h6q.825 0 1.413.588T11 17v2q0 .825-.587 1.413T9 21zm12 0q-.825 0-1.412-.587T13 19V5q0-.825.588-1.412T15 3h6q.825 0 1.413.588T23 5v14q0 .825-.587 1.413T21 21zm3-3q.425 0 .713-.288T19 17t-.288-.712T18 16t-.712.288T17 17t.288.713T18 18M3 13q-.825 0-1.412-.587T1 11V5q0-.825.588-1.412T3 3h6q.825 0 1.413.588T11 5v6q0 .825-.587 1.413T9 13zm4-5q.425 0 .713-.288T8 7t-.288-.712T7 6t-.712.288T6 7t.288.713T7 8m-3.25 3h2.5q.3 0 .45-.275t-.05-.525L5.4 8.525q-.15-.2-.4-.2t-.4.2L3.35 10.2q-.2.25-.05.525t.45.275"/></svg>
                <svg class="icon-filled" width="32" height="32" viewBox="1 1 22 22"><!-- Icon from Material 3 --><path fill="currentColor" d="M3 21q-.825 0-1.412-.587T1 19v-2q0-.825.588-1.412T3 15h6q.825 0 1.413.588T11 17v2q0 .825-.587 1.413T9 21zm12 0q-.825 0-1.412-.587T13 19V5q0-.825.588-1.412T15 3h6q.825 0 1.413.588T23 5v14q0 .825-.587 1.413T21 21zm3-3q.425 0 .713-.288T19 17t-.288-.712T18 16t-.712.288T17 17t.288.713T18 18M3 13q-.825 0-1.412-.587T1 11V5q0-.825.588-1.412T3 3h6q.825 0 1.413.588T11 5v6q0 .825-.587 1.413T9 13zm4-5q.425 0 .713-.288T8 7t-.288-.712T7 6t-.712.288T6 7t.288.713T7 8m-3.25 3h2.5q.3 0 .45-.275t-.05-.525L5.4 8.525q-.15-.2-.4-.2t-.4.2L3.35 10.2q-.2.25-.05.525t.45.275"/></svg>
            `,
            sidebar: `
                <svg class="icon-outline" width="32" height="32" viewBox="1.55 1.55 20.9 20.9"><!-- Icon from Material 3 --><path fill="currentColor" d="M15 20H3c-.55 0-1-.45-1-1V5c0-.55.45-1 1-1h12c.55 0 1 .45 1 1v14c0 .55-.45 1-1 1m4-12h2c.55 0 1-.45 1-1V5c0-.55-.45-1-1-1h-2c-.55 0-1 .45-1 1v2c0 .55.45 1 1 1m0 12h2c.55 0 1-.45 1-1v-2c0-.55-.45-1-1-1h-2c-.55 0-1 .45-1 1v2c0 .55.45 1 1 1m0-6h2c.55 0 1-.45 1-1v-2c0-.55-.45-1-1-1h-2c-.55 0-1 .45-1 1v2c0 .55.45 1 1 1"/></svg>
                <svg class="icon-filled" width="32" height="32" viewBox="1.55 1.55 20.9 20.9"><!-- Icon from Material 3 --><path fill="currentColor" d="M15 20H3c-.55 0-1-.45-1-1V5c0-.55.45-1 1-1h12c.55 0 1 .45 1 1v14c0 .55-.45 1-1 1m4-12h2c.55 0 1-.45 1-1V5c0-.55-.45-1-1-1h-2c-.55 0-1 .45-1 1v2c0 .55.45 1 1 1m0 12h2c.55 0 1-.45 1-1v-2c0-.55-.45-1-1-1h-2c-.55 0-1 .45-1 1v2c0 .55.45 1 1 1m0-6h2c.55 0 1-.45 1-1v-2c0-.55-.45-1-1-1h-2c-.55 0-1 .45-1 1v2c0 .55.45 1 1 1"/></svg>
            `,
            controls: `
                <svg class="icon-outline" width="32" height="32" viewBox="1.75 1.75 20.5 20.5""><!-- Icon from Material 3 --><path fill="currentColor" d="M3 18c0 .55.45 1 1 1h5v-2H4c-.55 0-1 .45-1 1M3 6c0 .55.45 1 1 1h9V5H4c-.55 0-1 .45-1 1m10 14v-1h7c.55 0 1-.45 1-1s-.45-1-1-1h-7v-1c0-.55-.45-1-1-1s-1 .45-1 1v4c0 .55.45 1 1 1s1-.45 1-1M7 10v1H4c-.55 0-1 .45-1 1s.45 1 1 1h3v1c0 .55.45 1 1 1s1-.45 1-1v-4c0-.55-.45-1-1-1s-1 .45-1 1m14 2c0-.55-.45-1-1-1h-9v2h9c.55 0 1-.45 1-1m-5-3c.55 0 1-.45 1-1V7h3c.55 0 1-.45 1-1s-.45-1-1-1h-3V4c0-.55-.45-1-1-1s-1 .45-1 1v4c0 .55.45 1 1 1"/></svg>
                <svg class="icon-filled" width="32" height="32" viewBox="1.75 1.75 20.5 20.5"><!-- Icon from Material 3 --><path fill="currentColor" d="M3 18c0 .55.45 1 1 1h5v-2H4c-.55 0-1 .45-1 1M3 6c0 .55.45 1 1 1h9V5H4c-.55 0-1 .45-1 1m10 14v-1h7c.55 0 1-.45 1-1s-.45-1-1-1h-7v-1c0-.55-.45-1-1-1s-1 .45-1 1v4c0 .55.45 1 1 1s1-.45 1-1M7 10v1H4c-.55 0-1 .45-1 1s.45 1 1 1h3v1c0 .55.45 1 1 1s1-.45 1-1v-4c0-.55-.45-1-1-1s-1 .45-1 1m14 2c0-.55-.45-1-1-1h-9v2h9c.55 0 1-.45 1-1m-5-3c.55 0 1-.45 1-1V7h3c.55 0 1-.45 1-1s-.45-1-1-1h-3V4c0-.55-.45-1-1-1s-1 .45-1 1v4c0 .55.45 1 1 1"/></svg>
            `,
            player: `
                <svg class="icon-outline" width="32" height="32" viewBox="1.55 1.55 20.9 20.9"><!-- Icon from Material 3 --><path fill="currentColor" d="M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2M9.5 14.67V9.33c0-.79.88-1.27 1.54-.84l4.15 2.67a1 1 0 0 1 0 1.68l-4.15 2.67c-.66.43-1.54-.05-1.54-.84"/></svg>
                <svg class="icon-filled" width="32" height="32" viewBox="1.55 1.55 20.9 20.9"><!-- Icon from Material 3 --><path fill="currentColor" d="M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2M9.5 14.67V9.33c0-.79.88-1.27 1.54-.84l4.15 2.67a1 1 0 0 1 0 1.68l-4.15 2.67c-.66.43-1.54-.05-1.54-.84"/></svg>
            `,
            subtitles: `
                <svg class="icon-outline" width="32" height="32" viewBox="1.55 1.55 20.9 20.9"><!-- Icon from Material Symbols --><path fill="currentColor" d="M4 20q-.825 0-1.412-.587T2 18V6q0-.825.588-1.412T4 4h16q.825 0 1.413.588T22 6v12q0 .825-.587 1.413T20 20zm3-4h6q.425 0 .713-.288T14 15t-.288-.712T13 14H7q-.425 0-.712.288T6 15t.288.713T7 16m4-4h6q.425 0 .713-.288T18 11t-.288-.712T17 10h-6q-.425 0-.712.288T10 11t.288.713T11 12m-4 0q.425 0 .713-.288T8 11t-.288-.712T7 10t-.712.288T6 11t.288.713T7 12m10 4q.425 0 .713-.288T18 15t-.288-.712T17 14t-.712.288T16 15t.288.713T17 16"/></svg>
                <svg class="icon-filled" width="32" height="32" viewBox="1.55 1.55 20.9 20.9"><!-- Icon from Material Symbols --><path fill="currentColor" d="M4 20q-.825 0-1.412-.587T2 18V6q0-.825.588-1.412T4 4h16q.825 0 1.413.588T22 6v12q0 .825-.587 1.413T20 20zm3-4h6q.425 0 .713-.288T14 15t-.288-.712T13 14H7q-.425 0-.712.288T6 15t.288.713T7 16m4-4h6q.425 0 .713-.288T18 11t-.288-.712T17 10h-6q-.425 0-.712.288T10 11t.288.713T11 12m-4 0q.425 0 .713-.288T8 11t-.288-.712T7 10t-.712.288T6 11t.288.713T7 12m10 4q.425 0 .713-.288T18 15t-.288-.712T17 14t-.712.288T16 15t.288.713T17 16"/></svg>
            `,
            plugins: `
                <svg class="icon-outline" width="32" height="32" viewBox="1.55 1.55 20.9 20.9"><!-- Icon from Material 3 --><path fill="currentColor" d="M20.5 11H19V7c0-1.1-.9-2-2-2h-4V3.5a2.5 2.5 0 0 0-5 0V5H4c-1.1 0-1.99.9-1.99 2v3.8H3.5c1.49 0 2.7 1.21 2.7 2.7s-1.21 2.7-2.7 2.7H2V20c0 1.1.9 2 2 2h3.8v-1.5c0-1.49 1.21-2.7 2.7-2.7s2.7 1.21 2.7 2.7V22H17c1.1 0 2-.9 2-2v-4h1.5a2.5 2.5 0 0 0 0-5"/></svg>
                <svg class="icon-filled" width="32" height="32" viewBox="1.55 1.55 20.9 20.9"><!-- Icon from Material 3 --><path fill="currentColor" d="M20.5 11H19V7c0-1.1-.9-2-2-2h-4V3.5a2.5 2.5 0 0 0-5 0V5H4c-1.1 0-1.99.9-1.99 2v3.8H3.5c1.49 0 2.7 1.21 2.7 2.7s-1.21 2.7-2.7 2.7H2V20c0 1.1.9 2 2 2h3.8v-1.5c0-1.49 1.21-2.7 2.7-2.7s2.7 1.21 2.7 2.7V22H17c1.1 0 2-.9 2-2v-4h1.5a2.5 2.5 0 0 0 0-5"/></svg>
            `,
            account: `
                <svg class="icon-outline" width="32" height="32" viewBox="2 2 20 20"><!-- Icon from Material 3 --><path fill="currentColor" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10s10-4.48 10-10S17.52 2 12 2m0 4c1.93 0 3.5 1.57 3.5 3.5S13.93 13 12 13s-3.5-1.57-3.5-3.5S10.07 6 12 6m0 14c-2.03 0-4.43-.82-6.14-2.88a9.95 9.95 0 0 1 12.28 0C16.43 19.18 14.03 20 12 20"/></svg>
                <svg class="icon-filled" width="32" height="32" viewBox="2 2 20 20"><!-- Icon from Material 3 --><path fill="currentColor" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10s10-4.48 10-10S17.52 2 12 2m0 4c1.93 0 3.5 1.57 3.5 3.5S13.93 13 12 13s-3.5-1.57-3.5-3.5S10.07 6 12 6m0 14c-2.03 0-4.43-.82-6.14-2.88a9.95 9.95 0 0 1 12.28 0C16.43 19.18 14.03 20 12 20"/></svg>
            `,
            about: `
                <svg class="icon-outline" width="32" height="32" viewBox="2 2 20 20"><!-- Icon from Material 3 --><path fill="currentColor" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10s10-4.48 10-10S17.52 2 12 2m0 15c-.55 0-1-.45-1-1v-4c0-.55.45-1 1-1s1 .45 1 1v4c0 .55-.45 1-1 1m1-8h-2V7h2z"/></svg>
                <svg class="icon-filled" width="32" height="32" viewBox="2 2 20 20"><!-- Icon from Material 3 --><path fill="currentColor" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10s10-4.48 10-10S17.52 2 12 2m0 15c-.55 0-1-.45-1-1v-4c0-.55.45-1 1-1s1 .45 1 1v4c0 .55-.45 1-1 1m1-8h-2V7h2z"/></svg>
            `,
            debug: `
                <svg class="icon-outline" width="32" height="32" viewBox="2 2 20 20"><!-- Icon from Material 3 --><path fill="currentColor" d="M21 14c0-.55-.45-1-1-1h-2.07c-.05-.39-.12-.77-.22-1.14l1.72-.99c.48-.28.64-.89.37-1.37a1.01 1.01 0 0 0-1.37-.37l-1.51.87c-.28-.48-.62-.91-.99-1.29c.04-.23.07-.46.07-.71c0-.8-.24-1.55-.65-2.18l.94-.94a.996.996 0 1 0-1.41-1.41l-1.02 1.02c-1.68-.89-3.1-.33-3.73 0L9.12 3.46a.996.996 0 1 0-1.41 1.41l.94.94C8.24 6.45 8 7.2 8 8c0 .25.03.48.07.72c-.37.38-.71.81-.99 1.28l-1.51-.87a.996.996 0 0 0-1.36.37c-.28.48-.11 1.09.37 1.37l1.72.99c-.1.37-.17.75-.22 1.14H4c-.55 0-1 .45-1 1s.45 1 1 1h2.07c.05.39.12.77.22 1.14l-1.72.99c-.48.28-.64.89-.37 1.37c.28.48.89.64 1.37.37L7.08 18c1.08 1.81 2.88 3 4.92 3s3.84-1.19 4.92-3l1.51.87c.48.28 1.09.11 1.37-.37s.11-1.09-.37-1.37l-1.72-.99c.1-.37.17-.75.22-1.14H20c.55 0 1-.45 1-1m-9 3c-.55 0-1-.45-1-1v-4c0-.55.45-1 1-1s1 .45 1 1v4c0 .55-.45 1-1 1"/></svg>
                <svg class="icon-filled" width="32" height="32" viewBox="2 2 20 20"><!-- Icon from Material 3 --><path fill="currentColor" d="M21 14c0-.55-.45-1-1-1h-2.07c-.05-.39-.12-.77-.22-1.14l1.72-.99c.48-.28.64-.89.37-1.37a1.01 1.01 0 0 0-1.37-.37l-1.51.87c-.28-.48-.62-.91-.99-1.29c.04-.23.07-.46.07-.71c0-.8-.24-1.55-.65-2.18l.94-.94a.996.996 0 1 0-1.41-1.41l-1.02 1.02c-1.68-.89-3.1-.33-3.73 0L9.12 3.46a.996.996 0 1 0-1.41 1.41l.94.94C8.24 6.45 8 7.2 8 8c0 .25.03.48.07.72c-.37.38-.71.81-.99 1.28l-1.51-.87a.996.996 0 0 0-1.36.37c-.28.48-.11 1.09.37 1.37l1.72.99c-.1.37-.17.75-.22 1.14H4c-.55 0-1 .45-1 1s.45 1 1 1h2.07c.05.39.12.77.22 1.14l-1.72.99c-.48.28-.64.89-.37 1.37c.28.48.89.64 1.37.37L7.08 18c1.08 1.81 2.88 3 4.92 3s3.84-1.19 4.92-3l1.51.87c.48.28 1.09.11 1.37-.37s.11-1.09-.37-1.37l-1.72-.99c.1-.37.17-.75.22-1.14H20c.55 0 1-.45 1-1m-9 3c-.55 0-1-.45-1-1v-4c0-.55.45-1 1-1s1 .45 1 1v4c0 .55-.45 1-1 1"/></svg>
            `
        },
    }

};

/**
 * ============================================================================
 * Icon Switcher Helper Functions
 * ============================================================================
 * Facilitates settings management and event notifications when the visual style changes.
 * ============================================================================
 */

/**
 * Update the active icon style theme.
 * @param {string} styleName - The identifier of the chosen style theme (e.g. 'default')
 */
export function setIconStyle(styleName) {
    if (iconStyles[styleName]) {
        currentIconStyle = styleName;
        storage.setItem('pref:iconStyle', styleName);
        eventBus.emit('prefChanged:iconStyle', styleName);
    }
}

/**
 * Retrieve the active icon style theme.
 * @returns {string} The active style theme name
 */
export function getIconStyle() {
    return currentIconStyle;
}

/**
 * ============================================================================
 * Proxy Factories for Dynamic Resolution
 * ============================================================================
 * Redirects category object properties dynamically to the active style's items.
 * Allows components to use standard imports without manual reload listeners.
 * ============================================================================
 */
function createIconProxy(category) {
    return new Proxy({}, {
        get(target, prop) {
            const activeStyle = getActiveStyle();
            const styleSet = iconStyles[activeStyle] || iconStyles['default'];
            const categorySet = styleSet[category] || iconStyles['default'][category];
            return categorySet[prop];
        },
        ownKeys(target) {
            const activeStyle = getActiveStyle();
            const styleSet = iconStyles[activeStyle] || iconStyles['default'];
            const categorySet = styleSet[category] || iconStyles['default'][category];
            return Reflect.ownKeys(categorySet);
        },
        getOwnPropertyDescriptor(target, prop) {
            const activeStyle = getActiveStyle();
            const styleSet = iconStyles[activeStyle] || iconStyles['default'];
            const categorySet = styleSet[category] || iconStyles['default'][category];
            return Reflect.getOwnPropertyDescriptor(categorySet, prop);
        }
    });
}

// Export dynamic proxies mirroring the original plain objects structure
export const sidebarIcons = createIconProxy('sidebarIcons');
export const settingsIcons = createIconProxy('settingsIcons');
export const detailsIcons = createIconProxy('detailsIcons');
export const osdIcons = createIconProxy('osdIcons');

/**
 * Dynamically resolves and builds the library icon markup based on collection type.
 * Respects the active style theme of the application.
 * @param {string} type - The CollectionType string (e.g. 'movies', 'tvshows', 'music')
 * @returns {string} Complete HTML string representing the library icon SVG elements
 */
export function getLibraryIcon(type) {
    // Normalize string casing to ensure match
    const colType = (type || '').toLowerCase();
    
    // Resolve alias matches to simplify dictionary keys
    let resolvedType = colType;
    if (colType === 'photo') resolvedType = 'photos';
    if (colType === 'book') resolvedType = 'books';
    if (colType === 'homevideo') resolvedType = 'homevideos';
    if (colType === 'folder') resolvedType = 'folders';

    const activeStyle = getActiveStyle();
    const styleSet = iconStyles[activeStyle] || iconStyles['default'];
    const libraryIcons = styleSet.libraryIcons || iconStyles['default'].libraryIcons;
    
    // Fetch and return the full SVG string directly
    return libraryIcons[resolvedType] || libraryIcons['folders'] || libraryIcons['default'];
}