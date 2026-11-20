// Before packing: build the Python wheel at the same version and put it in vendor/, so the npm package carries the app.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const npmDir = path.resolve(here, "..");
const root = path.resolve(npmDir, "..");
const version = JSON.parse(fs.readFileSync(path.join(npmDir, "package.json"), "utf8")).version;
const pyVersion = fs.readFileSync(path.join(root, "pyproject.toml"), "utf8").match(/^version = "([^"]+)"/m)[1];
if (pyVersion !== version) throw new Error(`version mismatch: npm ${version}, python ${pyVersion}`);
const dist = path.join(root, "dist");
fs.rmSync(dist, { recursive: true, force: true });
execFileSync("uv", ["build", "--wheel", "--out-dir", dist], { cwd: root, stdio: "inherit" });
const wheel = `repo_atlas-${version}-py3-none-any.whl`;
const vendor = path.join(npmDir, "vendor");
fs.rmSync(vendor, { recursive: true, force: true });
fs.mkdirSync(vendor);
fs.copyFileSync(path.join(dist, wheel), path.join(vendor, wheel));
console.log(`vendored ${wheel}`);
