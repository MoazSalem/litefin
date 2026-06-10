/**
 * ============================================================================
 * Litefin Tizen - Shared Icons Utility
 * ============================================================================
 * Centralized SVG definitions and mappings for the entire application.
 * Allows easy modification and customization of icons from a single source.
 * ============================================================================
 */

export const sidebarIcons = {
    logo: `
        <svg viewBox="0 0 100 100" width="40" height="40" class="sidebar-logo-svg" preserveAspectRatio="xMidYMid meet">
            <path class="logo-path-outer" d="M19.57,91c-2.24,0-4.73-0.44-6.87-2.02c-2.07-1.53-3.32-3.6-3.62-5.97
c-0.51-4.01,1.81-7.59,3.24-9.37c4.82-5.97,9.41-12.5,10.36-19.76c0.8-6.13-1-12.33-2.9-18.9c-0.59-2.04-1.21-4.16-1.73-6.27
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
        <svg class="icon-outline" width="24" height="24" viewBox="0 -960 960 960" fill="currentColor">
            <path d="M0-240v-63q0-43 44-70t116-27q13 0 25 .5t23 2.5q-14 21-21 44t-7 48v65H0Zm240 0v-65q0-32 17.5-58.5T307-410q32-20 76.5-30t96.5-10q53 0 97.5 10t76.5 30q32 20 49 46.5t17 58.5v65H240Zm540 0v-65q0-26-6.5-49T754-397q11-2 22.5-2.5t23.5-.5q72 0 116 26.5t44 70.5v63H780Zm-455-80h311q-10-20-55.5-35T480-370q-55 0-100.5 15T325-320ZM160-440q-33 0-56.5-23.5T80-520q0-34 23.5-57t56.5-23q34 0 57 23t23 57q0 33-23 56.5T160-440Zm640 0q-33 0-56.5-23.5T720-520q0-34 23.5-57t56.5-23q34 0 57 23t23 57q0 33-23 56.5T800-440Zm-320-40q-50 0-85-35t-35-85q0-51 35-85.5t85-34.5q51 0 85.5 34.5T600-600q0 50-34.5 85T480-480Zm0-80q17 0 28.5-11.5T520-600q0-17-11.5-28.5T480-640q-17 0-28.5 11.5T440-640q-17 0-28.5 11.5T440-600q0 17 11.5 28.5T480-560Zm1 240Zm-1-280Z"/>
        </svg>
        <svg class="icon-filled" width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12,12.75c1.63,0 3.07,0.39 4.24,0.9c1.08,0.48 1.76,1.56 1.76,2.73L18,18H6l0,-1.61c0,-1.18 0.68,-2.26 1.76,-2.73C8.93,13.14 10.37,12.75 12,12.75zM4,13c1.1,0 2,-0.9 2,-2c0,-1.1 -0.9,-2 -2,-2s-2,0.9 -2,2C2,12.1 2.9,13 4,13zM5.13,14.1C4.76,14.04 4.39,14 4,14c-0.99,0 -1.93,0.21 -2.78,0.58C0.48,14.9 0,15.62 0,16.43V18l4.5,0v-1.61C4.5,15.56 4.73,14.78 5.13,14.1zM20,13c1.1,0 2,-0.9 2,-2c0,-1.1 -0.9,-2 -2,-2s-2,0.9 -2,2C18,12.1 18.9,13 20,13zM24,16.43c0,-0.81 -0.48,-1.53 -1.22,-1.85C21.93,14.21 20.99,14 20,14c-0.39,0 -0.76,0.04 -1.13,0.1c0.4,0.68 0.63,1.46 0.63,2.29V18l4.5,0V16.43zM12,6c1.66,0 3,1.34 3,3c0,1.66 -1.34,3 -3,3s-3,-1.34 -3,-3C9,7.34 10.34,6 12,6z"/>
        </svg>
    `,
    home: `
        <svg class="icon-outline" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path>
            <polyline points="9 22 9 12 15 12 15 22"></polyline>
        </svg>
        <svg class="icon-filled" width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 2L3 9v11a2 2 0 0 0 2 2h4v-8h6v8h4a2 2 0 0 0 2-2V9L12 2z"/>
        </svg>
    `,
    livetv: `
        <svg class="icon-outline" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <rect x="2" y="7" width="20" height="15" rx="2" ry="2"></rect>
            <polyline points="17 2 12 7 7 2"></polyline>
        </svg>
        <svg class="icon-filled" width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
            <path d="M21,6h-7.59l3.29-3.29c0.39-0.39,0.39-1.02,0-1.41c-0.39-0.39-1.02-0.39-1.41,0L12,4.59L8.71,1.3c-0.39-0.39-1.02-0.39-1.41,0  c-0.39,0.39-0.39,1.02,0,1.41L10.59,6H3C1.9,6,1,6.9,1,8v12c0,1.1,0.9,2,2,2h18c1.1,0,2-0.9,2-2V8C23,6.9,22.1,6,21,6z M21,20H3V8h18  V20z"/>
        </svg>
    `,
    random: `
        <svg class="icon-outline" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <rect x="3.5" y="3.5" width="17" height="17" rx="3" />
            <circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none" />
            <circle cx="7.8" cy="7.8" r="1.6" fill="currentColor" stroke="none" />
            <circle cx="16.2" cy="16.2" r="1.6" fill="currentColor" stroke="none" />
            <circle cx="16.2" cy="7.8" r="1.6" fill="currentColor" stroke="none" />
            <circle cx="7.8" cy="16.2" r="1.6" fill="currentColor" stroke="none" />
        </svg>
        <svg class="icon-filled" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <rect x="3.5" y="3.5" width="17" height="17" rx="3" />
            <circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none" />
            <circle cx="7.8" cy="7.8" r="1.6" fill="currentColor" stroke="none" />
            <circle cx="16.2" cy="16.2" r="1.6" fill="currentColor" stroke="none" />
            <circle cx="16.2" cy="7.8" r="1.6" fill="currentColor" stroke="none" />
            <circle cx="7.8" cy="16.2" r="1.6" fill="currentColor" stroke="none" />
        </svg>
    `,
    favorites: `
        <svg class="icon-outline" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path>
        </svg>
        <svg class="icon-filled" width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/>
        </svg>
    `,
    search: `
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="11" cy="11" r="8"></circle>
            <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
        </svg>
    `,
    settings: `
        <svg class="icon-outline" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="3"></circle>
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
        </svg>
        <svg class="icon-filled" width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
            <path d="M19.14 12.94c.04-.31.06-.63.06-.94 0-.31-.02-.63-.06-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.488.488 0 0 0-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.484.484 0 0 0-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.04.31-.06.63-.06.94s.02.63.06.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/>
        </svg>
    `,
    userDefault: `
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path>
            <circle cx="12" cy="7" r="4"></circle>
        </svg>
    `
};

