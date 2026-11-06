"""Serve a directory on 127.0.0.1 for the install.sh tests.

    python3 -I serve.py <root> <port-file> <log-file>

Binds a free port, writes it to <port-file> once listening, and appends each
request's path to <log-file>.
"""

import functools
import http.server
import sys

root, port_file, log_file = sys.argv[1:4]


class Handler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, format, *args):
        with open(log_file, "a") as log:
            log.write(self.path + "\n")


server = http.server.ThreadingHTTPServer(
    ("127.0.0.1", 0), functools.partial(Handler, directory=root)
)
with open(port_file, "w") as f:
    f.write(str(server.server_address[1]))
server.serve_forever()
