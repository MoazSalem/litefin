/**
 * ============================================================================
 * Litefin - Quick Play
 * ============================================================================
 * Resolves an arbitrary library item (by id) into a directly playable item and
 * launches playback. This is the behaviour bound to the remote's dedicated
 * Play / Play-Pause key when a media card is focused on a browse page (Home,
 * Library, Favorites, Search, …).
 *
 * It mirrors the resolution logic of DetailsPage._play() so that pressing Play
 * on a Series/Season card behaves like the official Jellyfin app: it jumps
 * straight to the "Next Up" / first-unwatched episode instead of merely opening
 * the details page. The actual launch is delegated to the global `player:play`
 * EventBus handler in App.js (which owns navigation, SyncPlay, and audio-
 * container resolution), so this module only needs to resolve the *video*
 * container types it can't handle.
 * ============================================================================
 */

import { api } from '../api/index.js';
import { eventBus } from '../core/EventBus.js';
import { logger } from './Logger.js';

const log = logger.create('QuickPlay');

/* Types that are never directly playable from a browse card — ignore the key. */
const NON_PLAYABLE = ['Person', 'CollectionFolder', 'UserView', 'Folder', 'Genre', 'Studio', 'Year'];

/**
 * Resolve an item id (or partial item) to a playable item and launch it.
 * @param {string|Object} itemOrId - Item id, or an object with an `Id` field.
 * @returns {Promise<boolean>} True if a playback request was emitted.
 */
export async function quickPlayItem(itemOrId) {
    if (!itemOrId) return false;

    const id = typeof itemOrId === 'string' ? itemOrId : itemOrId.Id;
    if (!id) return false;

    // Fetch the full item so we get a reliable Type + UserData (resume position)
    // and the metadata needed to resolve container types below.
    let item;
    try {
        item = await api.getItem(id);
    } catch (e) {
        log.error('Failed to fetch item for quick play:', id, e?.message || e);
        return false;
    }
    if (!item || !item.Type) {
        log.warn('Quick play aborted — item not found or has no type:', id);
        return false;
    }

    if (NON_PLAYABLE.includes(item.Type)) {
        log.debug(`"${item.Type}" is not directly playable — ignoring Play key`);
        return false;
    }

    let itemToPlay = item;
    let resume = hasResumePosition(item);

    try {
        if (item.Type === 'Series') {
            const resolved = await resolveSeries(item);
            if (!resolved) return false;
            ({ item: itemToPlay, resume } = resolved);
        } else if (item.Type === 'Season') {
            const resolved = await resolveSeason(item);
            if (!resolved) return false;
            ({ item: itemToPlay, resume } = resolved);
        } else if (item.Type === 'BoxSet') {
            const resolved = await resolveBoxSet(item);
            if (!resolved) return false;
            itemToPlay = resolved;
            resume = hasResumePosition(resolved);
        } else if (item.Type === 'Program' && item.ChannelId) {
            // Live TV Program → play the parent Channel (mirrors DetailsPage._play).
            itemToPlay = { Id: item.ChannelId, Type: 'TvChannel', Name: item.ChannelName || item.Name };
            resume = false;
        }
        // Direct-playable video/audio types fall through unchanged. Audio
        // containers (MusicAlbum, …) also fall through — the global
        // player:play handler in App.js resolves those to their first track.
        // Playlist items are likewise resolved via getPlaylistItems() in App.js.
    } catch (e) {
        log.error(`Failed to resolve a playable item for ${item.Type}:`, e?.message || e);
        return false;
    }

    if (!itemToPlay?.Id) {
        log.warn('Quick play aborted — no resolved item id');
        return false;
    }

    log.info(`Quick play: launching "${itemToPlay.Name}" (${itemToPlay.Type}, resume=${resume})`);
    // fromBrowse tells App.js to PUSH the player (not replace the browse page) so
    // that stopping playback returns to the page we launched from — not a Details
    // page the user never opened.
    eventBus.emit('player:play', { item: itemToPlay, resume, fromBrowse: true });
    return true;
}

