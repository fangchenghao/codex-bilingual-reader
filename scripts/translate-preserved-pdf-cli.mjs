import { access, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { execFile, spawn } from "node:child_process";
import { constants } from "node:fs";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { basename, dirname, parse, resolve } from "node:path";
import { preparePdf2zhRuntime } from "./prepare-pdf2zh-runtime.mjs";
import { applyProxyDefaults, resolvePdfRuntime } from "./pdf-runtime-paths.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const checking = process.argv[2] === "--check";
const source = process.argv[2];
const requestedOutput = process.argv[3];
if (!checking && (!source || !requestedOutput)) throw new Error("Usage: node scripts/translate-preserved-pdf-cli.mjs <input.pdf> <output-directory>");

const output = requestedOutput ? resolve(requestedOutput) : "";
// Windows uses PDFMathTranslate's portable bundle; macOS/Linux use a venv that
// the runtime installer provisions. Both expose the same engine + interpreter
// contract, so everything below stays platform neutral.
const runtime = await resolvePdfRuntime({ root, env: process.env });
const home = runtime.home;
const portableRoot = runtime.portableRoot;
const engine = runtime.engine;
const bridgePython = runtime.python;
const broker = resolve(root, "scripts", "codex-batch-broker.py");
const compactDualPdfScript = resolve(root, "scripts", "compact-dual-pdf.py");
const exporter = resolve(root, "scripts", "export-bilingual-artifacts.mjs");
const docxBuilder = resolve(root, "scripts", "render-pages-to-docx.py");
const requestedCliTimeout = Number(process.env.CODEX_PDF_CLI_TIMEOUT_SECONDS || "300");
const backendTimeout = Math.max(1, Number.isFinite(requestedCliTimeout) ? requestedCliTimeout : 300);
// These workers only feed the local broker. The broker limits actual Codex
// concurrency independently while enough layout fragments gather per batch.
// Apple Silicon saturates earlier than a desktop x86 machine, so default lower.
const defaultWorkers = process.platform === "darwin" ? "32" : "64";
const qps = process.env.CODEX_PDF_QPS || defaultWorkers;
const workers = process.env.CODEX_PDF_WORKERS || defaultWorkers;
const recoveryIdleMs = Math.max(60000, Number(process.env.CODEX_PDF_ENGINE_RECOVERY_IDLE_SECONDS || "90") * 1000);
// Capture the real account home before isolating BabelDOC's HOME. A stale
// inherited CODEX_HOME can otherwise point into the temporary runtime.
const codexHome = runtime.codexHome;
const env = applyProxyDefaults({
  ...process.env,
  // On Windows BabelDOC runs inside a throwaway HOME so nothing leaks into the
  // real profile. On macOS/Linux we keep the real HOME on purpose: BabelDOC
  // hard-codes its cache to $HOME/.cache/babeldoc, and reusing that cache means
  // the ~340 MB of fonts/models are downloaded once instead of per run.
  ...(process.platform === "win32" ? { USERPROFILE: home, HOME: home } : {}),
  CODEX_HOME: codexHome,
  CODEX_PDF_CODEX_HOME: codexHome,
  CODEX_PDF_CODEX: process.env.CODEX_PDF_CODEX || "codex",
  CODEX_PDF_CLI_TIMEOUT_SECONDS: String(Math.floor(backendTimeout)),
  CODEX_PDF_BATCH_WAIT_MS: process.env.CODEX_PDF_BATCH_WAIT_MS || "200",
  PYTHONIOENCODING: "utf-8",
  PYTHONUTF8: "1",
  NO_COLOR: "1",
  // BabelDOC downloads its layout model and fonts from HuggingFace on first
  // run. The Windows portable bundle ships them already, but a venv install
  // fetches them, and huggingface.co is unreachable from mainland China.
  ...(process.env.HF_ENDPOINT
    ? { HF_ENDPOINT: process.env.HF_ENDPOINT }
    : process.platform === "win32"
      ? {}
      : { HF_ENDPOINT: "https://hf-mirror.com" }),
  // DirectML is available on some Windows machines but benchmarked slower than
  // CPU for BabelDOC's dynamic layout model. Keep it opt-in.
  CODEX_PDF_LAYOUT_PROVIDER: process.env.CODEX_PDF_LAYOUT_PROVIDER || "cpu",
});
if (checking) {
  await mkdir(home, { recursive: true });
  await access(engine, constants.X_OK);
  await access(resolve(root, "scripts", "prepare-pdf2zh-runtime.mjs"));
  await access(bridgePython, constants.X_OK);
  await access(resolve(root, "scripts", "pdf_layout.py"));
  await access(broker);
  await access(compactDualPdfScript);
  await access(exporter);
  await access(docxBuilder);
  const imports = "import sys; sys.path.extend(sys.argv[1:]); import pymupdf, babeldoc, pdf2zh_next";
  const packagePaths = runtime.mode === "portable" ? [resolve(portableRoot, "site-packages")] : [];
  await promisify(execFile)(bridgePython, ["-c", imports, ...packagePaths], { env, windowsHide: true, timeout: 30000 });
  console.log(`RESULT_JSON=${JSON.stringify({ status: "ready", engine, python: bridgePython })}`);
  process.exit(0);
}
await mkdir(output, { recursive: true });
await mkdir(home, { recursive: true });
// The DirectML/UTF-8 patches only apply to the Windows portable bundle; the venv
// install is stock PyPI packages, so nothing needs rewriting there.
if (runtime.mode === "portable") await preparePdf2zhRuntime(portableRoot);
const runnerResultPath = resolve(output, "codex-runner-result.json");
await rm(runnerResultPath, { force: true });
env.CODEX_PDF_CHECKPOINT_FILE = resolve(output, "codex-fragment-checkpoint.jsonl");
env.CODEX_PDF_PROGRESS_FILE = resolve(output, "codex-fragment-progress.jsonl");
env.CODEX_PDF_FATAL_FILE = resolve(output, "codex-fatal-error.json");
await rm(env.CODEX_PDF_FATAL_FILE, { force: true });
const brokerReadyPath = resolve(output, "codex-batch-broker-ready.json");
await rm(brokerReadyPath, { force: true });
const layoutToken = randomBytes(32).toString("hex");
const brokerChild = spawn(bridgePython, [broker, "--layout", "--ready-file", brokerReadyPath], {
  cwd: root, env: { ...env, CODEX_PDF_LAYOUT_TOKEN: layoutToken }, windowsHide: true, stdio: ["pipe", "ignore", "pipe"],
});
let brokerError = "";
let brokerSpawnFailed = false;
brokerChild.stderr.setEncoding("utf8");
brokerChild.stderr.on("data", (chunk) => { brokerError = (brokerError + chunk).slice(-1200); });
brokerChild.on("error", (error) => { brokerSpawnFailed = true; brokerError = error.message; });
let brokerReady = null;
const brokerStartedAt = Date.now();
while (!brokerReady && brokerChild.exitCode === null && !brokerSpawnFailed && Date.now() - brokerStartedAt < 10000) {
  try {
    brokerReady = JSON.parse(await readFile(brokerReadyPath, "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
}
if (!Number(brokerReady?.port)) {
  brokerChild.kill();
  throw new Error(`PDF 翻译服务启动失败：${brokerError || "未收到就绪信号，请修复 PDF 环境。"}`);
}
const stopBroker = () => { if (!brokerChild.killed) brokerChild.kill(); };
const sourceStem = parse(basename(source)).name;
const translationSide = process.env.CODEX_PDF_TRANSLATION_SIDE === "left" ? "left" : "right";
async function latestEngineDualPdf() {
  const candidates = (await readdir(output)).filter((name) => name.startsWith(sourceStem) && /dual.*\.pdf$/i.test(name) && !/\.compact\.pdf$/i.test(name));
  if (!candidates.length) return "";
  const paths = await Promise.all(candidates.map(async (name) => {
    const filePath = resolve(output, name);
    return { filePath, info: await stat(filePath) };
  }));
  return paths.sort((left, right) => right.info.mtimeMs - left.info.mtimeMs)[0].filePath;
}
const args = [
  source, "--output", output, "--lang-in", "en", "--lang-out", "zh-CN",
  // Native LLM requests carry ordered cross-page and cross-column groups.
  // The broker reuses its own context-aware checkpoints for these requests.
  "--openaicompatible", "--openai-compatible-base-url", `http://127.0.0.1:${brokerReady.port}/v1`,
  "--openai-compatible-api-key", layoutToken, "--openai-compatible-model", "bilingual-reader",
  "--openai-compatible-timeout", String(backendTimeout * 2 + 60), "--ignore-cache",
  "--qps", qps, "--pool-max-workers", workers, "--no-auto-extract-glossary",
  // Use BabelDOC's native dual-page compositor. It preserves the CJK font
  // resources Zotero can render. Do not pass --skip-clean: BabelDOC performs
  // CJK font subsetting in its clean stage, which is required by Zotero's
  // PDF.js reader. Direction remains explicitly user-controlled below.
  // Academic PDFs with selectable text do not need BabelDOC's scanned-page
  // detection pass. Table translation stays enabled to preserve full-text
  // behavior; it can be disabled explicitly for a faster draft.
  "--skip-scanned-detection", "--disable-rich-text-translate", "--watermark-output-mode", "no_watermark",
];
if (String(env.CODEX_PDF_TRANSLATE_TABLE_TEXT || "true") !== "false") args.push("--translate-table-text");
if (String(env.CODEX_PDF_PAGES || "").trim()) args.push("--pages", String(env.CODEX_PDF_PAGES).trim());
if (translationSide === "left") args.push("--dual-translate-first");
const child = spawn(engine, args, { cwd: root, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
const cancelChildren = () => { stopBroker(); child.kill(); };
process.once("SIGTERM", cancelChildren);
process.once("SIGINT", cancelChildren);
child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
let lastEngineActivityAt = Date.now();
child.stdout.on("data", (chunk) => { lastEngineActivityAt = Date.now(); process.stdout.write(chunk); });
child.stderr.on("data", (chunk) => { lastEngineActivityAt = Date.now(); process.stderr.write(chunk); });
let fatalError = null;
let stoppingForFatal = false;
let recoveredEngineDualPdf = "";
let recoveryProbe = { filePath: "", size: -1, mtimeMs: -1, stableSince: 0 };
async function readFatalError() {
  try {
    return JSON.parse((await readFile(env.CODEX_PDF_FATAL_FILE, "utf8")).trim());
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}
const fatalMonitor = setInterval(() => {
  void readFatalError().then((entry) => {
    if (!entry || stoppingForFatal) return;
    fatalError = entry;
    stoppingForFatal = true;
    // The engine owns its worker pool. Terminating this root process makes a
    // quota/authentication error visible immediately instead of retrying every fragment.
    child.kill();
  }).catch((error) => process.stderr.write(`Unable to read Codex failure marker: ${error.message}\n`));
}, 500);
const recoveryMonitor = setInterval(() => {
  void (async () => {
    if (stoppingForFatal || recoveredEngineDualPdf) return;
    const candidate = await latestEngineDualPdf();
    if (!candidate) return;
    const info = await stat(candidate);
    const now = Date.now();
    const progressInfo = await stat(env.CODEX_PDF_PROGRESS_FILE).catch(() => null);
    const lastActivity = Math.max(lastEngineActivityAt, progressInfo?.mtimeMs || 0);
    if (candidate !== recoveryProbe.filePath || info.size !== recoveryProbe.size || info.mtimeMs !== recoveryProbe.mtimeMs) {
      recoveryProbe = { filePath: candidate, size: info.size, mtimeMs: info.mtimeMs, stableSince: now };
      return;
    }
    if (now - recoveryProbe.stableSince < recoveryIdleMs || now - lastActivity < recoveryIdleMs) return;
    recoveredEngineDualPdf = candidate;
    stoppingForFatal = true;
    process.stderr.write(`PDF engine produced a stable dual PDF but did not exit for ${Math.round(recoveryIdleMs / 1000)} seconds; recovering output.\n`);
    child.kill();
  })().catch((error) => process.stderr.write(`Unable to monitor PDF engine recovery: ${error.message}\n`));
}, 1000);
let exitCode;
try {
  exitCode = await new Promise((resolvePromise, reject) => { child.on("error", reject); child.on("exit", (code) => resolvePromise(code)); });
} finally {
  process.off("SIGTERM", cancelChildren);
  process.off("SIGINT", cancelChildren);
  clearInterval(fatalMonitor);
  clearInterval(recoveryMonitor);
  stopBroker();
}
fatalError ||= await readFatalError();
if (fatalError) throw new Error(`翻译后端不可用，PDF 翻译已停止：${fatalError.message}`);
if (exitCode !== 0 && !recoveredEngineDualPdf) throw new Error(`PDF engine failed (${exitCode})`);
const engineDualPdf = recoveredEngineDualPdf || await latestEngineDualPdf();
if (!engineDualPdf) throw new Error("PDF engine completed but no bilingual PDF artifact was found");
const compactedDualPdf = resolve(output, `${parse(engineDualPdf).name}.compact.pdf`);
const compactChild = spawn(bridgePython, [
  compactDualPdfScript,
  engineDualPdf,
  compactedDualPdf,
  "--trim-points",
  String(env.CODEX_PDF_DUAL_INNER_TRIM_PT || "80"),
], { cwd: root, env, windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
let compactError = "";
compactChild.stderr.setEncoding("utf8");
compactChild.stderr.on("data", (chunk) => { compactError += chunk; process.stderr.write(chunk); });
const compactExitCode = await new Promise((resolvePromise, reject) => {
  compactChild.on("error", reject);
  compactChild.on("exit", (code) => resolvePromise(code));
});
if (compactExitCode !== 0) throw new Error(`Compact dual PDF failed (${compactExitCode}): ${compactError.slice(-800)}`);
const dualPdf = compactedDualPdf;
const exportFormats = String(env.CODEX_PDF_EXPORTS || "").split(",").filter(Boolean);
let artifacts = {};
if (exportFormats.length) {
  const exporterChild = spawn(process.execPath, [exporter, dualPdf, output, exportFormats.join(",")], { cwd: root, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let exporterOutput = "";
  let exporterError = "";
  exporterChild.stdout.setEncoding("utf8"); exporterChild.stderr.setEncoding("utf8");
  exporterChild.stdout.on("data", (chunk) => { exporterOutput += chunk; process.stdout.write(chunk); });
  exporterChild.stderr.on("data", (chunk) => { exporterError += chunk; process.stderr.write(chunk); });
  const exporterExitCode = await new Promise((resolvePromise, reject) => { exporterChild.on("error", reject); exporterChild.on("exit", (code) => resolvePromise(code)); });
  if (exporterExitCode !== 0) throw new Error(`Artifact export failed (${exporterExitCode}): ${exporterError.slice(-800)}`);
  const exportResult = exporterOutput.match(/EXPORTS_JSON=(\{[^\r\n]+\})/g)?.at(-1);
  if (!exportResult) throw new Error("Artifact exporter did not return EXPORTS_JSON");
  artifacts = JSON.parse(exportResult.slice("EXPORTS_JSON=".length));
}
const resultPayload = {
  dualPdf,
  engineDualPdf,
  recoveredEngineHang: Boolean(recoveredEngineDualPdf),
  bytes: (await stat(dualPdf)).size,
  artifacts,
};
// Zotero's Subprocess pipe can occasionally lose stdout from a completed
// Windows child process. Persist the same contract beside the artifacts so
// the add-on can recover the result without rerunning translation.
await writeFile(runnerResultPath, JSON.stringify(resultPayload), "utf8");
console.log(`RESULT_JSON=${JSON.stringify({ ...resultPayload, runnerResultPath })}`);
