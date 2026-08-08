import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";

import { prebuiltPackageName, RELEASE_TARGETS, releaseTargetId } from "./release-targets.mjs";
import { npmInvocation, parseArgs, readJson, verifyArtifactRecord } from "./release-artifact-utils.mjs";

const mode = process.argv[2];
const args = parseArgs(process.argv.slice(3));
const artifactDir = resolve(args["artifact-dir"] ?? "artifacts/download");
const kind = args.kind;
const version = args["package-version"];
const registry = (process.env.NPM_REGISTRY ?? "https://registry.npmjs.org").replace(/\/$/, "");
const expectedRepository = requiredEnv("EXPECTED_REPOSITORY").replace(/\/$/, "");
const expectedWorkflow = requiredEnv("EXPECTED_WORKFLOW");
const expectedTag = requiredEnv("EXPECTED_TAG");
const expectedCommit = requiredEnv("EXPECTED_COMMIT").toLowerCase();

assert.ok(mode === "publish" || mode === "verify", "Command must be publish or verify");
assert.ok(kind === "public" || kind === "prebuilt", "--kind must be public or prebuilt");
assert.match(version ?? "", /^\d+\.\d+\.\d+$/);
assert.equal(expectedTag, `v${version}`);
assert.match(expectedCommit, /^[a-f0-9]{40}$/);

const recordDescriptors = kind === "public"
  ? [{ file: "public.json", package: "@covas-labs/electron-overlay" }]
  : RELEASE_TARGETS.map((target) => ({
      file: `prebuilt-${releaseTargetId(target)}.json`,
      package: prebuiltPackageName("covas-labs", target),
      target: releaseTargetId(target)
    }));
const available = new Set(await readdir(artifactDir));
for (const { file } of recordDescriptors) assert.ok(available.has(file), `Missing ${file}`);

for (const descriptor of recordDescriptors) {
  const record = await readJson(resolve(artifactDir, descriptor.file));
  assert.equal(record.kind, kind);
  assert.equal(record.version, version);
  assert.equal(record.package, descriptor.package);
  assert.equal(record.target, descriptor.target);
  const tarballPath = await verifyArtifactRecord(record, artifactDir);
  const existing = await registryMetadata(record.package, version);
  if (mode === "publish" && !existing) {
    const publish = runNpm(["publish", tarballPath, "--provenance", "--access", "public", "--registry", registry]);
    if (publish.status !== 0) {
      console.error(publish.stderr || publish.stdout);
      console.log("Publish failed; checking whether a concurrent or partial publish produced the expected package.");
    }
  }
  await retry(async () => {
    const metadata = await registryMetadata(record.package, version);
    assert.ok(metadata, `${record.package}@${version} is not published`);
    await verifyRegistryPackage(record, metadata);
  }, 30, 10000);
  console.log(`Verified registry package ${record.package}@${version}.`);
}

async function verifyRegistryPackage(record, metadata) {
  assert.equal(metadata.name, record.package);
  assert.equal(metadata.version, record.version);
  assert.equal(metadata.dist?.shasum, record.sha1, "Published shasum does not match the release tarball");
  assert.equal(metadata.dist?.integrity, record.integrity, "Published integrity does not match the release tarball");
  assert.equal(normalizeRepository(metadata.repository?.url ?? metadata.repository), normalizeRepository(expectedRepository));
  const attestationsUrl = metadata.dist?.attestations?.url;
  assert.ok(attestationsUrl, "Package has no npm provenance attestations URL");
  const response = await fetch(attestationsUrl, { headers: { accept: "application/json" } });
  assert.ok(response.ok, `Attestations request failed: ${response.status}`);
  const document = await response.json();
  const statements = (document.attestations ?? []).flatMap((attestation) => {
    const payload = attestation.bundle?.dsseEnvelope?.payload;
    if (!payload) return [];
    return [JSON.parse(Buffer.from(payload, "base64").toString("utf8"))];
  });
  const expectedSubjectDigests = new Set([record.sha256, record.sha512, record.integrity, record.integrity.slice("sha512-".length)]);
  const statement = statements.find((candidate) => {
    if (candidate.predicateType !== "https://slsa.dev/provenance/v1") return false;
    const subjectDigests = candidate.subject?.flatMap(({ digest = {} }) => Object.values(digest).map(String)) ?? [];
    if (!subjectDigests.some((digest) => expectedSubjectDigests.has(digest))) return false;
    const build = candidate.predicate?.buildDefinition;
    const workflow = build?.externalParameters?.workflow;
    if (normalizeRepository(workflow?.repository) !== normalizeRepository(expectedRepository)
      || workflow?.ref !== `refs/tags/${expectedTag}`
      || workflow?.path !== expectedWorkflow) return false;
    return build?.resolvedDependencies?.some((dependency) =>
      normalizeSourceRepository(dependency.uri) === normalizeRepository(expectedRepository)
      && String(dependency.digest?.gitCommit).toLowerCase() === expectedCommit);
  });
  assert.ok(statement, "No SLSA provenance statement binds this tarball to the expected repository, workflow, tag, and source gitCommit");
}

async function registryMetadata(packageName, packageVersion) {
  const url = `${registry}/${packageName.replace("/", "%2f")}/${packageVersion}`;
  const response = await fetch(url, { headers: { accept: "application/json" } });
  if (response.status === 404) return undefined;
  assert.ok(response.ok, `Registry request failed for ${packageName}@${packageVersion}: ${response.status}`);
  return response.json();
}

function runNpm(npmArgs, cwd = process.cwd()) {
  const npm = npmInvocation(npmArgs);
  const result = spawnSync(npm.command, npm.args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, npm_config_registry: registry, npm_config_update_notifier: "false" }
  });
  if (result.error) throw result.error;
  return result;
}

async function retry(operation, attempts, delay) {
  let error;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (cause) {
      error = cause;
      if (attempt < attempts) await new Promise((resolveDelay) => setTimeout(resolveDelay, delay));
    }
  }
  throw error;
}

function normalizeRepository(value) {
  return String(value ?? "").replace(/^git\+/, "").replace(/\.git$/, "").replace(/^https?:\/\//, "").toLowerCase();
}

function normalizeSourceRepository(value) {
  return normalizeRepository(String(value ?? "").replace(/@refs\/.*$/, "").replace(/@[a-f0-9]{40}$/i, ""));
}

function requiredEnv(name) {
  assert.ok(process.env[name], `${name} is required`);
  return process.env[name];
}
