/**
 * ============================================================================
 * Litefin Tizen - Seerr Discovery Categories & Genre Helper
 * ============================================================================
 * Contains official Seerr image assets and mappings for:
 * - Movie Genre Duotone Backdrop Images
 * - TV Genre Duotone Backdrop Images
 * - Static Fallback Lists for Movie & TV Genres
 * - Movie Studios with TMDB Logo Paths
 * - Streaming Networks with TMDB Logo Paths
 * ============================================================================
 */

export const SEERR_MOVIE_GENRE_IMAGES = {
    28: 'https://image.tmdb.org/t/p/w1280_filter(duotone,991B1B,FCA5A5)/84FEpVVbSKYvKXDZJDZXOKBxCEm.jpg',
    12: 'https://image.tmdb.org/t/p/w1280_filter(duotone,480c8b,a96bef)/8sSKdEmlmqF4kJUd28SqthXC4yZ.jpg',
    16: 'https://image.tmdb.org/t/p/w1280_filter(duotone,032541,01b4e4)/c4TkvRGVrghFY2qFKJ0SUwqtAiW.jpg',
    35: 'https://image.tmdb.org/t/p/w1280_filter(duotone,92400E,FCD34D)/dUbP1HNdI0aCq1zgRJw28PWSqmk.jpg',
    80: 'https://image.tmdb.org/t/p/w1280_filter(duotone,1F2937,2864d2)/9FE5eD92WfVCiivM9Pq9GVSrlWk.jpg',
    99: 'https://image.tmdb.org/t/p/w1280_filter(duotone,065F46,6EE7B7)/gkkQRq9mh5E4DFlXPYKmvHDkMvk.jpg',
    18: 'https://image.tmdb.org/t/p/w1280_filter(duotone,9D174D,F9A8D4)/2YYOTdAI7vN4Iid3ckvtfr4NhTE.jpg',
    10751: 'https://image.tmdb.org/t/p/w1280_filter(duotone,777e0d,e4ed55)/kxQiIJ4gVcD3K6o14MJ72p5yRcE.jpg',
    14: 'https://image.tmdb.org/t/p/w1280_filter(duotone,1F2937,60A5FA)/yQIdU11DYQQp0neGtGtGxbGfRer.jpg',
    36: 'https://image.tmdb.org/t/p/w1280_filter(duotone,92400E,FCD34D)/zb6fM1CX41D9rF9hdgclu0peUmy.jpg',
    27: 'https://image.tmdb.org/t/p/w1280_filter(duotone,1F2937,D1D5DB)/7t6f6VxA2ZXbbZSVctgt7bZG2DI.jpg',
    10402: 'https://image.tmdb.org/t/p/w1280_filter(duotone,032541,01b4e4)/g7CHF8gTLGooTbP4GznIGwaqAGL.jpg',
    9648: 'https://image.tmdb.org/t/p/w1280_filter(duotone,5B21B6,C4B5FD)/zTnAnYIn0Iv3cn0ZHlzLhou3ybm.jpg',
    10749: 'https://image.tmdb.org/t/p/w1280_filter(duotone,9D174D,F9A8D4)/sd0RKOpnqESIWxU3sZwZhBsgAHl.jpg',
    878: 'https://image.tmdb.org/t/p/w1280_filter(duotone,1F2937,60A5FA)/1RhfevWmWCVHtEqxWBEjPOC5KG1.jpg',
    10770: 'https://image.tmdb.org/t/p/w1280_filter(duotone,991B1B,FCA5A5)/A7BiqPOKvGNalAZhFn1WfSeG9aO.jpg',
    53: 'https://image.tmdb.org/t/p/w1280_filter(duotone,1F2937,D1D5DB)/flxau5Iu7bChQHsESqvGZ3FQRaI.jpg',
    10752: 'https://image.tmdb.org/t/p/w1280_filter(duotone,1F2937,F87171)/zb6fM1CX41D9rF9hdgclu0peUmy.jpg',
    37: 'https://image.tmdb.org/t/p/w1280_filter(duotone,92400E,FCD34D)/gddUsvfyySrM5k8B8wwJy2VRlBx.jpg'
};

