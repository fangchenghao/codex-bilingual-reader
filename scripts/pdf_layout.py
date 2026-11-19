"""Adapt PDFMathTranslate's loopback Chat Completions requests to the batch broker."""
import asyncio
import hmac
import json
import threading
import time
from uuid import uuid4
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


def layout_fragments(prompt):
    # Both pinned BabelDOC versions end a layout request with this JSON array.
    # Leave single-paragraph fallback prompts and unfamiliar formats intact.
    instructions, separator, source = prompt.rpartition("## Here is the input:\n")
    if not separator:
        return None
    try:
        rows = json.loads(source)
    except ValueError:
        return None
    if not isinstance(rows, list) or not rows or not all(
        isinstance(row, dict) and type(row.get("id")) is int and isinstance(row.get("input"), str)
        for row in rows
    ) or len({row["id"] for row in rows}) != len(rows):
        return None
    # With a custom glossary, forward the engine's full instructions as supplied.
    if "## Glossary Tables" in instructions:
        return None
    titles = instructions.partition("## Contextual Hints for Better Translation\n")[2].split("\n\n", 1)[0].strip()
    items = []
    for index, row in enumerate(rows):
        context = {
            "titles": titles[:320],
            "previous": rows[index - 1]["input"][-480:] if index else "",
            "next": rows[index + 1]["input"][:480] if index + 1 < len(rows) else "",
            "layout": row.get("layout_label"),
            "formula_hints": row.get("formula_placeholders_hint"),
        }
        items.append((row["id"], row["input"], {key: value for key, value in context.items() if value}))
    return items


def start_layout_server(token, complete):
    loop = asyncio.get_running_loop()

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            if self.path != "/v1/chat/completions":
                return self.send_error(404)
            if not hmac.compare_digest(self.headers.get("Authorization", ""), f"Bearer {token}"):
                return self.send_error(401)
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if not 0 < length <= 4 * 1024 * 1024:
                    return self.send_error(413)
                body = json.loads(self.rfile.read(length))
                prompt = body["messages"][0]["content"]
                if len(body["messages"]) != 1 or not isinstance(prompt, str):
                    raise ValueError("Expected one text message from the PDF engine")
            except (KeyError, IndexError, TypeError, ValueError) as error:
                return self.send_error(400, str(error))
            try:
                answer = asyncio.run_coroutine_threadsafe(complete(prompt), loop).result()
                payload = {
                    "id": f"chatcmpl-{uuid4().hex}",
                    "object": "chat.completion",
                    "created": int(time.time()),
                    "model": body.get("model"),
                    "choices": [{"index": 0, "finish_reason": "stop", "message": {"role": "assistant", "content": answer}}],
                }
                status = 200
            except Exception as error:
                status, payload = 502, {"error": {"message": str(error)}}
            data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server
