/**
 * ============================================================================
 * Litefin - MDBList Ratings Formatter & Provider Resolver
 * ============================================================================
 * Provides centralized provider mapping, decimal precision formatting,
 * scale normalization (0-10 vs 0-100), and HTML generation for ratings
 * from MDBList, WhatsOn, Simkl, and other metadata aggregators.
 *
 * Supports Jellyfin 12.0 float updates and maintains backwards compatibility
 * with legacy Jellyfin 10.xx server plugin responses.
 * ============================================================================
 */

/**
 * Provider alias normalization mapping.
 * Resolves sub-provider source keys to their canonical identity.
 */
const PROVIDER_ALIASES = {
    whatson_imdb: 'imdb',
    simkl_imdb: 'imdb',
    whatson_tmdb: 'tmdb',
    whatson_trakt: 'trakt',
    whatson_tomatoes: 'tomatoes',
    whatson_popcorn: 'popcorn',
    tomatoesaudience: 'popcorn',
    whatson_metacritic: 'metacritic',
    whatson_metacriticuser: 'metacriticuser',
    metacriticus: 'metacriticuser',
    whatson_letterboxd: 'letterboxd',
    simkl_mal: 'myanimelist',
    mal: 'myanimelist',
    allocine: 'allocine_critics'
};

/**
 * Provider display names for accessibility labels, tooltips, and ALTs.
 */
const PROVIDER_NAMES = {
    imdb: 'IMDb',
    imdb_top_250: 'IMDb Top 250',
    tmdb: 'TMDb',
    tomatoes: 'Rotten Tomatoes',
    popcorn: 'Rotten Tomatoes Audience',
    metacritic: 'Metacritic',
    metacriticuser: 'Metacritic User',
    metacriticms: 'Metacritic Must-See',
    trakt: 'Trakt',
    letterboxd: 'Letterboxd',
    simkl: 'Simkl',
    myanimelist: 'MyAnimeList',
    anilist: 'AniList',
    kinopoisk: 'Kinopoisk',
    senscritique: 'SensCritique',
    allocine_critics: 'AlloCiné Critics',
    allocine_users: 'AlloCiné Users',
    betaseries: 'BetaSeries',
    rogerebert: 'RogerEbert.com',
    tvmaze: 'TVmaze',
    mdblist: 'MDBList',
    whatson: 'WhatsOn'
};

/**
 * Normalizes a raw source key using the alias directory.
 *
 * @param {string} source - Provider source key
 * @returns {string} Normalized canonical provider key
 */
export function normalizeSourceKey(source) {
    // Convert source to lowercase string for consistent matching
    const s = String(source || '').trim().toLowerCase();
    return PROVIDER_ALIASES[s] || s;
}

/**
 * Safely parses any rating value (number, string, or decimal) into a float.
 * Returns null if the value is not valid or empty.
 *
 * @param {*} value - Raw value from API response
 * @returns {number|null} Numeric representation or null
 */
export function parseNumericValue(value) {
    // Check for null or undefined input
    if (value === null || value === undefined || value === '') {
        return null;
    }

    // Attempt float parsing
    const num = parseFloat(value);
    if (Number.isNaN(num) || !Number.isFinite(num)) {
        return null;
    }

    return num;
}

/**
 * Formats a provider rating value with typographic precision.
 * 
 * - 0-10 Scale (IMDb, Letterboxd, Simkl, MAL, etc.): Formats with 1 decimal place (e.g. 8.5, 7.0).
 * - 0-100 / Percentage Scale (RT, Trakt, Metacritic, MDBList): Formats as rounded integer (e.g. 85%).
 * - Bidirectional Fallback: Calculates from `score` if `value` is null, and vice versa.
 *
 * @param {string} source - Raw provider source key
 * @param {*} rawValue - Native provider value (0-10 or 0-100)
 * @param {*} rawScore - Normalized score (0-100)
 * @returns {{ text: string, numeric0to10: number, isPercentage: boolean }|null}
 */
