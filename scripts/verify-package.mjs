import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspace = mkdtempSync(join(tmpdir(), "instruct-package-check-"));
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
function command(executable, args, cwd) {
  const result = spawnSync(executable, args, { cwd, stdio: "inherit", timeout: 120_000, env: process.env, shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${executable} exited ${result.status ?? result.signal}`);
}
try {
  const tarball = join(workspace, "instruct.tgz");
  command(pnpm, ["pack", "--out", tarball], root);
  const consumer = join(workspace, "consumer"); mkdirSync(consumer);
  writeFileSync(join(consumer, "package.json"), JSON.stringify({ name: "instruct-package-verification", private: true, type: "module" }));
  command(npm, ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarball], consumer);
  copyFileSync(join(root, "scripts", "package-consumer.mjs"), join(consumer, "package-consumer.mjs"));
  command(process.execPath, ["package-consumer.mjs"], consumer);
} finally {
  rmSync(workspace, { recursive: true, force: true });
}
