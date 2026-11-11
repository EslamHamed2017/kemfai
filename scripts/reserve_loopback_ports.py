#!/usr/bin/env python3
"""Reserve seven unique high loopback ports until the owned runner releases each one."""

import json
import random
import socket
import sys

NAMES = ("pg", "redis", "keycloak", "odoo", "api", "frontend", "fault-control")
sockets: dict[str, socket.socket] = {}

for name in NAMES:
    for port in random.sample(range(20000, 60000), 40000):
        candidate = socket.socket()
        try:
            candidate.bind(("127.0.0.1", port))
        except OSError:
            candidate.close()
            continue
        sockets[name] = candidate
        break
    else:
        raise RuntimeError(f"could not reserve a loopback port for {name}")

print(json.dumps({name: sock.getsockname()[1] for name, sock in sockets.items()}), flush=True)
for line in sys.stdin:
    command = line.strip().split()
    if len(command) != 2 or command[0] != "release" or command[1] not in sockets:
        print("error", flush=True)
        continue
    name = command[1]
    sockets.pop(name).close()
    print(f"released {name}", flush=True)

for reserved in sockets.values():
    reserved.close()