export function formatRatingValue(source, rawValue, rawScore) {
    // Resolve canonical provider identity
    const canonical = normalizeSourceKey(source);
    const val = parseNumericValue(rawValue);
    const score = parseNumericValue(rawScore);

    // If neither value nor score is valid, we cannot format
    if (val === null && score === null) {
        return null;
    }

    // Determine scale family based on provider
    switch (canonical) {
        // --- Percentage / 0-100 Scale Providers ---
        case 'tomatoes':
        case 'popcorn':
        case 'trakt':
        case 'mdblist':
        case 'whatson': {
            // Prioritize score or scale up value if value is out of 10
            let pScore = score !== null ? score : val;
            if (pScore !== null && pScore <= 10 && pScore > 0) {
                pScore = pScore * 10;
            }
            if (pScore === null) return null;

            const rounded = Math.round(pScore);
            return {
                text: `${rounded}%`,
                numeric0to10: rounded / 10,
                isPercentage: true
            };
        }

        // --- Metacritic (0-100 integer score without % sign) ---
        case 'metacritic':
        case 'metacriticms': {
            let mScore = score !== null ? score : val;
            if (mScore !== null && mScore <= 10 && mScore > 0) {
                mScore = mScore * 10;
            }
            if (mScore === null) return null;

            const rounded = Math.round(mScore);
            return {
                text: `${rounded}`,
                numeric0to10: rounded / 10,
                isPercentage: false
            };
        }

        // --- TMDb (MDBList sometimes returns 0-100, WhatsOn returns decimal 0-10) ---
        case 'tmdb': {
            let tVal = val !== null ? val : (score !== null ? score / 10 : null);
            if (tVal !== null && tVal > 10) {
                tVal = tVal / 10;
            }
            if (tVal === null) return null;

            return {
                text: tVal.toFixed(1),
                numeric0to10: tVal,
                isPercentage: false
            };
        }

        // --- Metacritic User (0-10 decimal or 0-100) ---
        case 'metacriticuser': {
            let muVal = val !== null ? val : (score !== null ? score / 10 : null);
            if (muVal !== null && muVal > 10) {
                muVal = muVal / 10;
            }
            if (muVal === null) return null;

            return {
                text: muVal.toFixed(1),
                numeric0to10: muVal,
                isPercentage: false
            };
        }

        // --- Standard 0-10 Scale Providers (IMDb, Simkl, Letterboxd, MAL, AniList, Kinopoisk, etc.) ---
        case 'imdb':
        case 'imdb_top_250':
        case 'letterboxd':
        case 'simkl':
        case 'myanimelist':
        case 'anilist':
        case 'kinopoisk':
        case 'senscritique':
        case 'allocine_critics':
        case 'allocine_users':
        case 'betaseries':
        case 'rogerebert':
        case 'tvmaze':
        default: {
            let standardVal = val !== null ? val : (score !== null ? score / 10 : null);
            // If the provider returned a 100-scale value unexpectedly, normalize to 10
            if (standardVal !== null && standardVal > 10) {
                standardVal = standardVal / 10;
            }
            if (standardVal === null) return null;

            return {
                text: standardVal.toFixed(1),
                numeric0to10: standardVal,
                isPercentage: false
            };
        }
    }
}

/**
 * Resolves the appropriate icon asset filename and CSS classes for a given provider rating.
 *
 * @param {string} source - Provider source key
 * @param {*} rawValue - Native value
 * @param {*} rawScore - Score value
 * @param {Object} [features] - Optional WhatsOn/MDBList metadata features (e.g. IMDb Top 250 rank)
 * @returns {{ assetName: string|null, className: string, displayName: string, formattedText: string, numeric0to10: number }}
 */
