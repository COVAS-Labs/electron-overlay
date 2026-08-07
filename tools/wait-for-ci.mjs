import assert from "node:assert/strict";

const repository = requiredEnv("GITHUB_REPOSITORY");
const commit = requiredEnv("GITHUB_SHA").toLowerCase();
const token = requiredEnv("GITHUB_TOKEN");
const apiUrl = (process.env.GITHUB_API_URL ?? "https://api.github.com").replace(/\/$/, "");
const workflow = process.env.EXPECTED_CI_WORKFLOW ?? "ci.yml";
const attempts = 60;
const delay = 20000;

assert.match(commit, /^[a-f0-9]{40}$/);
for (let attempt = 1; attempt <= attempts; attempt += 1) {
  const url = `${apiUrl}/repos/${repository}/actions/workflows/${encodeURIComponent(workflow)}/runs?head_sha=${commit}&event=push&per_page=100`;
  const response = await fetch(url, { headers: githubHeaders(token) });
  assert.ok(response.ok, `GitHub Actions API failed with ${response.status}: ${await response.text()}`);
  const document = await response.json();
  const runs = document.workflow_runs?.filter((run) => String(run.head_sha).toLowerCase() === commit) ?? [];
  if (runs.some((run) => run.status === "completed" && run.conclusion === "success")) {
    console.log(`CI completed successfully for ${commit}.`);
    process.exit(0);
  }
  const completed = runs.filter((run) => run.status === "completed");
  if (runs.length > 0 && completed.length === runs.length) {
    throw new Error(`CI completed without success for ${commit}: ${completed.map(({ html_url, conclusion }) => `${conclusion} (${html_url})`).join(", ")}`);
  }
  if (attempt < attempts) {
    console.log(`Waiting for CI on ${commit} (${attempt}/${attempts}).`);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, delay));
  }
}
throw new Error(`Timed out waiting for successful CI on ${commit}.`);

function githubHeaders(authToken) {
  return {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${authToken}`,
    "x-github-api-version": "2022-11-28"
  };
}

function requiredEnv(name) {
  assert.ok(process.env[name], `${name} is required`);
  return process.env[name];
}
