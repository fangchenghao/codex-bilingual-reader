import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { posix as path, resolve } from "node:path";
import test from "node:test";
import vm from "node:vm";
import { applyProxyDefaults, resolvePdfRuntime } from "../scripts/pdf-runtime-paths.mjs";

test("a folder named bilingual does not mark its original PDFs as translated", async () => {
  const main = await readFile(new URL("../src/main.js", import.meta.url), "utf8");
  let filename = "paper.pdf";
  const attachment = {
    isAttachment: () => true, attachmentContentType: "application/pdf",
    getField: () => "PDF", getFilePath: () => "/library/bilingual/" + filename,
  };
  const item = { getAttachments: () => [2] };
  const context = { Zotero: { Items: { get: (id) => Array.isArray(id) ? [attachment] : item } }, IOUtils: { exists: async () => false } };
  vm.runInNewContext(main, context);
  await assert.rejects(context.CodexBilingual.startPreservedPdfTranslation(1), /找不到原始 PDF 文件/);
  filename = "paper.zh-CN.dual.pdf";
  await assert.rejects(context.CodexBilingual.startPreservedPdfTranslation(1), /已检测到双语 PDF/);
});

test("Windows portable paths follow the launcher even when Zotero has another working directory", async () => {
  const root = resolve("tmp", "Example Profile", "codex-bilingual-runtime");
  const runtime = await resolvePdfRuntime({ root, platform: "win32", env: {} });
  const configured = await resolvePdfRuntime({ root, platform: "win32", env: { CODEX_PDF_ENGINE: runtime.engine } });
  assert.equal(configured.mode, "portable");
  assert.equal(configured.engine, resolve(root, ".tools/pdf2zh-next-staging-2.9.0-babeldoc-0.6.4/pdf2zh/pdf2zh.exe"));
  assert.equal(configured.python, resolve(configured.portableRoot, "runtime/pythonw.exe"));
  const proxy = applyProxyDefaults({ HTTPS_PROXY: "http://proxy.test:3128", no_proxy: "example.test" });
  assert.equal(proxy.no_proxy, proxy.NO_PROXY);
  assert.deepEqual(proxy.NO_PROXY.split(","), ["example.test", "127.0.0.1", "localhost"]);
  assert.equal(proxy.HTTPS_PROXY, "http://proxy.test:3128");
  assert.equal(applyProxyDefaults({ NO_PROXY: "*" }).NO_PROXY, "*");
});

test("repair validates candidate paths before committing and refreshes managed scripts on retry", async () => {
  const source = await readFile(new URL("../src/main.js", import.meta.url), "utf8");
  const prefs = new Map();
  const root = "/profile/codex-bilingual-runtime";
  const launcher = path.join(root, "scripts/translate-preserved-pdf-cli.mjs");
  const engine = path.join(root, ".venv/bin/pdf2zh_next");
  const node = "/usr/local/bin/node";
  const files = new Set(["/bin/bash", node]);
  let invalid = true;
  let installs = 0;
  function stream(...chunks) { return { async readString() { return chunks.shift() || ""; } }; }
  const context = {
    rootURI: "jar:file:///test.xpi!/",
    PathUtils: { ...path, parent: path.dirname, profileDir: "/profile" },
    Services: { appinfo: { OS: "Darwin" }, dirsvc: { get: () => ({ path: "/home" }) }, env: { get: () => "" } },
    Ci: { nsIFile: {} },
    IOUtils: {
      exists: async (dest) => files.has(dest), makeDirectory: async () => {},
      writeUTF8: async (dest) => { files.add(dest); },
    },
    Zotero: {
      Prefs: { get: (key) => prefs.get(key), set: (key, value) => prefs.set(key, value) },
      File: { getResourceAsync: async (uri) => { assert.ok(uri.startsWith("jar:file:///test.xpi!/content/runtime/")); return "script"; } },
    },
    Subprocess: { async call(options) {
      if (options.command === "/bin/bash") {
        installs++;
        return { stdout: stream("STA", "GE=checking\n", "INSTALL_JSON=" + JSON.stringify({ launcher, engine, node })), stderr: stream(), wait: async () => ({ exitCode: 0 }) };
      }
      assert.equal(options.command, node);
      assert.equal(options.environment.CODEX_PDF_ENGINE, engine);
      assert.deepEqual([...options.arguments], [launcher, "--check"]);
      return { stdout: stream('RESULT_JSON=' + JSON.stringify({ status: "ready", engine })), stderr: stream("missing dependency"), wait: async () => ({ exitCode: invalid ? 1 : 0 }) };
    } },
  };
  vm.runInNewContext(source, context);
  const api = context.CodexBilingual;
  const stages = [];
  const results = await Promise.allSettled([api.installPreservedPdfRuntime((s) => stages.push(s)), api.installPreservedPdfRuntime()]);
  assert.ok(results.every((r) => r.status === "rejected" && r.reason.message.includes("missing dependency")));
  assert.ok(stages.includes("checking"));
  assert.equal(installs, 1);
  assert.equal(prefs.size, 0);
  invalid = false;
  files.delete(launcher);
  await api.installPreservedPdfRuntime();
  assert.ok(files.has(launcher));
  assert.equal(installs, 2);
  assert.equal(prefs.get("extensions.zotero.codex-bilingual-reader.preservedPdfLauncherPath"), launcher);
  assert.equal(prefs.get("extensions.zotero.codex-bilingual-reader.cliNodePath"), node);
});
