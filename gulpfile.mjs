import gulp from "gulp";
import { deleteAsync as del } from "del";
import { readFileSync, writeFileSync, createWriteStream, copyFileSync, existsSync, mkdirSync } from "fs";
import { exec } from "child_process";
import { promisify } from "util";
import archiver from "archiver";
import path from "path";

const execAsync = promisify(exec);

console.info("Building FastFin Tizen app");

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

// ============================================================================
// Build tasks (webpack)
// ============================================================================

async function webpackModern() {
    console.info("Building modern bundle (Tizen 4.0+)...");
    await execAsync("npx webpack --config webpack.config.cjs --config-name modern");
    console.info("Modern build complete");
}

async function webpackLegacy() {
    console.info("Building legacy bundle (Tizen 3.0)...");
    await execAsync("npx webpack --config webpack.config.cjs --config-name legacy");
    console.info("Legacy build complete");
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
        console.info("Added signature files to build directory");
    } else {
        console.warn("Warning: No signature files found in .sign/ - package may not install on device");
    }
}

// ============================================================================
// Package tasks
// ============================================================================

async function packageModern() {
    const wgtName = `FastFin-${version}.wgt`;
    const simpleWgtName = "FastFin.wgt";
    await del([wgtName, simpleWgtName]);

    const buildDir = "dist/tizen4";

    // Copy signatures
    copySignatures(buildDir);

    // Create zip as .wgt
    async function createZip(outputPath) {
        return new Promise((resolve, reject) => {
            const output = createWriteStream(outputPath);
            const archive = archiver("zip", { zlib: { level: 9 } });

            output.on("close", () => {
                console.info(`Package created: ${path.basename(outputPath)} (${archive.pointer()} bytes)`);
                resolve();
            });

            archive.on("error", (err) => reject(err));

            archive.pipe(output);
            archive.directory(buildDir + "/", false);
            archive.finalize();
        });
    }

    console.info(`Creating ${simpleWgtName}...`);
    await createZip(simpleWgtName);

    console.info(`Creating ${wgtName}...`);
    await createZip(wgtName);
}

async function packageLegacy() {
    const wgtName = `FastFin-Legacy-${version}.wgt`;
    const simpleWgtName = "FastFin-Legacy.wgt";
    await del([wgtName, simpleWgtName]);

    const buildDir = "dist/tizen3";

    // Copy signatures
    copySignatures(buildDir);

    async function createZip(outputPath) {
        return new Promise((resolve, reject) => {
            const output = createWriteStream(outputPath);
            const archive = archiver("zip", { zlib: { level: 9 } });

            output.on("close", () => {
                console.info(`Package created: ${path.basename(outputPath)} (${archive.pointer()} bytes)`);
                resolve();
            });

            archive.on("error", (err) => reject(err));

            archive.pipe(output);
            archive.directory(buildDir + "/", false);
            archive.finalize();
        });
    }

    console.info(`Creating ${simpleWgtName}...`);
    await createZip(simpleWgtName);

    console.info(`Creating ${wgtName}...`);
    await createZip(wgtName);
}

// ============================================================================
// Exported tasks
// ============================================================================

const build = gulp.series(cleanDist, webpackModern);
const buildLegacy = gulp.series(cleanDist, webpackLegacy);
const buildAll = gulp.series(cleanDist, gulp.parallel(webpackModern, webpackLegacy));
const buildPackage = gulp.series(cleanDist, webpackModern, packageModern);
const buildPackageLegacy = gulp.series(cleanDist, webpackLegacy, packageLegacy);
const buildPackageAll = gulp.series(cleanDist, gulp.parallel(webpackModern, webpackLegacy), gulp.parallel(packageModern, packageLegacy));

export {
    clean,
    cleanDist,
    webpackModern,
    webpackLegacy,
    packageModern,
    packageLegacy,
    buildPackage,
    buildPackageLegacy,
    buildPackageAll,
    buildLegacy,
    buildAll,
};
export default build;
