import assert from 'node:assert/strict';
import test from 'node:test';

// Setup environment mocks
globalThis.window = {
    innerWidth: 1920,
    innerHeight: 1080
};
globalThis.localStorage = {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {}
};
globalThis.document = {
    documentElement: { clientWidth: 1920, clientHeight: 1080 },
    createElement: () => ({
        classList: { add: () => {}, remove: () => {}, toggle: () => {} },
        addEventListener: () => {},
        querySelectorAll: () => [],
        appendChild: () => {},
        innerHTML: ''
    }),
    body: {
        appendChild: () => {}
    }
};

test('AspectRatioMenu: Omits Zoom option on Tizen and offers Auto, Video Aspect Ratio, and Stretch', async () => {
    // 1. Test Tizen platform detection
    globalThis.window.tizen = {};
    const { platformInfo } = await import('../src/utils/PlatformInfo.js');
    platformInfo._platform = 'tizen';

    const { default: AspectRatioMenu } = await import('../src/player/osd/AspectRatioMenu.js');

    const mockOsd = {
        player: {
            backendType: 'tizen',
            getAspectRatio: () => 'auto',
            setAspectRatio: () => {}
        },
        _getFocused: () => null,
        _currentFocusRow: 0,
        _currentFocusIndex: 0,
        _updateFocus: () => {}
    };

    const menu = new AspectRatioMenu(mockOsd);
    const optionsOnTizen = menu.options.map(opt => opt.id);

    assert.deepStrictEqual(
        optionsOnTizen,
        ['auto', 'video_aspect_ratio', 'stretch'],
        'On Tizen AVPlay, AspectRatioMenu must offer Auto, Video Aspect Ratio, and Stretch (Zoom must be hidden)'
    );
});

test('AspectRatioMenu: Retains Zoom option on non-Tizen platforms', async () => {
    // 2. Test non-Tizen platform
    delete globalThis.window.tizen;
    delete globalThis.window.webapis;

    const { platformInfo } = await import('../src/utils/PlatformInfo.js');
    platformInfo._platform = 'web';

    const { default: AspectRatioMenu } = await import('../src/player/osd/AspectRatioMenu.js');

    const mockOsd = {
        player: {
            getAspectRatio: () => 'auto',
            setAspectRatio: () => {}
        },
        _getFocused: () => null,
        _currentFocusRow: 0,
        _currentFocusIndex: 0,
        _updateFocus: () => {}
    };

    const menu = new AspectRatioMenu(mockOsd);
    const optionsOnWeb = menu.options.map(opt => opt.id);

    assert.deepStrictEqual(
        optionsOnWeb,
        ['auto', 'zoom', 'stretch'],
        'On non-Tizen platforms, AspectRatioMenu must retain Auto, Zoom, and Stretch'
    );
});