/** True when an item has saved playback progress to resume from. */
function hasResumePosition(item) {
    return (item?.UserData?.PlaybackPositionTicks || 0) > 0;
}

/**
 * Series → "Next Up" episode (resume if it has progress), else first episode.
 */
async function resolveSeries(series) {
    let nextUp;
    if (api.isEmby()) {
        // Emby's /Shows/NextUp ignores SeriesId — fetch oldest unplayed episode instead.
        nextUp = await api.getItems({
            ParentId: series.Id,
            Recursive: true,
            IncludeItemTypes: 'Episode',
            Limit: 1,
            Filters: 'IsUnplayed',
            SortBy: 'ParentIndexNumber,IndexNumber',
            Fields: 'PrimaryImageAspectRatio,BasicSyncInfo,SeriesThumbImageTag,ParentThumbImageTag,BackdropImageTags,ParentBackdropImageTags'
        });
    } else {
        nextUp = await api.getNextUp({ SeriesId: series.Id, Limit: 1 });
    }

    if (nextUp?.Items?.length > 0) {
        const ep = nextUp.Items[0];
        return { item: ep, resume: hasResumePosition(ep) };
    }

    // Fallback: first episode ever (e.g. S1E1).
    const firstEp = await api.getItems({
        ParentId: series.Id,
        Recursive: true,
        IncludeItemTypes: 'Episode',
        Limit: 1,
        SortBy: 'ParentIndexNumber,IndexNumber'
    });
    if (firstEp?.Items?.length > 0) {
        const ep = firstEp.Items[0];
        return { item: ep, resume: hasResumePosition(ep) };
    }

    log.warn('No episodes found for series:', series.Id);
    return null;
}

/**
 * Season → first unwatched episode (else first episode). Tagged with the season
 * context so PlayQueue sequences the rest of the season for auto-advance.
 */
async function resolveSeason(season) {
    const result = await api.getItems({
        ParentId: season.Id,
        Recursive: true,
        IncludeItemTypes: 'Episode',
        SortBy: 'ParentIndexNumber,IndexNumber',
        Fields: 'UserData'
    });
    const episodes = result?.Items || [];
    if (episodes.length === 0) {
        log.warn('No episodes found for season:', season.Id);
        return null;
    }

    const target = { ...(episodes.find((ep) => !ep.UserData?.Played) || episodes[0]) };
    target.contextType = 'season';
    target.contextId = season.Id;
    return { item: target, resume: hasResumePosition(target) };
}

/**
 * BoxSet → first child (Movie preferred, then Episode, then Audio), tagged with
 * the boxset context + sort order so PlayQueue builds the full ordered queue.
 */
async function resolveBoxSet(boxset) {
    let sortBy = 'PremiereDate';
    if (boxset.DisplayOrder === 'SortName') sortBy = 'SortName';
    else if (boxset.DisplayOrder === 'Default') sortBy = 'DateModified';

    const params = { Recursive: true, Limit: 1, SortBy: sortBy, SortOrder: 'Ascending', ParentId: boxset.Id };
    const [movies, episodes, audio] = await Promise.all([
        api.getItems({ ...params, IncludeItemTypes: 'Movie' }),
        api.getItems({ ...params, IncludeItemTypes: 'Episode' }),
        api.getItems({ ...params, IncludeItemTypes: 'Audio' })
    ]);

    const target = movies?.Items?.[0] || episodes?.Items?.[0] || audio?.Items?.[0];
    if (!target) {
        log.warn('BoxSet is empty, nothing to play:', boxset.Id);
        return null;
    }

    target.contextType = 'boxset';
    target.contextId = boxset.Id;
    target.boxsetSortBy = sortBy;
    return target;
}

export default quickPlayItem;
