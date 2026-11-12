import QueueModal from '../player/osd/QueueModal.js';
import { eventBus } from '../core/EventBus.js';
import { focusManager } from '../ui/FocusManager.js';

const ROUTED_KEYS = ['up', 'down', 'left', 'enter'];
const PLAY_PAUSE_ROW = 1;

/* QueueModal talks to an OSDController; this stands in for exactly the members it touches. */
export default class QueueModalHost {
    constructor({ root, api, onJump, onClose }) {
        this._onClose = onClose;
        this._keyUnsubscribers = [];
        this._isOpen = false;
        this._osd = {
            player: null,
            _api: api,
            _osdEl: root,
            _currentFocusRow: 0,
            _currentFocusIndex: 0,
            _findActionIndex: () => 0,
            _updateFocus: () => {},
            closeMenu: () => this._close(),
            emit: (event, index) => {
                if (event === 'playQueueItem') onJump(index);
            }
        };
        this._modal = new QueueModal(this._osd);
    }

    get isOpen() {
        return this._isOpen;
    }

    open() {
        if (this._isOpen) return;
        this._isOpen = true;
        this._osd._currentFocusRow = 0;
        focusManager.suspend();
        this._keyUnsubscribers = ROUTED_KEYS.map((key) =>
            eventBus.on(`key:${key}`, (event) => {
                event?.preventDefault?.();
                this._modal.handleKey(key);
            })
        );
        this._modal.open();
    }

    back() {
        this._modal.handleKey('back');
    }

    destroy() {
        this._release();
        this._modal.destroy();
    }

    _close() {
        this._modal.hide();
        this._release();
        this._onClose(this._osd._currentFocusRow === PLAY_PAUSE_ROW);
    }

    _release() {
        if (!this._isOpen) return;
        this._isOpen = false;
        this._keyUnsubscribers.forEach((unsubscribe) => unsubscribe());
        this._keyUnsubscribers = [];
        focusManager.resume();
    }
}
