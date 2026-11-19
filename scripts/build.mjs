import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const build = resolve(root, "build");
const staging = resolve(build, "codex-bilingual-reader");
await rm(build, { recursive: true, force: true });
await mkdir(resolve(staging, "content", "scripts"), { recursive: true });
await mkdir(resolve(staging, "content", "icons"), { recursive: true });
await mkdir(resolve(staging, "content", "runtime"), { recursive: true });
await cp(resolve(root, "addon", "manifest.json"), resolve(staging, "manifest.json"));
await cp(resolve(root, "addon", "bootstrap.js"), resolve(staging, "bootstrap.js"));
await cp(resolve(root, "addon", "prefs.js"), resolve(staging, "prefs.js"));
await cp(resolve(root, "addon", "content", "icons", "icon.svg"), resolve(staging, "content", "icons", "icon.svg"));
await cp(resolve(root, "addon", "content", "icons", "icon-16.svg"), resolve(staging, "content", "icons", "icon-16.svg"));
await cp(resolve(root, "addon", "content", "icons", "icon-20.svg"), resolve(staging, "content", "icons", "icon-20.svg"));
await cp(resolve(root, "addon", "locale"), resolve(staging, "locale"), { recursive: true });
await cp(resolve(root, "addon", "content", "preferences.xhtml"), resolve(staging, "content", "preferences.xhtml"));
await cp(resolve(root, "addon", "content", "prefsPane-init.js"), resolve(staging, "content", "prefsPane-init.js"));
await cp(resolve(root, "addon", "content", "task-center.xhtml"), resolve(staging, "content", "task-center.xhtml"));
await cp(resolve(root, "addon", "content", "task-center.js"), resolve(staging, "content", "task-center.js"));
await cp(resolve(root, "src", "pipeline.js"), resolve(staging, "content", "scripts", "pipeline.js"));
await cp(resolve(root, "src", "preserved-pdf-workflow.js"), resolve(staging, "content", "scripts", "preserved-pdf-workflow.js"));
await cp(resolve(root, "src", "task-metrics.js"), resolve(staging, "content", "scripts", "task-metrics.js"));
await cp(resolve(root, "src", "official-pricing.js"), resolve(staging, "content", "scripts", "official-pricing.js"));
await cp(resolve(root, "src", "main.js"), resolve(staging, "content", "scripts", "main.js"));
const runtimeFiles = [
  "translate-preserved-pdf-cli.mjs",
  "pdf-runtime-paths.mjs",
  "prepare-pdf2zh-runtime.mjs",
  "codex-cli-translator.py",
  "codex-batch-broker.py",
  "pdf_layout.py",
  "compact-dual-pdf.py",
  "export-bilingual-artifacts.mjs",
  "render-pages-to-docx.py",
  "flatten-pdf-for-viewer.py",
  "verify-preserved-pdf.py",
  "install-preserved-pdf-runtime.ps1",
  "install-preserved-pdf-runtime.sh",
];
for (const name of runtimeFiles) {
  await cp(resolve(root, "scripts", name), resolve(staging, "content", "runtime", name));
}
const xpi = resolve(build, "codex-bilingual-reader.xpi");
const python = process.platform === "win32" ? "python" : "python3";
const result = spawnSync(python, [resolve(root, "scripts", "create-xpi.py"), staging, xpi], { stdio: "inherit" });
if (result.status !== 0) process.exit(result.status ?? 1);
const runtimeZip = resolve(build, "codex-bilingual-runtime.zip");
const runtimeResult = spawnSync(python, [resolve(root, "scripts", "create-runtime-bundle.py"), root, runtimeZip, ...runtimeFiles], { stdio: "inherit" });
if (runtimeResult.status !== 0) process.exit(runtimeResult.status ?? 1);
const manifest = JSON.parse(await readFile(resolve(staging, "manifest.json"), "utf8"));
const { id, strict_min_version, strict_max_version } = manifest.applications.zotero;
const update = {
  version: manifest.version,
  update_link: `${manifest.homepage_url}/releases/download/v${manifest.version}/codex-bilingual-reader.xpi`,
  update_hash: `sha256:${createHash("sha256").update(await readFile(xpi)).digest("hex").toUpperCase()}`,
  applications: { zotero: { strict_min_version, strict_max_version } },
};
const updateManifest = { addons: { [id]: { updates: [update] } } };
await writeFile(resolve(build, "update.json"), JSON.stringify(updateManifest, null, 2) + "\n");
console.log(`Built ${xpi}`);
console.log(`Built ${runtimeZip}`);
