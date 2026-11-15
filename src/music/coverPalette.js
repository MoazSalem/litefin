const SAMPLE_SIZE = 32;
const CACHE_LIMIT = 50;
const BIN_SHIFT = 4;
const MIN_ALPHA = 128;
const NEAR_BLACK_MAX_CHANNEL = 35;
const NEAR_WHITE_MIN_CHANNEL = 220;
const MIN_DISTANCE = 60;
const SHADE_FACTORS = [0.7, 0.45];

const shades = (rgb) => [rgb, ...SHADE_FACTORS.map((f) => rgb.map((c) => Math.round(c * f)))];

export const FALLBACK_PALETTE = shades([0, 164, 220]);

const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

function isUsable(r, g, b) {
    return Math.max(r, g, b) >= NEAR_BLACK_MAX_CHANNEL && Math.min(r, g, b) <= NEAR_WHITE_MIN_CHANNEL;
}

function collectBins(rgba) {
    const bins = new Map();
    for (let i = 0; i < rgba.length; i += 4) {
        const [r, g, b, a] = [rgba[i], rgba[i + 1], rgba[i + 2], rgba[i + 3]];
        if (a < MIN_ALPHA || !isUsable(r, g, b)) continue;
        const key = ((r >> BIN_SHIFT) << 8) | ((g >> BIN_SHIFT) << 4) | (b >> BIN_SHIFT);
        const bin = bins.get(key) || { count: 0, r: 0, g: 0, b: 0 };
        bins.set(key, { count: bin.count + 1, r: bin.r + r, g: bin.g + g, b: bin.b + b });
    }
    return [...bins.values()]
        .sort((x, y) => y.count - x.count)
        .map((bin) => [Math.round(bin.r / bin.count), Math.round(bin.g / bin.count), Math.round(bin.b / bin.count)]);
}

export function pickPalette(rgba) {
    const chosen = [];
    for (const color of collectBins(rgba)) {
        if (chosen.every((c) => distance(c, color) >= MIN_DISTANCE)) chosen.push(color);
        if (chosen.length === 3) break;
    }
    if (chosen.length === 0) return FALLBACK_PALETTE;
    if (chosen.length === 3) return chosen;
    const padding = shades(chosen[0]).slice(1);
    return [...chosen, ...padding].slice(0, 3);
}

const cache = new Map();

function loadImage(url) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('Cover image failed to load'));
        img.src = url;
    });
}

export async function paletteForItem(itemId, imageUrl) {
    if (cache.has(itemId)) return cache.get(itemId);
    let palette = FALLBACK_PALETTE;
    try {
        const img = await loadImage(imageUrl);
        const canvas = document.createElement('canvas');
        canvas.width = SAMPLE_SIZE;
        canvas.height = SAMPLE_SIZE;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, SAMPLE_SIZE, SAMPLE_SIZE);
        palette = pickPalette(ctx.getImageData(0, 0, SAMPLE_SIZE, SAMPLE_SIZE).data);
    } catch (_err) {
        palette = FALLBACK_PALETTE;
    }
    if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value);
    cache.set(itemId, palette);
    return palette;
}
