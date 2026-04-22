import gulp from 'gulp';
import { deleteAsync as del } from 'del';
import { readFileSync, createWriteStream, copyFileSync, existsSync, renameSync, cpSync, mkdirSync } from 'fs';
import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import archiver from 'archiver';
import path from 'path';

/*
 * exec() buffers ALL stdout + stderr in the parent process's RAM.
 * For non-webpack commands (ares-package, etc.) that's fine — output is small.
 * We still bump maxBuffer to 10 MB as a safety net.
 */
const _execAsync = promisify(exec);
const execAsync = (cmd, opts = {}) =>
    _execAsync(cmd, { maxBuffer: 10 * 1024 * 1024, ...opts });

/*
 * For webpack builds we use spawn() with stdio: 'inherit'.
 * This streams output directly to the parent's terminal with ZERO buffering
 * in the parent process, which is critical on CI runners where the combined
 * parent + child memory can exceed the runner's ~7 GB limit.
 */
function spawnAsync(command, opts = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, {
            stdio: 'inherit',
            shell: true,
            ...opts
        });
        child.on('close', (code) => {
            if (code !== 0) {
                reject(new Error(`Command "${command}" exited with code ${code}`));
            } else {
                resolve();
            }
        });
        child.on('error', reject);
    });
}

console.info('Building Litefin Tizen app');

// Read version from config.xml (Single Source of Truth)
// We already validated this regex in webpack.config.cjs
const configXmlContent = readFileSync('./config.xml', 'utf8');
const versionMatch = configXmlContent.match(/<widget[^>]*\sversion="([^"]+)"/);
const version = versionMatch ? versionMatch[1] : '0.0.0';

// Read appId from appinfo.json so we can predict the IPK filename that
// ares-package generates and rename it to match our naming convention.
const appinfoContent = JSON.parse(readFileSync('./appinfo.json', 'utf8'));
const appId = appinfoContent.id; // e.g. org.litefin.app

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

function cleanIpk() {
    return del(['*.ipk']);
}

// ============================================================================
// Build tasks (webpack) — all use spawnAsync to avoid buffering output in RAM
// ============================================================================

/** Base webpack command shared by every build */
const WP = 'npx webpack --config webpack.config.cjs';

async function webpackES6() {
    console.info('Building ES6 bundle (No Transpilation)...');
    await spawnAsync(`${WP} --config-name es6`);
    console.info('ES6 build complete');
}

async function webpackNormal() {
    console.info('Building Normal bundle (Chromium 63, Partialy transpilied)...');
    await spawnAsync(`${WP} --config-name normal`);
    console.info('Normal build complete');
}

async function webpackDebug() {
    // Debug build: same as ES6 but with source maps — for on-device debugging via sdb
    console.info('Building Debug bundle (ES6 + source maps)...');
    await spawnAsync(`${WP} --config-name debug`);
    console.info('Debug build complete');
}

async function webpackLegacy() {
    console.info('Building legacy bundle (Fully Transpiled To ES5)...');
    // Raise the heap cap — legacy Babel + Terser is very RAM-hungry on CI
    await spawnAsync(`${WP} --config-name legacy`, {
        env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=4096' }
    });
    console.info('Legacy build complete');
}

async function webpackUltraLegacy() {
    console.info('Building ultra-legacy bundle (Tizen 2.3 / Chrome 38)...');
    // Ultra-legacy churns through the most Babel + polyfill code — needs ample heap room
    await spawnAsync(`${WP} --config-name ultra-legacy`, {
        env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=4096' }
    });
    console.info('Ultra-Legacy build complete');
}

async function webpackAll() {
    console.info('Building all bundles sequentially to prevent OOM...');
    await webpackES6();
    await webpackNormal();
    await webpackLegacy();
    await webpackUltraLegacy();
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
    return new Promise((resolve, reject) => {
        const output = createWriteStream(outputName);
        const archive = archiver('zip', { zlib: { level: 9 } });

        output.on('close', () => {
            console.info(`Package created: ${outputName} (${archive.pointer()} bytes)`);
            resolve();
        });

        archive.on('error', (err) => reject(err));

        archive.pipe(output);
        
        // Tizen packages should not include LG WebOS's appinfo.json.
        // We use glob with an ignore rule instead of deleting the file from disk,
        // because WebOS packaging tasks are running in parallel against the exact same buildDir.
        archive.glob('**/*', {
            cwd: buildDir,
            ignore: ['appinfo.json']
        });

        if (existsSync('services')) {
            archive.directory('services/', 'services');
        }
        archive.finalize();
    });
}

