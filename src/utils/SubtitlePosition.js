/**
 * Keep text subtitles clear of the OSD without changing saved position settings.
 * Measure the controls themselves: .osd-bottom includes a large gradient padding.
 * Transforms leave the configured top/bottom and text margins intact.
 *
 * @param {HTMLElement} root - Player page element
 * @param {boolean} visible - Whether the main OSD controls are visible
 */
export function updateSubtitlePosition(root, visible) {
    if (!root) return;

    const overlays = root.querySelectorAll('.subtitle-overlay');
    let boundary = Infinity;
    const gap = root.getBoundingClientRect().height * 0.02;
    if (visible) {
        const controls = root.querySelectorAll('.osd-bottom > *');
        for (let i = 0; i < controls.length; i++) {
            const rect = controls[i].getBoundingClientRect();
            if (rect.width && rect.height) boundary = Math.min(boundary, rect.top - gap);
        }
    }

    for (let i = 0; i < overlays.length; i++) {
        const overlay = overlays[i];
        // Measure at the original position, avoiding cumulative movement on updates.
        overlay.style.transform = '';
        overlay.style.webkitTransform = '';
        if (!visible || overlay.classList.contains('hidden')) continue;

        const line = overlay.querySelector('.subtitle-line');
        if (!line) continue;
        const rect = line.getBoundingClientRect();
        if (!rect.width || !rect.height) continue;
        const offset = Math.max(0, rect.bottom - boundary);
        if (offset) {
            const transform = `translateY(-${offset}px)`;
            overlay.style.transform = transform;
            overlay.style.webkitTransform = transform;
        }
    }
}
