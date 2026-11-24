#!/usr/bin/env python3
"""
Local server for the Cloudburst web app: static files + a pass-through for DHM requests (avoids browser CORS limits).

    python serve.py            # http://localhost:8123
    python serve.py 9000
    python serve.py --open     # also open the browser
    python serve.py --app      # open as an app window (Edge/Chrome --app), installable as a PWA

/proxy/datafordeler?...    → https://wcs.datafordeler.dk/DHMNedboer/dhm_wcs/1.0.0/WCS?...
/proxy/dataforsyningen?... → https://api.dataforsyningen.dk/dhm_wcs_DAF?...
/proxy/copernicus/<tile>/<tile>.tif → Copernicus DEM GLO-30 on AWS (no CORS there); Range requests are passed through
/proxy/overpass (POST)     → Overpass API (OpenStreetMap), first endpoint that answers
The API key is passed through as given by the browser and never stored or logged by this server. Only these fixed
upstreams are reachable (no open proxy).
"""
import http.server
import os
import re
import sys
import urllib.error
import urllib.request

UPSTREAM = {
    "/proxy/datafordeler": "https://wcs.datafordeler.dk/DHMNedboer/dhm_wcs/1.0.0/WCS",
    "/proxy/dataforsyningen": "https://api.dataforsyningen.dk/dhm_wcs_DAF",
}

COPERNICUS = "https://copernicus-dem-30m.s3.amazonaws.com"
COPERNICUS_PATH = re.compile(r"^/proxy/copernicus/(Copernicus_DSM_COG_10_[NS]\d\d_00_[EW]\d{3}_00_DEM)/\1\.tif$")
OVERPASS = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter"]


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, ".wasm": "application/wasm", ".js": "text/javascript", ".mjs": "text/javascript"}

    def do_GET(self):
        path, _, query = self.path.partition("?")
        if path == "/proxy/ping":
            return self._send(200, b"ok", "text/plain")
        m = COPERNICUS_PATH.match(path)
        if m:
            headers = {"User-Agent": "cloudburst-local/1.0"}
            if self.headers.get("Range"):
                headers["Range"] = self.headers["Range"]
            return self._relay(urllib.request.Request(COPERNICUS + path[len("/proxy/copernicus"):], headers=headers))
        if path in UPSTREAM:
            return self._relay(urllib.request.Request(UPSTREAM[path] + "?" + query, headers={"User-Agent": "cloudburst-local/1.0"}))
        return super().do_GET()

    def do_POST(self):
        if self.path.partition("?")[0] != "/proxy/overpass":
            return self._send(404, b"not found", "text/plain")
        n = int(self.headers.get("Content-Length") or 0)
        if n > 100_000:
            return self._send(413, b"query too large", "text/plain")
        body = self.rfile.read(n)
        last = None
        for url in OVERPASS:
            req = urllib.request.Request(url, data=body, headers={"User-Agent": "cloudburst-local/1.0", "Content-Type": "application/x-www-form-urlencoded"})
            try:
                with urllib.request.urlopen(req, timeout=120) as r:
                    return self._send(r.status, r.read(), r.headers.get("Content-Type", "application/json"))
            except Exception as e:  # busy / offline: try the next endpoint
                last = e
        return self._send(502, f"Overpass unavailable: {last}".encode(), "text/plain")

    def _relay(self, req):
        try:
            with urllib.request.urlopen(req, timeout=180) as r:
                extra = {"Content-Range": r.headers["Content-Range"]} if r.headers.get("Content-Range") else {}
                return self._send(r.status, r.read(), r.headers.get("Content-Type", "application/octet-stream"), extra)
        except urllib.error.HTTPError as e:
            return self._send(e.code, e.read(), e.headers.get("Content-Type", "text/plain"))
        except Exception as e:  # network
            return self._send(502, str(e).encode(), "text/plain")

    def _send(self, code, body, ctype, extra=None):
        self.send_response(code)
        for k, v in (extra or {}).items():
            self.send_header(k, v)
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


class Server(http.server.ThreadingHTTPServer):
    # On Windows SO_REUSEADDR lets two servers share a port; disable it so a busy port is detected.
    allow_reuse_address = os.name != "nt"
    daemon_threads = True


def open_browser(url, app):
    import shutil, subprocess, webbrowser
    if app:
        candidates = [
            os.path.expandvars(r"%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"),
            os.path.expandvars(r"%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"),
            os.path.expandvars(r"%ProgramFiles%\Google\Chrome\Application\chrome.exe"),
            shutil.which("msedge") or "", shutil.which("google-chrome") or "", shutil.which("chromium") or "",
        ]
        for exe in candidates:
            if exe and os.path.exists(exe):
                subprocess.Popen([exe, f"--app={url}", "--window-size=1500,950"])
                return
    webbrowser.open(url)


if __name__ == "__main__":
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    port = int(args[0]) if args else 8123
    server = None
    for p in range(port, port + 20):  # first free port
        try:
            server = Server(("", p), Handler)
            port = p
            break
        except OSError:
            continue
    if server is None:
        sys.exit(f"No free port in {port}..{port + 19}")
    url = f"http://localhost:{port}/"
    print(f"Cloudburst web app on {url}  (close this window or press Ctrl+C to stop)")
    if "--open" in sys.argv or "--app" in sys.argv:
        import threading
        threading.Timer(0.6, open_browser, args=(url, "--app" in sys.argv)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
