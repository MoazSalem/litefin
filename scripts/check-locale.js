#!/usr/bin/env node
/**
 * check-locale.js
 *
 * Compares a target locale file against src/locales/en-us.json (source of truth).
 *
 * Usage:
 *   node scripts/check-locale.js --locale uk
 *   node scripts/check-locale.js -l pt-br
 *   node scripts/check-locale.js --all
 *
 * Flags:
 *   --locale, -l <code>   Locale code or path to compare (e.g. uk, pt-br, src/locales/uk.json)
 *   --all                 Check every locale in src/locales/ except en-us.json
 *   --skip-short, -s      Only flag multi-word untranslated values (skip single-word matches)
 *   --no-untranslated, -u Skip the untranslated-value check entirely
 *   --no-extra, -e        Skip the extra-keys check
 *
 * Short flags can be stacked: -se, -ue, -use
 * When stacking with -l, put -l last: -ul uk (not -lu uk)
 */

import { readFileSync, readdirSync } from 'fs';
import { resolve, join, basename, extname } from 'path';
import { fileURLToPath } from 'url';

// ── Helpers ──────────────────────────────────────────────────────────────────

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(__dirname, '..');
const LOCALES_DIR = join(ROOT, 'src', 'locales');
const SOURCE_FILE = join(LOCALES_DIR, 'en-us.json');

// ANSI colours (disabled when not a TTY)
const isTTY = process.stdout.isTTY;
const c = {
    reset: isTTY ? '\x1b[0m' : '',
    bold: isTTY ? '\x1b[1m' : '',
    red: isTTY ? '\x1b[31m' : '',
    yellow: isTTY ? '\x1b[33m' : '',
    green: isTTY ? '\x1b[32m' : '',
    cyan: isTTY ? '\x1b[36m' : '',
    grey: isTTY ? '\x1b[90m' : '',
    magenta: isTTY ? '\x1b[35m' : ''
};

const fmt = {
    header: (s) => `${c.bold}${c.cyan}${s}${c.reset}`,
    section: (s) => `${c.bold}${s}${c.reset}`,
    ok: (s) => `${c.green}${s}${c.reset}`,
    warn: (s) => `${c.yellow}${s}${c.reset}`,
    err: (s) => `${c.red}${s}${c.reset}`,
    muted: (s) => `${c.grey}${s}${c.reset}`,
    accent: (s) => `${c.magenta}${s}${c.reset}`
};

function loadJson(filePath) {
    try {
        return JSON.parse(readFileSync(filePath, 'utf-8'));
    } catch (e) {
        console.error(fmt.err(`\nError reading "${filePath}": ${e.message}\n`));
        process.exit(1);
    }
}

/** A value is considered "likely multi-word English" if it contains at least one space. */
function isMultiWord(str) {
    return typeof str === 'string' && str.includes(' ');
}
/** Resolve a locale argument to a file path. */
function resolveLocale(arg) {
    // Full path given
    if (arg.endsWith('.json')) {
        return resolve(ROOT, arg);
    }
    // Bare code, e.g. "uk" or "pt-br"
    return join(LOCALES_DIR, `${arg}.json`);
}

// ── Core compare ─────────────────────────────────────────────────────────────

const COMMENT_KEY_PREFIX = '_'; // e.g. "_Litefin Specific Keys"

const TECHNICAL_KEYS = [
    "Option3D", "OptionBluray", "OptionDvd", "OptionIsHD", "OptionIsSD",
    "AppleTV", "BackendTizen", "BackendWeb", "BackendWebOS", 
    "BitrateKbps", "BitrateMbps", "DolbyVision", "FHD", 
    "FontGoogleSans",
    "FontSilkscreen",
    "FontSpaceGrotesk",
    "FontRoboto",
    "FontBaloo",
    "HD",
    "Option4K",
    "Path",
    "ResolutionValue", "SpeedValue", "SyncPlay", "TizenValue", 
    "UHD", "UHD8K", "WebOSValue", "WMC"
];

