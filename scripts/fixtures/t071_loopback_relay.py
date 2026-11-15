#!/usr/bin/env python3
import argparse
import ipaddress
import json
import os
import selectors
import signal
import socket
import socketserver
import stat
import sys

ALLOWED_PORTS = {5432, 6379, 9000, 8080, 8069}


def fail(message: str) -> None:
    print(f"FAIL: {message}", file=sys.stderr)
    raise SystemExit(1)


def load_config(path: str) -> dict:
    metadata = os.stat(path, follow_symlinks=False)
    if not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != os.geteuid() or stat.S_IMODE(metadata.st_mode) != 0o600:
        fail("relay config must be an owner-only regular file")
    with open(path, encoding="utf-8") as source:
        config = json.load(source)
    target = ipaddress.ip_address(config.get("targetIp", ""))
    network = ipaddress.ip_network(config.get("subnet", ""), strict=False)
    port = config.get("targetPort")
    if target.version != 4 or network.version != 4 or target not in network or target in (network.network_address, network.broadcast_address):
        fail("relay target is not a usable address in the owned Docker subnet")
    if not target.is_private or port not in ALLOWED_PORTS:
        fail("relay target or port is outside the fixture allowlist")
    ready = config.get("readyFile")
    if not isinstance(ready, str) or not os.path.isabs(ready):
        fail("relay ready file must be absolute")
    parent = os.stat(os.path.dirname(ready), follow_symlinks=False)
    if not stat.S_ISDIR(parent.st_mode) or parent.st_uid != os.geteuid() or stat.S_IMODE(parent.st_mode) & 0o077:
        fail("relay ready directory must be owner-only")
    return {"target": str(target), "port": port, "ready": ready}


class Relay(socketserver.ThreadingTCPServer):
    allow_reuse_address = False
    daemon_threads = True


class Handler(socketserver.BaseRequestHandler):
    def handle(self) -> None:
        try:
            upstream = socket.create_connection(self.server.target, timeout=5)
        except OSError:
            return
        with upstream:
            sockets = (self.request, upstream)
            selector = selectors.DefaultSelector()
            for sock in sockets:
                sock.setblocking(False)
                selector.register(sock, selectors.EVENT_READ)
            while True:
                events = selector.select(timeout=30)
                if not events:
                    continue
                for key, _ in events:
                    source = key.fileobj
                    destination = upstream if source is self.request else self.request
                    try:
                        data = source.recv(65536)
                        if not data:
                            return
                        destination.sendall(data)
                    except OSError:
                        return


def main() -> None:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--validate-only", action="store_true")
    args = parser.parse_args()
    config_path = os.environ.get("T071_RELAY_CONFIG")
    if not config_path:
        fail("T071_RELAY_CONFIG is required")
    config = load_config(config_path)
    if args.validate_only:
        print("PASS: T071 relay configuration is valid.")
        return
    with Relay(("127.0.0.1", 0), Handler) as server:
        server.target = (config["target"], config["port"])
        leader_text = os.environ.get("KEMFAI_OWNED_SESSION_LEADER", "")
        try:
            leader_pid = int(leader_text)
        except ValueError:
            fail("owned session leader identity is invalid")
        if leader_pid <= 0 or leader_pid != os.getsid(0):
            fail("owned session leader identity does not match the relay session")
        payload = json.dumps({"pid": leader_pid, "port": server.server_address[1]}) + "\n"
        descriptor = os.open(config["ready"], os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as ready:
            ready.write(payload)
            ready.flush()
            os.fsync(ready.fileno())
        def stop(*_args) -> None:
            raise KeyboardInterrupt

        signal.signal(signal.SIGTERM, stop)
        try:
            server.serve_forever(poll_interval=0.2)
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()