test('WebOSPlayer: Computes explicit layout bounding box geometry for auto, zoom, and stretch modes', async () => {
    // ------------------------------------------------------------------------
    // WebOS Player Architecture Verification
    // ------------------------------------------------------------------------
    // On webOS TV, CSS object-fit is not supported on hardware-backed <video>.
    // Verify that WebOSPlayer calculates and applies explicit layout bounding
    // box dimensions (width, height, left, top) for all supported modes.
    // ------------------------------------------------------------------------

    // Dynamically import WebOSPlayer backend
    const { WebOSPlayer } = await import('../src/player/core/WebOSPlayer.js');

    // Create a mock style object to record CSS properties
    const mockStyle = {};

    // Mock video element representing 2.40:1 ultrawide content (1920x800)
    const mockVideo = {
        videoWidth: 1920,
        videoHeight: 800,
        style: mockStyle
    };

    // Mock container representing a standard 1080p display viewport (1920x1080)
    const mockContainer = {
        clientWidth: 1920,
        clientHeight: 1080,
        appendChild: () => {}
    };

    // Instantiate WebOSPlayer instance with the mock container
    const player = new WebOSPlayer({ container: mockContainer });
    player._videoElement = mockVideo;

    // ------------------------------------------------------------------------
    // Case 1: Fullscreen Stretch Mode
    // ------------------------------------------------------------------------
    // Must force the bounding box to match the full container (1920x1080)
    player.setAspectRatio('stretch');
    assert.strictEqual(player.getAspectRatio(), 'stretch');
    assert.strictEqual(mockStyle.left, '0px');
    assert.strictEqual(mockStyle.top, '0px');
    assert.strictEqual(mockStyle.width, '1920px');
    assert.strictEqual(mockStyle.height, '1080px');
    assert.strictEqual(mockStyle.objectFit, 'fill');

    // ------------------------------------------------------------------------
    // Case 2: Auto (Letterbox / Contain) Mode
    // ------------------------------------------------------------------------
    // Scale = min(1920/1920, 1080/800) = 1.0
    // Width = 1920px, Height = 800px, Top = (1080 - 800) / 2 = 140px
    player.setAspectRatio('auto');
    assert.strictEqual(player.getAspectRatio(), 'auto');
    assert.strictEqual(mockStyle.width, '1920px');
    assert.strictEqual(mockStyle.height, '800px');
    assert.strictEqual(mockStyle.left, '0px');
    assert.strictEqual(mockStyle.top, '140px');

    // ------------------------------------------------------------------------
    // Case 3: Zoom (Crop / Cover) Mode
    // ------------------------------------------------------------------------
    // Scale = max(1920/1920, 1080/800) = 1.35
    // Width = round(1920 * 1.35) = 2592px, Height = round(800 * 1.35) = 1080px
    // Left = round((1920 - 2592) / 2) = -336px, Top = 0px
    player.setAspectRatio('zoom');
    assert.strictEqual(player.getAspectRatio(), 'zoom');
    assert.strictEqual(mockStyle.width, '2592px');
    assert.strictEqual(mockStyle.height, '1080px');
    assert.strictEqual(mockStyle.left, '-336px');
    assert.strictEqual(mockStyle.top, '0px');

    // ------------------------------------------------------------------------
    // Case 4: Transition from Stretch directly to Zoom
    // ------------------------------------------------------------------------
    // When previous mode was 'stretch', setting 'zoom' resets to auto first,
    // ensuring right and bottom constraints from stretch are cleared.
    player.setAspectRatio('stretch');
    assert.strictEqual(mockStyle.right, '0px');
    assert.strictEqual(mockStyle.bottom, '0px');

    player.setAspectRatio('zoom');
    assert.strictEqual(player.getAspectRatio(), 'zoom');
    assert.strictEqual(mockStyle.width, '2592px');
    assert.strictEqual(mockStyle.height, '1080px');
    assert.strictEqual(mockStyle.left, '-336px');
    assert.strictEqual(mockStyle.top, '0px');
    assert.strictEqual(mockStyle.right, '');
    assert.strictEqual(mockStyle.bottom, '');
});

test('TizenAVPlayer: Computes explicit display rect geometry for auto, zoom, stretch, and video_aspect_ratio modes', async () => {
    // ------------------------------------------------------------------------
    // Tizen AVPlay Architecture Verification
    // ------------------------------------------------------------------------
    // On Samsung Tizen TVs, AVPlay renders video via a hardware overlay plane.
    // CSS object-fit cannot be applied to this video plane.
    // Verify that TizenAVPlayer calculates and applies explicit layout bounding
    // box dimensions (x, y, width, height) and hardware display methods.
    // ------------------------------------------------------------------------

    // Dynamically import TizenAVPlayer backend
    const { TizenAVPlayer } = await import('../src/player/core/TizenAVPlayer.js');

    // Mock webapis.avplay hardware interface
    let lastRect = null;
    let lastMethod = null;
    const methodCalls = [];
    const mockAvplay = {
        setDisplayRect: (x, y, w, h) => {
            lastRect = { x, y, width: w, height: h };
        },
        setDisplayMethod: (method) => {
            lastMethod = method;
            methodCalls.push(method);
        },
        getCurrentStreamInfo: () => [
            {
                type: 'VIDEO',
                extra_info: JSON.stringify({ Width: 1920, Height: 800 })
            }
        ]
    };

    // Mock container representing a standard 1080p display viewport (1920x1080)
    const mockContainer = {
        clientWidth: 1920,
        clientHeight: 1080,
        getBoundingClientRect: () => ({ left: 0, top: 0, width: 1920, height: 1080 })
    };

    // Instantiate TizenAVPlayer instance with mock container and mock avplay
    const player = new TizenAVPlayer({ container: mockContainer });
    player._avplay = mockAvplay;

    // ------------------------------------------------------------------------
    // Case 1: Fullscreen Stretch Mode
    // ------------------------------------------------------------------------
    player.setAspectRatio('stretch');
    assert.strictEqual(player.getAspectRatio(), 'stretch');
    assert.deepStrictEqual(lastRect, { x: 0, y: 0, width: 1920, height: 1080 });
    assert.strictEqual(lastMethod, 'PLAYER_DISPLAY_MODE_FULL_SCREEN');

    // ------------------------------------------------------------------------
    // Case 2: Auto (Letterbox / Contain) Mode
    // ------------------------------------------------------------------------
    player.setAspectRatio('auto');
    assert.strictEqual(player.getAspectRatio(), 'auto');
    assert.deepStrictEqual(lastRect, { x: 0, y: 0, width: 1920, height: 1080 });
    assert.strictEqual(lastMethod, 'PLAYER_DISPLAY_MODE_LETTER_BOX');

    // ------------------------------------------------------------------------
    // Case 3: Video Aspect Ratio Mode (Hardware DAR/PAR)
    // ------------------------------------------------------------------------
    player.setAspectRatio('video_aspect_ratio');
    assert.strictEqual(player.getAspectRatio(), 'video_aspect_ratio');
    assert.deepStrictEqual(lastRect, { x: 0, y: 0, width: 1920, height: 1080 });
    assert.strictEqual(lastMethod, 'PLAYER_DISPLAY_MODE_AUTO_ASPECT_RATIO');

    // ------------------------------------------------------------------------
    // Case 4: Zoom Fallback (Letterbox Mode)
    // ------------------------------------------------------------------------
    // AVPlay does not support negative coordinates or off-screen hardware cropping.
    // Setting 'zoom' safely falls back to standard letterbox bounds [0, 0, 1920, 1080].
    player.setAspectRatio('zoom');
    assert.deepStrictEqual(lastRect, { x: 0, y: 0, width: 1920, height: 1080 });
    assert.strictEqual(lastMethod, 'PLAYER_DISPLAY_MODE_LETTER_BOX');
});