function compareLocales(sourcePath, targetPath, opts = {}) {
    const source = loadJson(sourcePath);
    const target = loadJson(targetPath);

    const sourceKeys = Object.keys(source).filter((k) => !k.startsWith(COMMENT_KEY_PREFIX));
    const targetKeys = new Set(Object.keys(target).filter((k) => !k.startsWith(COMMENT_KEY_PREFIX)));
    const sourceKeySet = new Set(sourceKeys);

    const missing = [];
    const untranslated = [];
    const extra = [];

    // Keys in source not in target → missing
    // Keys where target value === source value → untranslated
    for (const key of sourceKeys) {
        if (!targetKeys.has(key)) {
            missing.push(key);
        } else if (!opts.noUntranslated) {
            const srcVal = source[key];
            const tgtVal = target[key];
            const isSameAsSource = srcVal !== '' && srcVal === tgtVal;
            const isTechnical = TECHNICAL_KEYS.includes(key);
            const passesShortFilter = opts.skipShort ? isMultiWord(srcVal) : true;

            if (isSameAsSource && passesShortFilter && !isTechnical) {
                untranslated.push({ key, value: srcVal });
            }
        }
    }

    // Keys in target not in source → extra
    if (!opts.noExtra) {
        for (const key of targetKeys) {
            if (!sourceKeySet.has(key)) {
                extra.push(key);
            }
        }
    }

    return { missing, untranslated, extra, sourceCount: sourceKeys.length };
}

// ── Output ────────────────────────────────────────────────────────────────────

function printResults(locale, { missing, untranslated, extra, sourceCount }) {
    const hasIssues = missing.length > 0 || untranslated.length > 0 || extra.length > 0;
    const coverage = Math.round(((sourceCount - missing.length - untranslated.length) / sourceCount) * 100);

    console.log('');
    console.log(fmt.header(`── ${locale} ─────────────────────────────────────────`));
    console.log(
        fmt.muted(
            `  Source keys: ${sourceCount}  |  Coverage estimate: ${coverage}%  |  Issues: ${missing.length + untranslated.length + extra.length}`
        )
    );

    if (!hasIssues) {
        console.log(fmt.ok('  No issues found.'));
        return { hasIssues: false };
    }

    // Missing keys
    if (missing.length > 0) {
        console.log('');
        console.log(fmt.section(`  Missing keys (${missing.length}):`));
        console.log(fmt.muted('  These keys exist in en-us.json but are absent from the target file.'));
        for (const key of missing) {
            console.log(fmt.err(`    - ${key}`));
        }
    }

    // Untranslated keys
    if (untranslated.length > 0) {
        console.log('');
        console.log(fmt.section(`  Untranslated keys (${untranslated.length}):`));
        console.log(fmt.muted('  Values identical to the English source — likely not yet translated.'));
        for (const { key, value } of untranslated) {
            console.log(fmt.warn(`    - ${key}`) + fmt.muted(`  →  "${value}"`));
        }
    }

    // Extra keys
    if (extra.length > 0) {
        console.log('');
        console.log(fmt.section(`  Extra keys (${extra.length}):`));
        console.log(fmt.muted('  These keys are in the target file but missing from en-us.json.'));
        for (const key of extra) {
            console.log(fmt.accent(`    + ${key}`));
        }
    }

    return { hasIssues: true };
}