export const settingsIcons = {
    appearance: `
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="10"/>
            <path d="M12 2a10 10 0 0 1 0 20Z" fill="currentColor"/>
        </svg>
    `,
    home: `
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>
            <polyline points="9 22 9 12 15 12 15 22"/>
        </svg>
    `,
    sidebar: `
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
            <line x1="9" y1="3" x2="9" y2="21"/>
        </svg>
    `,
    controls: `
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="4" y1="6" x2="20" y2="6"/>
            <circle cx="14" cy="6" r="2.5" fill="currentColor"/>
            <line x1="4" y1="12" x2="20" y2="12"/>
            <circle cx="8" cy="12" r="2.5" fill="currentColor"/>
            <line x1="4" y1="18" x2="20" y2="18"/>
            <circle cx="16" cy="18" r="2.5" fill="currentColor"/>
        </svg>
    `,
    player: `
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect x="2" y="3" width="20" height="14" rx="2" ry="2"/>
            <line x1="8" y1="21" x2="16" y2="21"/>
            <line x1="12" y1="17" x2="12" y2="21"/>
        </svg>
    `,
    subtitles: `
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect x="2" y="4" width="20" height="16" rx="2"/>
            <path d="M7 15h4M15 15h2M7 11h2M13 11h4"/>
        </svg>
    `,
    plugins: `
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M20.24 12.24a6 6 0 0 0-8.49-8.49L5 10.5V19h8.5l6.74-6.76z"/>
            <line x1="16" y1="8" x2="2" y2="22"/>
            <line x1="17" y1="15" x2="9" y2="15"/>
        </svg>
    `,
    account: `
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
            <circle cx="12" cy="7" r="4"/>
        </svg>
    `,
    about: `
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="10"/>
            <line x1="12" y1="16" x2="12" y2="12"/>
            <line x1="12" y1="8" x2="12.01" y2="8"/>
        </svg>
    `,
    debug: `
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect width="8" height="14" x="8" y="6" rx="4"/>
            <path d="m19 7-3 2"/>
            <path d="m5 7 3 2"/>
            <path d="m19 19-3-2"/>
            <path d="m5 19 3-2"/>
            <path d="M20 13h-4"/>
            <path d="M4 13h4"/>
            <path d="m10 4 1 2"/>
            <path d="m14 4-1 2"/>
        </svg>
    `
};

