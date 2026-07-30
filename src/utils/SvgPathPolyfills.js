/**
 * ============================================================================
 * Litefin Tizen - SVGPathElement Polyfills
 * ============================================================================
 * Polyfills for SVGPathElement.prototype.pathSegList and related methods that
 * were removed in modern Chrome but are required by libjass for ASS vector
 * drawing (\\p tag) support.
 *
 * These are module-level side-effects — import this file for the polyfills to
 * apply before any ASS rendering code executes.
 * ============================================================================
 */

// Check pathSegList capability safely using a dummy instance.
// Directly accessing SVGPathElement.prototype.pathSegList throws "Illegal invocation"
// on older browsers (like Chrome 38) because the native getter expects an instance context.
let hasPathSeg = false;
try {
    if (typeof document !== 'undefined') {
        const dummyPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        hasPathSeg = !!dummyPath.pathSegList;
    }
} catch (e) {
    hasPathSeg = false;
}

// Polyfill SVGPathElement.prototype.pathSegList for modern browsers where it was removed.
if (typeof window !== 'undefined' && typeof SVGPathElement !== 'undefined' && !hasPathSeg) {
    Object.defineProperty(SVGPathElement.prototype, 'pathSegList', {
        get() {
            const path = this;
            return {
                appendItem(item) {
                    let d = path.getAttribute('d') || '';
                    if (d) d += ' ';
                    if (item.type === 'M') {
                        d += `M ${item.x} ${item.y}`;
                    } else if (item.type === 'L') {
                        d += `L ${item.x} ${item.y}`;
                    } else if (item.type === 'C') {
                        d += `C ${item.x1} ${item.y1}, ${item.x2} ${item.y2}, ${item.x} ${item.y}`;
                    }
                    path.setAttribute('d', d);
                    return item;
                },
                clear() {
                    path.setAttribute('d', '');
                }
            };
        },
        configurable: true,
        enumerable: true
    });

    SVGPathElement.prototype.createSVGPathSegMovetoAbs = function (x, y) {
        return { type: 'M', x, y };
    };

    SVGPathElement.prototype.createSVGPathSegLinetoAbs = function (x, y) {
        return { type: 'L', x, y };
    };

    SVGPathElement.prototype.createSVGPathSegCurvetoCubicAbs = function (x, y, x1, y1, x2, y2) {
        return { type: 'C', x, y, x1, y1, x2, y2 };
    };
}
