#!/usr/bin/env python3
"""Reject literal Docker container removals which omit anonymous-volume cleanup.

Default discovery uses Git's tracked plus untracked/nonignored authored files and
explicitly excludes dependency, generated, cache, and scratch trees. Shell logical
lines and literal Python subprocess/os.system calls are covered. This is intentionally
not a complete shell/Python data-flow parser: aliases, wrappers, eval/generated code,
and dynamically assembled commands must call lib_docker_test_cleanup.sh instead.
"""
from __future__ import annotations

import ast
import pathlib
import shlex
import subprocess
import sys

REPO = pathlib.Path(__file__).resolve().parent.parent
BOUNDARY_CHARS = frozenset(";&|()")
EXCLUDED_PARTS = frozenset(
    {".git", "node_modules", "vendor", "dist", "build", "coverage", ".cache", "cache",
     "tmp", "temp", "scratch", "generated", "__pycache__", ".venv", "venv"}
)
VALUE_GLOBAL_OPTIONS = frozenset({"--config", "--context", "--host", "-H", "--log-level"})
FLAG_GLOBAL_OPTIONS = frozenset(
    {"--debug", "-D", "--tls", "--tlsverify", "--help", "-h", "--version", "-v"}
)


def authored_files() -> list[pathlib.Path]:
    if len(sys.argv) > 1:
        return [pathlib.Path(value).resolve() for value in sys.argv[1:]]
    output = subprocess.run(
        ["git", "ls-files", "--cached", "--others", "--exclude-standard", "--", "*.sh", "*.py"],
        cwd=REPO, check=True, text=True, capture_output=True,
    ).stdout.splitlines()
    return sorted(
        REPO / value for value in output
        if not any(part in EXCLUDED_PARTS for part in pathlib.PurePosixPath(value).parts)
    )


def logical_lines(text: str):
    pending = ""
    start = 1
    for number, line in enumerate(text.splitlines(), 1):
        if not pending:
            start = number
        pending += line
        if pending.rstrip().endswith("\\"):
            pending = pending.rstrip()[:-1] + " "
            continue
        yield start, pending
        pending = ""
    if pending:
        yield start, pending


def is_boundary(token: str) -> bool:
    return bool(token) and all(character in BOUNDARY_CHARS for character in token)


def docker_command_index(tokens: list[str], docker_index: int) -> int | None:
    index = docker_index + 1
    while index < len(tokens):
        token = tokens[index]
        if is_boundary(token) or token == "--":
            return None
        if token in VALUE_GLOBAL_OPTIONS:
            index += 2
            continue
        if any(token.startswith(option + "=") for option in VALUE_GLOBAL_OPTIONS if option.startswith("--")):
            index += 1
            continue
        if token in FLAG_GLOBAL_OPTIONS:
            index += 1
            continue
        return index
    return None


def removal_commands(tokens: list[str]):
    for index, token in enumerate(tokens):
        if token != "docker":
            continue
        command = docker_command_index(tokens, index)
        if command is None:
            continue
        if tokens[command] == "rm":
            argument_start = command + 1
        elif tokens[command:command + 2] == ["container", "rm"]:
            argument_start = command + 2
        else:
            continue
        arguments = []
        for argument in tokens[argument_start:]:
            if is_boundary(argument):
                break
            arguments.append(argument)
        yield arguments


def safe_removal(arguments: list[str]) -> bool:
    for argument in arguments:
        if argument == "--":
            return False
        if argument == "--volumes" or (
            argument.startswith("-") and not argument.startswith("--") and "v" in argument[1:]
        ):
            return True
    return False


def tokenize(line: str) -> list[str]:
    lexer = shlex.shlex(line, posix=True, punctuation_chars=";&|()")
    lexer.whitespace_split = True
    lexer.commenters = "#"
    return list(lexer)


def literal_command(node: ast.AST) -> list[str] | None:
    if isinstance(node, (ast.List, ast.Tuple)):
        values = []
        for item in node.elts:
            if not isinstance(item, ast.Constant) or not isinstance(item.value, str):
                return None
            values.append(item.value)
        return values
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        try:
            return tokenize(node.value)
        except ValueError:
            return []
    return None


def python_removals(tree: ast.AST):
    subprocess_names = {"run", "Popen", "check_call", "check_output"}
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call) or not node.args:
            continue
        function = node.func
        supported = (
            isinstance(function, ast.Attribute)
            and isinstance(function.value, ast.Name)
            and ((function.value.id == "subprocess" and function.attr in subprocess_names)
                 or (function.value.id == "os" and function.attr == "system"))
        )
        if not supported:
            continue
        tokens = literal_command(node.args[0])
        if tokens is None:
            continue
        for arguments in removal_commands(tokens):
            yield node.lineno, arguments


def inspect_file(path: pathlib.Path) -> list[str]:
    failures = []
    try:
        content = path.read_text(encoding="utf-8")
    except (OSError, UnicodeError) as error:
        return [f"{path}: unable to inspect: {error}"]
    if path.suffix == ".sh":
        for line_number, line in logical_lines(content):
            if "docker" not in line or "rm" not in line:
                continue
            try:
                commands = removal_commands(tokenize(line))
                for arguments in commands:
                    if not safe_removal(arguments):
                        failures.append(f"{path}:{line_number}: Docker container removal must include -v/--volumes before --")
            except ValueError as error:
                failures.append(f"{path}:{line_number}: cannot parse Docker removal line: {error}")
    elif path.suffix == ".py":
        try:
            tree = ast.parse(content, filename=str(path))
        except SyntaxError as error:
            return [f"{path}:{error.lineno}: cannot parse Python source: {error.msg}"]
        for line_number, arguments in python_removals(tree):
            if not safe_removal(arguments):
                failures.append(f"{path}:{line_number}: literal Python Docker removal must include -v/--volumes before --")
    return failures


files = authored_files()
failures = [failure for path in files for failure in inspect_file(path)]
if failures:
    print("Docker test cleanup gate FAILED:", file=sys.stderr)
    print("\n".join(f"  {failure}" for failure in failures), file=sys.stderr)
    raise SystemExit(1)
counts = {suffix: sum(path.suffix == suffix for path in files) for suffix in (".sh", ".py")}
print(f"Docker test cleanup gate passed ({counts['.sh']} shell and {counts['.py']} Python authored files scanned under {REPO}).")
