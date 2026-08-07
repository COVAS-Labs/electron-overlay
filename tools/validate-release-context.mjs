import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFile, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(await readFile(resolve(repoRoot, "packages", "electron-overlay", "package.json"), "utf8"));
const tag = process.env.GITHUB_REF_NAME;
const ref = process.env.GITHUB_REF;
const commit = process.env.GITHUB_SHA;

assert.match(tag ?? "", /^v\d+\.\d+\.\d+$/, "Release tag must be stable semver prefixed with v");
assert.equal(ref, `refs/tags/${tag}`, "Release must run from the pushed tag ref");
assert.equal(manifest.version, tag.slice(1), "Package version must match the release tag");
assert.match(commit ?? "", /^[a-f0-9]{40}$/, "GITHUB_SHA must be a full commit SHA");
assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim(), commit);
assert.equal(execFileSync("git", ["rev-parse", `${tag}^{commit}`], { cwd: repoRoot, encoding: "utf8" }).trim(), commit);
assert.ok(process.env.GITHUB_OUTPUT, "GITHUB_OUTPUT is required");
await appendFile(process.env.GITHUB_OUTPUT, `package_version=${manifest.version}\n`, "utf8");
console.log(`Validated ${tag} at ${commit} for package version ${manifest.version}.`);
