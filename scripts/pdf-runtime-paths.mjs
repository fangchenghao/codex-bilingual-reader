/**
 * pdf-runtime-paths.mjs — resolve the PDFMathTranslate (pdf2zh_next) engine and
 * the Python interpreter that runs the Codex translation bridge, on every
 * supported platform.
 *
 * Two runtime layouts are supported:
 *
 *   portable  (Windows)  <root>/.tools/pdf2zh-next-staging-2.9.0-babeldoc-0.6.4/pdf2zh
 *                        engine: pdf2zh.exe
 *                        python: runtime/pythonw.exe
 *
 *   venv      (macOS/Linux)
 *                        <root>/.venv
 *                        engine: bin/pdf2zh_next
 *                        python: bin/python3
 *
 * Both can be overridden with CODEX_PDF_ENGINE / CODEX_PDF_PYTHON, which is how
 * the "advanced: use an existing workspace" preference wires a custom install.
 */
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";

export const PORTABLE_ROOT = resolve(
  ".tools",
  "pdf2zh-next-staging-2.9.0-babeldoc-0.6.4",
  "pdf2zh",
);
export const VENV_ROOT = ".venv";

// The engine is pinned to this pair because pdf2zh_next 2.9.0 requires
// pymupdf<1.25.3 while babeldoc 0.6.3+ requires pymupdf>=1.26.7. babeldoc 0.6.2
// is the newest release that satisfies both.
export const PDF2ZH_VERSION = "2.9.0";
export const BABELDOC_VERSION = "0.6.2";
export const MIN_PYTHON = "3.10";
export const MAX_PYTHON = "3.13";

export const isWindows = (platform = process.platform) => platform === "win32";

export async function pathExists(candidate) {
  if (!candidate) return false;
  try {
    await access(candidate);
    return true;
  } catch (_error) {
    return false;
  }
}

/**
 * Resolve the engine, the bridge interpreter, and the isolated HOME that
 * BabelDOC runs inside.
 *
 * @param {{ root: string, platform?: string, env?: Record<string, string|undefined> }} options
 */
export async function resolvePdfRuntime({ root, platform = process.platform, env = process.env }) {
  const windows = isWindows(platform);
  const portableRoot = resolve(root, PORTABLE_ROOT);
  const venvRoot = resolve(root, VENV_ROOT);
  const engineOverride = String(env.CODEX_PDF_ENGINE || "").trim();
  const pythonOverride = String(env.CODEX_PDF_PYTHON || "").trim();

  const bundledEngine = windows
    ? resolve(portableRoot, "pdf2zh.exe")
    : resolve(venvRoot, "bin", "pdf2zh_next");
  const bundledPython = windows
    ? resolve(portableRoot, "runtime", "pythonw.exe")
    : resolve(venvRoot, "bin", "python3");

  const engine = engineOverride || bundledEngine;
  let python = pythonOverride || bundledPython;

  // A custom engine that ships its own interpreter can also be used by naming
  // the venv/bin directory next to it; otherwise fall back to the bundled one.
  if (!pythonOverride && engineOverride && !(await pathExists(python))) {
    const sibling = resolve(engineOverride, "..", windows ? "python.exe" : "python3");
    if (await pathExists(sibling)) python = sibling;
  }

  const mode = engineOverride ? "custom" : windows ? "portable" : "venv";
  return {
    platform,
    mode,
    engine,
    python,
    portableRoot,
    venvRoot,
    root,
    // BabelDOC and the bundled fonts/model cache stay inside the runtime root so
    // uninstalling the add-on leaves no trace in the user's home directory.
    home: resolve(root, ".runtime", "pdf2zh-home"),
    codexHome:
      String(env.CODEX_PDF_CODEX_HOME || "").trim() ||
      (windows
        ? resolve(env.USERPROFILE || env.HOME || homedir(), ".codex")
        : resolve(env.CODEX_HOME || resolve(env.HOME || homedir(), ".codex"))),
  };
}

/**
 * Proxy defaults differ per platform:
 *  - Windows assumes a local Clash instance on 7897, as the original add-on did.
 *  - macOS/Linux usually have no explicit proxy env, but the *system* proxy can
 *    still be inherited by Python's HTTP stack. When no proxy env var is set we
 *    force NO_PROXY=*, because a system proxy pointing at a stopped client
 *    turns every request into a ConnectTimeout. Users who really need a proxy
 *    can export HTTP(S)_PROXY and it is preserved untouched.
 */
export function applyProxyDefaults(env, platform = process.platform) {
  const proxyKeys = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"];
  const hasExplicitProxy = proxyKeys.some((key) => String(env[key] || "").trim());
  const next = { ...env };
  if (platform === "win32") {
    const defaults = { HTTP_PROXY: "http://127.0.0.1:7897", HTTPS_PROXY: "http://127.0.0.1:7897", ALL_PROXY: "http://127.0.0.1:7897" };
    for (const [key, value] of Object.entries(defaults)) {
      if (!next[key]) next[key] = value;
    }
  }
  for (const key of proxyKeys) {
    if (key in next && !String(next[key] || "").trim()) delete next[key];
  }
  if (!String(next.NO_PROXY || "").trim()) {
    next.NO_PROXY = hasExplicitProxy ? "127.0.0.1,localhost" : "*";
  }
  return next;
}
