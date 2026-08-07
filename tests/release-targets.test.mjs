import assert from "node:assert/strict";
import test from "node:test";

import { PREBUILT_PACKAGES } from "../packages/electron-overlay/dist/index.js";

import {
  getReleaseTarget,
  prebuiltPackageName,
  RELEASE_TARGETS,
  releaseTargetId
} from "../tools/release-targets.mjs";

test("release targets are the supported prebuilt matrix", () => {
  assert.deepEqual(RELEASE_TARGETS.map(releaseTargetId), [
    "linux-x64",
    "win32-x64",
    "darwin-arm64"
  ]);
  assert.equal(
    prebuiltPackageName("covas-labs", RELEASE_TARGETS[0]),
    "@covas-labs/electron-overlay-prebuilt-linux-x64"
  );

  const runtimePrebuilts = Object.entries(PREBUILT_PACKAGES).flatMap(([platform, architectures]) =>
    Object.entries(architectures).map(([arch, packageName]) => ({
      target: `${platform}-${arch}`,
      packageName
    }))
  ).sort((left, right) => left.target.localeCompare(right.target));
  const canonicalPrebuilts = RELEASE_TARGETS.map((target) => ({
    target: releaseTargetId(target),
    packageName: prebuiltPackageName("covas-labs", target)
  })).sort((left, right) => left.target.localeCompare(right.target));
  assert.deepEqual(runtimePrebuilts, canonicalPrebuilts);
});

test("unsupported release targets are rejected", () => {
  assert.throws(() => getReleaseTarget("darwin", "x64"), /Unsupported release target/);
});
