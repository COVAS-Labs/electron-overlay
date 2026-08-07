import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export function parseArgs(argv) {
  return Object.fromEntries(argv.filter((arg) => arg.startsWith("--")).map((arg) => {
    const [key, ...value] = arg.slice(2).split("=");
    return [key, value.join("=") || "true"];
  }));
}

export async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

export async function fileDigests(path) {
  const contents = await readFile(path);
  return {
    size: contents.byteLength,
    sha1: createHash("sha1").update(contents).digest("hex"),
    sha256: createHash("sha256").update(contents).digest("hex"),
    sha512: createHash("sha512").update(contents).digest("hex"),
    integrity: `sha512-${createHash("sha512").update(contents).digest("base64")}`
  };
}

export async function verifyArtifactRecord(record, artifactDir) {
  assert.match(record.package, /^@covas-labs\/electron-overlay(?:-prebuilt-(?:linux-x64|win32-x64|darwin-arm64))?$/);
  assert.match(record.version, /^\d+\.\d+\.\d+$/);
  assert.match(record.tarball, /^[a-z0-9._-]+\.tgz$/);
  const tarballPath = resolve(artifactDir, record.tarball);
  const actual = await fileDigests(tarballPath);
  for (const field of ["size", "sha1", "sha256", "sha512", "integrity"]) {
    assert.equal(actual[field], record[field], `${record.tarball} ${field} mismatch`);
  }
  return tarballPath;
}

export function tarballName(packageName, version) {
  return `${packageName.replace(/^@/, "").replace("/", "-")}-${version}.tgz`;
}

export function npmInvocation(args) {
  const npmCli = process.env.npm_execpath;
  assert.ok(npmCli, "Run this tool through its npm script so npm_execpath is available.");
  return {
    command: process.execPath,
    args: [npmCli, ...args]
  };
}
