import assert from 'node:assert/strict';
import test from 'node:test';

import { AudioClassifier } from '../src/utils/AudioClassifier.js';

test('AudioClassifier: classifies Japanese-only audio tracks as Subbed', () => {
    assert.equal(AudioClassifier.classify(['jpn']), 'Subbed');
    assert.equal(AudioClassifier.classify(['ja']), 'Subbed');
    assert.equal(AudioClassifier.classify(['Japanese']), 'Subbed');
    assert.equal(AudioClassifier.classify(['jp']), 'Subbed');
});

test('AudioClassifier: classifies foreign-only audio tracks as Dubbed', () => {
    assert.equal(AudioClassifier.classify(['eng']), 'Dubbed');
    assert.equal(AudioClassifier.classify(['spa']), 'Dubbed');
    assert.equal(AudioClassifier.classify(['fra']), 'Dubbed');
    assert.equal(AudioClassifier.classify(['ger', 'fre']), 'Dubbed');
});

test('AudioClassifier: classifies files with Japanese and foreign tracks as Subbed/Dubbed', () => {
    assert.equal(AudioClassifier.classify(['jpn', 'eng']), 'Subbed/Dubbed');
    assert.equal(AudioClassifier.classify(['ja', 'spa', 'fra']), 'Subbed/Dubbed');
    assert.equal(AudioClassifier.classify(['Japanese', 'English']), 'Subbed/Dubbed');
});

test('AudioClassifier: skips untagged or undefined tokens', () => {
    assert.equal(AudioClassifier.classify(['und']), null);
    assert.equal(AudioClassifier.classify(['unknown']), null);
    assert.equal(AudioClassifier.classify(['']), null);
    assert.equal(AudioClassifier.classify([]), null);
    assert.equal(AudioClassifier.classify(['und', 'jpn']), 'Subbed');
    assert.equal(AudioClassifier.classify(['und', 'eng']), 'Dubbed');
    assert.equal(AudioClassifier.classify(['und', 'jpn', 'eng']), 'Subbed/Dubbed');
});

test('AudioClassifier: extracts audio languages from Jellyfin Item MediaStreams', () => {
    const itemWithStreams = {
        MediaStreams: [
            { Type: 'Video', Codec: 'hevc' },
            { Type: 'Audio', Language: 'jpn', Codec: 'flac' },
            { Type: 'Subtitle', Language: 'eng' }
        ]
    };
    assert.equal(AudioClassifier.classify(itemWithStreams), 'Subbed');

    const itemDualAudio = {
        MediaStreams: [
            { Type: 'Video', Codec: 'h264' },
            { Type: 'Audio', Language: 'jpn' },
            { Type: 'Audio', Language: 'eng' }
        ]
    };
    assert.equal(AudioClassifier.classify(itemDualAudio), 'Subbed/Dubbed');
});

test('AudioClassifier: extracts audio languages from MediaSources array', () => {
    const itemWithSources = {
        MediaSources: [
            {
                MediaStreams: [
                    { Type: 'Audio', Language: 'eng' }
                ]
            }
        ]
    };
    assert.equal(AudioClassifier.classify(itemWithSources), 'Dubbed');
});

test('AudioClassifier: classifySeason returns common verdict or null on conflict', () => {
    const allSubbed = [
        { MediaStreams: [{ Type: 'Audio', Language: 'jpn' }] },
        { MediaStreams: [{ Type: 'Audio', Language: 'jpn' }] }
    ];
    assert.equal(AudioClassifier.classifySeason(allSubbed), 'Subbed');

    const mixedSeason = [
        { MediaStreams: [{ Type: 'Audio', Language: 'jpn' }] },
        { MediaStreams: [{ Type: 'Audio', Language: 'eng' }] }
    ];
    assert.equal(AudioClassifier.classifySeason(mixedSeason), null);

    const subbedWithUntagged = [
        { MediaStreams: [{ Type: 'Audio', Language: 'jpn' }] },
        { MediaStreams: [{ Type: 'Audio', Language: 'und' }] },
        { MediaStreams: [{ Type: 'Audio', Language: 'jpn' }] }
    ];
    assert.equal(AudioClassifier.classifySeason(subbedWithUntagged), 'Subbed');
});

test('AudioClassifier: undefined or technical audio descriptors are never classified as Dubbed', () => {
    // 1. Audio stream with technical title and no language tag
    const itemWithTechnicalStream = {
        MediaStreams: [
            { Type: 'Audio', DisplayTitle: 'AAC - Stereo', Codec: 'aac' }
        ]
    };
    assert.equal(AudioClassifier.classify(itemWithTechnicalStream), null);

    // 2. Audio stream with undefined language and 5.1 surround title
    const itemWithSurroundStream = {
        MediaStreams: [
            { Type: 'Audio', Language: 'und', DisplayTitle: 'FLAC 5.1', Codec: 'flac' }
        ]
    };
    assert.equal(AudioClassifier.classify(itemWithSurroundStream), null);

    // 3. Audio stream with Track 1 default title
    const itemWithTrackTitle = {
        MediaStreams: [
            { Type: 'Audio', Title: 'Track 1 - Stereo' }
        ]
    };
    assert.equal(AudioClassifier.classify(itemWithTrackTitle), null);

    // 4. Contrast: Japanese language in title is Subbed
    const itemWithJapaneseTitle = {
        MediaStreams: [
            { Type: 'Audio', DisplayTitle: 'Japanese (FLAC 2.0)' }
        ]
    };
    assert.equal(AudioClassifier.classify(itemWithJapaneseTitle), 'Subbed');

    // 5. Contrast: English language in title is Dubbed
    const itemWithEnglishTitle = {
        MediaStreams: [
            { Type: 'Audio', DisplayTitle: 'English (AAC Stereo)' }
        ]
    };
    assert.equal(AudioClassifier.classify(itemWithEnglishTitle), 'Dubbed');
});

