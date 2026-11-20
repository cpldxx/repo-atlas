#!/usr/bin/env node
// Starts Repo Atlas. The app itself is a Python package; uv downloads it (and a matching Python, if needed) on the
// first run and caches it, so later runs start in seconds. Arguments are passed through: `npm create repo-atlas -- --help`.
"use strict";
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");
const pkg = require("../package.json");

const WIN = process.platform === "win32";
const UV = WIN ? "uv.exe" : "uv";
// The app ships inside this package as a Python wheel (vendor/), so nothing else is fetched by name.
// REPO_ATLAS_FROM lets you run another build instead (a wheel path or a directory).
const BUNDLED = path.join(__dirname, "..", "vendor", `repo_atlas-${pkg.version}-py3-none-any.whl`);
const FROM = process.env.REPO_ATLAS_FROM || (fs.existsSync(BUNDLED) ? BUNDLED : `${pkg.config.pythonPackage}==${pkg.version}`);

function works(cmd) {
  const r = spawnSync(cmd, ["--version"], { stdio: "ignore" });
  return r.status === 0;
}
function findUv() {
  if (works(UV)) return UV;
  const home = os.homedir();
  const spots = [path.join(home, ".local", "bin", UV), path.join(home, ".cargo", "bin", UV)];
  if (process.env.XDG_BIN_HOME) spots.unshift(path.join(process.env.XDG_BIN_HOME, UV));
  return spots.find((p) => fs.existsSync(p) && works(p)) || null;
}
function ask(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => { rl.close(); resolve(answer.trim().toLowerCase()); });
  });
}
const INSTALL = WIN
  ? ["powershell", ["-ExecutionPolicy", "ByPass", "-c", "irm https://astral.sh/uv/install.ps1 | iex"]]
  : ["sh", ["-c", "curl -LsSf https://astral.sh/uv/install.sh | sh"]];
const INSTALL_TEXT = WIN
  ? 'powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"'
  : "curl -LsSf https://astral.sh/uv/install.sh | sh";

async function main() {
  let uv = findUv();
  if (!uv) {
    console.log("\nRepo Atlas runs on uv, a small tool that installs Python apps (https://docs.astral.sh/uv/).");
    if (!process.stdin.isTTY) {
      console.log(`Install it with:\n\n  ${INSTALL_TEXT}\n\nthen run this command again.`);
      process.exit(1);
    }
    const answer = await ask("Install uv now? [Y/n] ");
    if (answer && answer !== "y" && answer !== "yes") {
      console.log(`\nTo install it yourself:\n\n  ${INSTALL_TEXT}\n`);
      process.exit(1);
    }
    const r = spawnSync(INSTALL[0], INSTALL[1], { stdio: "inherit" });
    uv = r.status === 0 ? findUv() : null;
    if (!uv) {
      console.log(`\nuv didn't install. Try it yourself:\n\n  ${INSTALL_TEXT}\n`);
      process.exit(1);
    }
  }
  const args = ["tool", "run", "--from", FROM, "repo-atlas", ...process.argv.slice(2)];
  const child = spawn(uv, args, { stdio: "inherit" });
  // Ctrl+C reaches the app directly (same terminal), so just wait for it to finish; other stop signals are passed on.
  process.on("SIGINT", () => {});
  for (const sig of ["SIGTERM", "SIGHUP"]) process.on(sig, () => child.kill(sig));
  child.on("exit", (code, signal) => process.exit(signal ? 1 : code ?? 0));
  child.on("error", (err) => {
    console.error(`Couldn't start uv: ${err.message}`);
    process.exit(1);
  });
}
main();
