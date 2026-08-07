import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(await readFile(
  resolve(repoRoot, "packages", "electron-overlay", "package.json"),
  "utf8"
));
const npmCli = process.env.npm_execpath;

if (!npmCli) throw new Error("Run package preparation through npm run package:prepare.");

for (const args of [
  [npmCli, "run", "build"],
  ["./tools/prepare-public-package.mjs", `--package-version=${manifest.version}`],
  ["./tools/prepare-prebuilt-package.mjs", `--package-version=${manifest.version}`]
]) {
  const result = spawnSync(process.execPath, args, { cwd: repoRoot, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
