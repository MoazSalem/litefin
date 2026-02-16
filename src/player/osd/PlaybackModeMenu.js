import BaseMenu from './BaseMenu.js';
import { ICONS } from './icons.js';
import { logger } from '../../utils/Logger.js';

const log = logger.create( 'PlaybackModeMenu' );

export default class PlaybackModeMenu extends BaseMenu {
    constructor( osdController ) {
        super( osdController );
        this.isModal = true;
        this.title = 'Playback Mode';
        this.options = [
            { id: 'auto', label: 'Auto' },
            { id: 'directPlay', label: 'Force Direct Play' },
            { id: 'transcode', label: 'Force Transcode' },
            { id: 'remux', label: 'Force Remux' }
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

        const optionsHtml = this.options.map( ( opt, i ) => {
            const isSelected = opt.id === currentMode;
            const checkIcon = isSelected ? ICONS.check : '';

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
                <div class="track-menu-title">${this.title}</div>
                <div class="track-menu-options">
                    ${optionsHtml}
                </div>
            </div>
        `;

        this.$el.querySelectorAll( '.track-item' ).forEach( btn => {
            btn.addEventListener( 'click', ( e ) => {
                e.stopPropagation();
                this.focusIndex = parseInt( btn.dataset.menuIndex );
                this.handleEnter();
            } );
        } );

        this.updateFocus();
    }

    handleKey( key ) {
        switch ( key ) {
            case 'up':
                if ( this.focusIndex > 0 ) {
                    this.focusIndex--;
                    this.updateFocus();
                }
                return true;
            case 'down':
                if ( this.focusIndex < this.options.length - 1 ) {
                    this.focusIndex++;
                    this.updateFocus();
                }
                return true;
            case 'enter':
                return true;
            case 'back':
            case 'left':
            case 'right':
                this.hide();
                this.osd.toggleSettings( true );
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
                opt.focus();
                opt.scrollIntoView( { block: 'nearest', behavior: 'smooth' } );
            }
        } );
    }
}
