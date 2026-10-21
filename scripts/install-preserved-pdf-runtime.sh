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

VENV="$RUNTIME_ROOT/.venv"
LOG_PREFIX="[codex-bilingual]"

log() { echo "$LOG_PREFIX $*"; }
fail() { echo "$LOG_PREFIX ERROR: $*" >&2; exit 1; }

# A system proxy pointed at a stopped client turns every download into a
# timeout. Only override when the user has not configured a proxy explicitly.
if [ -z "${HTTP_PROXY:-}${HTTPS_PROXY:-}${ALL_PROXY:-}${http_proxy:-}${https_proxy:-}${all_proxy:-}" ]; then
  export NO_PROXY="*"
fi
# HuggingFace is unreachable from mainland China; BabelDOC pulls its layout
# model from there on first run.
export HF_ENDPOINT="${HF_ENDPOINT:-https://hf-mirror.com}"

python_minor_version() {
  "$1" -c 'import sys; print(sys.version_info.major, sys.version_info.minor)' 2>/dev/null || true
}

python_is_supported() {
  local version major minor
  version="$(python_minor_version "$1")" || return 1
  [ -n "$version" ] || return 1
  major="${version%% *}"
  minor="${version##* }"
  [ "$major" = "3" ] || return 1
  [ "$minor" -ge "$MIN_PYTHON_MINOR" ] 2>/dev/null || return 1
  [ "$minor" -le "$MAX_PYTHON_MINOR" ] 2>/dev/null || return 1
  return 0
}

PYTHON=""
for candidate in \
  /opt/homebrew/bin/python3.13 \
  /opt/homebrew/bin/python3.12 \
  /opt/homebrew/bin/python3.11 \
  /opt/homebrew/bin/python3.10 \
  /usr/local/bin/python3.13 \
  /usr/local/bin/python3.12 \
  /usr/local/bin/python3.11 \
  /usr/local/bin/python3.10 \
  /usr/bin/python3 \
  python3.12 python3.13 python3.11 python3.10 python3; do
  if command -v "$candidate" >/dev/null 2>&1 && python_is_supported "$candidate"; then
    PYTHON="$candidate"
    break
  fi
done

log "runtime root: $RUNTIME_ROOT"
mkdir -p "$RUNTIME_ROOT"

install_with_uv() {
  local uv="$1"
  log "using uv at $uv"
  "$uv" venv --python 3.12 --allow-existing "$VENV" || return 1
  "$uv" pip install --python "$VENV/bin/python" \
    "pdf2zh_next==${PDF2ZH_VERSION}" \
    "babeldoc==${BABELDOC_VERSION}" \
    "bitstring==${BITSTRING_VERSION}" || return 1
}

install_with_pip() {
  local python="$1"
  log "using python at $python ($(python_minor_version "$python"))"
  "$python" -m venv "$VENV" || fail "无法创建虚拟环境（$python -m venv）"
  "$VENV/bin/python" -m pip install --upgrade pip >/dev/null 2>&1 || true
  "$VENV/bin/python" -m pip install \
    "pdf2zh_next==${PDF2ZH_VERSION}" \
    "babeldoc==${BABELDOC_VERSION}" \
    "bitstring==${BITSTRING_VERSION}" || return 1
}

installed=0
if command -v uv >/dev/null 2>&1; then
  log "installing pdf2zh_next ${PDF2ZH_VERSION} + babeldoc ${BABELDOC_VERSION} with uv"
  if install_with_uv "$(command -v uv)"; then installed=1; fi
fi
if [ "$installed" -ne 1 ]; then
  if [ -z "$PYTHON" ]; then
    fail "未找到 Python 3.${MIN_PYTHON_MINOR}-3.${MAX_PYTHON_MINOR}。请安装 Homebrew Python（brew install python@3.12）或 uv（brew install uv）后重试。"
  fi
  log "installing pdf2zh_next ${PDF2ZH_VERSION} + babeldoc ${BABELDOC_VERSION} with pip"
  install_with_pip "$PYTHON" || fail "依赖安装失败，请检查网络后重试。"
fi

[ -x "$VENV/bin/pdf2zh_next" ] || fail "安装完成但未找到 $VENV/bin/pdf2zh_next"
"$VENV/bin/python" -c "from bitstring import BitStream; import pdf2zh_next, babeldoc" \
  || fail "依赖校验失败：pdf2zh_next / babeldoc / bitstring 无法导入"

log "engine: $VENV/bin/pdf2zh_next"
log "python: $VENV/bin/python"

NODE=""
for candidate in /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node "$HOME/.volta/bin/node" "$HOME/.nvm/current/bin/node"; do
  if [ -x "$candidate" ]; then NODE="$candidate"; break; fi
done
if [ -z "$NODE" ] && command -v node >/dev/null 2>&1; then NODE="$(command -v node)"; fi
if [ -z "$NODE" ]; then
  echo "$LOG_PREFIX WARNING: 未找到 node，稍后请在设置中手动指定 Node 路径。" >&2
fi

# The add-on parses a single INSTALL_JSON line, mirroring the PowerShell installer.
printf 'INSTALL_JSON={"status":"ready","launcher":"%s","engine":"%s","python":"%s","node":"%s"}\n' \
  "$RUNTIME_ROOT/scripts/translate-preserved-pdf-cli.mjs" \
  "$VENV/bin/pdf2zh_next" \
  "$VENV/bin/python" \
  "$NODE"
