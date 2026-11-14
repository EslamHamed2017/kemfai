#!/usr/bin/env python3
"""Exact-owned, loopback-only Story 2 Odoo fault controller."""
import argparse
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.request import Request, urlopen

KEY = "kemfai.accounting.test_fault_mode"
ALLOWED = {None, "tenant-audit-create-failure"}

def rpc(url, service, method, args):
    data = json.dumps({"jsonrpc":"2.0","method":"call","params":{"service":service,"method":method,"args":args},"id":1}).encode()
    with urlopen(Request(url + "/jsonrpc", data=data, headers={"content-type":"application/json"}), timeout=30) as response:
        body = json.load(response)
    if body.get("error"): raise RuntimeError("Odoo fault-control RPC failed")
    return body.get("result")

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--odoo-url", required=True)
    parser.add_argument("--login", required=True)
    parser.add_argument("--password", required=True)
    parser.add_argument("--database", action="append", required=True)
    args=parser.parse_args()
    def set_mode(mode):
        if mode not in ALLOWED: raise ValueError("unsupported fault mode")
        for database in args.database:
            uid=rpc(args.odoo_url,"common","authenticate",[database,args.login,args.password,{}])
            if not uid: raise RuntimeError("fault-control authentication failed")
            rpc(args.odoo_url,"object","execute_kw",[database,uid,args.password,"ir.config_parameter","set_param",[KEY,mode or False],{}])
        print(f"fault={mode or 'none'} databases={len(args.database)}", flush=True)
    class Handler(BaseHTTPRequestHandler):
        def send_json(self,status,payload):
            data=json.dumps(payload).encode(); self.send_response(status); self.send_header("content-type","application/json"); self.send_header("content-length",str(len(data))); self.end_headers(); self.wfile.write(data)
        def do_GET(self):
            self.send_json(200,{"ready":True}) if self.path=="/health" else self.send_json(404,{"error":"not found"})
        def do_PUT(self):
            if self.path != "/fault": return self.send_json(404,{"error":"not found"})
            try:
                length=int(self.headers.get("content-length","0")); payload=json.loads(self.rfile.read(length) or b"{}"); set_mode(payload.get("mode")); self.send_json(200,{"accepted":True})
            except ValueError as error: self.send_json(400,{"error":str(error)})
            except Exception: self.send_json(503,{"error":"fault control unavailable"})
        def log_message(self, *_): pass
    server = ThreadingHTTPServer(("127.0.0.1",args.port),Handler)
    print(f"ready host=127.0.0.1 port={args.port} databases={len(args.database)}", flush=True)
    server.serve_forever()
if __name__ == "__main__": main()
