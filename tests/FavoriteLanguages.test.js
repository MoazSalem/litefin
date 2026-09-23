import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

// Read LanguageManager source directly
const source = readFileSync(new URL('../src/utils/LanguageManager.js', import.meta.url), 'utf8');

function setup(initialFavorites = []) {
    const storageMap = new Map();
    if (initialFavorites && initialFavorites.length > 0) {
        storageMap.set('pref:favoriteLanguages', JSON.stringify(initialFavorites));
    }

    const emittedEvents = [];

    const context = vm.createContext({
        storage: {
            getItem: (key) => storageMap.get(key) || null,
            setItem: (key, val) => storageMap.set(key, String(val)),
            removeItem: (key) => storageMap.delete(key)
        },
        eventBus: {
            emit: (event, data) => {
                emittedEvents.push({ event, data });
            }
        },
        logger: {
            create: () => ({
                info: () => {},
                debug: () => {},
                warn: () => {},
                error: () => {}
            })
        }
    });

    const code = `
        const storage = this.storage;
        const eventBus = this.eventBus;
        const logger = this.logger;
        ${source
            .replace(/import\s+.*?;/g, '')
            .replace(/export\s+const\s+languageManager\s*=\s*new\s+LanguageManager\(\);/, '')
            .replace(/export\s+default\s+languageManager;/, '')}
        
        new LanguageManager();
    `;

    const manager = vm.runInContext(code, context);
    return { manager, storageMap, emittedEvents };
}

test('LanguageManager - initial state without favorites', () => {
    const { manager } = setup();

    assert.equal(manager.hasFavorites(), false);
    assert.equal(manager.getFavorites().length, 0);

    // filterOptions returns all options when no favorites set
    const options = [
        { value: 'eng', label: 'English' },
        { value: 'spa', label: 'Spanish' },
        { value: 'fra', label: 'French' }
    ];
    const filtered = manager.filterOptions(options);
    assert.equal(filtered.length, 3);
    assert.equal(filtered[0].value, 'eng');
});

test('LanguageManager - add, toggle, and clear favorites', () => {
    const { manager, emittedEvents } = setup();

    // Add English
    manager.addFavorite('eng');
    assert.equal(manager.hasFavorites(), true);
    assert.equal(manager.isFavorite('eng'), true);
    assert.equal(manager.isFavorite('en'), true);
    assert.equal(manager.isFavorite('English'), true);

    // Toggle Spanish on
    const nowFav = manager.toggleFavorite('spa');
    assert.equal(nowFav, true);
    assert.equal(manager.isFavorite('spa'), true);
    assert.equal(manager.isFavorite('es'), true);

    // Toggle Spanish off
    const nowRemoved = manager.toggleFavorite('spa');
    assert.equal(nowRemoved, false);
    assert.equal(manager.isFavorite('spa'), false);

    // Clear favorites
    manager.clearFavorites();
    assert.equal(manager.hasFavorites(), false);
    assert.equal(manager.getFavorites().length, 0);
});

test('LanguageManager - option filtering preserves special options', () => {
    const { manager } = setup([
        { code: 'eng', twoLetter: 'en', name: 'English' },
        { code: 'jpn', twoLetter: 'ja', name: 'Japanese' }
    ]);

    const dropdownOptions = [
        { value: 'none', label: 'None' },
        { value: 'Default', label: 'Default' },
        { value: 'eng', label: 'English' },
        { value: 'fra', label: 'French' },
        { value: 'jpn', label: 'Japanese' },
        { value: 'rus', label: 'Russian' }
    ];

    const filtered = manager.filterOptions(dropdownOptions);
    const filteredValues = filtered.map(o => o.value);

    // Should include special options (none, Default) + favorites (eng, jpn)
    assert.deepEqual(filteredValues, ['none', 'Default', 'eng', 'jpn']);
});

test('LanguageManager - track matching for audio and subtitle streams', () => {
    const { manager } = setup([
        { code: 'ara', twoLetter: 'ar', name: 'Arabic' },
        { code: 'eng', twoLetter: 'en', name: 'English' }
    ]);

    // English audio track
    assert.equal(manager.isFavoriteTrack({ Language: 'eng', DisplayTitle: 'English (DTS-HD MA 5.1)' }), true);

    // Arabic subtitle track
    assert.equal(manager.isFavoriteTrack({ Language: 'ara', DisplayTitle: 'Arabic [SubRip]' }), true);

    // French audio track
    assert.equal(manager.isFavoriteTrack({ Language: 'fra', DisplayTitle: 'French (Stereo)' }), false);

    // German audio track with 'ger' alias
    assert.equal(manager.isFavoriteTrack({ Language: 'ger', DisplayTitle: 'German' }), false);
});

