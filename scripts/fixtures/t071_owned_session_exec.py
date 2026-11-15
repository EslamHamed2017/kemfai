#!/usr/bin/env python3
"""Establish an owned session before sanitizing and executing a fixture service."""
import os
import sys

os.setsid()
args = sys.argv[1:]
keep = {"PATH", "HOME", "PLAYWRIGHT_BROWSERS_PATH"}
if len(args) >= 2 and args[0] == "--keep-env":
    keep.update(filter(None, args[1].split(",")))
    args = args[2:]
if len(args) >= 2 and args[0] == "--cwd":
    os.chdir(args[1])
    args = args[2:]
if not args:
    raise SystemExit("usage: t071_owned_session_exec.py [--keep-env NAMES] [--cwd DIR] COMMAND [ARG ...]")
for name in tuple(os.environ):
    if name not in keep:
        del os.environ[name]
os.execvp(args[0], args)
