import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  getReleaseTarget,
  prebuiltPackageName,
  RELEASE_TARGETS,
  releaseTargetId
} from "./release-targets.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const target = getReleaseTarget();
const targetId = releaseTargetId(target);
const publicDir = resolve(repoRoot, "artifacts", "publish", "public", "package");
const prebuiltDir = resolve(repoRoot, "artifacts", "publish", `prebuilt-${targetId}`, "package");
const packDir = resolve(repoRoot, "artifacts", "npm-pack");
const sourceManifest = await readJson(resolve(repoRoot, "packages", "electron-overlay", "package.json"));
const publicManifest = await readJson(resolve(publicDir, "package.json"));
const prebuiltManifest = await readJson(resolve(prebuiltDir, "package.json"));
const metadata = await readJson(resolve(prebuiltDir, "metadata.json"));
const ownerScope = publicManifest.name.match(/^@([^/]+)\/electron-overlay$/)?.[1];
const rootLicense = await readFile(resolve(repoRoot, "LICENSE"), "utf8");

assert.ok(ownerScope, `Unexpected public package name: ${publicManifest.name}`);
const expectedOptionalDependencies = Object.fromEntries(
  RELEASE_TARGETS.map((releaseTarget) => [
    prebuiltPackageName(ownerScope, releaseTarget),
    sourceManifest.version
  ])
);
const expectedPublicManifest = {
  ...sourceManifest,
  optionalDependencies: expectedOptionalDependencies,
  publishConfig: {
    registry: "https://registry.npmjs.org",
    access: "public"
  }
};
delete expectedPublicManifest.scripts;
assert.deepEqual(publicManifest, expectedPublicManifest);
assert.equal(await readFile(resolve(publicDir, "LICENSE"), "utf8"), rootLicense);

const expectedPrebuiltName = prebuiltPackageName(ownerScope, target);
assert.deepEqual(prebuiltManifest, {
  name: expectedPrebuiltName,
  version: sourceManifest.version,
  description: `Electron overlay native addon for ${targetId}.`,
  license: "MIT",
  repository: {
    type: "git",
    url: "git+https://github.com/COVAS-Labs/electron-overlay.git"
  },
  main: "index.js",
  os: [target.platform],
  cpu: [target.arch],
  files: ["index.js", "metadata.json", "README.md", "LICENSE", "x11_overlay.node"],
  publishConfig: {
    registry: "https://registry.npmjs.org",
    access: "public"
  }
});
assert.equal(await readFile(resolve(prebuiltDir, "LICENSE"), "utf8"), rootLicense);
assert.deepEqual(metadata, {
  packageName: expectedPrebuiltName,
  packageVersion: sourceManifest.version,
  runtime: "electron",
  platform: target.platform,
  arch: target.arch
});

await rm(packDir, { recursive: true, force: true });
await mkdir(packDir, { recursive: true });

const publicPack = pack(publicDir);
const prebuiltPack = pack(prebuiltDir);
assert.equal(publicPack.filename, tarballName(publicManifest.name, sourceManifest.version));
assert.equal(prebuiltPack.filename, tarballName(expectedPrebuiltName, sourceManifest.version));
assert.equal(publicPack.name, publicManifest.name);
assert.equal(publicPack.version, sourceManifest.version);
assert.equal(prebuiltPack.name, expectedPrebuiltName);
assert.equal(prebuiltPack.version, sourceManifest.version);
assert.deepEqual(filePaths(publicPack), [
  "LICENSE",
  "README.md",
  "dist/index.d.ts",
  "dist/index.js",
  "package.json"
]);
assert.deepEqual(filePaths(prebuiltPack), [
  "LICENSE",
  "README.md",
  "index.js",
  "metadata.json",
  "package.json",
  "x11_overlay.node"
]);

const artifactManifest = {
  version: sourceManifest.version,
  target: targetId,
  public: await artifactRecord(publicPack),
  prebuilt: await artifactRecord(prebuiltPack)
};
await writeFile(
  resolve(packDir, "artifacts.json"),
  `${JSON.stringify(artifactManifest, null, 2)}\n`,
  "utf8"
);
console.log(`Validated npm package artifacts in ${packDir}`);

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function pack(packageDir) {
  const npmCli = process.env.npm_execpath;
  if (!npmCli) throw new Error("Run package validation through npm run package:validate.");
  const result = spawnSync(process.execPath, [
    npmCli,
    "pack",
    packageDir,
    "--json",
    "--pack-destination",
    packDir
  ], { cwd: repoRoot, encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`npm pack failed for ${packageDir}:\n${result.stderr || result.stdout}`);
  }
  const output = JSON.parse(result.stdout);
  assert.equal(output.length, 1);
  return output[0];
}

function filePaths(packResult) {
  return packResult.files.map(({ path }) => path).sort();
}

async function artifactRecord(packResult) {
  assert.match(packResult.integrity, /^sha512-/);
  assert.match(packResult.shasum, /^[a-f0-9]{40}$/);
  assert.ok(Number.isSafeInteger(packResult.size) && packResult.size > 0);
  const tarball = await readFile(resolve(packDir, packResult.filename));
  assert.equal(tarball.byteLength, packResult.size);
  return {
    package: packResult.name,
    tarball: packResult.filename,
    integrity: packResult.integrity,
    shasum: packResult.shasum,
    size: packResult.size,
    sha256: createHash("sha256").update(tarball).digest("hex")
  };
}

function tarballName(packageName, version) {
  return `${packageName.replace(/^@/, "").replace("/", "-")}-${version}.tgz`;
}
