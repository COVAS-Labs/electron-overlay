import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";

const require = createRequire(import.meta.url);
const nodeGyp = require.resolve("node-gyp/bin/node-gyp.js");
const electronVersion = require("electron/package.json").version;
const result = spawnSync(process.execPath, [
  nodeGyp,
  "rebuild",
  `--target=${electronVersion}`,
  "--dist-url=https://electronjs.org/headers",
  `--arch=${process.arch}`
], {
  cwd: process.cwd(),
  stdio: "inherit"
});

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}