test('WebOSPlayer: Resolves fallback dimensions when video element dimensions are 0 (webOS 5 native HLS)', async () => {
    // ------------------------------------------------------------------------
    // webOS 5 Dimension Resolution Verification
    // ------------------------------------------------------------------------
    // On webOS 5, native HLS demuxers frequently report 0x0 for videoWidth/videoHeight.
    // WebOSPlayer must query Jellyfin mediaSource / stream metadata to compute geometry.
    // ------------------------------------------------------------------------

    const { WebOSPlayer } = await import('../src/player/core/WebOSPlayer.js');

    const mockStyle = {};
    const mockVideo = {
        videoWidth: 0,
        videoHeight: 0,
        style: mockStyle
    };

    const mockContainer = {
        clientWidth: 1920,
        clientHeight: 1080,
        appendChild: () => {}
    };

    // Instantiate player and attach simulated play options with stream metadata
    const player = new WebOSPlayer({ container: mockContainer });
    player._videoElement = mockVideo;
    player._currentPlayOptions = {
        mediaSource: {
            MediaStreams: [
                {
                    Type: 'Video',
                    Width: 1920,
                    Height: 800,
                    AspectRatio: '2.40:1'
                }
            ]
        }
    };

    // 1. Auto mode with 0x0 DOM dimensions: should resolve to 1920x800 centered
    player.setAspectRatio('auto');
    assert.strictEqual(mockStyle.width, '1920px');
    assert.strictEqual(mockStyle.height, '800px');
    assert.strictEqual(mockStyle.left, '0px');
    assert.strictEqual(mockStyle.top, '140px');

    // 2. Zoom mode with 0x0 DOM dimensions: should resolve to 2592x1080 cropped
    player.setAspectRatio('zoom');
    assert.strictEqual(mockStyle.width, '2592px');
    assert.strictEqual(mockStyle.height, '1080px');
    assert.strictEqual(mockStyle.left, '-336px');
    assert.strictEqual(mockStyle.top, '0px');
    assert.strictEqual(mockStyle.objectFit, 'cover');

    // 3. Zoom mode with 1920x1080 container holding baked 2.40:1 letterbox
    // DOM reports 1920x1080, but AspectRatio metadata indicates 2.40:1 active frame
    mockVideo.videoWidth = 1920;
    mockVideo.videoHeight = 1080;
    player.setAspectRatio('zoom');

    // Expected scale = 1080 / 800 = 1.35
    // Width = 1920 * 1.35 = 2592px, Height = 1080 * 1.35 = 1458px
    // Left = (1920 - 2592) / 2 = -336px, Top = (1080 - 1458) / 2 = -189px
    assert.strictEqual(mockStyle.width, '2592px');
    assert.strictEqual(mockStyle.height, '1458px');
    assert.strictEqual(mockStyle.left, '-336px');
    assert.strictEqual(mockStyle.top, '-189px');
    assert.strictEqual(mockStyle.objectFit, 'cover');
});

