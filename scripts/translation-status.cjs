const fs = require('fs');
const path = require('path');

/**
 * translation-status.cjs
 * 
 * Calculates translation progress and optionally updates src/locales/languages.js.
 * Usage: node scripts/translation-status.cjs [--update]
 */

const LOCALES_DIR = path.join(__dirname, '../src/locales');
const SOURCE_FILE = path.join(LOCALES_DIR, 'en-us.json');
const LANGUAGES_JS = path.join(LOCALES_DIR, 'languages.js');

const c = {
    reset: "\x1b[0m",
    bold: "\x1b[1m",
    green: "\x1b[32m",
    yellow: "\x1b[33m",
    red: "\x1b[31m",
    cyan: "\x1b[36m",
    grey: "\x1b[90m"
};

function getStatus() {
    const shouldUpdate = process.argv.includes('--update') || process.argv.includes('-u');

    if (!fs.existsSync(SOURCE_FILE)) {
        console.error("Could not find en-us.json");
        return;
    }

    const enUs = JSON.parse(fs.readFileSync(SOURCE_FILE, 'utf8'));
    const sourceKeys = Object.keys(enUs).filter(k => !k.startsWith('_'));
    const totalKeys = sourceKeys.length;

    const files = fs.readdirSync(LOCALES_DIR)
        .filter(f => f.endsWith('.json') && f !== 'en-us.json')
        .sort();

    console.log(`\n${c.bold}${c.cyan}Litefin Translation Status${c.reset}`);
    console.log(`${c.grey}Source: en-us.json (${totalKeys} keys)${c.reset}\n`);

    const TECHNICAL_KEYS = [
        "Option3D", "OptionBluray", "OptionDvd", "OptionIsHD", "OptionIsSD",
        "AppleTV", "BackendTizen", "BackendWeb", "BackendWebOS", 
        "BitrateKbps", "BitrateMbps", "DolbyVision", "FHD", 
        "FontGoogleSans", "FontSilkscreen", "FontSpaceGrotesk", "FontRoboto", "FontBaloo", "HD", "Option4K", "Path", 
        "ResolutionValue", "SpeedValue", "SyncPlay", "TizenValue", 
        "UHD", "UHD8K", "WebOSValue", "WMC"
    ];

    const results = [];
    // English is always 100%
    results.push({ lang: 'en-us', percent: 100.0, count: totalKeys });

    files.forEach(file => {
        const lang = path.basename(file, '.json');
        const content = JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, file), 'utf8'));
        
        let translatedCount = 0;
        sourceKeys.forEach(key => {
            const isTechnical = TECHNICAL_KEYS.includes(key);
            const isTranslated = content[key] && content[key] !== enUs[key];
            
            if (content[key] && (isTranslated || isTechnical)) {
                translatedCount++;
            }
        });

        const percent = ((translatedCount / totalKeys) * 100);
        results.push({ lang, percent: parseFloat(percent.toFixed(2)), count: translatedCount });
    });

    // Print sorted by percentage descending for console output
    const sortedResults = [...results].sort((a, b) => b.percent - a.percent);

    sortedResults.forEach(res => {
        if (res.lang === 'en-us' && sortedResults.length > 20) return; // Hide English in bulk list unless it's a short list

        let color = c.green;
        if (res.percent < 90) color = c.yellow;
        if (res.percent < 50) color = c.red;

        const progressBarWidth = 20;
        const filled = Math.round((res.percent / 100) * progressBarWidth);
        const bar = "█".repeat(filled) + "░".repeat(progressBarWidth - filled);

        console.log(
            `${res.lang.padEnd(8)} ` +
            `${color}${res.percent.toFixed(1).padStart(5)}%${c.reset} ` +
            `${c.grey}[${bar}]${c.reset} ` +
            `${c.grey}(${res.count}/${totalKeys})${c.reset}`
        );
    });

    if (shouldUpdate && fs.existsSync(LANGUAGES_JS)) {
        console.log(`\n${c.bold}Updating and reordering languages.js...${c.reset}`);
        
        let langJsContent = fs.readFileSync(LANGUAGES_JS, 'utf8');
        
        // Extract the array part from the JS file
        const arrayStart = langJsContent.indexOf('[');
        const arrayEnd = langJsContent.lastIndexOf(']') + 1;
        
        if (arrayStart === -1 || arrayEnd === 0) {
            console.error(`${c.red}Could not find the array in languages.js${c.reset}`);
            return;
        }

        const arrayText = langJsContent.substring(arrayStart, arrayEnd);
        let languages;
        try {
            // We use eval-like parsing or JSON.parse if it's clean JSON
            // The file looks like clean JSON inside the array, but we'll be careful
            languages = JSON.parse(arrayText);
        } catch (e) {
            console.error(`${c.red}Failed to parse array in languages.js. Ensure it is valid JSON-formatted array.${c.reset}`);
            return;
        }

        // Update completeness from results
        languages.forEach(langObj => {
            const match = results.find(r => r.lang === langObj.value);
            if (match) {
                langObj.completeness = match.percent;
            }
        });

        // Add any missing languages from the locales folder that aren't in languages.js yet
        results.forEach(res => {
            if (!languages.find(l => l.value === res.lang)) {
                languages.push({
                    value: res.lang,
                    label: res.lang.toUpperCase(), // Fallback label
                    completeness: res.percent
                });
            }
        });

        // Sort: >85% first (alpha by label), then the rest (alpha by label)
        languages.sort((a, b) => {
            const aComplete = a.completeness >= 85;
            const bComplete = b.completeness >= 85;

            if (aComplete && !bComplete) return -1;
            if (!aComplete && bComplete) return 1;

            // Both are in the same group, sort by label
            return a.label.localeCompare(b.label);
        });

        const newArrayText = JSON.stringify(languages, null, 4);
        const newContent = `// Auto-generated language mapping\nexport const availableLanguages = ${newArrayText};\n`;

        fs.writeFileSync(LANGUAGES_JS, newContent, 'utf8');
        console.log(`${c.green}Successfully updated and reordered languages.js${c.reset}`);
    } else if (shouldUpdate) {
        console.error(`${c.red}Could not find languages.js to update.${c.reset}`);
    }

    console.log("");
}

getStatus();
