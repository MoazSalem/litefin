import gulp from 'gulp';
import { deleteAsync as del } from 'del';
import { readFileSync, createWriteStream, copyFileSync, existsSync } from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';
import archiver from 'archiver';
import path from 'path';

const execAsync = promisify(exec);

console.info('Building Litefin Tizen app');

// Read version from config.xml (Single Source of Truth)
// We already validated this regex in webpack.config.cjs
const configXmlContent = readFileSync('./config.xml', 'utf8');
const versionMatch = configXmlContent.match(/<widget[^>]*\sversion="([^"]+)"/);
const version = versionMatch ? versionMatch[1] : '0.0.0';

console.log(`Package Version: ${version}`);

// ============================================================================
// Clean tasks
// ============================================================================

function clean() {
    return del(['build/**', '!build']);
}

function cleanDist() {
    return del(['dist/**', '!dist']);
}

function cleanWgt() {
    return del(['*.wgt']);
}

// ============================================================================
// Build tasks (webpack)
// ============================================================================

async function webpackES6() {
    console.info('Building ES6 bundle (No Transpilation)...');
    await execAsync('npx webpack --config webpack.config.cjs --config-name es6');
    console.info('ES6 build complete');
}

async function webpackNormal() {
    console.info('Building Normal bundle (Chromium 69, Partialy transpilied)...');
    await execAsync('npx webpack --config webpack.config.cjs --config-name normal');
    console.info('Normal build complete');
}

async function webpackLegacy() {
    console.info('Building legacy bundle (Fully Transpiled To ES5)...');
    await execAsync('npx webpack --config webpack.config.cjs --config-name legacy');
    console.info('Legacy build complete');
}

async function webpackAll() {
    console.info('Building all bundles...');
    await execAsync('npx webpack --config webpack.config.cjs');
    console.info('All builds complete');
}

// ============================================================================
// Copy signature files
// ============================================================================

function copySignatures(buildDir) {
    const signatureFiles = [
        { src: '.sign/author-signature.xml', dest: `${buildDir}/author-signature.xml` },
        { src: '.sign/signature1.xml', dest: `${buildDir}/signature1.xml` }
    ];

    let copied = false;
    for (const file of signatureFiles) {
        if (existsSync(file.src)) {
            copyFileSync(file.src, file.dest);
            copied = true;
        }
    }

    if (copied) {
        console.info(`Added signature files to ${buildDir}`);
    } else {
        console.warn('Warning: No signature files found in .sign/');
    }
}

// ============================================================================
// Package helpers
// ============================================================================

async function createWgt(buildDir, outputName) {
    // Tizen packages should not include LG WebOS's appinfo.json
    const appinfoPath = path.join(buildDir, 'appinfo.json');
    if (existsSync(appinfoPath)) {
        await del([appinfoPath]);
    }

    return new Promise((resolve, reject) => {
        const output = createWriteStream(outputName);
        const archive = archiver('zip', { zlib: { level: 9 } });

        output.on('close', () => {
            console.info(`Package created: ${outputName} (${archive.pointer()} bytes)`);
            resolve();
        });

        archive.on('error', (err) => reject(err));

        archive.pipe(output);
        archive.directory(buildDir + '/', false);
        archive.finalize();
    });
}

async function createIpk(buildDir, outputDir) {
    // WebOS packages should not include Tizen's config.xml
    const configPath = path.join(buildDir, 'config.xml');
    if (existsSync(configPath)) {
        await del([configPath]);
    }

    console.info(`Running ares-package on ${buildDir}...`);
    try {
        const { stdout, stderr } = await execAsync(`npx ares-package ${buildDir} -o ${outputDir}`);
        console.info(stdout);
        if (stderr) console.warn(stderr);
    } catch (error) {
        console.error('Failed to create IPK:', error);
        throw error;
    }
}

// ============================================================================
// Package tasks - each produces a single versioned file
// ============================================================================

async function packageES6() {
    const buildDir = 'dist/es6';
    const wgtName = `Litefin-${version}-es6.wgt`; // No transpilation

    copySignatures(buildDir);
    console.info(`Creating ${wgtName}...`);
    await createWgt(buildDir, wgtName);
}

async function packageNormal() {
    const buildDir = 'dist/normal';
    const wgtName = `Litefin-${version}.wgt`; // Default, no suffix

    copySignatures(buildDir);
    console.info(`Creating ${wgtName}...`);
    await createWgt(buildDir, wgtName);
}

async function packageWebos() {
    const buildDir = 'dist/normal'; // Re-use the normal build payload for WebOS
    const outputDir = '.'; // Output to root

    console.info(`Creating WebOS IPK...`);
    await createIpk(buildDir, outputDir);
}

async function packageLegacy() {
    const buildDir = 'dist/legacy';
    const wgtName = `Litefin-${version}-legacy.wgt`;

    copySignatures(buildDir);
    console.info(`Creating ${wgtName}...`);
    await createWgt(buildDir, wgtName);
}

// ============================================================================
// Sync task
// ============================================================================

async function syncVersion() {
    const fs = await import('fs');

    // Sync package.json
    const pkg = JSON.parse(fs.readFileSync('./package.json', 'utf8'));
    if (pkg.version !== version) {
        console.info(`Syncing package.json version: ${pkg.version} -> ${version}`);
        pkg.version = version;
        fs.writeFileSync('./package.json', JSON.stringify(pkg, null, 4));
    } else {
        console.info('package.json version is already up to date');
    }

    // Sync appinfo.json
    if (fs.existsSync('./appinfo.json')) {
        const appinfo = JSON.parse(fs.readFileSync('./appinfo.json', 'utf8'));
        if (appinfo.version !== version) {
            console.info(`Syncing appinfo.json version: ${appinfo.version} -> ${version}`);
            appinfo.version = version;
            fs.writeFileSync('./appinfo.json', JSON.stringify(appinfo, null, 4));
        } else {
            console.info('appinfo.json version is already up to date');
        }
    }
}

// ============================================================================
// Main tasks
// ============================================================================

// Build and package all 3 versions (default for npm run package)
const buildPackage = gulp.series(
    syncVersion,
    cleanDist,
    cleanWgt,
    webpackAll,
    gulp.parallel(packageES6, packageNormal, packageLegacy)
);

// Individual build+package tasks
const buildPackageES6 = gulp.series(syncVersion, cleanDist, webpackES6, packageES6);
const buildPackageNormal = gulp.series(syncVersion, cleanDist, webpackNormal, packageNormal);
const buildPackageWebos = gulp.series(syncVersion, cleanDist, webpackNormal, packageWebos);
const buildPackageLegacy = gulp.series(syncVersion, cleanDist, webpackLegacy, packageLegacy);

// Just build (no packaging)
const build = gulp.series(syncVersion, cleanDist, webpackAll);
const buildES6 = gulp.series(syncVersion, cleanDist, webpackES6);
const buildNormal = gulp.series(syncVersion, cleanDist, webpackNormal);
const buildLegacy = gulp.series(syncVersion, cleanDist, webpackLegacy);

export {
    clean,
    cleanDist,
    cleanWgt,
    webpackES6,
    webpackNormal,
    webpackLegacy,
    webpackAll,
    packageES6,
    packageNormal,
    packageWebos,
    packageLegacy,
    buildPackage,
    buildPackageES6,
    buildPackageNormal,
    buildPackageWebos,
    buildPackageLegacy,
    build,
    buildES6,
    buildNormal,
    buildLegacy
};

export default buildPackage;
