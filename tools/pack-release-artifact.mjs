import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  getReleaseTarget,
  prebuiltBinaryFiles,
  prebuiltPackageName,
  RELEASE_TARGETS,
  releaseTargetId
} from "./release-targets.mjs";
import { fileDigests, npmInvocation, parseArgs, tarballName } from "./release-artifact-utils.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = parseArgs(process.argv.slice(2));
const kind = args.kind;
const version = args["package-version"];
const outputDir = resolve(repoRoot, args["output-dir"] ?? "artifacts/release");
const target = kind === "prebuilt" ? getReleaseTarget() : undefined;
const targetId = target && releaseTargetId(target);
const packageDir = resolve(repoRoot, "artifacts", "publish", kind === "public" ? "public" : `prebuilt-${targetId}`, "package");
const manifest = JSON.parse(await readFile(resolve(packageDir, "package.json"), "utf8"));

assert.ok(kind === "public" || kind === "prebuilt", "--kind must be public or prebuilt");
assert.match(version ?? "", /^\d+\.\d+\.\d+$/, "Expected a stable --package-version");
assert.equal(manifest.version, version);
if (kind === "public") {
  assert.equal(manifest.name, "@covas-labs/electron-overlay");
  assert.deepEqual(manifest.optionalDependencies, Object.fromEntries(RELEASE_TARGETS.map((releaseTarget) =>
    [prebuiltPackageName("covas-labs", releaseTarget), version])));
} else {
  assert.equal(manifest.name, prebuiltPackageName("covas-labs", target));
  assert.deepEqual(manifest.os, [target.platform]);
  assert.deepEqual(manifest.cpu, [target.arch]);
  const metadata = JSON.parse(await readFile(resolve(packageDir, "metadata.json"), "utf8"));
  assert.deepEqual(metadata, {
    packageName: manifest.name,
    packageVersion: version,
    runtime: "electron",
    platform: target.platform,
    arch: target.arch
  });
}

await mkdir(outputDir, { recursive: true });
const npm = npmInvocation(["pack", packageDir, "--json", "--pack-destination", outputDir]);
const result = spawnSync(npm.command, npm.args, {
  cwd: repoRoot,
  encoding: "utf8"
});
if (result.error) throw result.error;
if (result.status !== 0) throw new Error(`npm pack failed:\n${result.stderr || result.stdout}`);
const [packed] = JSON.parse(result.stdout);
assert.equal(packed.name, manifest.name);
assert.equal(packed.version, version);
assert.equal(packed.filename, tarballName(manifest.name, version));
assert.deepEqual(packed.files.map(({ path }) => path).sort(), kind === "public"
  ? ["LICENSE", "README.md", "THIRD_PARTY_NOTICES", "dist/index.d.ts", "dist/index.js", "package.json"]
  : ["LICENSE", "README.md", "THIRD_PARTY_NOTICES", "index.js", "metadata.json", "package.json", ...prebuiltBinaryFiles(target)].sort());
const tarballPath = resolve(outputDir, packed.filename);
const digests = await fileDigests(tarballPath);
assert.equal(digests.size, packed.size);
assert.equal(digests.sha1, packed.shasum);
assert.equal(digests.integrity, packed.integrity);

const record = {
  kind,
  ...(targetId && { target: targetId }),
  package: manifest.name,
  version,
  tarball: packed.filename,
  ...digests
};
const recordName = kind === "public" ? "public.json" : `prebuilt-${targetId}.json`;
await writeFile(resolve(outputDir, recordName), `${JSON.stringify(record, null, 2)}\n`, "utf8");
console.log(`Packed ${record.package}@${version} as ${record.tarball}.`);