test('TizenAVPlayer: Calculates explicit display rect for non-square pixel DVD remuxes (NTSC and PAL)', async () => {
    // ------------------------------------------------------------------------
    // Tizen AVPlay Non-Square Pixel (Anamorphic) DAR Verification
    // ------------------------------------------------------------------------
    // Standard-definition DVDs store video using non-square pixels (720x480 for NTSC,
    // 720x576 for PAL) relying on PAR/DAR flags to render in 4:3 or 16:9.
    // AVPlay's hardware scaler strictly ignores these flags under PLAYER_DISPLAY_MODE_LETTER_BOX
    // and PLAYER_DISPLAY_MODE_AUTO_ASPECT_RATIO on NTSC MPEG-2 MKV remuxes.
    // Verify that TizenAVPlayer detects the anamorphic mismatch and computes explicit
    // letterbox/pillarbox geometry to scale to the true presentation ratio.
    // ------------------------------------------------------------------------

    const { TizenAVPlayer } = await import('../src/player/core/TizenAVPlayer.js');

    let lastRect = null;
    let lastMethod = null;
    const mockAvplay = {
        setDisplayRect: (x, y, w, h) => {
            lastRect = { x, y, width: w, height: h };
        },
        setDisplayMethod: (method) => {
            lastMethod = method;
        },
        getCurrentStreamInfo: () => []
    };

    const mockContainer = {
        clientWidth: 1920,
        clientHeight: 1080,
        getBoundingClientRect: () => ({ left: 0, top: 0, width: 1920, height: 1080 })
    };

    const player = new TizenAVPlayer({ container: mockContainer });
    player._avplay = mockAvplay;

    // ------------------------------------------------------------------------
    // Case 1: NTSC DVD 4:3 Remux (720x480, AspectRatio: "4:3")
    // ------------------------------------------------------------------------
    // Storage ratio = 720 / 480 = 1.50 (3:2)
    // Presentation ratio = 4 / 3 = 1.333333
    // On 1920x1080: Height = 1080, Width = Math.round(1080 * 4/3) = 1440, Left = 240
    player._currentPlayOptions = {
        mediaSource: {
            Width: 720,
            Height: 480,
            MediaStreams: [
                {
                    Type: 'Video',
                    Width: 720,
                    Height: 480,
                    AspectRatio: '4:3'
                }
            ]
        }
    };

    // Auto mode should correct the 3:2 distortion to 4:3 pillarbox
    player.setAspectRatio('auto');
    assert.strictEqual(player.getAspectRatio(), 'auto');
    assert.deepStrictEqual(lastRect, { x: 240, y: 0, width: 1440, height: 1080 });
    assert.strictEqual(lastMethod, 'PLAYER_DISPLAY_MODE_FULL_SCREEN');

    // Video aspect ratio mode should also apply the corrected geometry
    player.setAspectRatio('video_aspect_ratio');
    assert.deepStrictEqual(lastRect, { x: 240, y: 0, width: 1440, height: 1080 });
    assert.strictEqual(lastMethod, 'PLAYER_DISPLAY_MODE_FULL_SCREEN');

    // Stretch mode should still stretch edge-to-edge
    player.setAspectRatio('stretch');
    assert.deepStrictEqual(lastRect, { x: 0, y: 0, width: 1920, height: 1080 });
    assert.strictEqual(lastMethod, 'PLAYER_DISPLAY_MODE_FULL_SCREEN');

    // ------------------------------------------------------------------------
    // Case 2: PAL DVD 4:3 Remux (720x576, AspectRatio: "4:3")
    // ------------------------------------------------------------------------
    // Storage ratio = 720 / 576 = 1.25 (5:4)
    // Presentation ratio = 4 / 3 = 1.333333
    // On 1920x1080: Height = 1080, Width = 1440, Left = 240
    player._currentPlayOptions = {
        mediaSource: {
            Width: 720,
            Height: 576,
            MediaStreams: [
                {
                    Type: 'Video',
                    Width: 720,
                    Height: 576,
                    AspectRatio: '4:3'
                }
            ]
        }
    };

    player.setAspectRatio('auto');
    assert.deepStrictEqual(lastRect, { x: 240, y: 0, width: 1440, height: 1080 });
    assert.strictEqual(lastMethod, 'PLAYER_DISPLAY_MODE_FULL_SCREEN');

    // ------------------------------------------------------------------------
    // Case 3: Anamorphic 16:9 NTSC DVD (720x480, AspectRatio: "16:9")
    // ------------------------------------------------------------------------
    // Storage ratio = 720 / 480 = 1.50 (3:2)
    // Presentation ratio = 16 / 9 = 1.777778
    // On 1920x1080: Width = 1920, Height = 1080, Left = 0, Top = 0
    player._currentPlayOptions = {
        mediaSource: {
            Width: 720,
            Height: 480,
            MediaStreams: [
                {
                    Type: 'Video',
                    Width: 720,
                    Height: 480,
                    AspectRatio: '16:9'
                }
            ]
        }
    };

    player.setAspectRatio('auto');
    assert.deepStrictEqual(lastRect, { x: 0, y: 0, width: 1920, height: 1080 });
    assert.strictEqual(lastMethod, 'PLAYER_DISPLAY_MODE_FULL_SCREEN');
});

