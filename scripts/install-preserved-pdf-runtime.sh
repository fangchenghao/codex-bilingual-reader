#!/bin/bash
# install-preserved-pdf-runtime.sh — provision the PDFMathTranslate runtime that
# the "preserved layout bilingual PDF" pipeline needs, on macOS and Linux.
#
# The Windows equivalent ships a portable bundle with an embedded Python. Here
# we create a venv inside the add-on runtime directory and install the exact
# pinned versions that satisfy each other:
#
#   pdf2zh_next 2.9.0  requires pymupdf<1.25.3 and babeldoc>=0.6.2,<0.7.0
#   babeldoc    0.6.2  requires pymupdf>=1.25.1   (0.6.3+ wants >=1.26.7 → conflict)
#   bitstring   4.3.1  is the newest release that still exports BitStream,
#                      which babeldoc 0.6.2 imports
#
# Usage: install-preserved-pdf-runtime.sh --runtime-root <directory>
set -euo pipefail

PDF2ZH_VERSION="2.9.0"
BABELDOC_VERSION="0.6.2"
BITSTRING_VERSION="4.3.1"
MIN_PYTHON_MINOR=10
MAX_PYTHON_MINOR=13

RUNTIME_ROOT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --runtime-root) RUNTIME_ROOT="${2:-}"; shift 2 ;;
    --runtime-root=*) RUNTIME_ROOT="${1#*=}"; shift ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done
if [ -z "$RUNTIME_ROOT" ]; then
  echo "Missing --runtime-root <directory>" >&2
  exit 2
fi

mkdir -p "$RUNTIME_ROOT"
RUNTIME_ROOT="$(cd "$RUNTIME_ROOT" && pwd)"
VENV="$RUNTIME_ROOT/.venv"
TOOLS="$RUNTIME_ROOT/.tools"
# Finder and Linux desktop launchers do not source interactive shell profiles.
export PATH="${PATH:-/usr/bin:/bin}:/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$HOME/.cargo/bin"
stage() { echo "STAGE=$*"; }
fail() { echo "[codex-bilingual] $*" >&2; exit 1; }
mkdir -p "$TOOLS"
STAGING="$(mktemp -d "$TOOLS/.setup-XXXXXX")"
trap 'rm -rf "$STAGING"' EXIT

# Extract only the named executable after verifying the official archive.
install_tool() {
  local tool="$1" os arch platform target url member digest destination actual wheel_tag
  os="$(uname -s)"
  arch="$(uname -m)"
  case "$arch" in arm64|aarch64) arch=arm64 ;; x86_64|amd64) arch=x64 ;; esac
  case "$os" in Darwin) platform=darwin ;; Linux) platform=linux ;; *) fail "请在此平台预先安装 ${tool}。" ;; esac
  case "$tool/$platform/$arch" in
    node/darwin/arm64) digest=8294b7aa9b03997481c06babf1e8b270c859358f27da57a11509afe537ac381d ;;
    node/darwin/x64)   digest=d1b5e999db158c62fe8f7267a4476b035d8bd93b1a605bac24a3f0dd166e3316 ;;
    node/linux/arm64)  digest=d28c8a5bf0a808f0ed434a1dce8c54ae98f0371c0bd86ac58abc613f73e6643f ;;
    node/linux/x64)    digest=f625d97cd707df4ff96254916fbc5ff014f09c09effe5a1e0ca8f6d41a8789d4 ;;
    uv/darwin/arm64)   wheel_tag=macosx_11_0_arm64; digest=66c512266d633bef48384a1f53003f41f2a8e7b36fe6e7fbfd3e0fd52d96fa63 ;;
    uv/darwin/x64)     wheel_tag=macosx_10_12_x86_64; digest=c16ed11e013557536b3e60065f1b912f6407bd6518e041b961e23ef9e6b4fbf5 ;;
    uv/linux/arm64)    wheel_tag=manylinux_2_17_aarch64.manylinux2014_aarch64.musllinux_1_1_aarch64; digest=5435c5ce14a56431208ca0996416d310f1598e8c2c8ba707688985a16bb82dbe ;;
    uv/linux/x64)      wheel_tag=manylinux_2_17_x86_64.manylinux2014_x86_64; digest=d7f459fe4fd247d830351c75686d3996ace3c6f3f728eb0e85a30b7ada0cef19 ;;
    *) fail "请在 $os $arch 上预先安装 $tool，再点击修复。" ;;
  esac
  if [ "$tool" = node ]; then
    target="node-v24.19.0-$platform-$arch"
    url="https://nodejs.org/dist/v24.19.0/$target.tar.gz"
    member="$target/bin/node"
    destination="$TOOLS/node/bin/node"
  else
    url="https://files.pythonhosted.org/packages/py3/u/uv/uv-0.13.9-py3-none-$wheel_tag.whl"
    member="uv-0.13.9.data/scripts/uv"
    destination="$TOOLS/bin/uv"
  fi
  stage "正在下载并校验 ${tool}…"
  curl -fsSL --retry 2 --connect-timeout 15 --speed-time 45 --speed-limit 1024 -o "$STAGING/archive" "$url" || fail "下载 $tool 失败，请检查 $url 的网络连接。"
  if command -v sha256sum >/dev/null; then
    actual="$(sha256sum < "$STAGING/archive")"
  else
    actual="$(shasum -a 256 < "$STAGING/archive")"
  fi
  [ "${actual%% *}" = "$digest" ] || fail "$tool 下载校验失败，请再次点击修复。"
  if [ "$tool" = uv ]; then
    if command -v unzip >/dev/null; then
      unzip -p "$STAGING/archive" "$member" > "$STAGING/uv"
    elif command -v python3 >/dev/null; then
      python3 -c 'import sys, zipfile; sys.stdout.buffer.write(zipfile.ZipFile(sys.argv[1]).read(sys.argv[2]))' "$STAGING/archive" "$member" > "$STAGING/uv"
    else
      fail "解压 uv 需要 unzip 或 Python 3。"
    fi
    member=uv
    chmod 755 "$STAGING/uv"
  else
    tar -xzf "$STAGING/archive" -C "$STAGING" "$member"
  fi
  mkdir -p "$(dirname "$destination")"
  mv -f "$STAGING/$member" "$destination"
}

