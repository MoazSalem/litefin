import assert from 'node:assert/strict';
import test from 'node:test';

/**
 * ============================================================================
 * Alphabet Quick-Jump & Sort Character Extraction Test Suite
 * ============================================================================
 * Verifies that items starting with brackets, parentheses, punctuation,
 * or numbers (such as "(T)Raumschiff Surprise", "[REC]", "#Alive", "10 Cloverfield")
 * are correctly indexed into the '#' character bucket rather than stripping
 * their leading punctuation and mistakenly jumping to an inner letter.
 * ============================================================================
 */

/**
 * Mirror implementation of _getItemSortChar from LibraryPage.js
 * for pure isolated unit testing without DOM dependencies.
 *
 * @param {Object} item - Media item object
 * @returns {string} Normalized uppercase character ('A'-'Z' or '#')
 */
function getItemSortChar(item) {
    if (!item) return '';

    // Prioritize server-calculated SortName, falling back to Name
    let name = (item.SortName || item.Name || '').trim();

    // If SortName was not provided by API, strip common English leading articles
    if (!item.SortName && name) {
        const match = name.match(/^(the|a|an)\s+/i);
        if (match) {
            name = name.slice(match[0].length).trim();
        }
    }

    if (!name) return '#';

    // Extract first character and strip combining diacritics/accents (e.g., 'É' -> 'E')
    const firstChar = name.charAt(0).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase();

    // Any non-alphabetic character (numbers, brackets, punctuation, symbols) belongs to '#'
    if (firstChar < 'A' || firstChar > 'Z') {
        return '#';
    }

    return firstChar;
}

/**
 * Mirror implementation of _findTargetCharIndex from LibraryPage.js
 *
 * @param {Array} items - Loaded items
 * @param {string} char - Target character ('#' or 'A'-'Z')
 * @returns {number} 0-based index or -1
 */
function findTargetCharIndex(items, char) {
    if (!items || !items.length) return -1;

    if (char === '#') {
        const idx = items.findIndex((item) => {
            const firstChar = getItemSortChar(item);
            return firstChar === '#' || (firstChar && (firstChar < 'A' || firstChar > 'Z'));
        });
        return idx !== -1 ? idx : 0;
    }

    const targetChar = char.toUpperCase();

    // 1. Direct match: first item starting with this letter
    const exactIdx = items.findIndex((item) => {
        return getItemSortChar(item) === targetChar;
    });
    if (exactIdx !== -1) return exactIdx;

    // 2. Nearest successor match: first item starting with a letter greater than target
    const nextIdx = items.findIndex((item) => {
        const firstChar = getItemSortChar(item);
        return firstChar >= 'A' && firstChar <= 'Z' && firstChar > targetChar;
    });

    return nextIdx;
}

test('Item sort character handles titles starting with brackets and parentheses as #', () => {
    // Parentheses bracket title: should NOT strip "(" and jump to "T"
    const movieTraumschiff = {
        Id: '1',
        Name: '(T)Raumschiff Surprise - Periode 1',
        SortName: '(T)Raumschiff Surprise - Periode 1'
    };
    assert.strictEqual(
        getItemSortChar(movieTraumschiff),
        '#',
        '(T)Raumschiff Surprise must be indexed under #, not T'
    );

    // Parentheses title without SortName provided by server
    const movieTraumschiffNoSort = {
        Id: '1b',
        Name: '(T)Raumschiff Surprise - Periode 1'
    };
    assert.strictEqual(
        getItemSortChar(movieTraumschiffNoSort),
        '#',
        'Title starting with ( must be indexed under # even if SortName is missing'
    );

    // Square brackets
    const movieRec = {
        Id: '2',
        Name: '[REC]',
        SortName: '[REC]'
    };
    assert.strictEqual(
        getItemSortChar(movieRec),
        '#',
        '[REC] must be indexed under #'
    );

    // Numerical title
    const movieTen = {
        Id: '3',
        Name: '10 Cloverfield Lane',
        SortName: '0000000010 cloverfield lane'
    };
    assert.strictEqual(
        getItemSortChar(movieTen),
        '#',
        '10 Cloverfield Lane must be indexed under #'
    );

    // Quotes and symbols
    const movieSymbol = {
        Id: '4',
        Name: '"A Beautiful Mind"',
        SortName: '"A Beautiful Mind"'
    };
    assert.strictEqual(
        getItemSortChar(movieSymbol),
        '#',
        'Quotation-prefixed titles must map to # when SortName preserves quotes'
    );
});

test('Item sort character handles standard alphabetical and diacritic titles correctly', () => {
    // Regular title with server-side SortName
    const movieMatrix = {
        Id: '5',
        Name: 'The Matrix',
        SortName: 'matrix'
    };
    assert.strictEqual(
        getItemSortChar(movieMatrix),
        'M',
        'The Matrix with SortName "matrix" should be M'
    );

    // Regular title fallback without SortName (strips "The ")
    const movieMatrixNoSort = {
        Id: '6',
        Name: 'The Matrix'
    };
    assert.strictEqual(
        getItemSortChar(movieMatrixNoSort),
        'M',
        'The Matrix without SortName should strip "The " and index as M'
    );

    // Diacritic / accent title
    const movieAmelie = {
        Id: '7',
        Name: 'Éléphant',
        SortName: 'Éléphant'
    };
    assert.strictEqual(
        getItemSortChar(movieAmelie),
        'E',
        'Éléphant should normalize to E'
    );
});

test('Alphabet target index scanner correctly distinguishes # from T for bracketed items', () => {
    const items = [
        { Id: '1', Name: '(T)Raumschiff Surprise', SortName: '(T)Raumschiff Surprise' },
        { Id: '2', Name: '10 Cloverfield Lane', SortName: '0000000010 cloverfield lane' },
        { Id: '3', Name: 'Avatar', SortName: 'avatar' },
        { Id: '4', Name: 'Taken', SortName: 'taken' },
        { Id: '5', Name: 'The Terminator', SortName: 'terminator' }
    ];

    // Querying '#' must return index 0 ((T)Raumschiff)
    assert.strictEqual(
        findTargetCharIndex(items, '#'),
        0,
        'Index for # should be the first item starting with brackets/numbers'
    );

    // Querying 'T' must NOT return index 0 ((T)Raumschiff), it must return index 3 (Taken)
    assert.strictEqual(
        findTargetCharIndex(items, 'T'),
        3,
        'Index for T must point to Taken, not (T)Raumschiff'
    );

    // Querying 'A' must return index 2 (Avatar)
    assert.strictEqual(
        findTargetCharIndex(items, 'A'),
        2,
        'Index for A must point to Avatar'
    );
});