async function createIpk(buildDir, outputDir, finalName) {
    /*
     * IMPORTANT: We must NOT modify `buildDir` directly because the Tizen WGT
     * packaging tasks may be reading from the same directory in parallel.
     * Instead, copy the build output to a uniquely-named staging directory,
     * strip the Tizen-only `config.xml` from the copy, then package from there.
     */
    const stagingDir = `${buildDir}-webos-staging`;

    // Wipe any leftover staging dir from a previous failed run
    await del([stagingDir]);

    // Copy the entire build output to the staging directory using Node's
    // built-in cpSync — avoids xcopy/cp platform differences and path issues.
    console.info(`Staging WebOS build: ${buildDir} → ${stagingDir}`);
    cpSync(buildDir, stagingDir, { recursive: true });

    /*
     * Remove Tizen-specific files that ares-package doesn't recognise and
     * that must NOT appear inside a WebOS IPK package.
     *
     * When `buildPackage` runs, all Tizen and WebOS packaging tasks execute in
     * parallel via gulp.parallel(). The Tizen tasks call copySignatures(buildDir)
     * which writes author-signature.xml / signature1.xml directly into the shared
     * buildDir (e.g. dist/es6/). If our cpSync above runs AFTER those files land,
     * they get dragged into the IPK — which is why `npm run package` produces a
     * larger IPK than `npm run package:webos-es6` (where no signatures are written).
     *
     * Deleting them here from the staging copy is the safest fix; it mirrors what
     * we already do for config.xml and does not touch the original buildDir.
     */
    const tizenOnlyFiles = [
        path.join(stagingDir, 'config.xml'),
        path.join(stagingDir, 'author-signature.xml'),
        path.join(stagingDir, 'signature1.xml'),
        path.join(stagingDir, 'tile_1920x1080.png'),
        path.join(stagingDir, 'icon.png')
    ];
    await del(tizenOnlyFiles.filter(f => existsSync(f)));

    /*
     * Copy WebOS-specific icon and splash assets from the project root.
     * These are intentionally NOT part of the shared webpack CopyPlugin output
     * so they never end up inside Tizen WGT packages.
     *   icon-80.png       → 80×80 icon (required by WebOS)
     *   icon-130.png      → 130×130 large icon (required by WebOS)
     *   splash.png        → splash/background image referenced in appinfo.json
     */
    const webosAssets = [
        { src: 'icon-80.png', dest: path.join(stagingDir, 'icon-80.png') },
        { src: 'icon-130.png', dest: path.join(stagingDir, 'icon-130.png') },
        { src: 'splash.png', dest: path.join(stagingDir, 'assets', 'splash.png') }
    ];

    for (const asset of webosAssets) {
        if (existsSync(asset.src)) {
            // Ensure asset sub-directory exists (e.g. assets/ for splash)
            mkdirSync(path.dirname(asset.dest), { recursive: true });
            copyFileSync(asset.src, asset.dest);
            console.info(`Copied WebOS asset: ${asset.src} → ${asset.dest}`);
        } else {
            console.warn(`WebOS asset not found (skipping): ${asset.src}`);
        }
    }

    console.info(`Running ares-package on ${stagingDir}...`);
    try {
        /*
         * --no-minify: ares-package ships with an old UglifyJS-based minifier
         * that can't handle ES6+ syntax (optional chaining, arrow functions, etc.).
         * All our webpack builds are already fully minified in production mode,
         * so disabling ares-package's minification step is correct and necessary.
         *
         * PARALLELISM: we output to a unique per-variant subdirectory, NOT to the
         * shared root '.'. All 4 WebOS tasks run in parallel and ares-package always
         * names its output `{appId}_{version}_all.ipk`. Without isolation, all 4
         * tasks race to create and rename that exact filename, and only 2 survive.
         */
        const ipkOutDir = `${stagingDir}-out`;
        mkdirSync(ipkOutDir, { recursive: true });

        const { stdout, stderr } = await execAsync(
            `npx ares-package --no-minify "${stagingDir}" "services" -o "${ipkOutDir}"`
        );
        if (stdout) console.info(stdout);
        if (stderr) console.warn(stderr);

        // Rename the generated IPK and move it to the final output directory
        const generatedName = path.join(ipkOutDir, `${appId}_${version}_all.ipk`);
        const targetName = path.join(outputDir, finalName || `${appId}_${version}_all.ipk`);
        if (existsSync(generatedName)) {
            renameSync(generatedName, targetName);
            console.info(`Renamed IPK → ${path.basename(targetName)}`);
        } else {
            console.warn(`Expected IPK not found: ${generatedName}`);
        }

        // Clean up the unique IPK output dir
        await del([ipkOutDir]);
    } catch (error) {
        console.error('Failed to create IPK:', error);
        throw error;
    } finally {
        // Always clean up staging dir, even on error
        await del([stagingDir]);
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

async function packageTest() {
    const buildDir = 'dist/normal';
    const wgtName = `litefin.wgt`; // test output

    copySignatures(buildDir);
    console.info(`Creating ${wgtName}...`);
    await createWgt(buildDir, wgtName);
}

async function packageDebug() {
    // Debug build ships with source maps — use only for on-device debugging
    const buildDir = 'dist/debug';
    const wgtName = `Litefin-${version}-debug.wgt`;

    copySignatures(buildDir);
    console.info(`Creating ${wgtName}...`);
    await createWgt(buildDir, wgtName);
}

async function packageWebos() {
    // Default normal build shipped as WebOS IPK — matches Tizen's default WGT naming
    const buildDir = 'dist/normal';
    const ipkName = `Litefin-${version}-webos.ipk`;

    console.info(`Creating ${ipkName}...`);
    await createIpk(buildDir, '.', ipkName);
}

async function packageWebosES6() {
    const buildDir = 'dist/es6';
    const ipkName = `Litefin-${version}-es6-webos.ipk`;

    console.info(`Creating ${ipkName}...`);
    await createIpk(buildDir, '.', ipkName);
}

async function packageWebosLegacy() {
    const buildDir = 'dist/legacy';
    const ipkName = `Litefin-${version}-legacy-webos.ipk`;

    console.info(`Creating ${ipkName}...`);
    await createIpk(buildDir, '.', ipkName);
}

async function packageWebosUltraLegacy() {
    const buildDir = 'dist/ultra-legacy';
    const ipkName = `Litefin-${version}-ultra-legacy-webos.ipk`;

    console.info(`Creating ${ipkName}...`);
    await createIpk(buildDir, '.', ipkName);
}

async function packageLegacy() {
    const buildDir = 'dist/legacy';
    const wgtName = `Litefin-${version}-legacy.wgt`;

    copySignatures(buildDir);
    console.info(`Creating ${wgtName}...`);
    await createWgt(buildDir, wgtName);
}

async function packageUltraLegacy() {
    const buildDir = 'dist/ultra-legacy';
    const wgtName = `Litefin-${version}-ultra-legacy.wgt`;

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

// Build and package all versions (default for npm run package)
// Produces 4 WGT (Tizen) + 4 IPK (WebOS) in parallel
const buildPackage = gulp.series(
    syncVersion,
    cleanDist,
    gulp.parallel(cleanWgt, cleanIpk),
    webpackAll,
    gulp.parallel(
        // Tizen WGT
        packageES6,
        packageNormal,
        packageLegacy,
        packageUltraLegacy,
        // WebOS IPK
        packageWebosES6,
        packageWebos,
        packageWebosLegacy,
        packageWebosUltraLegacy
    )
);

// Individual Tizen build+package tasks
const buildPackageES6 = gulp.series(syncVersion, cleanDist, webpackES6, packageES6);
const buildPackageNormal = gulp.series(syncVersion, cleanDist, webpackNormal, packageNormal);
const buildPackageTest = gulp.series(syncVersion, cleanDist, webpackNormal, packageTest);
const buildPackageLegacy = gulp.series(syncVersion, cleanDist, webpackLegacy, packageLegacy);
const buildPackageUltraLegacy = gulp.series(syncVersion, cleanDist, webpackUltraLegacy, packageUltraLegacy);
const buildPackageDebug = gulp.series(syncVersion, webpackDebug, packageDebug);

// Individual WebOS build+package tasks
const buildPackageWebos = gulp.series(syncVersion, cleanDist, cleanIpk, webpackNormal, packageWebos);
const buildPackageWebosES6 = gulp.series(syncVersion, cleanDist, cleanIpk, webpackES6, packageWebosES6);
const buildPackageWebosLegacy = gulp.series(syncVersion, cleanDist, cleanIpk, webpackLegacy, packageWebosLegacy);
const buildPackageWebosUltraLegacy = gulp.series(
    syncVersion,
    cleanDist,
    cleanIpk,
    webpackUltraLegacy,
    packageWebosUltraLegacy
);

// Just build (no packaging)
const build = gulp.series(syncVersion, cleanDist, webpackAll);
const buildES6 = gulp.series(syncVersion, cleanDist, webpackES6);
const buildNormal = gulp.series(syncVersion, cleanDist, webpackNormal);
const buildLegacy = gulp.series(syncVersion, cleanDist, webpackLegacy);
const buildUltraLegacy = gulp.series(syncVersion, cleanDist, webpackUltraLegacy);
const buildDebug = gulp.series(syncVersion, webpackDebug);

export {
    clean,
    cleanDist,
    cleanWgt,
    cleanIpk,
    webpackES6,
    webpackNormal,
    webpackLegacy,
    webpackUltraLegacy,
    webpackDebug,
    webpackAll,
    // Tizen WGT packaging
    packageES6,
    packageNormal,
    packageTest,
    packageLegacy,
    packageUltraLegacy,
    packageDebug,
    // WebOS IPK packaging
    packageWebos,
    packageWebosES6,
    packageWebosLegacy,
    packageWebosUltraLegacy,
    // Tizen build+package
    buildPackage,
    buildPackageES6,
    buildPackageNormal,
    buildPackageTest,
    buildPackageLegacy,
    buildPackageUltraLegacy,
    buildPackageDebug,
    // WebOS build+package
    buildPackageWebos,
    buildPackageWebosES6,
    buildPackageWebosLegacy,
    buildPackageWebosUltraLegacy,
    // Build only
    build,
    buildES6,
    buildNormal,
    buildLegacy,
    buildUltraLegacy,
    buildDebug
};

export default buildPackage;
