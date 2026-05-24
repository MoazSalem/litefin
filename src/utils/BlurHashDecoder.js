/**
 * ============================================================================
 * Litefin Tizen - BlurHash Decoder Utility
 * ============================================================================
 * Highly optimized, zero-dependency pure JavaScript implementation of the
 * BlurHash decoding algorithm. Designed specifically to run efficiently on
 * resource-constrained smart TV web runtimes (e.g. Tizen 3/4, Chromium 47/56).
 *
 * Performance Optimizations:
 * 1. Precomputed Cosine Tables: Avoids costly Math.cos operations inside
 *    the primary pixel iteration loop.
 * 2. Flat typed arrays: High speed buffer transfers.
 * ============================================================================
 */

// ============================================================================
// BASE-83 ENCODING ALPHABET DEFINED BY BLURHASH SPECIFICATION
// ============================================================================
//
// The BlurHash format utilizes a custom 83-character base-83 encoding sequence.
// These specific characters are chosen to be safe to embed in XML, HTML, JSON,
// and URLs without escape sequences.
//
// CRITICAL CORRECTION (Fixed Twice):
// The original implementation had 90 characters with wrong ASCII (!, &, (, ), /, <, >).
// The first fix still accidentally included '&' (ampersand), producing a 84-character
// string instead of 83. This shifted every character index from position 65 onward
// by +1, corrupting all AC coefficient decoding and producing wrong colors.
//
// The string below is the EXACT official 83-character sequence from:
// https://github.com/woltapp/blurhash/blob/master/TypeScript/src/base83.ts
// ============================================================================
const BASE83_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz#$%*+,-.:;=?@[]^_{|}~';

// Fast pre-allocated hash lookup table for mapping characters to indices in O(1) time.
// This completely avoids expensive index lookups or search scans inside loops.
const BASE83_MAP = {};
for (let i = 0; i < BASE83_CHARS.length; i++) {
    BASE83_MAP[BASE83_CHARS[i]] = i;
}

/**
 * Decode a Base83 integer string to a standard decimal number.
 * @param {string} str - Base83 string
 * @returns {number} Decoded value
 */
function decode83(str) {
    let value = 0;
    for (let i = 0; i < str.length; i++) {
        const c = str[i];
        value = value * 83 + (BASE83_MAP[c] || 0);
    }
    return value;
}

/**
 * Convert a quantized AC component value to a real linear color value.
 * @param {number} value - Quantized integer
 * @param {number} maxVal - Max amplitude factor
 * @returns {number} Linear color channel
 */
function decodeAC(value, maxVal) {
    const r = Math.floor(value / (19 * 19));
    const g = Math.floor(value / 19) % 19;
    const b = value % 19; // Extract channels with correct base-19 modulo math

    // Apply signed power scale factor for smooth transitions
    const scale = (x) => {
        const sign = Math.sign(x - 9);
        const abs = Math.abs(x - 9);
        return sign * Math.pow(abs / 9, 2) * maxVal;
    };

    return [scale(r), scale(g), scale(b)];
}

/**
 * Convert a quantized DC (average color) value to a real linear color value.
 * @param {number} value - Quantized integer
 * @returns {number[]} Linear color channels [R, G, B]
 */
function decodeDC(value) {
    const r = value >> 16;
    const g = (value >> 8) & 255;
    const b = value & 255; // Unpack 24-bit color

    // Transform from sRGB space to linear RGB space
    const srgbToLinear = (c) => {
        const v = c / 255;
        return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    };

    return [srgbToLinear(r), srgbToLinear(g), srgbToLinear(b)];
}

/**
 * Linear color space back to standard sRGB space clamp mapping.
 * @param {number} value - Linear float color component
 * @returns {number} Clamped sRGB byte value
 */
function linearToSrgb(value) {
    const v = Math.max(0, Math.min(1, value));
    const srgb = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
    return Math.round(srgb * 255);
}

