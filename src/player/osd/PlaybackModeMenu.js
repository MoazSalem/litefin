// Import base menu functionality to extend generic menu UI behaviors.
import BaseMenu from './BaseMenu.js';

// Import centralized icon registry from utility to load clean, scalable SVG resources.
import { osdIcons } from '../../utils/Icons.js';

// Import logging utility to facilitate structured OSD and application event debugging.
import { logger } from '../../utils/Logger.js';

// Import localization utility to map text strings into user-configured locale values.
import { i18n } from '../../utils/i18n.js';

const log = logger.create( 'PlaybackModeMenu' );

export default class PlaybackModeMenu extends BaseMenu {
    constructor( osdController ) {
        super( osdController );
        this.isModal = true;
        this.title = i18n.t('PlaybackMode');
        this.options = [
            // Auto lets the server decide the best delivery method.
            { id: 'auto', label: i18n.t('Auto') },

            // Forces the raw file to be sent as-is without any server processing.
            { id: 'directPlay', label: i18n.t('ForceDirectPlay') },

            // Rewraps the video into a new container without re-encoding any streams.
            // Previously labelled "Force Remux".
            { id: 'remux', label: i18n.t('ChangeContainer') },

            // Full re-encode of video stream; audio is copied through untouched.
            { id: 'transcodeVideo', label: i18n.t('TranscodeVideoOnly') },

            // Full re-encode of audio stream; video is copied through untouched.
            { id: 'transcodeAudio', label: i18n.t('TranscodeAudioOnly') },

            // Forces both video and audio to be fully re-encoded on the server.
            { id: 'transcode', label: i18n.t('ForceTranscode') }
        ];
    }

    open() {
        // Pre-select current mode
        const currentMode = this.osd.player.getPlaybackMode() || 'auto';
        const index = this.options.findIndex( opt => opt.id === currentMode );

        this.focusIndex = index !== -1 ? index : 0;

        this.render();
        this.show();
    }

    show() {
        this._prevFocus = this.osd._getFocused();
        this._prevRow = this.osd._currentFocusRow;
        this._prevIndex = this.osd._currentFocusIndex;

        this.isVisible = true;
        if ( this.$el ) {
            this.$el.classList.add( 'visible' );
            this.updateFocus();
        }
    }

    hide() {
        this.isVisible = false;
        if ( this.$el ) {
            this.$el.classList.remove( 'visible' );
        }

        if ( this._prevRow !== undefined ) {
            this.osd._currentFocusRow = this._prevRow;
            this.osd._currentFocusIndex = this._prevIndex;
            this.osd._updateFocus();

            /*
             * Lock out enter/click inputs for 350ms to absorb any ghost key presses
             * or trailing clicks on the newly focused parent button on the OSD.
             */
            this.osd._focusRestoreLockout = true;
            if ( this.osd._focusRestoreLockoutTimer ) {
                clearTimeout( this.osd._focusRestoreLockoutTimer );
            }
            this.osd._focusRestoreLockoutTimer = setTimeout( () => {
                this.osd._focusRestoreLockout = false;
                this.osd._focusRestoreLockoutTimer = null;
            }, 350 );
        }
    }

    render() {
        if ( !this.$el ) {
            this.$el = document.createElement( 'div' );
            this.$el.className = 'track-menu-overlay';
            document.body.appendChild( this.$el );

            this.$el.addEventListener( 'click', ( e ) => {
                if ( e.target === this.$el ) {
                    this.osd.closeMenu();
                }
            } );
        }

        const currentMode = this.osd.player.getPlaybackMode() || 'auto';

        // Loop over each menu item definition to construct the HTML options block.
        const optionsHtml = this.options.map( ( opt, i ) => {
            // Determine if this specific item corresponds to the player's active state.
            const isSelected = opt.id === currentMode;
            
            // ================================================================
            // Dynamic Selection Mark
            // ================================================================
            // Apply the checkmark icon when the option matches the selected state.
            // Using the unified check icon.
            const checkIcon = isSelected ? osdIcons.check : '';

            // Generate HTML markup containing standard button and dynamic SVG state.
            return `
            <button class="track-option track-item ${isSelected ? 'selected' : ''}" 
                    data-id="${opt.id}" data-menu-index="${i}">
                <span class="track-option-label">${opt.label}</span>
                <span class="track-option-check">${checkIcon}</span>
            </button>
            `;
        } ).join( '' );

        this.$el.innerHTML = `
            <div class="track-menu">
                <div class="track-menu-title">${i18n.t('PlaybackMode')}</div>
                <div class="track-menu-options">
                    ${optionsHtml}
                </div>
            </div>
        `;

        this.$el.querySelectorAll( '.track-item' ).forEach( btn => {
            btn.addEventListener( 'click', ( e ) => {
                e.stopPropagation();
                /*
                 * ================================================================
                 * TIZEN TV CLICK ORIGIN GUARD
                 * ================================================================
                 * Discard synthetic focus-clicks and Enter-synthesized clicks (detail === 0
                 * or clientX === 0 && clientY === 0). D-pad Enter is handled exclusively
                 * via handleKey() -> handleEnter().
                 * ================================================================
                 */
                if ( btn._programmaticFocus ) return;
                if ( e.detail === 0 ) return;
                if ( e.clientX === 0 && e.clientY === 0 ) return;

                this.focusIndex = parseInt( btn.dataset.menuIndex );
                this.handleEnter();
            } );
        } );

        this.updateFocus();
    }

    handleKey( key ) {
        switch ( key ) {
            case 'up':
                if (this.focusIndex > 0) {
                    this.focusIndex--;
                } else {
                    this.focusIndex = this.options.length - 1;
                }
                this.updateFocus();
                return true;
            case 'down':
                if (this.focusIndex < this.options.length - 1) {
                    this.focusIndex++;
                } else {
                    this.focusIndex = 0;
                }
                this.updateFocus();
                return true;
            case 'enter':
                this.handleEnter();
                return true;
            case 'back':
            case 'left':
            case 'right':
                this.osd.closeMenu();
                return true;
        }
        return false;
    }

    handleEnter() {
        const selected = this.options[ this.focusIndex ];
        if ( selected ) {
            log.info( 'Selected playback mode:', selected.id );
            this.osd.player.setPlaybackMode( selected.id );
            this.osd.closeMenu();
        }
    }

    updateFocus() {
        if ( !this.$el ) return;
        const options = this.$el.querySelectorAll( '.track-option' );
        options.forEach( ( opt, i ) => {
            const isFocused = i === this.focusIndex;
            opt.classList.toggle( 'focused', isFocused );
            if ( isFocused ) {
                opt._programmaticFocus = true;
                opt.focus( { preventScroll: true } );
                setTimeout( () => { opt._programmaticFocus = false; }, 0 );
                opt.scrollIntoView( { block: 'nearest', behavior: 'smooth' } );
            }
        } );
    }
}
