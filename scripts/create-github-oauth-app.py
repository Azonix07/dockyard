#!/usr/bin/env python3
"""Register a Runbase GitHub App via Manifest (one browser click).

Produces client_id + client_secret for Railway-style Connect GitHub OAuth.
"""
from __future__ import annotations

import json
import threading
import urllib.request
import webbrowser
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

PORT = 9876
REDIRECT = f"http://127.0.0.1:{PORT}/callback"
API_CALLBACK = "https://abhinand.tail8a4b6e.ts.net:8444/api/github/callback"
WEB_URL = "https://runbase.in"
CRED_FILE = Path("/tmp/runbase-github-app.json")

MANIFEST = {
    "name": "Runbase",
    "url": WEB_URL,
    "hook_attributes": {
        "url": "https://abhinand.tail8a4b6e.ts.net:8444/api/webhooks/github"
    },
    "redirect_url": REDIRECT,
    "callback_urls": [API_CALLBACK, REDIRECT],
    "setup_url": f"{WEB_URL}/new",
    "public": False,
    "default_permissions": {
        "contents": "read",
        "metadata": "read",
    },
    "default_events": ["push"],
}

INDEX_HTML = f"""<!doctype html>
<html>
<head><meta charset="utf-8"><title>Create Runbase GitHub App</title></head>
<body style="font-family:system-ui;padding:48px;background:#0b0f14;color:#e8edf2">
  <h1>Connect Runbase to GitHub</h1>
  <p>Click below (you may need to sign in to GitHub). This creates the app credentials
  so Runbase can use a Railway-style <b>Connect GitHub</b> button.</p>
  <form id="f" action="https://github.com/settings/apps/new" method="post">
    <input type="hidden" name="manifest" value='{json.dumps(MANIFEST)}'>
    <button type="submit" style="font-size:18px;padding:14px 22px;background:#e86d2f;color:#fff;border:0;border-radius:10px;cursor:pointer">
      Create GitHub App
    </button>
  </form>
  <script>setTimeout(() => document.getElementById('f').submit(), 400)</script>
</body>
</html>
"""

DONE = {"ok": False}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt: str, *args) -> None:  # noqa: A003
        return

    def do_GET(self) -> None:  # noqa: N802
        path = urlparse(self.path)
        if path.path == "/":
            body = INDEX_HTML.encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return

        if path.path == "/callback":
            q = parse_qs(path.query)
            code = (q.get("code") or [None])[0]
            if not code:
                self.send_response(400)
                self.end_headers()
                self.wfile.write(b"missing code - try again")
                return
            req = urllib.request.Request(
                f"https://api.github.com/app-manifests/{code}/conversions",
                data=b"",
                method="POST",
                headers={
                    "Accept": "application/vnd.github+json",
                    "User-Agent": "dockyard-setup",
                    "X-GitHub-Api-Version": "2022-11-28",
                },
            )
            with urllib.request.urlopen(req, timeout=60) as resp:
                data = json.load(resp)
            CRED_FILE.write_text(json.dumps(data, indent=2))
            DONE["ok"] = True
            body = (
                "<!doctype html><html><body style='font-family:system-ui;padding:48px;"
                "background:#0b0f14;color:#e8edf2'>"
                "<h1>GitHub App created</h1>"
                "<p>Credentials saved. Close this tab - Runbase setup continues automatically.</p>"
                "</body></html>"
            ).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            threading.Thread(target=self.server.shutdown, daemon=True).start()
            return

        self.send_response(404)
        self.end_headers()


def main() -> None:
    if CRED_FILE.exists():
        CRED_FILE.unlink()
    httpd = HTTPServer(("127.0.0.1", PORT), Handler)
    print(f"Listening on http://127.0.0.1:{PORT}/")
    print("Opening browser - sign into GitHub if needed, then confirm Create GitHub App.")
    webbrowser.open(f"http://127.0.0.1:{PORT}/")
    httpd.serve_forever()
    if not DONE["ok"] or not CRED_FILE.exists():
        raise SystemExit("GitHub App registration did not complete")
    data = json.loads(CRED_FILE.read_text())
    print("OK")
    print(f"  name:       {data.get('name')}")
    print(f"  client_id:  {data.get('client_id')}")
    print(f"  html_url:   {data.get('html_url')}")
    print(f"  saved:      {CRED_FILE}")


if __name__ == "__main__":
    main()