// ── CLI ───────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
    const raw = argv.slice(2);
    const opts = {
        locales: [],
        all: false,
        skipShort: false,
        noUntranslated: false,
        noExtra: false
    };

    // Pre-pass: expand stacked short flags like -ue → -u -e
    // Single-char flags that are pure booleans: s, u, e
    // -l takes a value so it can be stacked but must come last: -ul uk
    const BOOLEAN_SHORT = new Set(['s', 'u', 'e', 'a']);
    const expanded = [];
    for (const arg of raw) {
        if (/^-[a-zA-Z]{2,}$/.test(arg)) {
            // Multi-char single-dash: expand char by char
            for (const ch of arg.slice(1)) {
                expanded.push(`-${ch}`);
            }
        } else {
            expanded.push(arg);
        }
    }

    for (let i = 0; i < expanded.length; i++) {
        const arg = expanded[i];
        if (arg === '--all' || arg === '-a') {
            opts.all = true;
        } else if (arg === '--locale' || arg === '-l') {
            opts.locales.push(expanded[++i]);
        } else if (arg.startsWith('--locale=')) {
            opts.locales.push(arg.slice('--locale='.length));
        } else if (arg === '--skip-short' || arg === '-s') {
            opts.skipShort = true;
        } else if (arg === '--no-untranslated' || arg === '-u') {
            opts.noUntranslated = true;
        } else if (arg === '--no-extra' || arg === '-e') {
            opts.noExtra = true;
        } else if (!arg.startsWith('-')) {
            // Bare positional argument — treat as a locale code.
            // Handles `npm run locale:check -- uk` and the npm quirk where
            // `npm run locale:check -l uk` causes npm to consume -l itself,
            // leaving `uk` as a bare token passed to the script.
            opts.locales.push(arg);
        } else {
            console.error(fmt.err(`Unknown argument: ${arg}`));
            printUsage();
            process.exit(1);
        }
    }

    return opts;
}

function printUsage() {
    console.log(`
${fmt.header('Locale Check Tool')}

${fmt.section('Usage:')}
  node scripts/check-locale.js <locale>            Check a single locale (positional)
  node scripts/check-locale.js --locale <code>     Check a single locale (explicit flag)
  node scripts/check-locale.js --all               Check all locales

${fmt.section('Examples:')}
  node scripts/check-locale.js uk
  node scripts/check-locale.js -l pt-br
  node scripts/check-locale.js --locale src/locales/de.json
  node scripts/check-locale.js --all
  node scripts/check-locale.js uk -se              # skip-short + no-extra (stacked)
  node scripts/check-locale.js -ul uk -e           # stacked -u -l, then -e

${fmt.section('Options:')}
  --locale, -l <code>     Locale code or .json path to compare against en-us.json
  --all, -a               Scan every file in src/locales/ (except en-us.json)
  --skip-short, -s        Only flag multi-word untranslated values (skip single-word matches)
  --no-untranslated, -u   Skip the untranslated-value check entirely
  --no-extra, -e          Skip the extra-keys check

${fmt.section('Flag stacking:')}
  Boolean short flags (-s, -u, -e, -a) can be combined: -se, -ue, -use
  When stacking with -l (which takes a value), put -l last: -ul uk
`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

const opts = parseArgs(process.argv);

if (!opts.all && opts.locales.length === 0) {
    printUsage();
    process.exit(0);
}

let targetFiles = [];

if (opts.all) {
    const entries = readdirSync(LOCALES_DIR).filter((f) => extname(f) === '.json' && basename(f) !== 'en-us.json');
    targetFiles = entries.map((f) => ({ label: basename(f, '.json'), path: join(LOCALES_DIR, f) }));
} else {
    targetFiles = opts.locales.map((l) => ({
        label: basename(resolveLocale(l), '.json'),
        path: resolveLocale(l)
    }));
}

console.log(fmt.header('\nLocale Check'));
console.log(fmt.muted(`Source of truth: src/locales/en-us.json`));

let anyIssues = false;

for (const { label, path } of targetFiles) {
    const results = compareLocales(SOURCE_FILE, path, {
        noUntranslated: opts.noUntranslated,
        noExtra: opts.noExtra,
        skipShort: opts.skipShort
    });
    const { hasIssues } = printResults(label, results);
    if (hasIssues) anyIssues = true;
}

// Summary line when checking multiple locales
if (targetFiles.length > 1) {
    console.log('');
    if (anyIssues) {
        console.log(fmt.err('Some locales have issues. Review the output above.'));
    } else {
        console.log(fmt.ok('All checked locales look good!'));
    }
}

console.log('');
process.exit(anyIssues ? 1 : 0);
