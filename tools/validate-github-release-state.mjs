import assert from "node:assert/strict";
import { appendFile } from "node:fs/promises";

const repository = requiredEnv("GITHUB_REPOSITORY");
const tag = requiredEnv("EXPECTED_TAG");
const expectedCommit = requiredEnv("EXPECTED_COMMIT").toLowerCase();
const token = requiredEnv("GITHUB_TOKEN");
const output = requiredEnv("GITHUB_OUTPUT");
const apiUrl = (process.env.GITHUB_API_URL ?? "https://api.github.com").replace(/\/$/, "");

assert.match(tag, /^v\d+\.\d+\.\d+$/);
assert.match(expectedCommit, /^[a-f0-9]{40}$/);
const ref = await githubRequest(`/repos/${repository}/git/ref/tags/${encodeURIComponent(tag)}`);
assert.ok(ref.ok, `Unable to read remote tag ${tag}: ${ref.status} ${await ref.text()}`);
let object = (await ref.json()).object;
for (let depth = 0; object.type === "tag" && depth < 5; depth += 1) {
  const annotatedTag = await githubRequest(`/repos/${repository}/git/tags/${object.sha}`);
  assert.ok(annotatedTag.ok, `Unable to dereference annotated tag ${object.sha}: ${annotatedTag.status} ${await annotatedTag.text()}`);
  object = (await annotatedTag.json()).object;
}
assert.equal(object.type, "commit", `Remote tag ${tag} does not resolve to a commit`);
assert.equal(String(object.sha).toLowerCase(), expectedCommit, `Remote tag ${tag} moved after publication`);

const release = await githubRequest(`/repos/${repository}/releases/tags/${encodeURIComponent(tag)}`);
if (release.status === 404) {
  await appendFile(output, "release_exists=false\n", "utf8");
  console.log(`Remote tag ${tag} still targets ${expectedCommit}; no GitHub Release exists.`);
} else {
  assert.ok(release.ok, `Unable to query GitHub Release ${tag}: ${release.status} ${await release.text()}`);
  await appendFile(output, "release_exists=true\n", "utf8");
  console.log(`Remote tag ${tag} still targets ${expectedCommit}; the GitHub Release already exists.`);
}

function githubRequest(path) {
  return fetch(`${apiUrl}${path}`, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28"
    }
  });
}

function requiredEnv(name) {
  assert.ok(process.env[name], `${name} is required`);
  return process.env[name];
}
