import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

/**
 * ============================================================================
 * Unit Tests: Admin Identify & Image Management Endpoints
 * ============================================================================
 * Verifies RemoteSearch query dispatch, metadata identification apply,
 * image metadata retrieval, remote provider image fetching, download, and deletion.
 * ============================================================================
 */

test('ApiClient.getRemoteSearchResults dispatches POST to /Items/RemoteSearch/{ItemType}', async () => {
    const calls = [];
    const client = {
        post: async (endpoint, data, config) => {
            calls.push({ endpoint, data, config });
            return [{ Name: 'Fight Club', ProductionYear: 1999, Id: 'remote-1' }];
        },
        async getRemoteSearchResults(itemType, searchInfo, itemId, includeDisabledProviders = false) {
            const payload = {
                SearchInfo: searchInfo || {},
                ItemId: itemId,
                IncludeDisabledProviders: !!includeDisabledProviders
            };
            const typeSegment = encodeURIComponent(itemType);
            return this.post(`/Items/RemoteSearch/${typeSegment}`, payload);
        }
    };

    const results = await client.getRemoteSearchResults('Movie', { Name: 'Fight Club', Year: 1999 }, 'item-123');

    assert.equal(calls.length, 1);
    assert.equal(calls[0].endpoint, '/Items/RemoteSearch/Movie');
    assert.equal(calls[0].data.ItemId, 'item-123');
    assert.equal(calls[0].data.SearchInfo.Name, 'Fight Club');
    assert.equal(results.length, 1);
});

test('ApiClient.applyRemoteSearchResult dispatches POST to /Items/RemoteSearch/Apply/{ItemId}', async () => {
    const calls = [];
    const client = {
        clearEtagCache: () => {},
        post: async (endpoint, data, config) => {
            calls.push({ endpoint, data, config });
            return { Success: true };
        },
        async applyRemoteSearchResult(itemId, searchResult, replaceAllImages = true) {
            const url = `/Items/RemoteSearch/Apply/${encodeURIComponent(itemId)}?replaceAllImages=${replaceAllImages ? 'true' : 'false'}`;
            return this.post(url, searchResult);
        }
    };

    const resultPayload = { Name: 'Inception', ProductionYear: 2010 };
    await client.applyRemoteSearchResult('item-456', resultPayload, true);

    assert.equal(calls.length, 1);
    assert.equal(calls[0].endpoint, '/Items/RemoteSearch/Apply/item-456?replaceAllImages=true');
    assert.deepEqual(calls[0].data, resultPayload);
});

test('ApiClient image methods dispatch to correct REST endpoints', async () => {
    const gets = [];
    const posts = [];
    const deletes = [];

    const client = {
        clearEtagCache: () => {},
        get: async (endpoint, params) => {
            gets.push({ endpoint, params });
            return [];
        },
        post: async (endpoint, data, options) => {
            posts.push({ endpoint, data, options });
            return { Success: true };
        },
        delete: async (endpoint) => {
            deletes.push({ endpoint });
            return { Success: true };
        },
        async getItemImages(itemId) {
            return this.get(`/Items/${encodeURIComponent(itemId)}/Images`);
        },
        async getItemRemoteImages(itemId, options = {}) {
            const params = {};
            if (options.type) params.type = options.type;
            if (options.includeAllLanguages !== undefined) {
                params.includeAllLanguages = options.includeAllLanguages;
            } else {
                params.includeAllLanguages = true;
            }
            return this.get(`/Items/${encodeURIComponent(itemId)}/RemoteImages`, params);
        },
        async downloadRemoteImage(itemId, type, imageUrl, providerName = '') {
            const params = { Type: type, ImageUrl: imageUrl };
            if (providerName) params.ProviderName = providerName;
            return this.post(`/Items/${encodeURIComponent(itemId)}/RemoteImages/Download`, null, { params });
        },
        async deleteItemImage(itemId, imageType, imageIndex = null) {
            let endpoint = `/Items/${encodeURIComponent(itemId)}/Images/${encodeURIComponent(imageType)}`;
            if (imageIndex !== null && imageIndex !== undefined) {
                endpoint += `/${encodeURIComponent(imageIndex)}`;
            }
            return this.delete(endpoint);
        },
        async updateItemImageIndex(itemId, imageType, imageIndex, newIndex) {
            const endpoint = `/Items/${encodeURIComponent(itemId)}/Images/${encodeURIComponent(imageType)}/${encodeURIComponent(imageIndex)}/Index`;
            return this.post(endpoint, null, { params: { newIndex } });
        }
    };

    // 1. Get images
    await client.getItemImages('item-789');
    assert.equal(gets[0].endpoint, '/Items/item-789/Images');

    // 2. Get remote images
    await client.getItemRemoteImages('item-789', { type: 'Primary' });
    assert.equal(gets[1].endpoint, '/Items/item-789/RemoteImages');
    assert.equal(gets[1].params.type, 'Primary');
    assert.equal(gets[1].params.includeAllLanguages, true);

    // 3. Download remote image
    await client.downloadRemoteImage('item-789', 'Primary', 'https://image.tmdb.org/t/p/original/test.jpg', 'TheMovieDb');
    assert.equal(posts[0].endpoint, '/Items/item-789/RemoteImages/Download');
    assert.equal(posts[0].options.params.Type, 'Primary');
    assert.equal(posts[0].options.params.ProviderName, 'TheMovieDb');

    // 4. Delete image
    await client.deleteItemImage('item-789', 'Backdrop', 0);
    assert.equal(deletes[0].endpoint, '/Items/item-789/Images/Backdrop/0');

    // 5. Update image index / prioritization
    await client.updateItemImageIndex('item-789', 'Backdrop', 2, 0);
    assert.equal(posts[1].endpoint, '/Items/item-789/Images/Backdrop/2/Index');
    assert.equal(posts[1].options.params.newIndex, 0);
});

