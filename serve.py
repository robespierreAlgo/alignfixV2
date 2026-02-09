from http.server import SimpleHTTPRequestHandler, HTTPServer

class COEPRequestHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        super().end_headers()

PORT = 8000
server_address = ("127.0.0.1", PORT)
httpd = HTTPServer(server_address, COEPRequestHandler)
print(f"Serving at http://127.0.0.1:{PORT}")
httpd.serve_forever()
