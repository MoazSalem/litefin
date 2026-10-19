/**
 * ============================================================================
 * Litefin Client Plugin - Automated Packaging Script
 * ============================================================================
 * Automates compiling the web client bundle across supported tiers (Modern,
 * Normal, Legacy, Ultra-Legacy), publishing the .NET 8 server plugin with
 * stamped metadata, bundling client assets, creating the release zip archive,
 * calculating MD5 checksums, and generating/updating the repository manifest.
 * ============================================================================
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import archiver from 'archiver';
import process from 'process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

// ============================================================================
// 1. Version, Tier, and Argument Parsing
// ============================================================================
// Retrieve version from config.xml (Single Source of Truth for all Litefin platforms)
let version = '1.0.0';
const configXmlPath = path.join(rootDir, 'config.xml');
if (fs.existsSync(configXmlPath)) {
    const configXmlContent = fs.readFileSync(configXmlPath, 'utf8');
    const versionMatch = configXmlContent.match(/<widget[^>]*\sversion="([^"]+)"/);
    if (versionMatch && versionMatch[1]) {
        version = versionMatch[1].trim();
    }
} else {
    // Fallback to package.json if config.xml is missing
    const packageJsonPath = path.join(rootDir, 'package.json');
    if (fs.existsSync(packageJsonPath)) {
        const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
        version = packageJson.version || version;
    }
}

// Ensure package.json version matches config.xml
const packageJsonPath = path.join(rootDir, 'package.json');
if (fs.existsSync(packageJsonPath)) {
    const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    if (pkg.version !== version) {
        pkg.version = version;
        fs.writeFileSync(packageJsonPath, JSON.stringify(pkg, null, 4));
    }
}

// Calculate 4-part assembly version required by .NET (e.g. 2.0.20 -> 2.0.20.0)
const assemblyVersion = version.split('.').length === 3 ? `${version}.0` : version;

// Ensure server-plugin/Litefin.Web.csproj reflects the active version
const csprojPath = path.join(rootDir, 'server-plugin', 'Litefin.Web.csproj');
if (fs.existsSync(csprojPath)) {
    const csprojContent = fs.readFileSync(csprojPath, 'utf8');
    const updatedCsproj = csprojContent
        .replace(/<Version>[^<]+<\/Version>/, `<Version>${version}</Version>`)
        .replace(/<AssemblyVersion>[^<]+<\/AssemblyVersion>/, `<AssemblyVersion>${assemblyVersion}</AssemblyVersion>`)
        .replace(/<FileVersion>[^<]+<\/FileVersion>/, `<FileVersion>${assemblyVersion}</FileVersion>`);
    if (updatedCsproj !== csprojContent) {
        fs.writeFileSync(csprojPath, updatedCsproj, 'utf8');
    }
}

// Parse command line arguments
const args = process.argv.slice(2);
const changelogArg = args.find((a) => a.startsWith('--changelog='));
let changelog = changelogArg ? changelogArg.replace('--changelog=', '').trim() : '';

// Supported build tiers and tier-specific configuration matrix
const TIER_CONFIGS = {
    modern: {
        name: 'Litefin Client',
        zipSuffix: '',
        webpackConfig: 'web',
        distDir: path.join(rootDir, 'dist', 'web'),
        guid: 'b4a2c918-7e3f-4d92-a1b8-6e54f0a9d123',
        description: 'Embedded modern Litefin client with Movi WebAssembly video player.',
        overview: 'Access Litefin directly in your browser at /litefin.'
    },
    normal: {
        name: 'Litefin Client (Normal)',
        zipSuffix: '-Normal',
        webpackConfig: 'normal',
        distDir: path.join(rootDir, 'dist', 'normal'),
        guid: 'b4a2c918-7e3f-4d92-a1b8-6e54f0a9d124',
        description: 'Embedded Litefin client (Normal tier for Chromium 63+ / Tizen 5.0+).',
        overview: 'Access Litefin directly in your browser at /litefin (Chromium 63+ compatible).'
    },
    legacy: {
        name: 'Litefin Client (Legacy)',
        zipSuffix: '-Legacy',
        webpackConfig: 'legacy',
        distDir: path.join(rootDir, 'dist', 'legacy'),
        guid: 'b4a2c918-7e3f-4d92-a1b8-6e54f0a9d125',
        description: 'Embedded Litefin client (Legacy tier for Chromium 38+ / Tizen 3.0+ / webOS 4.0+).',
        overview: 'Access Litefin directly in your browser at /litefin (Chromium 38+ / ES5 compatible).'
    },
    'ultra-legacy': {
        name: 'Litefin Client (Ultra-Legacy)',
        zipSuffix: '-Ultra-Legacy',
        webpackConfig: 'ultra-legacy',
        distDir: path.join(rootDir, 'dist', 'ultra-legacy'),
        guid: 'b4a2c918-7e3f-4d92-a1b8-6e54f0a9d126',
        description: 'Embedded Litefin client (Ultra-Legacy tier for Chromium 26+ / Tizen 2.3+ / webOS 1.0+).',
        overview: 'Access Litefin directly in your browser at /litefin (Chromium 26+ / heavy polyfills).'
    }
};

// Parse target tier from CLI flag (--tier=...) or positional arguments
const tierArg = args.find((a) => a.startsWith('--tier='));
let tier = tierArg ? tierArg.replace('--tier=', '').trim().toLowerCase() : '';
if (!tier) {
    const validTiers = Object.keys(TIER_CONFIGS);
    tier = args.find((a) => validTiers.includes(a.toLowerCase())) || 'modern';
}

const currentConfig = TIER_CONFIGS[tier] || TIER_CONFIGS.modern;

// Check environment variable fallback for CI/CD runners
if (!changelog && process.env.CHANGELOG) {
    changelog = process.env.CHANGELOG.trim();
}

// If no explicit changelog is passed, attempt git log extraction or default to release note
if (!changelog) {
    try {
        const prevTag = execSync('git describe --tags --abbrev=0 HEAD^ 2>nul || git rev-list --max-parents=0 HEAD', {
            cwd: rootDir,
            encoding: 'utf8'
        }).trim();

        const gitLog = execSync(`git log ${prevTag}..HEAD --pretty=format:"- %s"`, {
            cwd: rootDir,
            encoding: 'utf8'
        }).trim();

        changelog = gitLog || `Release ${version}`;
    } catch {
        changelog = `Release ${version}`;
    }
}

console.log(`\n======================================================`);
console.log(` Packaging ${currentConfig.name} Plugin v${version}`);
console.log(` Tier: ${tier} (Webpack Target: ${currentConfig.webpackConfig})`);
console.log(` GUID: ${currentConfig.guid}`);
console.log(`======================================================\n`);

// ============================================================================
// 2. Build the Web Client (Tier-Specific Webpack Target)
// ============================================================================
// Compiles client code for the selected browser runtime tier
console.log(`>>> [1/5] Compiling Litefin web client bundle [${currentConfig.name}]...`);
try {
    execSync(`npx webpack --config webpack.config.cjs --config-name ${currentConfig.webpackConfig}`, {
        cwd: rootDir,
        stdio: 'inherit',
        env: {
            ...process.env,
            NODE_OPTIONS: process.env.NODE_OPTIONS || '--max-old-space-size=4096'
        }
    });
} catch (err) {
    console.error(`Failed to compile ${tier} bundle:`, err);
    process.exit(1);
}

const distClientDir = currentConfig.distDir;
if (!fs.existsSync(distClientDir) || !fs.existsSync(path.join(distClientDir, 'index.html'))) {
    console.error(`Build output ${distClientDir}/index.html was not found!`);
    process.exit(1);
}

// ============================================================================
// 3. Compile and Publish .NET Server Plugin
// ============================================================================
// Publishes Litefin.Web.dll targeting net8.0 with stamped tier metadata
// Path to the .NET plugin project and output publication folder
const publishDir = path.join(rootDir, 'server-plugin', 'bin', 'Release', 'net8.0', 'publish');

if (fs.existsSync(publishDir)) {
    fs.rmSync(publishDir, { recursive: true, force: true });
}

try {
    execSync(
        `dotnet publish "${csprojPath}" -c Release -o "${publishDir}" -p:Version=${version} -p:AssemblyVersion=${assemblyVersion} -p:FileVersion=${assemblyVersion} -p:PluginGuid=${currentConfig.guid} -p:PluginName="${currentConfig.name}" -p:PluginDescription="${currentConfig.description}"`,
        {
            cwd: rootDir,
            stdio: 'inherit'
        }
    );
} catch (err) {
    console.error('Failed to publish .NET plugin assembly:', err);
    process.exit(1);
}

// ============================================================================
// 4. Bundle Web Assets and Meta Information
// ============================================================================
// Copy compiled tier distribution folder into the publish folder under web/
console.log('\n>>> [3/5] Bundling web client assets into plugin directory...');
const targetWebDir = path.join(publishDir, 'web');
if (fs.existsSync(targetWebDir)) {
    fs.rmSync(targetWebDir, { recursive: true, force: true });
}
fs.cpSync(distClientDir, targetWebDir, { recursive: true });

// Copy icon_oblong.png into plugin package root
const iconOblongSrc = path.join(rootDir, 'assets', 'icon_oblong.png');
if (fs.existsSync(iconOblongSrc)) {
    fs.copyFileSync(iconOblongSrc, path.join(publishDir, 'icon_oblong.png'));
}

// Write meta.json for Jellyfin plugin discovery and catalog metadata
const pluginGuid = currentConfig.guid;
const timestamp = new Date().toISOString();

const meta = {
    category: 'General',
    changelog: changelog,
    description: currentConfig.description,
    guid: pluginGuid,
    name: currentConfig.name,
    overview: currentConfig.overview,
    owner: 'MoazSalem',
    imageUrl: 'https://raw.githubusercontent.com/MoazSalem/litefin/development/assets/icon_oblong.png',
    targetAbi: '10.10.0.0',
    timestamp: timestamp,
    version: version,
    status: 'Active',
    autoUpdate: true,
    assemblies: ['Litefin.Web.dll']
};

fs.writeFileSync(path.join(publishDir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8');

// ============================================================================
// 5. Create Plugin Release ZIP Archive
// ============================================================================
console.log('\n>>> [4/5] Compressing plugin release archive...');
const zipName = `Litefin.Client.Plugin${currentConfig.zipSuffix}_${version}.zip`;
const zipPath = path.join(rootDir, zipName);

if (fs.existsSync(zipPath)) {
    fs.unlinkSync(zipPath);
}

await new Promise((resolve, reject) => {
    const output = fs.createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 9 } });

    output.on('close', resolve);
    archive.on('error', reject);

    archive.pipe(output);
    archive.directory(publishDir, false);
    archive.finalize();
});

console.log(`Created archive: ${zipName} (${fs.statSync(zipPath).size} bytes)`);

// ============================================================================
// 6. Calculate MD5 Checksum and Update Repository Manifest
// ============================================================================
console.log('\n>>> [5/5] Updating litefin-plugin-manifest.json...');
const zipBuffer = fs.readFileSync(zipPath);
const md5Hash = crypto.createHash('md5').update(zipBuffer).digest('hex');

console.log(`MD5 Checksum: ${md5Hash}`);

const manifestPath = path.join(rootDir, 'litefin-plugin-manifest.json');
let manifest = [];

if (fs.existsSync(manifestPath)) {
    try {
        manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch (e) {
        console.warn('Could not parse existing manifest, generating a new one.');
        manifest = [];
    }
}

// Find existing plugin entry for this tier or create a fresh entry
let pluginEntry = manifest.find((item) => item.guid === pluginGuid);
if (!pluginEntry) {
    pluginEntry = {
        guid: pluginGuid,
        name: currentConfig.name,
        description: currentConfig.description,
        overview: currentConfig.overview,
        owner: 'MoazSalem',
        category: 'General',
        imageUrl: 'https://raw.githubusercontent.com/MoazSalem/litefin/development/assets/icon_oblong.png',
        versions: []
    };
    manifest.push(pluginEntry);
} else {
    // Keep metadata properties up to date
    pluginEntry.name = currentConfig.name;
    pluginEntry.description = currentConfig.description;
    pluginEntry.overview = currentConfig.overview;
    pluginEntry.imageUrl = 'https://raw.githubusercontent.com/MoazSalem/litefin/development/assets/icon_oblong.png';
}

// Remove any existing version entry for this exact version to ensure idempotence
pluginEntry.versions = (pluginEntry.versions || []).filter((v) => v.version !== version);

// Resolve release tag name for download URL (uses CI tag if present, else fallback)
const releaseTag = process.env.TAG_NAME || process.env.GITHUB_REF_NAME || `v${version}`;
const tagForUrl = releaseTag.startsWith('v') ? releaseTag : `v${releaseTag}`;

// Prepend the new version to the versions list
const versionEntry = {
    version: version,
    changelog: changelog,
    targetAbi: '10.10.0.0',
    sourceUrl: `https://github.com/MoazSalem/litefin/releases/download/${tagForUrl}/${zipName}`,
    checksum: md5Hash,
    timestamp: timestamp
};

pluginEntry.versions.unshift(versionEntry);

// Format and save updated repository manifest
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
console.log(`Manifest updated at: ${manifestPath}`);

console.log('\n======================================================');
console.log(` Build and packaging completed for ${currentConfig.name}!`);
console.log(` Plugin Archive: ${zipName}`);
console.log(` Manifest: litefin-plugin-manifest.json`);
console.log('======================================================\n');
