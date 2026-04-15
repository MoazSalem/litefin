const fs = require('fs');
const path = require('path');

/**
 * sync-locales.cjs
 * 
 * This script ensures all language files in src/locales are synchronized with en-us.json.
 * It enforces the same key order, injects missing keys (using English as fallback),
 * and removes obsolete keys.
 * 
 * Ported and extracted from the global port_translations.js utility.
 */

const LOCALE_DIR = path.join(__dirname, '../src/locales');
const EN_JSON_PATH = path.join(LOCALE_DIR, 'en-us.json');

const LITEFIN_MARKER = "_Litefin Specific Keys";
const UNTRANSLATED_MARKER = "_Jellyfin Untranslated Keys";

/**
 * Writes JSON to file with identical spacing/marker logic as the main porting script.
 */
function writeJsonWithMarkers(outputPath, jsonObject) {
    let outputString = JSON.stringify(jsonObject, null, 4);

    // Inject empty line before markers for better Git diff readability
    outputString = outputString.replace(
        new RegExp(`^(\\s+)"${UNTRANSLATED_MARKER}"`, 'm'),
        '\n$1"' + UNTRANSLATED_MARKER + '"'
    );
    outputString = outputString.replace(
        new RegExp(`^(\\s+)"${LITEFIN_MARKER}"`, 'm'),
        '\n$1"' + LITEFIN_MARKER + '"'
    );

    fs.writeFileSync(outputPath, outputString + '\n');
}

function syncLocales() {
    console.log("Starting locale synchronization...");

    if (!fs.existsSync(EN_JSON_PATH)) {
        console.error(`Error: Could not find master file at ${EN_JSON_PATH}`);
        process.exit(1);
    }

    // 1. Read and Sort en-us.json (the Gold Standard)
    const enContent = JSON.parse(fs.readFileSync(EN_JSON_PATH, 'utf8'));
    const enEntries = Object.entries(enContent);
    const markerIndex = enEntries.findIndex(([key]) => key === LITEFIN_MARKER);

    let sharedKeys, litefinSpecificKeys;

    if (markerIndex !== -1) {
        // Sort sections alphabetically while maintaining the marker boundary
        sharedKeys = enEntries.slice(0, markerIndex).sort((a, b) => a[0].localeCompare(b[0]));
        litefinSpecificKeys = enEntries.slice(markerIndex + 1).sort((a, b) => a[0].localeCompare(b[0]));
    } else {
        // Fallback if no marker is present (sort entirely)
        sharedKeys = enEntries.sort((a, b) => a[0].localeCompare(b[0]));
        litefinSpecificKeys = [];
    }

    // Reconstruct sorted en-us.json
    const sortedEnContent = {};
    sharedKeys.forEach(([k, v]) => sortedEnContent[k] = v);
    if (markerIndex !== -1) {
        sortedEnContent[LITEFIN_MARKER] = "";
        litefinSpecificKeys.forEach(([k, v]) => sortedEnContent[k] = v);
    }

    writeJsonWithMarkers(EN_JSON_PATH, sortedEnContent);
    console.log("Verified and sorted en-us.json");

    // 2. Sync all other locales
    const localeFiles = fs.readdirSync(LOCALE_DIR)
        .filter(file => file.endsWith('.json') && file !== 'en-us.json');

    localeFiles.forEach(file => {
        const filePath = path.join(LOCALE_DIR, file);
        let currentJson = {};

        try {
            currentJson = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        } catch (e) {
            console.warn(`Warning: Could not parse ${file}, starting fresh.`);
        }

        const synchronizedJson = {};

        // Sync Shared Section
        sharedKeys.forEach(([key, enValue]) => {
            // Keep existing translation if present and not empty
            synchronizedJson[key] = currentJson[key] || enValue;
        });

        // Sync Litefin Specific Section
        if (markerIndex !== -1) {
            synchronizedJson[LITEFIN_MARKER] = "";
            litefinSpecificKeys.forEach(([key, enValue]) => {
                synchronizedJson[key] = currentJson[key] || enValue;
            });
        }

        writeJsonWithMarkers(filePath, synchronizedJson);
        console.log(`Synchronized ${file}`);
    });

    console.log("Locale synchronization complete!");
}

syncLocales();