stage "正在寻找 Node.js 和 PDF 引擎…"
NODE=""
for candidate in "${CBR_NODE:-}" "$TOOLS/node/bin/node" "$(command -v node || true)" \
  "$HOME/.volta/bin/node" "$HOME/.nvm/current/bin/node" "$HOME"/.nvm/versions/node/*/bin/node; do
  if [ -x "$candidate" ] && "$candidate" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)' 2>/dev/null; then
    NODE="$candidate"
    break
  fi
done
if [ -z "$NODE" ]; then
  install_tool node
  NODE="$TOOLS/node/bin/node"
  "$NODE" --version >/dev/null || fail "Node.js 无法运行。请安装适合此系统的 Node.js 20+ 后重试。"
fi

engine_ready() {
  [ -x "$VENV/bin/pdf2zh_next" ] && "$VENV/bin/python" - "$PDF2ZH_VERSION" "$BABELDOC_VERSION" "$BITSTRING_VERSION" <<'PY' 2>/dev/null
import sys
from importlib.metadata import version
import pymupdf, babeldoc, pdf2zh_next
from bitstring import BitStream
sys.exit([version(name) for name in ("pdf2zh_next", "babeldoc", "bitstring")] != sys.argv[1:])
PY
}

if ! engine_ready; then
  requirements=("pdf2zh_next==$PDF2ZH_VERSION" "babeldoc==$BABELDOC_VERSION" "bitstring==$BITSTRING_VERSION")
  PYTHON=""
  for candidate in "$VENV/bin/python" python3.12 python3.11 python3.13 python3.10 python3; do
    if command -v "$candidate" >/dev/null && "$candidate" -c "import sys; sys.exit(not ((3, $MIN_PYTHON_MINOR) <= sys.version_info[:2] <= (3, $MAX_PYTHON_MINOR)))" 2>/dev/null; then
      PYTHON="$(command -v "$candidate")"
      break
    fi
  done
  UV="$(command -v uv || true)"
  if [ -z "$UV" ] && [ -x "$TOOLS/bin/uv" ]; then UV="$TOOLS/bin/uv"; fi
  if [ -z "$UV" ] && { [ -z "$PYTHON" ] || ! "$PYTHON" -m venv "$VENV"; }; then
    install_tool uv
    UV="$TOOLS/bin/uv"
  fi
  if [ -n "$UV" ]; then
    stage "正在准备 Python 虚拟环境…"
    if [ -z "$PYTHON" ]; then
      PYTHON="$("$UV" python find --no-python-downloads 3.12 2>/dev/null || true)"
      if [ -z "$PYTHON" ]; then
        export UV_PYTHON_INSTALL_DIR="$TOOLS/python" UV_PYTHON_BIN_DIR="$TOOLS/bin"
        PYTHON=3.12
      fi
    fi
    "$UV" venv --python "$PYTHON" --allow-existing "$VENV"
    stage "正在安装 PDF 引擎和排版依赖，首次下载可能需要几分钟…"
    "$UV" pip install --python "$VENV/bin/python" "${requirements[@]}"
  else
    stage "正在使用 pip 安装 PDF 引擎和排版依赖…"
    "$VENV/bin/python" -m pip install "${requirements[@]}"
  fi
  engine_ready || fail "依赖校验失败。请检查上方安装错误后重试。"
fi

stage "正在验证安装路径…"
"$VENV/bin/python" - "$RUNTIME_ROOT" "$NODE" <<'PY'
import json, sys
from pathlib import Path
root = Path(sys.argv[1])
print("INSTALL_JSON=" + json.dumps({
    "status": "ready", "launcher": str(root / "scripts/translate-preserved-pdf-cli.mjs"),
    "engine": str(root / ".venv/bin/pdf2zh_next"), "python": str(root / ".venv/bin/python"),
    "node": sys.argv[2],
}))
PY