export function getMdbProviderInfo(source, rawValue, rawScore = null, features = null) {
    // Resolve canonical identity and formatted numerical value
    const canonical = normalizeSourceKey(source);
    const formatted = formatRatingValue(source, rawValue, rawScore);
    const score0to100 = formatted ? formatted.numeric0to10 * 10 : 0;
    const displayName = PROVIDER_NAMES[canonical] || canonical.charAt(0).toUpperCase() + canonical.slice(1);

    // If value cannot be formatted, return empty descriptor
    if (!formatted) {
        return {
            assetName: null,
            className: `icon-${canonical}`,
            displayName,
            formattedText: '',
            numeric0to10: 0
        };
    }

    // 1. IMDb & IMDb Top 250 check
    if (canonical === 'imdb') {
        const topRanking = features?.imdb_top_ranking || features?.imdbTopRanking || features?.ImdbTopRanking;
        if (topRanking && parseInt(topRanking, 10) > 0 && parseInt(topRanking, 10) <= 250) {
            return {
                assetName: 'imdb_top_250.png',
                className: 'icon-imdb-top250',
                displayName: 'IMDb Top 250',
                formattedText: formatted.text,
                numeric0to10: formatted.numeric0to10
            };
        }
        return {
            assetName: 'IMDb.png',
            className: 'icon-imdb',
            displayName,
            formattedText: formatted.text,
            numeric0to10: formatted.numeric0to10
        };
    }

    // 2. Rotten Tomatoes Critics (Fresh vs Rotten vs Certified)
    if (canonical === 'tomatoes') {
        const isCertified = features?.rotten_tomatoes_critics_certified || features?.rottenTomatoesCriticsCertified;
        let assetName = 'Rotten_Tomatoes.png';
        if (isCertified) {
            assetName = 'rotten-tomatoes-certified.png';
        } else if (score0to100 < 60 && score0to100 > 0) {
            assetName = 'Rotten_Tomatoes_rotten.png';
        }

        return {
            assetName,
            className: 'icon-rt',
            displayName,
            formattedText: formatted.text,
            numeric0to10: formatted.numeric0to10
        };
    }

    // 3. Rotten Tomatoes Audience (Popcorn)
    if (canonical === 'popcorn') {
        const isAudienceCertified = features?.rotten_tomatoes_users_certified || features?.rottenTomatoesUsersCertified;
        let assetName = 'Rotten_Tomatoes_positive_audience.png';
        if (isAudienceCertified) {
            assetName = 'roten_tomatoes_ver.png';
        } else if (score0to100 < 60 && score0to100 > 0) {
            assetName = 'Rotten_Tomatoes_negative_audience.png';
        }

        return {
            assetName,
            className: 'icon-rt-aud',
            displayName,
            formattedText: formatted.text,
            numeric0to10: formatted.numeric0to10
        };
    }

    // 4. Metacritic & Metacritic Must-See
    if (canonical === 'metacritic') {
        const isMustSee = features?.metacritic_must_see || features?.metacriticMustSee;
        const assetName = isMustSee ? 'metacriticms.png' : 'Metacritic.png';
        return {
            assetName,
            className: isMustSee ? 'icon-metacritic-ms' : 'icon-metacritic',
            displayName: isMustSee ? 'Metacritic Must-See' : displayName,
            formattedText: formatted.text,
            numeric0to10: formatted.numeric0to10
        };
    }

    // 5. Metacritic User
    if (canonical === 'metacriticuser') {
        return {
            assetName: 'mus2.png',
            className: 'icon-metacritic-user',
            displayName,
            formattedText: formatted.text,
            numeric0to10: formatted.numeric0to10
        };
    }

    // 6. Direct Provider Asset Mappings
    const directAssetMap = {
        tmdb: { asset: 'TMDB.png', class: 'icon-tmdb' },
        trakt: { asset: 'Trakt.png', class: 'icon-trakt' },
        letterboxd: { asset: 'letterboxd.png', class: 'icon-letterboxd' },
        simkl: { asset: 'simkl.png', class: 'icon-simkl' },
        myanimelist: { asset: 'mal.png', class: 'icon-mal' },
        anilist: { asset: 'anilist.png', class: 'icon-anilist' },
        kinopoisk: { asset: 'kinopoisk.png', class: 'icon-kinopoisk' },
        senscritique: { asset: 'senscritique.png', class: 'icon-senscritique' },
        allocine_critics: { asset: 'allocine.png', class: 'icon-allocine' },
        allocine_users: { asset: 'allocine.png', class: 'icon-allocine-users' },
        betaseries: { asset: 'betaseries.png', class: 'icon-betaseries' },
        rogerebert: { asset: 'Roger_Ebert.png', class: 'icon-rogerebert' },
        tvmaze: { asset: 'tvmaze.png', class: 'icon-tvmaze' },
        mdblist: { asset: 'mdblist.svg', class: 'icon-mdblist' },
        whatson: { asset: 'whatson.png', class: 'icon-whatson' }
    };

    if (directAssetMap[canonical]) {
        const item = directAssetMap[canonical];
        return {
            assetName: item.asset,
            className: item.class,
            displayName,
            formattedText: formatted.text,
            numeric0to10: formatted.numeric0to10
        };
    }

    // Default generic fallback
    return {
        assetName: null,
        className: 'icon-default',
        displayName,
        formattedText: formatted.text,
        numeric0to10: formatted.numeric0to10
    };
}
