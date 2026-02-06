import { SettingsManager } from '../../settings/SettingsManager';
import { debug } from '../../utils/debug';
import './SettingsPage.scss';

/**
 * SettingsPage - Minimal UI for player settings
 */
export class SettingsPage {
    /**
     * @param {Object} options
     * @param {HTMLElement} options.container - Container element to render into
     * @param {SettingsManager} options.settingsManager - Settings manager instance
     */
    constructor(options = {}) {
        this.container = options.container || document.body;
        this.settingsManager = options.settingsManager || new SettingsManager();
    }

    /**
     * Initialize the settings page
     */
    init() {
        this.render();
        this.bindEvents();
        this.loadValues();

        debug.log('SettingsPage initialized');
    }

    /**
     * Render the UI template
     */
    render() {
        // Ensure body has the correct class for styling
        document.body.classList.add('settings-page-body');

        this.container.innerHTML = `
            <div class="settings-container">
                <div class="settings-header">
                    <h1 class="settings-title">Player Settings</h1>
                </div>
                
                <!-- Audio Settings -->
                <div class="settings-section">
                    <h2 class="section-title">Audio</h2>
                    
                    ${this._renderSelect('allowedAudioChannels', 'Audio Channels', 'Maximum number of audio channels', [
            { value: -1, label: 'Auto' },
            { value: 2, label: 'Stereo' },
            { value: 6, label: '5.1 Surround' },
            { value: 8, label: '7.1 Surround' }
        ])}
                    
                    ${this._renderToggle('enableDts', 'Enable DTS', 'Enable DTS audio passthrough')}
                    ${this._renderToggle('enableTrueHd', 'Enable TrueHD', 'Enable TrueHD audio passthrough')}
                </div>
                
                <!-- Video Quality -->
                <div class="settings-section">
                    <h2 class="section-title">Video Quality</h2>
                    
                    ${this._renderSelect('maxBitrateInternet', 'Internet Streaming Bitrate', 'Maximum bitrate for streaming outside home network', [
            { value: 120000000, label: 'Auto (Maximum)' },
            { value: 60000000, label: '60 Mbps' },
            { value: 40000000, label: '40 Mbps' },
            { value: 20000000, label: '20 Mbps' },
            { value: 15000000, label: '15 Mbps' },
            { value: 10000000, label: '10 Mbps' },
            { value: 8000000, label: '8 Mbps' },
            { value: 4000000, label: '4 Mbps' },
            { value: 1500000, label: '1.5 Mbps' }
        ])}
                    
                    ${this._renderToggle('enableH264Hi10p', 'Enable H.264 High 10 Profile', 'Required for some 10-bit content')}
                </div>
                
                <!-- Subtitles -->
                <div class="settings-section">
                    <h2 class="section-title">Subtitles</h2>
                    
                    ${this._renderSelect('subtitleMode', 'Subtitle Mode', 'When to display subtitles', [
            { value: 'Default', label: 'Default' },
            { value: 'Smart', label: 'Smart (when audio differs)' },
            { value: 'Always', label: 'Always On' },
            { value: 'OnlyForced', label: 'Forced Only' },
            { value: 'None', label: 'None' }
        ])}
                    
                    ${this._renderSelect('subtitleBurnIn', 'Burn In Subtitles', 'Burn subtitles into video stream', [
            { value: '', label: 'Auto' },
            { value: 'all', label: 'Always' },
            { value: 'onlyImageFormats', label: 'Image formats only (PGS, VobSub)' },
            { value: 'onlyText', label: 'Text formats only' }
        ])}
                </div>
                
                <!-- Subtitle Appearance -->
                <div class="settings-section">
                    <h2 class="section-title">Subtitle Appearance</h2>
                    
                    ${this._renderSelect('subtitleSize', 'Text Size', 'Subtitle font size', [
            { value: 'smaller', label: 'Smaller' },
            { value: 'small', label: 'Small' },
            { value: 'medium', label: 'Medium' },
            { value: 'larger', label: 'Larger' },
            { value: 'extralarge', label: 'Extra Large' }
        ])}
                    
                    ${this._renderSelect('subtitleWeight', 'Text Weight', 'Subtitle font weight', [
            { value: 'normal', label: 'Normal' },
            { value: 'bold', label: 'Bold' }
        ])}
                    
                    ${this._renderSelect('subtitleDropShadow', 'Text Shadow', 'Shadow effect for readability', [
            { value: 'dropshadow', label: 'Drop Shadow' },
            { value: 'raised', label: 'Raised' },
            { value: 'depressed', label: 'Depressed' },
            { value: 'uniform', label: 'Uniform' },
            { value: 'none', label: 'None' }
        ])}
                    
                    ${this._renderSelect('subtitleFont', 'Font', 'Subtitle font family', [
            { value: '', label: 'Default' },
            { value: 'typewriter', label: 'Typewriter' },
            { value: 'print', label: 'Print' },
            { value: 'console', label: 'Console' },
            { value: 'cursive', label: 'Cursive' },
            { value: 'casual', label: 'Casual' },
            { value: 'smallcaps', label: 'Small Caps' }
        ])}
                    
                    ${this._renderColor('subtitleTextColor', 'Text Color', 'Subtitle text color')}
                    
                    ${this._renderSelect('subtitleTextBackground', 'Background', 'Background behind subtitle text', [
            { value: 'transparent', label: 'Transparent' },
            { value: 'rgba(0,0,0,0.5)', label: 'Semi-transparent' },
            { value: 'rgba(0,0,0,0.8)', label: 'Dark' },
            { value: '#000000', label: 'Solid Black' }
        ])}
                </div>
                
                <!-- Playback -->
                <div class="settings-section">
                    <h2 class="section-title">Playback</h2>
                    
                    ${this._renderSelect('skipForwardLength', 'Skip Forward Length', 'Seconds to skip forward (base for speed multiplier)', [
            { value: 5000, label: '5 seconds' },
            { value: 10000, label: '10 seconds' },
            { value: 15000, label: '15 seconds' },
            { value: 20000, label: '20 seconds' },
            { value: 25000, label: '25 seconds' },
            { value: 30000, label: '30 seconds' },
            { value: 45000, label: '45 seconds' },
            { value: 60000, label: '60 seconds' }
        ])}
                    
                    ${this._renderSelect('skipBackLength', 'Skip Back Length', 'Seconds to skip backward (base for speed multiplier)', [
            { value: 5000, label: '5 seconds' },
            { value: 10000, label: '10 seconds' },
            { value: 15000, label: '15 seconds' },
            { value: 20000, label: '20 seconds' },
            { value: 25000, label: '25 seconds' },
            { value: 30000, label: '30 seconds' },
            { value: 45000, label: '45 seconds' },
            { value: 60000, label: '60 seconds' }
        ])}
                    
                    ${this._renderToggle('enableNextEpisodeAutoPlay', 'Auto-play Next Episode', 'Automatically play next episode in series')}
                </div>
                
                <!-- Actions -->
                <div class="settings-actions">
                    <button class="btn btn-primary" id="saveBtn">Save Settings</button>
                    <button class="btn btn-secondary" id="resetBtn">Reset to Defaults</button>
                </div>
            </div>
        `;
    }