export const MOVIE_GENRES_FALLBACK = [
    { id: 28, name: 'Action' },
    { id: 12, name: 'Adventure' },
    { id: 16, name: 'Animation' },
    { id: 35, name: 'Comedy' },
    { id: 80, name: 'Crime' },
    { id: 99, name: 'Documentary' },
    { id: 18, name: 'Drama' },
    { id: 10751, name: 'Family' },
    { id: 14, name: 'Fantasy' },
    { id: 36, name: 'History' },
    { id: 27, name: 'Horror' },
    { id: 10402, name: 'Music' },
    { id: 9648, name: 'Mystery' },
    { id: 10749, name: 'Romance' },
    { id: 878, name: 'Science Fiction' },
    { id: 10770, name: 'TV Movie' },
    { id: 53, name: 'Thriller' },
    { id: 10752, name: 'War' },
    { id: 37, name: 'Western' }
];

export const SEERR_TV_GENRE_IMAGES = {
    10759: 'https://image.tmdb.org/t/p/w1280_filter(duotone,480c8b,a96bef)/2OMB0ynKlyIenMJWI2Dy9IWT4c.jpg',
    16: 'https://image.tmdb.org/t/p/w1280_filter(duotone,92400E,FCD34D)/aok7IhrbA83josNz9Dqh8tNA0Ao.jpg',
    35: 'https://image.tmdb.org/t/p/w1280_filter(duotone,032541,01b4e4)/hINekSpbcBxjnjGqmIm6I4bz2ab.jpg',
    80: 'https://image.tmdb.org/t/p/w1280_filter(duotone,1F2937,2864d2)/tc7canPSAn2X14hYi6Rl3gZm1o4.jpg',
    99: 'https://image.tmdb.org/t/p/w1280_filter(duotone,065F46,6EE7B7)/kezOZjTISHEyxHCtZdFZEUmGpjn.jpg',
    18: 'https://image.tmdb.org/t/p/w1280_filter(duotone,9D174D,F9A8D4)/dyFTt1a9ZpFdKE96kPlE9fQvXOJ.jpg',
    10751: 'https://image.tmdb.org/t/p/w1280_filter(duotone,777e0d,e4ed55)/4FqKFhF4BrNsrK3EdRpVJofVqCp.jpg',
    10762: 'https://image.tmdb.org/t/p/w1280_filter(duotone,032541,01b4e4)/c2oiRa7V3bQzof4wVGzLXtWJ5QU.jpg',
    9648: 'https://image.tmdb.org/t/p/w1280_filter(duotone,5B21B6,C4B5FD)/cvlLBcQWpO9X21jDHhgPJnE2aVq.jpg',
    10763: 'https://image.tmdb.org/t/p/w1280_filter(duotone,1F2937,D1D5DB)/2Ib8kvWa9gGhJrAfGlhIvbmtbWn.jpg',
    10764: 'https://image.tmdb.org/t/p/w1280_filter(duotone,552c01,d47c1d)/naUighMJIjHGQJIXSj7wMOgKbSd.jpg',
    10765: 'https://image.tmdb.org/t/p/w1280_filter(duotone,1F2937,60A5FA)/iFOkrSrJRwE27PwbyQeYLlMJXzw.jpg',
    10766: 'https://image.tmdb.org/t/p/w1280_filter(duotone,9D174D,F9A8D4)/eXPYbOfQ6YRgqgnsXTTEIL1clRs.jpg',
    10767: 'https://image.tmdb.org/t/p/w1280_filter(duotone,065F46,6EE7B7)/7jEnft2CLNbILWAiBRIBrXNN7Qh.jpg',
    10768: 'https://image.tmdb.org/t/p/w1280_filter(duotone,1F2937,F87171)/a97Q8f3dWiaMg2nq79zG5oZVotp.jpg',
    37: 'https://image.tmdb.org/t/p/w1280_filter(duotone,92400E,FCD34D)/gr45CCUujlK8r8HLe5xvw6FheDL.jpg'
};

export const TV_GENRES_FALLBACK = [
    { id: 10759, name: 'Action & Adventure' },
    { id: 16, name: 'Animation' },
    { id: 35, name: 'Comedy' },
    { id: 80, name: 'Crime' },
    { id: 99, name: 'Documentary' },
    { id: 18, name: 'Drama' },
    { id: 10751, name: 'Family' },
    { id: 10762, name: 'Kids' },
    { id: 9648, name: 'Mystery' },
    { id: 10763, name: 'News' },
    { id: 10764, name: 'Reality' },
    { id: 10765, name: 'Sci-Fi & Fantasy' },
    { id: 10766, name: 'Soap' },
    { id: 10767, name: 'Talk' },
    { id: 10768, name: 'War & Politics' },
    { id: 37, name: 'Western' }
];

