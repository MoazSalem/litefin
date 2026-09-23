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
 * Resolves sub-provider source keys and user-input variants to their canonical identity.
 */
const PROVIDER_ALIASES = {
    whatson_imdb: 'imdb',
    simkl_imdb: 'imdb',
    whatson_tmdb: 'tmdb',
    whatson_trakt: 'trakt',
    whatson_tomatoes: 'tomatoes',
    rt: 'tomatoes',
    rottentomatoes: 'tomatoes',
    rotten_tomatoes: 'tomatoes',
    whatson_popcorn: 'popcorn',
    tomatoesaudience: 'popcorn',
    audience: 'popcorn',
    rotten_tomatoes_audience: 'popcorn',
    whatson_metacritic: 'metacritic',
    whatson_metacriticuser: 'metacriticuser',
    metacriticus: 'metacriticuser',
    metacritic_user: 'metacriticuser',
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
 * @param {Object} [settings] - Optional WebClientSettings configuration from server
 * @returns {{ assetName: string|null, className: string, displayName: string, formattedText: string, numeric0to10: number }}
 */
export function getMdbProviderInfo(source, rawValue, rawScore = null, features = null, settings = null) {
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

    // 1. IMDb & IMDb Top 250 check (honors enableImdbTop250Icon setting)
    if (canonical === 'imdb') {
        const topRanking = features?.imdb_top_ranking || features?.imdbTopRanking || features?.ImdbTopRanking;
        const allowTop250 = settings ? settings.top250 === true : true;
        if (allowTop250 && topRanking && parseInt(topRanking, 10) > 0 && parseInt(topRanking, 10) <= 250) {
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

    // 2. Rotten Tomatoes Critics (Fresh vs Rotten vs Certified, honors enableWebExtraTomatoesCertified setting)
    if (canonical === 'tomatoes') {
        const isCertified = features?.rotten_tomatoes_critics_certified || features?.rottenTomatoesCriticsCertified;
        const allowCertified = settings ? settings.extras?.tc === true : true;
        let assetName = 'Rotten_Tomatoes.png';
        if (allowCertified && isCertified) {
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

    // 3. Rotten Tomatoes Audience (Popcorn, honors enableWebExtraRottenVerified setting)
    if (canonical === 'popcorn') {
        const isAudienceCertified = features?.rotten_tomatoes_users_certified || features?.rottenTomatoesUsersCertified;
        const allowAudienceCertified = settings ? settings.extras?.rv === true : true;
        let assetName = 'Rotten_Tomatoes_positive_audience.png';
        if (allowAudienceCertified && isAudienceCertified) {
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

    // 4. Metacritic & Metacritic Must-See (honors enableWebExtraMetacriticMustSee setting)
    if (canonical === 'metacritic') {
        const isMustSee = features?.metacritic_must_see || features?.metacriticMustSee;
        const allowMustSee = settings ? settings.extras?.mc === true : true;
        const assetName = allowMustSee && isMustSee ? 'metacriticms.png' : 'Metacritic.png';
        return {
            assetName,
            className: allowMustSee && isMustSee ? 'icon-metacritic-ms' : 'icon-metacritic',
            displayName: allowMustSee && isMustSee ? 'Metacritic Must-See' : displayName,
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

/**
 * Parses a comma-, semicolon-, or newline-separated string of source names
 * into a deduplicated list of lowercase strings.
 *
 * @param {string} raw - Raw delimited string
 * @returns {Array<string>} Unique list of parsed sources
 */
export function parseSourcesList(raw) {
    if (!raw) return [];
    const parts = String(raw)
        .split(/[\n,;]+/)
        .map((x) => (x || '').trim().toLowerCase())
        .filter(Boolean);

    const seen = Object.create(null);
    const out = [];
    for (const p of parts) {
        if (!seen[p]) {
            seen[p] = true;
            out.push(p);
        }
    }
    return out;
}

/**
 * Normalizes raw server WebClientSettings response into a structured configuration object.
 * Matches Jellyfin Web's WebUiInjector configuration parser.
 *
 * @param {Object} [cfg] - Raw settings object from /Plugins/MdbListRatings/WebClientSettings
 * @returns {Object} Normalized settings object
 */
export function normalizeWebClientSettings(cfg = {}) {
    const rawMode = cfg?.webAllRatingsMode || cfg?.WebAllRatingsMode;
    const mode = (typeof rawMode === 'number' && rawMode === 1) || String(rawMode).toLowerCase() === 'custom'
        ? 'custom'
        : 'all';

    const orderRaw = cfg?.webAllRatingsOrderCsv || cfg?.WebAllRatingsOrderCsv || cfg?.webAllRatingsOrder || '';
    const order = parseSourcesList(orderRaw);

    const awardKeysRaw = cfg?.webAwardKeysCsv || cfg?.WebAwardKeysCsv || '';
    const awardKeys = parseSourcesList(awardKeysRaw);

    return {
        enabled: cfg?.enableWebAllRatingsFromCache !== false,
        mode,
        order,
        top250: Boolean(cfg?.enableImdbTop250Icon ?? cfg?.EnableImdbTop250Icon ?? false),
        extras: {
            tc: Boolean(cfg?.enableWebExtraTomatoesCertified ?? cfg?.EnableWebExtraTomatoesCertified ?? false),
            rv: Boolean(cfg?.enableWebExtraRottenVerified ?? cfg?.EnableWebExtraRottenVerified ?? false),
            mc: Boolean(cfg?.enableWebExtraMetacriticMustSee ?? cfg?.EnableWebExtraMetacriticMustSee ?? false),
            al: Boolean(cfg?.enableWebExtraAniList ?? cfg?.EnableWebExtraAniList ?? false)
        },
        awards: {
            enabled: Boolean(cfg?.enableWebAwardBadges ?? cfg?.EnableWebAwardBadges ?? true),
            keys: awardKeys,
            nominations: Boolean(cfg?.enableWebAwardNominationsBadge ?? cfg?.EnableWebAwardNominationsBadge ?? false)
        }
    };
}

/**
 * Deduplicates ratings by equivalent provider family (e.g. IMDb vs WhatsOn IMDb vs Simkl IMDb).
 * Preserves the one with the highest vote count, or first occurrence if votes are tied/missing.
 * Matches Jellyfin Web WebUiInjector deduplication behavior.
 *
 * @param {Array} ratings - Raw ratings array from API response
 * @returns {Array} Deduplicated ratings array
 */
export function dedupeEquivalentRatings(ratings) {
    const input = Array.isArray(ratings) ? ratings : [];
    const bestByFamily = Object.create(null);
    const familyOrder = [];

    for (const r of input) {
        if (!r) continue;
        const rawSource = r.source || r.Source;
        if (!rawSource) continue;

        const family = normalizeSourceKey(rawSource);
        const existing = bestByFamily[family];

        if (!existing) {
            bestByFamily[family] = r;
            familyOrder.push(family);
            continue;
        }

        // Compare votes: known positive vote count beats unknown (-1)
        const existingVotes = Number(existing.votes ?? existing.Votes ?? -1);
        const candidateVotes = Number(r.votes ?? r.Votes ?? -1);
        const ev = Number.isFinite(existingVotes) ? existingVotes : -1;
        const cv = Number.isFinite(candidateVotes) ? candidateVotes : -1;

        if (cv > ev) {
            bestByFamily[family] = r;
        }
    }

    const result = [];
    for (const family of familyOrder) {
        const winner = bestByFamily[family];
        if (winner) {
            result.push(winner);
        }
    }

    return result;
}

/**
 * Filters and orders ratings according to user configuration from server WebClientSettings.
 * 
 * If mode is 'custom', only providers specified in settings.order are returned, in that order.
 * If mode is 'all', all deduplicated providers are returned.
 *
 * @param {Array} ratings - Raw ratings array from API response
 * @param {Object} [settings] - Normalized WebClientSettings from normalizeWebClientSettings()
 * @returns {Array} Filtered and ordered ratings array
 */
export function filterAndOrderRatings(ratings, settings = null) {
    // 1. Always deduplicate equivalent providers first (e.g. whatson_imdb vs imdb)
    const deduped = dedupeEquivalentRatings(ratings);

    // 2. If settings are not in custom mode or no order is specified, return deduped list
    if (!settings || settings.mode !== 'custom' || !Array.isArray(settings.order) || settings.order.length === 0) {
        return deduped;
    }

    // 3. In custom mode, build a map by canonical family
    const familyMap = Object.create(null);
    for (const r of deduped) {
        const rawSource = r.source || r.Source;
        if (!rawSource) continue;
        const family = normalizeSourceKey(rawSource);
        if (!familyMap[family]) {
            familyMap[family] = r;
        }
    }

    // 4. Extract ratings strictly following the user's custom order
    const ordered = [];
    const usedFamilies = Object.create(null);

    for (const orderKey of settings.order) {
        const requestedFamily = normalizeSourceKey(orderKey);
        if (requestedFamily && familyMap[requestedFamily] && !usedFamilies[requestedFamily]) {
            ordered.push(familyMap[requestedFamily]);
            usedFamilies[requestedFamily] = true;
        }
    }

    return ordered;
}
