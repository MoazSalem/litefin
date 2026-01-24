import gulp from "gulp";
import { deleteAsync as del } from "del";
import { readFileSync, createWriteStream, copyFileSync, existsSync } from "fs";
import { exec } from "child_process";
import { promisify } from "util";
import archiver from "archiver";
import path from "path";

const execAsync = promisify(exec);

console.info("Building Litefin Tizen app");

const pkg = JSON.parse(readFileSync("./package.json", "utf8"));
const version = pkg.version;

// ============================================================================
// Clean tasks
// ============================================================================

function clean() {
    return del(["build/**", "!build"]);
}

function cleanDist() {
    return del(["dist/**", "!dist"]);
}

function cleanWgt() {
    return del(["*.wgt"]);
}

// ============================================================================
// Build tasks (webpack)
// ============================================================================

async function webpackES6() {
    console.info("Building ES6 bundle (Tizen 6.0+, no transpilation)...");
    await execAsync("npx webpack --config webpack.config.cjs --config-name es6");
    console.info("ES6 build complete");
}

async function webpackNormal() {
    console.info("Building Normal bundle (Tizen 5.0+, Chromium 69)...");
    await execAsync("npx webpack --config webpack.config.cjs --config-name normal");
    console.info("Normal build complete");
}

async function webpackLegacy() {
    console.info("Building legacy bundle (Tizen 3.0+, ES5)...");
    await execAsync("npx webpack --config webpack.config.cjs --config-name legacy");
    console.info("Legacy build complete");
}

async function webpackAll() {
    console.info("Building all bundles...");
    await execAsync("npx webpack --config webpack.config.cjs");
    console.info("All builds complete");
}

// ============================================================================
// Copy signature files
// ============================================================================

function copySignatures(buildDir) {
    const signatureFiles = [
        { src: ".sign/author-signature.xml", dest: `${buildDir}/author-signature.xml` },
        { src: ".sign/signature1.xml", dest: `${buildDir}/signature1.xml` }
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
        console.warn("Warning: No signature files found in .sign/");
    }
}

// ============================================================================
// Package helpers
// ============================================================================

async function createWgt(buildDir, outputName) {
    return new Promise((resolve, reject) => {
        const output = createWriteStream(outputName);
        const archive = archiver("zip", { zlib: { level: 9 } });

        output.on("close", () => {
            console.info(`Package created: ${outputName} (${archive.pointer()} bytes)`);
            resolve();
        });

        archive.on("error", (err) => reject(err));

        archive.pipe(output);
        archive.directory(buildDir + "/", false);
        archive.finalize();
    });
}

// ============================================================================
// Package tasks - each produces a single versioned file
// ============================================================================

async function packageES6() {
    const buildDir = "dist/es6";
    const wgtName = `Litefin-${version}-es6.wgt`;  // No transpilation

    copySignatures(buildDir);
    console.info(`Creating ${wgtName}...`);
    await createWgt(buildDir, wgtName);
}

async function packageNormal() {
    const buildDir = "dist/normal";
    const wgtName = `Litefin-${version}.wgt`;  // Default, no suffix

    copySignatures(buildDir);
    console.info(`Creating ${wgtName}...`);
    await createWgt(buildDir, wgtName);
}

async function packageLegacy() {
    const buildDir = "dist/legacy";
    const wgtName = `Litefin-${version}-legacy.wgt`;

    copySignatures(buildDir);
    console.info(`Creating ${wgtName}...`);
    await createWgt(buildDir, wgtName);
}

// ============================================================================
// Main tasks
// ============================================================================

// Build and package all 3 versions (default for npm run package)
const buildPackage = gulp.series(
    cleanDist,
    cleanWgt,
    webpackAll,
    gulp.parallel(packageES6, packageNormal, packageLegacy)
);

// Individual build+package tasks
const buildPackageES6 = gulp.series(cleanDist, webpackES6, packageES6);
const buildPackageNormal = gulp.series(cleanDist, webpackNormal, packageNormal);
const buildPackageLegacy = gulp.series(cleanDist, webpackLegacy, packageLegacy);

// Just build (no packaging)
const build = gulp.series(cleanDist, webpackAll);
const buildES6 = gulp.series(cleanDist, webpackES6);
const buildNormal = gulp.series(cleanDist, webpackNormal);
const buildLegacy = gulp.series(cleanDist, webpackLegacy);

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
    packageLegacy,
    buildPackage,
    buildPackageES6,
    buildPackageNormal,
    buildPackageLegacy,
    build,
    buildES6,
    buildNormal,
    buildLegacy
};

export default buildPackage;