export function getLibraryIcon(type) {
    // Normalize strings to avoid mismatching cases
    const colType = (type || '').toLowerCase();

    let outlinePath = '';
    let filledPath = '';
    const viewBox = '0 0 24 24';

    // Precise path configurations for extreme visual sharpness
    switch (colType) {
        case 'movies':
            // Premium film clapperboard design with slanted slates and play center
            outlinePath = `<path d="M4 18h16a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2zm0-10h16M2 8l4-4M18 8l-4-4M10 8L6 4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`;
            filledPath = `<path d="M20 4H4c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zM4 6h3.5L6 8.5H3.5L5 6zm5.5 0h3.5l-1.5 2.5H9L10.5 6zM15 6h3.5l-1.5 2.5h-3.5L15 6zm5 10H4V10h16v6zm-10-1.5l4-2.5-4-2.5v5z" fill="currentColor"/>`;
            break;
        case 'tvshows':
            // Elegant TV display monitor with pedestal stand (differentiates beautifully from Live TV rabbit-ears)
            outlinePath = `<rect x="2" y="3" width="20" height="14" rx="2" ry="2" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><line x1="8" y1="21" x2="16" y2="21" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><line x1="12" y1="17" x2="12" y2="21" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`;
            filledPath = `<path d="M21 2H3c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h7v2H8v2h8v-2h-2v-2h7c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-3 12H6v-8h12v8z" fill="currentColor"/>`;
            break;
        case 'music':
            // Linked musical notes
            outlinePath = `<path d="M9 18V5l12-2v13" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><circle cx="6" cy="18" r="3" stroke="currentColor" stroke-width="2"/><circle cx="18" cy="16" r="3" stroke="currentColor" stroke-width="2"/>`;
            filledPath = `<path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h6V3h-8z" fill="currentColor"/>`;
            break;
        case 'photos':
        case 'photo':
            // Classic camera or landscape picture frame
            outlinePath = `<rect x="3" y="3" width="18" height="18" rx="2" ry="2" stroke="currentColor" stroke-width="2"/><circle cx="8.5" cy="8.5" r="1.5" stroke="currentColor" stroke-width="2"/><polyline points="21 15 16 10 5 21" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`;
            filledPath = `<path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-4.5 6c.83 0 1.5.67 1.5 1.5s-.67 1.5-1.5 1.5-1.5-.67-1.5-1.5.67-1.5 1.5-1.5zM5 19l3-3.86 2.14 2.58 3-3.86L19 19H5z" fill="currentColor"/>`;
            break;
        case 'books':
        case 'book':
            // Detailed ledger/book outline
            outlinePath = `<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`;
            filledPath = `<path d="M18 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zM9 4h2v5L9 8l-2 1V4h2z" fill="currentColor"/>`;
            break;
        case 'homevideos':
        case 'homevideo':
            // Retro camcorder icon
            outlinePath = `<path d="M23 7l-7 5 7 5V7z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`;
            filledPath = `<path d="M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z" fill="currentColor"/>`;
            break;
        case 'boxsets':
            // Visual dimensional layered sheets
            outlinePath = `<path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`;
            filledPath = `<path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>`;
            break;
        case 'playlists':
            // Menu lines layered with an action chevron
            outlinePath = `<path d="M12 12H3M16 6H3M12 18H3M16 12l5 3-5 3v-6z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`;
            filledPath = `<path d="M3 10h11v2H3zm0-4h11v2H3zm0 8h7v2H3zm13-1v6l5-3-5-3z" fill="currentColor"/>`;
            break;
        case 'livetv':
            // Elegant TV sets with antenna (matches static OSD and TV Shows styling)
            outlinePath = `<rect x="2" y="7" width="20" height="15" rx="2" ry="2" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><polyline points="17 2 12 7 7 2" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`;
            filledPath = `<path d="M21 6h-7.59l3.29-3.29c.39-.39.39-1.02 0-1.41c-.39-.39-1.02-.39-1.41,0L12 4.59L8.71 1.3c-.39-.39-1.02-.39-1.41,0c-.39.39-.39 1.02 0 1.41L10.59 6H3C1.9 6 1 6.9 1 8v12c0 1.1.9 2 2 2h18c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zM21 20H3V8h18v12z" fill="currentColor"/>`;
            break;
        case 'folders':
        case 'folder':
        default:
            // Universal tabbed document folder
            outlinePath = `<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`;
            filledPath = `<path d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z" fill="currentColor"/>`;
            break;
    }

    return `
        <svg class="icon-outline" viewBox="${viewBox}" width="24" height="24" fill="none">${outlinePath}</svg>
        <svg class="icon-filled" viewBox="${viewBox}" width="24" height="24" fill="none">${filledPath}</svg>
    `;
}