export const MOVIE_STUDIOS = [
    { id: 2, name: 'Disney', logo: 'wdrCwmRnLFJhEoH8GSfymY85KHT.png' },
    { id: 127928, name: '20th Century', logo: 'h0rjX5vjW5r8yEnUBStFarjcLT4.png' },
    { id: 34, name: 'Sony Pictures', logo: 'GagSvqWlyPdkFHMfQ3pNq6ix9P.png' },
    { id: 174, name: 'Warner Bros.', logo: 'ky0xOc5OrhzkZ1N6KyUxacfQsCk.png' },
    { id: 33, name: 'Universal', logo: '8lvHyhjr8oUKOOy2dKXoALWKdp0.png' },
    { id: 4, name: 'Paramount', logo: 'fycMZt242LVjagMByZOLUGbCvv3.png' },
    { id: 420, name: 'Marvel', logo: 'hUzeosd33nzE5MCNsZxCGEKTXaQ.png' },
    { id: 9993, name: 'DC', logo: '2Tc1P3Ac8M479naPp1kYT3izLS5.png' },
    { id: 41077, name: 'A24', logo: '1ZXsGaFPgrgS6ZZGS37AqD5uU12.png' }
];

export const STREAMING_NETWORKS = [
    { id: 213, name: 'Netflix', logo: 'wwemzKWzjKYJFfCeiB57q3r4Bcm.png' },
    { id: 2739, name: 'Disney+', logo: 'gJ8VX6JSu3ciXHuC2dDGAo2lvwM.png' },
    { id: 1024, name: 'Prime Video', logo: 'ifhbNuuVnlwYy5oXA5VIb2YR8AZ.png' },
    { id: 2552, name: 'Apple TV+', logo: '4KAy34EHvRM25Ih8wb82AuGU7zJ.png' },
    { id: 453, name: 'Hulu', logo: 'pqUTCleNUiTLAVlelGxUgWn1ELh.png' },
    { id: 49, name: 'HBO', logo: 'tuomPhY2UtuPTqqFnKMVHvSb724.png' },
    { id: 4330, name: 'Paramount+', logo: 'fi83B1oztoS47xxcemFdPMhIzK.png' },
    { id: 3353, name: 'Peacock', logo: 'gIAcGTjKKr0KOHL5s4O36roJ8p7.png' }
];

/**
 * Builds normalized genre items for movie or TV slider tracks.
 * @param {Array<Object>|null} rawList - The API response list from Seerr.
 * @param {'movie'|'tv'} mediaType - Media type string.
 * @returns {Array<Object>} Normalized genre items array.
 */
export function buildGenreSliderItems(rawList, mediaType = 'movie') {
    const imagesMap = mediaType === 'tv' ? SEERR_TV_GENRE_IMAGES : SEERR_MOVIE_GENRE_IMAGES;
    const fallbackList = mediaType === 'tv' ? TV_GENRES_FALLBACK : MOVIE_GENRES_FALLBACK;

    // Use API payload if available, otherwise use static fallback list
    const sourceList = rawList && rawList.length > 0 ? rawList : fallbackList;

    return sourceList
        .map((g) => {
            if (!g || !g.id) return null;
            const customImage = imagesMap[g.id];
            const backdrop = g.backdrops?.[0] || g.backdropPath || '';
            const imageUrl = customImage || (backdrop ? `https://image.tmdb.org/t/p/w780${backdrop}` : '');

            return {
                Id: `seerr-genre-${mediaType}-${g.id}`,
                Name: g.name || '',
                Type: 'Folder',
                _imageUrl: imageUrl,
                _backdropUrl: imageUrl,
                _mediaType: mediaType,
                _genreId: g.id,
                _isGenreCard: true
            };
        })
        .filter((item) => item && item.Name);
}

/**
 * Builds normalized studio card items with TMDB logo duotone URLs.
 * @returns {Array<Object>}
 */
export function buildStudioItems() {
    return MOVIE_STUDIOS.map((s) => ({
        Id: `seerr-studio-${s.id}`,
        Name: s.name,
        Type: 'Folder',
        _imageUrl: s.logo ? `https://image.tmdb.org/t/p/w780_filter(duotone,ffffff,bababa)/${s.logo}` : '',
        _studioId: s.id,
        _isStudioCard: true
    }));
}

/**
 * Builds normalized network card items with TMDB logo duotone URLs.
 * @returns {Array<Object>}
 */
export function buildNetworkItems() {
    return STREAMING_NETWORKS.map((n) => ({
        Id: `seerr-network-${n.id}`,
        Name: n.name,
        Type: 'Folder',
        _imageUrl: n.logo ? `https://image.tmdb.org/t/p/w780_filter(duotone,ffffff,bababa)/${n.logo}` : '',
        _networkId: n.id,
        _isNetworkCard: true
    }));
}
