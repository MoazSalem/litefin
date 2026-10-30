const DISPOSED = 'SourceBuffer queue disposed';

export default class SourceBufferQueue {
    constructor(sourceBuffer) {
        this._sourceBuffer = sourceBuffer;
        this._tail = Promise.resolve();
        this._disposed = false;
        this._abortPending = null;
    }

    run(operation) {
        const result = this._tail.then(() => this._execute(operation));
        this._tail = result.catch(() => {});
        return result;
    }

    dispose() {
        this._disposed = true;
        if (this._abortPending) this._abortPending();
    }

    _execute(operation) {
        if (this._disposed) return Promise.reject(new Error(DISPOSED));
        const sourceBuffer = this._sourceBuffer;
        return new Promise((resolve, reject) => {
            let failure = null;
            const settle = (fn, value) => {
                sourceBuffer.removeEventListener('updateend', onEnd);
                sourceBuffer.removeEventListener('error', onError);
                this._abortPending = null;
                fn(value);
            };
            /* error is followed by updateend; settling on error would let that updateend end the next operation */
            const onError = () => {
                failure = new Error('SourceBuffer update failed');
            };
            const onEnd = () => (failure ? settle(reject, failure) : settle(resolve));
            sourceBuffer.addEventListener('updateend', onEnd);
            sourceBuffer.addEventListener('error', onError);
            this._abortPending = () => settle(reject, new Error(DISPOSED));
            try {
                operation(sourceBuffer);
            } catch (err) {
                settle(reject, err);
                return;
            }
            if (!sourceBuffer.updating) settle(resolve);
        });
    }
}