test('LanguageManager - cross-format ISO 639 matching for Albanian, Akan, Afrikaans, Basque', () => {
    const { manager } = setup();

    // Favorite Albanian using 3-letter ISO code from Jellyfin cultures
    manager.addFavorite({ code: 'sqi', twoLetter: 'sq', name: 'Albanian' });
    // Favorite Akan
    manager.addFavorite({ code: 'aka', twoLetter: 'ak', name: 'Akan' });
    // Favorite Afrikaans
    manager.addFavorite('afr');

    // Matching against 2-letter UI option { value: 'sq', label: 'Shqip' }
    assert.equal(manager.isFavorite({ value: 'sq', label: 'Shqip' }), true);

    // Matching against 2-letter UI option { value: 'ak', label: 'Akan' }
    assert.equal(manager.isFavorite({ value: 'ak', label: 'Akan' }), true);

    // Matching against 2-letter UI option { value: 'af', label: 'Afrikaans' }
    assert.equal(manager.isFavorite({ value: 'af', label: 'Afrikaans' }), true);

    // Matching against string code
    assert.equal(manager.isFavorite('sq'), true);
    assert.equal(manager.isFavorite('sqi'), true);
    assert.equal(manager.isFavorite('alb'), true);
    assert.equal(manager.isFavorite('albanian'), true);
});

test('LanguageManager - registerCultures dynamically indexes unknown server cultures', () => {
    const { manager } = setup();

    manager.registerCultures([
        {
            ThreeLetterISOLanguageName: 'xyz',
            TwoLetterISOLanguageName: 'xz',
            DisplayName: 'Custom Language',
            ThreeLetterISOLanguageNames: ['xyz', 'xzz']
        }
    ]);

    manager.addFavorite('xyz');

    // Both 2-letter and 3-letter match
    assert.equal(manager.isFavorite('xz'), true);
    assert.equal(manager.isFavorite('xyz'), true);
    assert.equal(manager.isFavorite('xzz'), true);
    assert.equal(manager.isFavorite({ value: 'xz', label: 'Custom Language' }), true);
});

test('LanguageManager - regression: favoriting Arabic does not falsely match Euskara (substring false positives)', () => {
    const { manager } = setup();

    // Add only Arabic to favorites
    manager.addFavorite('ara');

    // Verify Arabic matches properly across formats
    assert.equal(manager.isFavorite('ara'), true);
    assert.equal(manager.isFavorite('ar'), true);
    assert.equal(manager.isFavorite('Arabic'), true);
    assert.equal(manager.isFavorite('العربية'), true);
    assert.equal(manager.isFavorite({ value: 'ar', label: 'العربية' }), true);
    assert.equal(manager.isFavorite({ value: 'ara', label: 'Arabic' }), true);

    // Verify Basque / Euskara is NOT matched as favorite
    assert.equal(manager.isFavorite('Euskara'), false);
    assert.equal(manager.isFavorite('eus'), false);
    assert.equal(manager.isFavorite('eu'), false);
    assert.equal(manager.isFavorite({ value: 'eu', label: 'Euskara' }), false);
    assert.equal(manager.isFavoriteTrack({ Language: 'eus', DisplayTitle: 'Euskara' }), false);

    // Verify filtering a list with Arabic and Euskara options
    const options = [
        { value: 'ar', label: 'العربية' },
        { value: 'eu', label: 'Euskara' },
        { value: 'en', label: 'English' }
    ];
    const filtered = manager.filterOptions(options);
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].value, 'ar');
});

test('LanguageManager - regression: token matching avoids false substrings across other languages', () => {
    const { manager } = setup();

    // Favorite Punjabi ('pan')
    manager.addFavorite('pan');

    // Spanish ('spa' / 'Spanish' / 'Español') must NOT match 'pan'
    assert.equal(manager.isFavorite('spa'), false);
    assert.equal(manager.isFavorite('Spanish'), false);
    assert.equal(manager.isFavorite({ value: 'es', label: 'Spanish' }), false);
    assert.equal(manager.isFavoriteTrack({ Language: 'spa', DisplayTitle: 'Spanish (Stereo)' }), false);

    // Clear and favorite Norwegian ('nor')
    manager.clearFavorites();
    manager.addFavorite('nor');

    // Titles containing words with 'nor' as substring should not match unless whole token
    assert.equal(manager.isFavoriteTrack({ DisplayTitle: 'North American Version' }), false);
    assert.equal(manager.isFavoriteTrack({ DisplayTitle: 'Norwegian (Stereo)' }), true);
});