    /**
     * Bind event listeners
     */
    bindEvents() {
        const saveBtn = this.container.querySelector('#saveBtn');
        const resetBtn = this.container.querySelector('#resetBtn');

        if (saveBtn) {
            saveBtn.addEventListener('click', () => this.save());
        }

        if (resetBtn) {
            resetBtn.addEventListener('click', () => this.reset());
        }
    }

    /**
     * Load current values into form
     */
    loadValues() {
        // Collect all IDs from DOM
        const inputs = this.container.querySelectorAll('[id]:not(#saveBtn):not(#resetBtn)');

        inputs.forEach(input => {
            const key = input.id;
            // Access getter by property name (SettingsManager properties match IDs)
            let value = this.settingsManager[key];

            // Handle if value is undefined (maybe not in manager yet or simple typo)
            if (value === undefined) return;

            if (input.type === 'checkbox') {
                input.checked = !!value;
            } else {
                input.value = value;
            }
        });
    }

    /**
     * Save settings from form
     */
    save() {
        const inputs = this.container.querySelectorAll('[id]:not(#saveBtn):not(#resetBtn)');
        const changes = {};

        inputs.forEach(input => {
            const key = input.id;
            let value;

            if (input.type === 'checkbox') {
                value = input.checked;
            } else if (input.tagName === 'SELECT') {
                // Try parse number if valid
                const num = parseFloat(input.value);
                value = isNaN(num) ? input.value : num;

                // Specific fix for string values that look like numbers but shouldn't be parsed?
                // Or "Auto" = "" strings. 
                // For now, simple logic: if original was string, keep string? 
                // SettingsManager setter usually handles type conversion if needed, 
                // but let's be careful.
                const original = this.settingsManager[key];
                if (typeof original === 'string' && !isNaN(num)) {
                    // It was a string, let's keep it string if it matches
                    // But some selects like "Bitrate" are numbers.
                }
            } else {
                value = input.value;
            }

            // Update manager
            this.settingsManager[key] = value;
            changes[key] = value;
        });

        debug.log('Settings saved:', changes);

        // Notify host
        if (window.parent !== window) {
            window.parent.postMessage({ type: 'settingsSaved', settings: changes }, '*');
        }

        // Visual feedback
        const saveBtn = this.container.querySelector('#saveBtn');
        const originalText = saveBtn.textContent;
        saveBtn.textContent = 'Saved!';
        saveBtn.style.backgroundColor = '#4caf50';
        setTimeout(() => {
            saveBtn.textContent = originalText;
            saveBtn.style.backgroundColor = '';
        }, 2000);
    }

    /**
     * Reset settings
     */
    reset() {
        if (confirm('Are you sure you want to reset all settings to default?')) {
            this.settingsManager.resetToDefaults();
            this.loadValues();
        }
    }

    // Helpers for rendering
    _renderSelect(id, label, desc, options) {
        return `
            <div class="setting-row">
                <div class="setting-label">
                    <div class="setting-label-text">${label}</div>
                    <div class="setting-label-desc">${desc}</div>
                </div>
                <div class="setting-control">
                    <select id="${id}" class="jellyfin-select">
                        ${options.map(opt => `<option value="${opt.value}">${opt.label}</option>`).join('')}
                    </select>
                </div>
            </div>
        `;
    }

    _renderToggle(id, label, desc) {
        return `
            <div class="setting-row">
                <div class="setting-label">
                    <div class="setting-label-text">${label}</div>
                    <div class="setting-label-desc">${desc}</div>
                </div>
                <div class="setting-control">
                    <label class="toggle">
                        <input type="checkbox" id="${id}">
                        <span class="toggle-slider"></span>
                    </label>
                </div>
            </div>
        `;
    }

    _renderColor(id, label, desc) {
        return `
            <div class="setting-row">
                <div class="setting-label">
                    <div class="setting-label-text">${label}</div>
                    <div class="setting-label-desc">${desc}</div>
                </div>
                <div class="setting-control">
                    <input type="color" id="${id}" class="jellyfin-color" value="#ffffff">
                </div>
            </div>
        `;
    }
}
