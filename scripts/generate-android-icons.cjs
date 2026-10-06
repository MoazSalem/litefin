#!/usr/bin/env node
/**
 * ============================================================================
 * Litefin - Android Launcher Icon Generator
 * ============================================================================
 * Reads assets/icon.png and emits properly sized launcher icons for every
 * Android density bucket into the mipmap folders under
 * android/app/src/main/res/ (ic_launcher.png per density).
 *
 * Uses jpeg-js/pngjs (dev-only, installed ad hoc by the packaging task).
 * Run with: node scripts/generate-android-icons.cjs
 * ============================================================================
 */

const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');

const ROOT = path.resolve(__dirname, '..');
const SRC_ICON = path.join(ROOT, 'assets', 'icon.png');
const RES_DIR = path.join(ROOT, 'android', 'app', 'src', 'main', 'res');

// Density bucket -> launcher icon size (px)
const DENSITIES = {
    'mipmap-mdpi': 48,
    'mipmap-hdpi': 72,
    'mipmap-xhdpi': 96,
    'mipmap-xxhdpi': 144,
    'mipmap-xxxhdpi': 192
};

/**
 * Nearest-neighbor area-average resize of an RGBA PNG buffer.
 * Simple box filter — good enough for launcher icons.
 * @param {Buffer} pngBuf - Source PNG buffer
 * @param {number} targetW - Target width in px
 * @param {number} targetH - Target height in px
 * @returns {Buffer} Resized PNG buffer
 */
function resizePng(pngBuf, targetW, targetH) {
    const src = PNG.sync.read(pngBuf);
    const dst = new PNG({ width: targetW, height: targetH });

    const sx = src.width / targetW;
    const sy = src.height / targetH;

    for (let y = 0; y < targetH; y++) {
        for (let x = 0; x < targetW; x++) {
            // Box-average the source pixels covered by this target pixel
            const x0 = Math.floor(x * sx);
            const x1 = Math.min(src.width, Math.max(x0 + 1, Math.floor((x + 1) * sx)));
            const y0 = Math.floor(y * sy);
            const y1 = Math.min(src.height, Math.max(y0 + 1, Math.floor((y + 1) * sy)));

            let r = 0, g = 0, b = 0, a = 0, count = 0;
            for (let yy = y0; yy < y1; yy++) {
                for (let xx = x0; xx < x1; xx++) {
                    const idx = (src.width * yy + xx) << 2;
                    const alpha = src.data[idx + 3];
                    // Premultiply for correct averaging of transparent pixels
                    r += src.data[idx] * alpha;
                    g += src.data[idx + 1] * alpha;
                    b += src.data[idx + 2] * alpha;
                    a += alpha;
                    count++;
                }
            }

            const outIdx = (targetW * y + x) << 2;
            if (a > 0) {
                dst.data[outIdx] = Math.round(r / a);
                dst.data[outIdx + 1] = Math.round(g / a);
                dst.data[outIdx + 2] = Math.round(b / a);
                dst.data[outIdx + 3] = Math.round(a / count);
            } else {
                dst.data[outIdx] = 0;
                dst.data[outIdx + 1] = 0;
                dst.data[outIdx + 2] = 0;
                dst.data[outIdx + 3] = 0;
            }
        }
    }

    return PNG.sync.write(dst);
}

function main() {
    if (!fs.existsSync(SRC_ICON)) {
        console.error('Source icon not found:', SRC_ICON);
        process.exit(1);
    }

    const srcBuf = fs.readFileSync(SRC_ICON);

    for (const [dir, size] of Object.entries(DENSITIES)) {
        const outDir = path.join(RES_DIR, dir);
        fs.mkdirSync(outDir, { recursive: true });
        const outPath = path.join(outDir, 'ic_launcher.png');
        fs.writeFileSync(outPath, resizePng(srcBuf, size, size));
        console.log(`Wrote ${path.relative(ROOT, outPath)} (${size}x${size})`);
    }
}

main();