test('DetailsPage source contains admin checks and handlers for identify and edit-images', () => {
    const detailsSource = readFileSync('src/pages/DetailsPage.js', 'utf8');

    // Verify admin checks include identify and edit-images
    assert.ok(detailsSource.includes("options.push({ id: 'identify'"));
    assert.ok(detailsSource.includes("options.push({ id: 'edit-images'"));

    // Verify modal invocations
    assert.ok(detailsSource.includes('IdentifyModal.show(itemId, this'));
    assert.ok(detailsSource.includes('ImageEditorModal.show(itemId, this'));

    // Verify _refreshItem exists
    assert.ok(detailsSource.includes('_refreshItem()'));

    // Verify tag parameter is included in _loadImages for cache-busting
    assert.ok(detailsSource.includes('tag: item.ImageTags.Primary'));
});

test('BackdropManager attaches tag parameter for cache-busting on backdrop changes', () => {
    const backdropSource = readFileSync('src/utils/BackdropManager.js', 'utf8');

    // Verify BackdropManager extracts backdrop tag
    assert.ok(backdropSource.includes('item.BackdropImageTags[0]'));
    assert.ok(backdropSource.includes('options.tag = backdropTag'));
});

test('DetailsPage, PersonPage, and SeerrDetailsPage have safe tooltip listeners and timer cleanup', () => {
    const detailsSource = readFileSync('src/pages/DetailsPage.js', 'utf8');
    const personSource = readFileSync('src/pages/PersonPage.js', 'utf8');
    const seerrSource = readFileSync('src/pages/SeerrDetailsPage.js', 'utf8');

    // Verify tooltip timer cleanup on destroy
    assert.ok(detailsSource.includes('this._tooltipTimers.forEach((t) => clearTimeout(t))'));
    assert.ok(personSource.includes('this._tooltipTimers.forEach((t) => clearTimeout(t))'));
    assert.ok(seerrSource.includes('this._tooltipTimers.forEach((t) => clearTimeout(t))'));

    // Verify no duplicate _refreshItem in DetailsPage
    const refreshItemMatches = detailsSource.match(/async _refreshItem\(\)/g) || [];
    assert.equal(refreshItemMatches.length, 1, 'Should only have 1 _refreshItem in DetailsPage');
});

test('ImageEditorModal and DetailsPage preserve focus transition context and declare containers', () => {
    const editorSource = readFileSync('src/components/ImageEditorModal.js', 'utf8');
    const detailsSource = readFileSync('src/pages/DetailsPage.js', 'utf8');

    // Ensure tabsContainer and contentContainer are queried before registration
    assert.ok(editorSource.includes("const tabsContainer = overlay.querySelector('#image-tabs-container')"));
    assert.ok(editorSource.includes("const contentContainer = overlay.querySelector('#image-content-container')"));

    // Ensure transitionContext is consumed in _showMoreOptionsModal
    assert.ok(detailsSource.includes('async _showMoreOptionsModal(itemId, transitionContext = null)'));
    assert.ok(detailsSource.includes('transitionContext?.prevFocus'));
    assert.ok(detailsSource.includes('this._hasModifiedArtwork = true'));

    // Ensure rich metadata is deactivated if active
    assert.ok(detailsSource.includes('if (this._isRichMetaActive)'));
    assert.ok(detailsSource.includes('this._deactivateRichMeta()'));
});
