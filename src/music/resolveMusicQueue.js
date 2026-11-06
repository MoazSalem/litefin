export const ALBUM_TRACK_SORT = 'ParentIndexNumber,IndexNumber,SortName';
export const COLLECTION_TRACK_SORT = `Album,${ALBUM_TRACK_SORT}`;
const MAX_QUEUE_TRACKS = 1000;

const CONTAINER_FILTERS = {
    MusicAlbum: { key: 'AlbumIds', sortBy: ALBUM_TRACK_SORT },
    MusicArtist: { key: 'ArtistIds', sortBy: COLLECTION_TRACK_SORT },
    MusicGenre: { key: 'GenreIds', sortBy: COLLECTION_TRACK_SORT }
};

async function queryTracks(getItems, filter, sortBy) {
    const result = await getItems({
        ...filter,
        IncludeItemTypes: 'Audio',
        Recursive: true,
        SortBy: sortBy,
        SortOrder: 'Ascending',
        Limit: MAX_QUEUE_TRACKS
    });
    return result?.Items || [];
}

async function containerTracks(getItems, containerId, { key, sortBy }) {
    const tracks = await queryTracks(getItems, { [key]: containerId }, sortBy);
    if (tracks.length > 0) return tracks;
    return queryTracks(getItems, { ParentId: containerId }, sortBy);
}

function songAlbumId({ item, contextType, contextId }) {
    const type = contextType || item.contextType;
    const id = contextId || item.contextId;
    if (type === 'music' && id) return id;
    return item.AlbumId || null;
}

async function songQueue(request, getItems) {
    const alone = { tracks: [request.item], startIndex: 0 };
    const albumId = songAlbumId(request);
    if (!albumId) return alone;
    try {
        const tracks = await containerTracks(getItems, albumId, CONTAINER_FILTERS.MusicAlbum);
        const startIndex = tracks.findIndex((track) => track.Id === request.item.Id);
        return startIndex === -1 ? alone : { tracks, startIndex };
    } catch {
        return alone;
    }
}

export async function resolveMusicQueue(request, { getItems, random = Math.random }) {
    const { item, shuffle = false } = request;
    if (item.Type === 'Audio') return songQueue(request, getItems);
    const tracks = await containerTracks(getItems, item.Id, CONTAINER_FILTERS[item.Type]);
    const startIndex = shuffle && tracks.length > 0 ? Math.floor(random() * tracks.length) : 0;
    return { tracks, startIndex };
}
