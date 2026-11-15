const SOUND_SETTINGS_URI = 'luna://com.webos.settingsservice/getSystemSettings';

// An unreferenced PalmServiceBridge can be garbage-collected, ending the subscription
const liveBridges = [];

/* webOS routes Web Audio through the UI-feedback mixer, which is not sent over ARC/eARC
   (verified on an LG C5 with a soundbar: silent). Only the TV speakers are known to work;
   an unknown output (non-webOS, or the setting could not be read) keeps Web Audio. */
export function webAudioAudibleOn(soundOutput) {
    return !soundOutput || soundOutput === 'tv_speaker';
}

export function watchSoundOutput(createBridge, onChange) {
    const bridge = createBridge();
    liveBridges.push(bridge);
    bridge.onservicecallback = (message) => {
        let reply;
        try {
            reply = JSON.parse(message);
        } catch {
            return;
        }
        const soundOutput = reply?.returnValue ? reply.settings?.soundOutput : null;
        if (soundOutput) onChange(soundOutput);
    };
    bridge.call(SOUND_SETTINGS_URI, JSON.stringify({ category: 'sound', keys: ['soundOutput'], subscribe: true }));
}