class BlurHashDecoder {
    /**
     * Decode a BlurHash string into a raw RGBA pixel array (Uint8ClampedArray).
     * @param {string} hash - The BlurHash string
     * @param {number} width - Target width for decoded representation (keep low, e.g. 20)
     * @param {number} height - Target height for decoded representation
     * @param {number} [punch=1.0] - Optional factor to adjust contrast/color intensity
     * @returns {Uint8ClampedArray|null} Decoded RGBA pixel data or null if invalid
     */
    static decode(hash, width, height, punch = 1.0) {
        // Validation: Standard BlurHash strings must be at least 6 characters long
        if (!hash || hash.length < 6) return null;

        try {
            // -------------------------------------------------------------
            // 1. Parse Component Counts & Configuration Metadata
            // -------------------------------------------------------------
            const sizeFlag = decode83(hash[0]);
            const numX = (sizeFlag % 9) + 1;
            const numY = Math.floor(sizeFlag / 9) + 1;

            const quantisedMaxVal = decode83(hash[1]);
            const maxVal = (quantisedMaxVal + 1) / 166 * punch;

            // Total expected length must match: 4 + 2 * (numX * numY)
            const expectedLength = 4 + 2 * numX * numY;
            if (hash.length !== expectedLength) return null;

            // -------------------------------------------------------------
            // 2. Unpack DC & AC Frequency Coefficients
            // -------------------------------------------------------------
            const colors = new Array(numX * numY);
            
            // The first frequency component (0, 0) is the average DC color
            colors[0] = decodeDC(decode83(hash.substring(2, 6)));

            // Subsequent coefficients are high-frequency AC detail blocks
            let offset = 6;
            for (let i = 1; i < numX * numY; i++) {
                colors[i] = decodeAC(decode83(hash.substring(offset, offset + 2)), maxVal);
                offset += 2;
            }

            // -------------------------------------------------------------
            // 3. Precompute Cosine Component Factors
            //    Avoids repeating heavy Math.cos operations inside pixel loops.
            // -------------------------------------------------------------
            const cosX = new Float32Array(width * numX);
            for (let x = 0; x < width; x++) {
                for (let i = 0; i < numX; i++) {
                    cosX[x * numX + i] = Math.cos((Math.PI * x * i) / width);
                }
            }

            const cosY = new Float32Array(height * numY);
            for (let y = 0; y < height; y++) {
                for (let j = 0; j < numY; j++) {
                    cosY[y * numY + j] = Math.cos((Math.PI * y * j) / height);
                }
            }

            // -------------------------------------------------------------
            // 4. DCT Inverse Transform & Pixel Buffer Assembly
            // -------------------------------------------------------------
            const pixels = new Uint8ClampedArray(width * height * 4);
            let pixelOffset = 0;

            for (let y = 0; y < height; y++) {
                const yOffset = y * numY;

                for (let x = 0; x < width; x++) {
                    const xOffset = x * numX;

                    let r = 0;
                    let g = 0;
                    let b = 0;

                    // Evaluate Double Summation for the current coordinate
                    for (let j = 0; j < numY; j++) {
                        const basisY = cosY[yOffset + j];

                        for (let i = 0; i < numX; i++) {
                            const basisX = cosX[xOffset + i];
                            const basis = basisX * basisY; // Combined DCT Basis

                            const color = colors[j * numX + i];
                            r += color[0] * basis;
                            g += color[1] * basis;
                            b += color[2] * basis;
                        }
                    }

                    // Convert linear RGB to standard sRGB space and fill canvas buffer
                    pixels[pixelOffset] = linearToSrgb(r);
                    pixels[pixelOffset + 1] = linearToSrgb(g);
                    pixels[pixelOffset + 2] = linearToSrgb(b);
                    pixels[pixelOffset + 3] = 255; // Alpha full opacity

                    pixelOffset += 4;
                }
            }

            return pixels;
        } catch (e) {
            // Failure-resilient handler for corrupted or malformed hash inputs
            return null;
        }
    }
}

export default BlurHashDecoder;
