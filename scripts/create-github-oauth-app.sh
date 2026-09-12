#!/usr/bin/env bash
# One-click GitHub OAuth App registration for Runbase (Railway-style Connect).
# Opens GitHub App Manifest → you click Create → credentials land here automatically.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${MANIFEST_PORT:-9876}"
REDIRECT="http://127.0.0.1:${PORT}/callback"
STATE="runbase-$(date +%s)"

MANIFEST=$(python3 - <<'PY'
import json
print(json.dumps({
  "name": "Runbase",
  "url": "https://runbase.in",
  "hook_attributes": {"url": "https://abhinand.tail8a4b6e.ts.net:8444/api/webhooks/github"},
  "redirect_url": "http://127.0.0.1:9876/callback",
  "callback_urls": [
    "https://abhinand.tail8a4b6e.ts.net:8444/api/github/callback",
    "http://127.0.0.1:9876/callback"
  ],
  "setup_url": "https://runbase.in/new",
  "public": False,
  "default_permissions": {
    "contents": "read",
    "metadata": "read",
    "emails": "read"
  },
  "default_events": ["push"]
}))
PY
)

# Fix redirect_url port dynamically
MANIFEST=$(python3 - <<PY
import json
m = json.loads('''$MANIFEST''')
m["redirect_url"] = "$REDIRECT"
m["callback_urls"] = [
  "https://abhinand.tail8a4b6e.ts.net:8444/api/github/callback",
  "$REDIRECT",
]
print(json.dumps(m))
PY
)

HTML=$(python3 - <<PY
import html, json
manifest = '''$MANIFEST'''
print(f"""<!doctype html>
<html><body style="font-family:system-ui;padding:40px;background:#0b0f14;color:#e8edf2">
  <h1>Create Runbase GitHub App</h1>
  <p>This registers the OAuth credentials Railway-style Connect needs.</p>
  <form id="f" action="https://github.com/settings/apps/new?state={html.escape('$STATE')}" method="post">
    <input type="hidden" name="manifest" value="{html.escape(manifest)}">
    <button style="font-size:18px;padding:12px 20px;background:#e86d2f;color:#fff;border:0;border-radius:8px;cursor:pointer">
      Create GitHub App on GitHub
    </button>
  </form>
  <script>document.getElementById('f').submit()</script>
</body></html>""")
PY
)

python3 - <<PY
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlparse, parse_qs
import json, subprocess, os, sys, webbrowser, urllib.request

PORT = $PORT
STATE = "$STATE"
ROOT = "$ROOT"
CRED_FILE = "/tmp/runbase-github-app.json"
DONE = {"ok": False}

class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_GET(self):
        u = urlparse(self.path)
        if u.path == "/":
            body = """$HTML""".encode()
            # Fix: HTML has issues with embedding - serve from file instead
            self.send_response(200)
            self.send_header("Content-Type", "text/html")
            self.end_headers()
            self.wfile.write(open("/tmp/dockyard-manifest.html","rb").read())
            return
        if u.path == "/callback":
            q = parse_qs(u.query)
            code = (q.get("code") or [None])[0]
            if not code:
                self.send_response(400)
                self.end_headers()
                self.wfile.write(b"missing code")
                return
            req = urllib.request.Request(
                f"https://api.github.com/app-manifests/{code}/conversions",
                data=b"",
                method="POST",
                headers={"Accept": "application/vnd.github+json", "User-Agent": "dockyard"},
            )
            with urllib.request.urlopen(req) as resp:
                data = json.load(resp)
            open(CRED_FILE, "w").write(json.dumps(data, indent=2))
            DONE["ok"] = True
            html = b"""<!doctype html><html><body style='font-family:system-ui;padding:40px;background:#0b0f14;color:#e8edf2'>
              <h1>Runbase connected to GitHub</h1>
              <p>Credentials saved. You can close this tab — setup continues in the terminal.</p>
              </body></html>"""
            self.send_response(200)
            self.send_header("Content-Type", "text/html")
            self.end_headers()
            self.wfile.write(html)
            # shutdown soon
            import threading
            threading.Thread(target=self.server.shutdown, daemon=True).start()
            return
        self.send_response(404)
        self.end_headers()

open("/tmp/dockyard-manifest.html","w").write("""$HTML""")
httpd = HTTPServer(("127.0.0.1", PORT), H)
print(f"Open http://127.0.0.1:{PORT}/  (auto-opens)")
print("Log into GitHub if asked, then click Create GitHub App.")
webbrowser.open(f"http://127.0.0.1:{PORT}/")
httpd.serve_forever()
if not DONE["ok"] and not os.path.exists(CRED_FILE):
    print("No credentials received", file=sys.stderr)
    sys.exit(1)
print(f"Saved {CRED_FILE}")
PY