test('HtmlVideoPlayer: Corrects anamorphic non-square pixel DVD aspect ratio in auto mode', async () => {
    // ------------------------------------------------------------------------
    // HTML5 Video Non-Square Pixel DAR Correction Verification
    // ------------------------------------------------------------------------
    // When interlaced video falls back to HtmlVideoPlayer, browser decoders size
    // <video> elements according to videoWidth / videoHeight (e.g. 720x480 -> 3:2),
    // ignoring PAR/DAR flags. HtmlVideoPlayer must apply explicit letterbox/pillarbox
    // geometry to display 4:3 DVDs correctly without 3:2 stretching.
    // ------------------------------------------------------------------------

    const { HtmlVideoPlayer } = await import('../src/player/core/HtmlVideoPlayer.js');

    const mockStyle = {};
    const mockVideo = {
        videoWidth: 720,
        videoHeight: 480,
        style: mockStyle
    };

    const mockContainer = {
        clientWidth: 1920,
        clientHeight: 1080,
        appendChild: () => {}
    };

    const player = new HtmlVideoPlayer({ container: mockContainer });
    player._videoElement = mockVideo;

    // 1. NTSC DVD remux (720x480, AspectRatio: "4:3")
    player._currentPlayOptions = {
        mediaSource: {
            Width: 720,
            Height: 480,
            MediaStreams: [
                {
                    Type: 'Video',
                    Width: 720,
                    Height: 480,
                    AspectRatio: '4:3'
                }
            ]
        }
    };

    // Auto mode should pillarbox to 1440x1080 at left: 240px with objectFit: fill
    player.setAspectRatio('auto');
    assert.strictEqual(player.getAspectRatio(), 'auto');
    assert.strictEqual(mockStyle.width, '1440px');
    assert.strictEqual(mockStyle.height, '1080px');
    assert.strictEqual(mockStyle.left, '240px');
    assert.strictEqual(mockStyle.top, '0px');
    assert.strictEqual(mockStyle.objectFit, 'fill');

    // 2. Stretch mode should stretch across 100% of container
    player.setAspectRatio('stretch');
    assert.strictEqual(mockStyle.width, '100%');
    assert.strictEqual(mockStyle.height, '100%');
    assert.strictEqual(mockStyle.left, '0px');
    assert.strictEqual(mockStyle.top, '0px');
    assert.strictEqual(mockStyle.objectFit, 'fill');

    // 3. Zoom mode should cover 100% of container
    player.setAspectRatio('zoom');
    assert.strictEqual(mockStyle.width, '100%');
    assert.strictEqual(mockStyle.height, '100%');
    assert.strictEqual(mockStyle.left, '0px');
    assert.strictEqual(mockStyle.top, '0px');
    assert.strictEqual(mockStyle.objectFit, 'cover');

    // 4. Standard 1080p square-pixel content in auto mode
    mockVideo.videoWidth = 1920;
    mockVideo.videoHeight = 1080;
    player._currentPlayOptions = {
        mediaSource: {
            Width: 1920,
            Height: 1080,
            MediaStreams: [
                {
                    Type: 'Video',
                    Width: 1920,
                    Height: 1080,
                    AspectRatio: '16:9'
                }
            ]
        }
    };
    player.setAspectRatio('auto');
    assert.strictEqual(mockStyle.width, '100%');
    assert.strictEqual(mockStyle.height, '100%');
    assert.strictEqual(mockStyle.left, '0px');
    assert.strictEqual(mockStyle.top, '0px');
    assert.strictEqual(mockStyle.objectFit, 'contain');
});

