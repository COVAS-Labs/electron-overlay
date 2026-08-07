import assert from "node:assert/strict";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { prebuiltPackageName, RELEASE_TARGETS, releaseTargetId } from "./release-targets.mjs";
import { parseArgs, readJson, verifyArtifactRecord } from "./release-artifact-utils.mjs";

const args = parseArgs(process.argv.slice(2));
const artifactDir = resolve(args["artifact-dir"] ?? "artifacts/download");
const outputDir = resolve(args["output-dir"] ?? "artifacts/github-release");
const version = args["package-version"];
const recordDescriptors = [
  { file: "public.json", package: "@covas-labs/electron-overlay", kind: "public" },
  ...RELEASE_TARGETS.map((target) => ({
    file: `prebuilt-${releaseTargetId(target)}.json`,
    package: prebuiltPackageName("covas-labs", target),
    kind: "prebuilt",
    target: releaseTargetId(target)
  }))
];
const records = [];
await mkdir(outputDir, { recursive: true });

for (const descriptor of recordDescriptors) {
  const record = await readJson(resolve(artifactDir, descriptor.file));
  assert.equal(record.version, version);
  assert.equal(record.package, descriptor.package);
  assert.equal(record.kind, descriptor.kind);
  assert.equal(record.target, descriptor.target);
  const tarballPath = await verifyArtifactRecord(record, artifactDir);
  await copyFile(tarballPath, resolve(outputDir, record.tarball));
  records.push(record);
}

records.sort((left, right) => left.package.localeCompare(right.package));
const releaseManifest = {
  version,
  tag: process.env.EXPECTED_TAG,
  commit: process.env.EXPECTED_COMMIT,
  repository: process.env.EXPECTED_REPOSITORY,
  packages: records
};
assert.equal(releaseManifest.tag, `v${version}`);
assert.match(releaseManifest.commit ?? "", /^[a-f0-9]{40}$/);
assert.ok(releaseManifest.repository);
await writeFile(resolve(outputDir, "release-manifest.json"), `${JSON.stringify(releaseManifest, null, 2)}\n`, "utf8");
await writeFile(resolve(outputDir, "SHA256SUMS"), `${records.map((record) => `${record.sha256}  ${record.tarball}`).join("\n")}\n`, "utf8");
console.log(`Prepared ${records.length} package tarballs and release metadata in ${outputDir}.`);
