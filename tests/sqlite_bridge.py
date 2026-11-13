#!/usr/bin/env python3
"""A throwaway SQLite-over-HTTP bridge so `src/db.js` can be tested against a real
database engine.

Why: D1 *is* SQLite, but Node 20 has no in-process SQLite binding and `npm install` does not
work in this sandbox, so the alternative was to test `d1Store` against a hand-written fake —
which would prove that my fake agrees with my code and nothing about the SQL. Instead the
Worker's store runs against Python's sqlite3 module, which is the same engine D1 uses.

This is test tooling. It is not deployed, serves only localhost, and refuses to run against
a file that already exists unless told to.
"""
import argparse
import json
import sqlite3
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

LOCK = threading.Lock()


class Handler(BaseHTTPRequestHandler):
    # A file, not ":memory:": a new sqlite3 connection per request would otherwise get a
    # fresh empty database each time, and the test would fail in a way that looks like a
    # missing table rather than a bug in the harness.
    db_path = ":memory:"
    schema = ""

    def log_message(self, *args):  # silence per-request logging
        pass

    def _conn(self):
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        return conn

    def do_POST(self):
        length = int(self.headers.get("content-length") or 0)
        payload = json.loads(self.rfile.read(length) or b"{}")
        sql = payload.get("sql", "")
        params = payload.get("params") or []
        kind = payload.get("kind", "all")
        out = {"ok": True}
        try:
            with LOCK:
                conn = self._conn()
                try:
                    cur = conn.execute(sql, params)
                    if kind == "run":
                        conn.commit()
                        out["changes"] = cur.rowcount
                        out["last_row_id"] = cur.lastrowid
                    elif kind == "first":
                        row = cur.fetchone()
                        out["row"] = dict(row) if row is not None else None
                    else:
                        out["rows"] = [dict(r) for r in cur.fetchall()]
                finally:
                    conn.close()
        except Exception as exc:  # report, do not crash the bridge
            out = {"ok": False, "error": f"{type(exc).__name__}: {exc}"}
        body = json.dumps(out).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def serve(schema_path: str, port: int = 0):
    import os
    import tempfile
    Handler.schema = open(schema_path).read()
    fd, path = tempfile.mkstemp(suffix=".sqlite3")
    os.close(fd)
    Handler.db_path = path
    conn = sqlite3.connect(Handler.db_path)
    conn.executescript(Handler.schema)
    conn.commit()
    conn.close()
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    server.db_file = path
    return server


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--schema", default="schema.sql")
    ap.add_argument("--port", type=int, default=8799)
    args = ap.parse_args()
    srv = serve(args.schema, args.port)
    print(f"bridge on http://127.0.0.1:{srv.server_address[1]}", flush=True)
    threading.Event().wait()
