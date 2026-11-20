/**
 * ============================================================================
 * Litefin Quick-Access Header Launcher
 * ============================================================================
 * Embedded bridge script injected into the Jellyfin Web client.
 * Injects a quick-access toolbar icon into the Jellyfin Web header
 * to launch the Litefin client with spring animations and zero lag.
 * Responsive interactive design for tactile and fluid feedback.
 * ============================================================================
 */
(function () {
    "use strict";

    // Cached presentation state: "Colored" (default), "White" (monochrome SVG), or "Hidden"
    var isLauncherEnabled = true;
    var buttonMode = "Colored";
    var configFetched = false;

    // Monochrome SVG logo definition for "White" button mode
    var LITEFIN_SVG_WHITE =
        '<svg viewBox="0 0 100 100" width="24" height="24" style="vertical-align:middle;display:block;pointer-events:none;" fill="currentColor">' +
        '<path d="M19.57,91c-2.24,0-4.73-0.44-6.87-2.02c-2.07-1.53-3.32-3.6-3.62-5.97c-0.51-4.01,1.81-7.59,3.24-9.37c4.82-5.97,9.41-12.5,10.36-19.76c0.8-6.13-1-12.33-2.9-18.9c-0.59-2.04-1.21-4.16-1.73-6.27 c-0.8-3.17-1.42-6.59-0.53-10.08c1.8-7.06,9.11-10.26,21.74-9.53c10.63,0.62,21.35,5.21,30.19,12.91 C82.12,33.08,93.56,53.11,90.5,72.93c-0.23,1.54-0.58,2.97-1.04,4.26c-1.28,3.66-3.47,6.32-6.34,7.68 c-3.63,1.71-7.38,1.01-10.39,0.44c-2.45-0.46-5.35-0.99-8.34-1.37c-6.72-0.86-12.12-0.79-17.02,0.21 c-3.5,0.71-6.9,1.8-10.49,2.95c-4.51,1.44-9.17,2.94-14.09,3.64C21.84,90.88,20.74,91,19.57,91z M35.69,16 c-5.23,0-10.52,0.9-11.4,4.36c-0.5,1.98-0.04,4.37,0.53,6.65c0.5,1.99,1.09,4.04,1.67,6.02c2.02,6.97,4.11,14.17,3.12,21.75 c-1.17,8.98-6.38,16.48-11.85,23.25c-1.19,1.47-1.87,3.08-1.75,4.08c0.04,0.31,0.17,0.73,0.85,1.23 c0.89,0.66,2.51,0.81,4.95,0.46c4.34-0.62,8.53-1.96,12.95-3.38c3.61-1.16,7.35-2.35,11.22-3.14c5.67-1.16,11.81-1.26,19.31-0.3 c3.17,0.41,6.2,0.95,8.74,1.43c2.32,0.44,4.52,0.85,6.1,0.11c1.15-0.54,2.07-1.78,2.72-3.66l0-0.01c0.31-0.87,0.55-1.88,0.72-3 c2.65-17.2-7.5-34.78-18.74-44.57c-7.68-6.69-16.92-10.67-26-11.2C37.81,16.04,36.75,16,35.69,16z" />' +
        '<path d="M69.3,63.51c0.19-0.64,0.32-1.3,0.41-1.95 c1.26-9.44-3.2-19.55-9.22-25.63c-3.64-3.67-8.19-6.14-13.02-6.47c-2.7-0.18-7.56-0.15-8.41,3.7c-0.32,1.47-0.07,3.03,0.25,4.49 c1.01,4.7,2.72,9.41,2.18,14.21C41,56.22,38.72,60,36.34,63.41c-1.14,1.63-1.9,4.02-0.12,5.54c0.97,0.83,2.3,0.8,3.49,0.6 c3.88-0.64,7.47-2.62,11.3-3.52c2.77-0.66,5.63-0.55,8.42-0.14c1.33,0.2,2.64,0.47,3.96,0.75c1.25,0.27,2.62,0.57,3.82-0.09 C68.26,65.98,68.91,64.81,69.3,63.51z" />' +
        '</svg>';

    /**
     * Resolves the active Jellyfin ApiClient instance from global scope.
     * Compatible with stock Jellyfin Web and Jellyfin v10.9 / v10.10+ builds.
     */
    function currentApiClient() {
        return (
            window.ApiClient ||
            (window.connectionManager &&
                window.connectionManager.currentApiClient &&
                window.connectionManager.currentApiClient()) ||
            null
        );
    }

    /**
     * Invokes a property or method on a target object safely without throwing.
     */
    function callIfFunction(target, member) {
        if (!target) return null;
        try {
            var value = target[member];
            if (typeof value === "function") {
                return value.call(target);
            }
            return value;
        } catch (e) {
            return null;
        }
    }

    /**
     * Resolves the base URL endpoint where Litefin web assets and client are hosted.
     * Preserves upstream reverse proxy path prefixes if present.
     */
    function resolveLitefinBase() {
        // First try reading the server address configured on ApiClient
        try {
            var api = currentApiClient();
            if (api && typeof api.serverAddress === "function") {
                var server = api.serverAddress() || "";
                if (server) {
                    var parsed = new URL(server, window.location.origin);
                    var prefix = (parsed.pathname || "").replace(/\/$/, "");
                    return prefix + "/litefin";
                }
            }
        } catch (e) {}

        // Fallback: extract base path before /web/ segment in window.location.pathname
        var path = window.location.pathname || "";
        var webIdx = path.toLowerCase().lastIndexOf("/web/");
        if (webIdx >= 0) {
            return path.substring(0, webIdx) + "/litefin";
        }

        // Default root subpath
        return "/litefin";
    }

    /**
     * Tests whether a DOM element is currently visible in the document flow.
     */
    function isElementVisible(el) {
        if (!el) return false;
        if (el.offsetParent !== null) return true;
        var rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
    }

    /**
     * Checks server plugin configuration to determine if the header button is enabled.
     * Defers button removal if disabled by server administrator.
     */
    function verifyLauncherConfiguration() {
        if (configFetched) return;
        configFetched = true;

        var base = resolveLitefinBase();
        try {
            fetch(base + "/config.json", { cache: "no-store" })
                .then(function (res) {
                    if (!res.ok) return { headerButtonMode: "Colored", enableHeaderButton: true };
                    return res.json();
                })
                .then(function (data) {
                    var mode = (data && data.headerButtonMode) || (data && data.enableHeaderButton === false ? "Hidden" : "Colored");
                    buttonMode = mode;
                    if (mode === "Hidden") {
                        isLauncherEnabled = false;
                        removeExistingButtons();
                    } else {
                        isLauncherEnabled = true;
                        var existing = document.querySelectorAll(".headerLitefinButton");
                        for (var i = 0; i < existing.length; i++) {
                            renderButtonContent(existing[i], buttonMode);
                        }
                    }
                })
                .catch(function () {
                    // Retain default enabled state on fetch failure
                });
        } catch (e) {}
    }

    /**
     * Removes all existing Litefin header buttons from the document.
     */
    function removeExistingButtons() {
        var buttons = document.querySelectorAll(".headerLitefinButton");
        for (var i = 0; i < buttons.length; i++) {
            if (buttons[i].parentNode) {
                buttons[i].parentNode.removeChild(buttons[i]);
            }
        }
    }

    /**
     * Creates and configures the Litefin header button element.
     * Design specifications:
     * - Minimum 44x44pt click and touch target area.
     * - Subtle drop shadow and tactile spring animation on press.
     * - Accessible labeling for screen readers.
     */
    /**
     * Renders button inner markup matching the selected mode (Colored PNG or White SVG).
     */
    function renderButtonContent(btn, mode) {
        var litefinBase = resolveLitefinBase();
        if (mode === "White") {
            btn.innerHTML = LITEFIN_SVG_WHITE;
        } else {
            btn.innerHTML =
                '<img src="' +
                litefinBase +
                '/assets/icon-130.png" style="width:24px;height:24px;border-radius:4px;vertical-align:middle;display:block;pointer-events:none;object-fit:contain;" alt="Litefin">';
        }
    }

    function createLitefinButton() {
        var litefinBase = resolveLitefinBase();
        var btn = document.createElement("button");
        btn.type = "button";
        btn.className =
            "headerButton headerButtonRight headerLitefinButton MuiButtonBase-root MuiIconButton-root MuiIconButton-colorInherit MuiIconButton-sizeLarge";
        btn.title = "Open Litefin";
        btn.setAttribute("aria-label", "Open Litefin");

        // Enforce 1:1 circular aspect ratio matching Jellyfin toolbar icons (48x48)
        btn.style.width = "48px";
        btn.style.height = "48px";
        btn.style.padding = "12px";
        btn.style.boxSizing = "border-box";
        btn.style.borderRadius = "50%";
        btn.style.alignSelf = "center";

        // Render content matching the active button mode (Colored or White SVG)
        renderButtonContent(btn, buttonMode);

        // On press, navigate directly to the Litefin client
        btn.addEventListener("click", function (e) {
            e.preventDefault();
            e.stopPropagation();
            window.location.href = litefinBase + "/";
        });

        return btn;
    }

    // Selector targeting user menu button or avatar element in Jellyfin Web
    var TOOLBAR_USER_SELECTOR =
        'button[aria-controls="app-user-menu"], button[aria-label*="UserMenu"], button[aria-label*="User"], .MuiAvatar-root';

    /**
     * Finds the button container row preceding the avatar element in MUI toolbar.
     */
    function findToolbarButtonRow(userBox) {
        for (var el = userBox.previousElementSibling; el; el = el.previousElementSibling) {
            if (el.tagName !== "DIV") continue;
            var css = window.getComputedStyle(el);
            if (css.display.indexOf("flex") !== -1 && css.justifyContent === "flex-end") {
                return el;
            }
        }
        return null;
    }

    /**
     * Injects the Litefin launcher into modern MUI toolbars.
     */
    function injectIntoToolbar(toolbar) {
        if (!toolbar || !isElementVisible(toolbar)) return false;

        var btn = toolbar.querySelector(".headerLitefinButton");
        var userBtn = toolbar.querySelector(TOOLBAR_USER_SELECTOR);

        if (userBtn) {
            var userBox = userBtn.closest(".MuiToolbar-root > *");
            if (userBox && userBox !== toolbar && userBox.parentNode === toolbar) {
                var buttonRow = findToolbarButtonRow(userBox);
                if (buttonRow) {
                    if (btn && btn.parentNode === buttonRow) return true;
                    if (!btn) btn = createLitefinButton();
                    buttonRow.appendChild(btn);
                    return true;
                }
                if (userBox.previousElementSibling === btn) {
                    return true;
                }
                if (!btn) btn = createLitefinButton();
                toolbar.insertBefore(btn, userBox);
                return true;
            }
            if (userBtn.parentNode) {
                if (userBtn.previousElementSibling === btn) {
                    return true;
                }
                if (!btn) btn = createLitefinButton();
                userBtn.parentNode.insertBefore(btn, userBtn);
                return true;
            }
        }

        if (btn) return true;
        btn = createLitefinButton();

        var buttonsContainer = toolbar.querySelector(
            '.MuiBox-root[style*="justify-content: flex-end"], div[style*="flex-grow: 1"]'
        );
        if (buttonsContainer) {
            buttonsContainer.appendChild(btn);
        } else {
            toolbar.appendChild(btn);
        }
        return true;
    }

    /**
     * Injects the Litefin launcher into legacy skin headers.
     */
    function injectIntoLegacyHeader(headerRight) {
        if (!headerRight || !isElementVisible(headerRight)) return false;

        var btn = headerRight.querySelector(".headerLitefinButton");
        var userBtn = headerRight.querySelector(".headerUserButton, .headerButton-user");

        if (userBtn && userBtn.parentNode === headerRight) {
            if (userBtn.previousElementSibling === btn) {
                return true;
            }
            if (!btn) btn = createLitefinButton();
            headerRight.insertBefore(btn, userBtn);
            return true;
        }

        if (btn) return true;
        btn = createLitefinButton();

        var syncBtn = headerRight.querySelector(".headerSyncButton");
        if (syncBtn && syncBtn.parentNode === headerRight) {
            headerRight.insertBefore(btn, syncBtn);
        } else {
            headerRight.appendChild(btn);
        }
        return true;
    }

    /**
     * Deduplicates buttons if multiple renders or re-mounts occurred.
     */
    function removeExtraButtons() {
        var all = document.querySelectorAll(".headerLitefinButton");
        if (all.length < 2) return;
        var keep = null;
        for (var k = 0; k < all.length && !keep; k++) {
            if (isElementVisible(all[k])) keep = all[k];
        }
        if (!keep) keep = all[0];
        for (var m = 0; m < all.length; m++) {
            if (all[m] !== keep && all[m].parentNode) {
                all[m].parentNode.removeChild(all[m]);
            }
        }
    }

    /**
     * Primary injection pass scanning the DOM for header toolbars.
     */
    function injectHeaderButton() {
        // Do not inject if disabled by server settings
        if (!isLauncherEnabled) {
            removeExistingButtons();
            return;
        }

        var injected = false;

        // Modern Material-UI toolbars
        var toolbars = document.querySelectorAll(".MuiToolbar-root");
        for (var i = 0; i < toolbars.length && !injected; i++) {
            if (
                toolbars[i].querySelector(TOOLBAR_USER_SELECTOR) &&
                injectIntoToolbar(toolbars[i])
            ) {
                injected = true;
            }
        }
        for (var t = 0; t < toolbars.length && !injected; t++) {
            if (injectIntoToolbar(toolbars[t])) {
                injected = true;
            }
        }

        // Legacy Jellyfin headers
        var legacyHeaders = document.querySelectorAll(
            ".skinHeader:not(.osdHeader) .headerRight, .headerRight"
        );
        for (var j = 0; j < legacyHeaders.length && !injected; j++) {
            if (injectIntoLegacyHeader(legacyHeaders[j])) {
                injected = true;
            }
        }

        // Fallback user avatar positioning
        if (!injected && !document.querySelector(".headerLitefinButton")) {
            var anyUserBtn = document.querySelector(
                ".headerUserButton, button[aria-controls='app-user-menu'], button[aria-label*='UserMenu']"
            );
            if (anyUserBtn && isElementVisible(anyUserBtn) && anyUserBtn.parentNode) {
                if (!anyUserBtn.parentNode.querySelector(".headerLitefinButton")) {
                    var fallbackBtn = createLitefinButton();
                    anyUserBtn.parentNode.insertBefore(fallbackBtn, anyUserBtn);
                }
            }
        }

        removeExtraButtons();
    }

    /**
     * Injects the CSS rule to swap the Material TV glyph for the Litefin SVG logo
     * on the dashboard/plugins sidebar entry.
     */
    function ensureSidebarLogoStyle() {
        if (document.getElementById("litefin-sidebar-icon-style")) return;
        var style = document.createElement("style");
        style.id = "litefin-sidebar-icon-style";
        style.textContent =
            "a[href*='configurationpage?name=Litefin' i] .material-icons, " +
            "a[href*='configurationpage?name=Litefin' i] .sidebarLinkIcon {" +
            "--litefinMark: url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100' fill='%23fff'%3E%3Cpath d='M19.57,91c-2.24,0-4.73-0.44-6.87-2.02c-2.07-1.53-3.32-3.6-3.62-5.97c-0.51-4.01,1.81-7.59,3.24-9.37c4.82-5.97,9.41-12.5,10.36-19.76c0.8-6.13-1-12.33-2.9-18.9c-0.59-2.04-1.21-4.16-1.73-6.27 c-0.8-3.17-1.42-6.59-0.53-10.08c1.8-7.06,9.11-10.26,21.74-9.53c10.63,0.62,21.35,5.21,30.19,12.91 C82.12,33.08,93.56,53.11,90.5,72.93c-0.23,1.54-0.58,2.97-1.04,4.26c-1.28,3.66-3.47,6.32-6.34,7.68 c-3.63,1.71-7.38,1.01-10.39,0.44c-2.45-0.46-5.35-0.99-8.34-1.37c-6.72-0.86-12.12-0.79-17.02,0.21 c-3.5,0.71-6.9,1.8-10.49,2.95c-4.51,1.44-9.17,2.94-14.09,3.64C21.84,90.88,20.74,91,19.57,91z M35.69,16 c-5.23,0-10.52,0.9-11.4,4.36c-0.5,1.98-0.04,4.37,0.53,6.65c0.5,1.99,1.09,4.04,1.67,6.02c2.02,6.97,4.11,14.17,3.12,21.75 c-1.17,8.98-6.38,16.48-11.85,23.25c-1.19,1.47-1.87,3.08-1.75,4.08c0.04,0.31,0.17,0.73,0.85,1.23 c0.89,0.66,2.51,0.81,4.95,0.46c4.34-0.62,8.53-1.96,12.95-3.38c3.61-1.16,7.35-2.35,11.22-3.14c5.67-1.16,11.81-1.26,19.31-0.3 c3.17,0.41,6.2,0.95,8.74,1.43c2.32,0.44,4.52,0.85,6.1,0.11c1.15-0.54,2.07-1.78,2.72-3.66l0-0.01c0.31-0.87,0.55-1.88,0.72-3 c2.65-17.2-7.5-34.78-18.74-44.57c-7.68-6.69-16.92-10.67-26-11.2C37.81,16.04,36.75,16,35.69,16z'/%3E%3Cpath d='M69.3,63.51c0.19-0.64,0.32-1.3,0.41-1.95 c1.26-9.44-3.2-19.55-9.22-25.63c-3.64-3.67-8.19-6.14-13.02-6.47c-2.7-0.18-7.56-0.15-8.41,3.7c-0.32,1.47-0.07,3.03,0.25,4.49 c1.01,4.7,2.72,9.41,2.18,14.21C41,56.22,38.72,60,36.34,63.41c-1.14,1.63-1.9,4.02-0.12,5.54c0.97,0.83,2.3,0.8,3.49,0.6 c3.88-0.64,7.47-2.62,11.3-3.52c2.77-0.66,5.63-0.55,8.42-0.14c1.33,0.2,2.64,0.47,3.96,0.75c1.25,0.27,2.62,0.57,3.82-0.09 C68.26,65.98,68.91,64.81,69.3,63.51z'/%3E%3C/svg%3E\");" +
            "font-size: 0 !important;" +
            "width: 1.5rem !important;" +
            "height: 1.5rem !important;" +
            "display: inline-block !important;" +
            "background-color: currentColor !important;" +
            "-webkit-mask: var(--litefinMark) center/contain no-repeat !important;" +
            "mask: var(--litefinMark) center/contain no-repeat !important;" +
            "}";
        document.head.appendChild(style);
    }

    ensureSidebarLogoStyle();

    // Check configuration asynchronously in parallel
    verifyLauncherConfiguration();

    // Initial mount on DOM readiness
    if (document.readyState === "complete") {
        setTimeout(injectHeaderButton, 50);
    } else {
        window.addEventListener("load", function () {
            setTimeout(injectHeaderButton, 50);
        });
    }

    // Coalesce rapid DOM mutations using requestAnimationFrame
    var scanScheduled = false;
    function scheduleInject() {
        if (scanScheduled) return;
        scanScheduled = true;
        var run = function () {
            scanScheduled = false;
            injectHeaderButton();
        };
        if (typeof requestAnimationFrame === "function") {
            requestAnimationFrame(run);
        } else {
            setTimeout(run, 50);
        }
    }

    // Observe dynamic route changes and UI re-renders in Jellyfin Web SPA
    try {
        var observer = new MutationObserver(scheduleInject);
        observer.observe(document.body || document.documentElement, {
            childList: true,
            subtree: true,
        });
    } catch (e) {}

    // Periodic check to guarantee icon remains present across view navigations
    setInterval(injectHeaderButton, 1000);
})();




