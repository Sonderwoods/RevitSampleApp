#!/usr/bin/env python3
"""
Local server for the Cloudburst web app: static files + a pass-through for DHM requests (avoids browser CORS limits).

    python serve.py            # http://localhost:8123
    python serve.py 9000

/proxy/datafordeler?...    → https://wcs.datafordeler.dk/DHMNedboer/dhm_wcs/1.0.0/WCS?...
/proxy/dataforsyningen?... → https://api.dataforsyningen.dk/dhm_wcs_DAF?...
The API key is passed through as given by the browser and never stored or logged by this server.
"""
import http.server
import os
import sys
import urllib.error
import urllib.request

UPSTREAM = {
    "/proxy/datafordeler": "https://wcs.datafordeler.dk/DHMNedboer/dhm_wcs/1.0.0/WCS",
    "/proxy/dataforsyningen": "https://api.dataforsyningen.dk/dhm_wcs_DAF",
}


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, ".wasm": "application/wasm", ".js": "text/javascript", ".mjs": "text/javascript"}

    def do_GET(self):
        path, _, query = self.path.partition("?")
        if path == "/proxy/ping":
            return self._send(200, b"ok", "text/plain")
        if path in UPSTREAM:
            req = urllib.request.Request(UPSTREAM[path] + "?" + query, headers={"User-Agent": "cloudburst-local/1.0"})
            try:
                with urllib.request.urlopen(req, timeout=180) as r:
                    return self._send(r.status, r.read(), r.headers.get("Content-Type", "application/octet-stream"))
            except urllib.error.HTTPError as e:
                return self._send(e.code, e.read(), e.headers.get("Content-Type", "text/plain"))
            except Exception as e:  # network
                return self._send(502, str(e).encode(), "text/plain")
        return super().do_GET()

    def _send(self, code, body, ctype):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        msg = fmt % args
        if "/proxy/" in msg:  # never log keys
            msg = msg.split("?")[0] + "?…"
        sys.stderr.write(f"{self.address_string()} {msg}\n")


if __name__ == "__main__":
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8123
    print(f"Cloudburst web app on http://localhost:{port}  (Ctrl+C to stop)")
    http.server.ThreadingHTTPServer(("", port), Handler).serve_forever()
