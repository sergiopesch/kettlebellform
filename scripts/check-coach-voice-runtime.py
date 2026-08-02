#!/usr/bin/env python3
"""Validate the production voice generator's authenticated runtime boundary."""

from __future__ import annotations

import argparse
import ast
import hashlib
import json
import os
import re
import sys
from pathlib import Path


REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
DIRECT_REQUIREMENTS = REPOSITORY_ROOT / "requirements/voice-generation.in"
RUNTIME_LOCK = REPOSITORY_ROOT / "requirements/voice-generation.lock"
RUNTIME_MANIFEST = REPOSITORY_ROOT / "requirements/voice-runtime.json"
GENERATOR = REPOSITORY_ROOT / "scripts/generate-coach-voice-raw.py"
REFERENCE_GENERATOR = REPOSITORY_ROOT / "scripts/generate-coach-voice-references.py"
WRAPPER = REPOSITORY_ROOT / "scripts/run-coach-voice-generation.py"
DOCUMENTATION = REPOSITORY_ROOT / "docs/VOICE_PACK.md"
EXPECTED_PYTHON = "3.12.13"
EXPECTED_MANAGED_PYTHON_RELATIVE = (
    ".local/share/uv/python/cpython-3.12.13-macos-aarch64-none/bin/python3.12"
)
EXPECTED_DIRECT_PACKAGES = {
    "huggingface-hub",
    "mlx",
    "mlx-audio",
    "numpy",
    "safetensors",
    "soundfile",
    "tokenizers",
    "transformers",
}
HASH_PATTERN = re.compile(r"--hash=sha256:([0-9a-f]{64})(?:\s*\\)?$")
REQUIREMENT_PATTERN = re.compile(
    r"^([A-Za-z0-9_.-]+)==([^\s;\\]+)(?:\s*\\)?$"
)


def canonical_name(name: str) -> str:
    return re.sub(r"[-_.]+", "-", name).lower()


def parse_direct_requirements(path: Path) -> tuple[dict[str, str], list[str]]:
    failures: list[str] = []
    packages: dict[str, str] = {}
    if not path.is_file():
        return packages, [f"missing direct requirements: {path.relative_to(REPOSITORY_ROOT)}"]
    for number, raw_line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        match = REQUIREMENT_PATTERN.fullmatch(line)
        if not match:
            failures.append(f"direct requirement line {number} is not an exact pin: {line}")
            continue
        name = canonical_name(match.group(1))
        if name in packages:
            failures.append(f"duplicate direct requirement: {name}")
        packages[name] = match.group(2)
    if set(packages) != EXPECTED_DIRECT_PACKAGES:
        failures.append(
            "direct package set mismatch: expected "
            f"{sorted(EXPECTED_DIRECT_PACKAGES)}, got {sorted(packages)}"
        )
    return packages, failures


def parse_hashed_lock(path: Path) -> tuple[dict[str, str], int, list[str]]:
    failures: list[str] = []
    packages: dict[str, str] = {}
    hashes_by_package: dict[str, set[str]] = {}
    if not path.is_file():
        return packages, 0, [f"missing runtime lock: {path.relative_to(REPOSITORY_ROOT)}"]

    active_package: str | None = None
    for number, raw_line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        stripped = raw_line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        if raw_line[0].isspace():
            hash_match = HASH_PATTERN.fullmatch(stripped)
            if hash_match and active_package:
                digest = hash_match.group(1)
                if digest == "0" * 64:
                    failures.append(f"placeholder SHA-256 for {active_package} at line {number}")
                hashes_by_package[active_package].add(digest)
            elif not stripped.startswith("#"):
                failures.append(f"unsupported lock continuation at line {number}: {stripped}")
            continue

        match = REQUIREMENT_PATTERN.fullmatch(stripped)
        if not match:
            failures.append(f"lock line {number} is not an exact registry pin: {stripped}")
            active_package = None
            continue
        active_package = canonical_name(match.group(1))
        if active_package in packages:
            failures.append(f"duplicate locked requirement: {active_package}")
        packages[active_package] = match.group(2)
        hashes_by_package[active_package] = set()

    for package in packages:
        if not hashes_by_package[package]:
            failures.append(f"locked requirement has no SHA-256: {package}=={packages[package]}")
    return packages, sum(len(items) for items in hashes_by_package.values()), failures


def is_main_guard(node: ast.stmt) -> bool:
    if not isinstance(node, ast.If) or not isinstance(node.test, ast.Compare):
        return False
    return (
        isinstance(node.test.left, ast.Name)
        and node.test.left.id == "__name__"
        and len(node.test.ops) == 1
        and isinstance(node.test.ops[0], ast.Eq)
        and len(node.test.comparators) == 1
        and isinstance(node.test.comparators[0], ast.Constant)
        and node.test.comparators[0].value == "__main__"
    )


def imported_roots(node: ast.AST) -> list[str]:
    if isinstance(node, ast.Import):
        return [alias.name.split(".", 1)[0] for alias in node.names]
    if isinstance(node, ast.ImportFrom) and node.module:
        return [node.module.split(".", 1)[0]]
    return []


def check_generator(lock_digest: str) -> list[str]:
    failures: list[str] = []
    source = GENERATOR.read_text(encoding="utf-8")
    tree = ast.parse(source, filename=GENERATOR.as_posix())
    stdlib = set(getattr(sys, "stdlib_module_names", ())) | {
        "__future__",
        "argparse",
        "datetime",
        "hashlib",
        "importlib",
        "json",
        "os",
        "pathlib",
        "platform",
        "re",
        "sys",
        "typing",
    }
    guard_line = next(
        (node.lineno for node in tree.body if is_main_guard(node)),
        len(source.splitlines()) + 1,
    )
    pre_main_third_party: list[str] = []
    for node in tree.body:
        if getattr(node, "lineno", guard_line) >= guard_line:
            break
        for module in imported_roots(node):
            if module not in stdlib:
                pre_main_third_party.append(f"{module}@{node.lineno}")
    if pre_main_third_party:
        failures.append(
            "third-party imports execute before the main guard: "
            + ", ".join(pre_main_third_party)
        )

    main_function = next(
        (node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == "main"),
        None,
    )
    if main_function is None:
        failures.append("generator has no main() function")
    else:
        runtime_calls = [
            node.lineno
            for node in ast.walk(main_function)
            if isinstance(node, ast.Call)
            and isinstance(node.func, ast.Name)
            and node.func.id == "validate_runtime"
        ]
        delayed_third_party = [
            node.lineno
            for node in ast.walk(main_function)
            if imported_roots(node)
            and any(module not in stdlib for module in imported_roots(node))
        ]
        if not runtime_calls:
            failures.append("main() does not call validate_runtime()")
        if not delayed_third_party:
            failures.append("main() has no delayed third-party imports")
        if runtime_calls and delayed_third_party and min(runtime_calls) >= min(delayed_third_party):
            failures.append("validate_runtime() does not precede delayed third-party imports")
        private_path_access = [
            node.lineno
            for node in ast.walk(main_function)
            if isinstance(node, ast.Attribute)
            and node.attr in {"expanduser", "read_bytes", "read_text"}
        ]
        if runtime_calls and private_path_access and min(runtime_calls) >= min(private_path_access):
            failures.append("validate_runtime() does not precede private-path access")
        planned_receipts = [
            node.lineno
            for node in ast.walk(main_function)
            if isinstance(node, ast.Call)
            and isinstance(node.func, ast.Name)
            and node.func.id == "write_receipt_atomically"
        ]
        model_loads = [
            node.lineno
            for node in ast.walk(main_function)
            if isinstance(node, ast.Call)
            and isinstance(node.func, ast.Name)
            and node.func.id == "load_model"
        ]
        if not planned_receipts:
            failures.append("main() does not persist a pre-generation receipt")
        elif delayed_third_party and min(planned_receipts) >= min(delayed_third_party):
            failures.append("generation plan is not persisted before third-party imports")
        elif model_loads and min(planned_receipts) >= min(model_loads):
            failures.append("generation plan is not persisted before model loading")

    required_fragments = {
        f'EXPECTED_PYTHON = "{EXPECTED_PYTHON}"': "exact Python patch constant",
        f'VOICE_RUNTIME_LOCK_SHA256 = "{lock_digest}"': "bound runtime-lock digest",
        "sys.flags.isolated": "isolated-interpreter check",
        "importlib.metadata.distributions()": "complete installed-distribution inventory",
        'os.environ.get("HF_HUB_OFFLINE")': "Hugging Face offline gate",
        'os.environ.get("TRANSFORMERS_OFFLINE")': "Transformers offline gate",
        "local_files_only=True": "offline model-snapshot lookup",
        '"status": "planned"': "durable pre-generation plan status",
        "os.replace(temporary_path, path)": "atomic receipt replacement",
        "os.fsync(temporary.fileno())": "durable receipt file synchronization",
        "confined_private_path(args.reference_root": "repository-private reference confinement",
        "confined_private_path(args.output_root": "repository-private output confinement",
        "PRIVATE_ROOT.is_symlink()": "symlinked private-root rejection",
        '"--check-runtime"': "preflight-only CLI",
        '"--stage-model"': "explicit model-staging CLI",
    }
    for fragment, label in required_fragments.items():
        if fragment not in source:
            failures.append(f"generator is missing {label}")
    return failures


def check_reference_generator(lock_digest: str) -> list[str]:
    failures: list[str] = []
    if not REFERENCE_GENERATOR.is_file():
        return ["future-reference generator is missing"]
    source = REFERENCE_GENERATOR.read_text(encoding="utf-8")
    tree = ast.parse(source, filename=REFERENCE_GENERATOR.as_posix())
    stdlib = set(getattr(sys, "stdlib_module_names", ())) | {
        "__future__",
        "argparse",
        "datetime",
        "hashlib",
        "importlib",
        "json",
        "os",
        "pathlib",
        "platform",
        "random",
        "re",
        "sys",
        "tempfile",
        "typing",
    }
    third_party = [
        f"{module}@{node.lineno}"
        for node in tree.body
        for module in imported_roots(node)
        if module not in stdlib
    ]
    if third_party:
        failures.append(
            "future-reference generator imports third-party code at module load: "
            + ", ".join(third_party)
        )

    main_function = next(
        (node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == "main"),
        None,
    )
    if main_function is None:
        failures.append("future-reference generator has no main() function")
    else:
        calls: dict[str, list[int]] = {}
        for node in ast.walk(main_function):
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Name):
                calls.setdefault(node.func.id, []).append(node.lineno)
        if "validate_runtime" not in calls:
            failures.append("future-reference production commands have no runtime preflight")
        production_calls = [
            line
            for name in ("prepare", "generate", "verify", "stage_model")
            for line in calls.get(name, [])
        ]
        if (
            "validate_runtime" in calls
            and production_calls
            and min(calls["validate_runtime"]) >= min(production_calls)
        ):
            failures.append("future-reference runtime preflight follows private workflow access")

    generate_function = next(
        (
            node
            for node in tree.body
            if isinstance(node, ast.FunctionDef) and node.name == "generate"
        ),
        None,
    )
    if generate_function is None:
        failures.append("future-reference generator has no generate() function")
    else:
        imports = [
            node.lineno
            for node in ast.walk(generate_function)
            if imported_roots(node)
            and any(module not in stdlib for module in imported_roots(node))
        ]
        receipt_writes = [
            node.lineno
            for node in ast.walk(generate_function)
            if isinstance(node, ast.Call)
            and isinstance(node.func, ast.Name)
            and node.func.id == "atomic_write_json"
        ]
        if not imports:
            failures.append("future-reference generator has no delayed third-party imports")
        if not receipt_writes or (imports and min(receipt_writes) >= min(imports)):
            failures.append("future-reference execution plan is not durable before imports")

    required_fragments = {
        f'EXPECTED_PYTHON = "{EXPECTED_PYTHON}"': "exact Python patch constant",
        f'VOICE_RUNTIME_LOCK_SHA256 = "{lock_digest}"': "bound full-lock digest",
        "VOICE_RUNTIME_MANIFEST_SHA256 =": "bound toolchain-manifest digest",
        '"toolchainManifestSha256": VOICE_RUNTIME_MANIFEST_SHA256': "manifest-bound immutable plan",
        '"uv": manifest["uv"]': "authenticated uv provenance",
        '"python": manifest["python"]': "authenticated CPython provenance",
        "importlib.metadata.distributions()": "complete installed-distribution inventory",
        "sys.flags.isolated": "isolated-interpreter check",
        'os.environ.get("HF_HUB_OFFLINE")': "Hugging Face offline gate",
        'os.environ.get("TRANSFORMERS_OFFLINE")': "Transformers offline gate",
        '"lockSha256": VOICE_RUNTIME_LOCK_SHA256': "lock-bound immutable plan",
        '"packages": dict(sorted(packages.items()))': "complete locked plan inventory",
        "local_files_only=True": "offline reference-model lookup",
        "private_output_root(output_root": "repository-private reference confinement",
        "PRIVATE_ROOT.is_symlink()": "symlinked private-root rejection",
        "receipt_path.is_symlink()": "symlinked receipt rejection",
        "output.is_symlink()": "symlinked recorded-output rejection",
        "REFERENCE_MODEL_ATTESTATION": "private reference-model attestation",
        "build_model_attestation(": "content-tree model attestation",
        "verify_model_snapshot(": "pre-inference model-tree verification",
        '"modelAttestationSha256"': "model-attestation plan binding",
        '"stage-model"': "separate public-model staging command",
        'if args.command == "self-check":': "portable self-check bypass",
    }
    for fragment, label in required_fragments.items():
        if fragment not in source:
            failures.append(f"future-reference generator is missing {label}")
    if re.search(r"uv\s+run[\s\S]{0,500}generate-coach-voice-references\.py", source):
        failures.append("future-reference generator still documents a direct uv-run path")
    return failures


def check_manifest(lock_digest: str, *, authenticate_local: bool) -> list[str]:
    failures: list[str] = []
    try:
        manifest_text = RUNTIME_MANIFEST.read_text(encoding="utf-8")
        manifest = json.loads(manifest_text)
    except (OSError, json.JSONDecodeError) as error:
        return [f"runtime manifest is unavailable or invalid: {error}"]
    if not isinstance(manifest, dict) or manifest.get("schemaVersion") != 1:
        failures.append("runtime manifest schema is not exactly 1")
        return failures
    if manifest.get("platform") != "macos-aarch64":
        failures.append("runtime manifest is not bound to macos-aarch64")
    if manifest.get("minimumMacosVersion") != "14.0":
        failures.append("runtime manifest is not bound to macOS 14.0 or newer")
    if re.search(r"/Users/[^/]+/", manifest_text):
        failures.append("runtime manifest exposes a developer account name")

    uv = manifest.get("uv")
    python = manifest.get("python")
    lock = manifest.get("lock")
    if not all(isinstance(section, dict) for section in (uv, python, lock)):
        failures.append("runtime manifest is missing uv, python, or lock sections")
        return failures
    assert isinstance(uv, dict) and isinstance(python, dict) and isinstance(lock, dict)

    for label, digest in (
        ("uv executable", uv.get("sha256")),
        ("Python executable", python.get("executableSha256")),
        ("Python immutable tree", python.get("immutableTreeSha256")),
        ("runtime lock", lock.get("sha256")),
    ):
        if not isinstance(digest, str) or not re.fullmatch(r"[0-9a-f]{64}", digest):
            failures.append(f"runtime manifest has an invalid {label} SHA-256")
        elif digest == "0" * 64:
            failures.append(f"runtime manifest has a placeholder {label} SHA-256")
    if python.get("version") != EXPECTED_PYTHON:
        failures.append("runtime manifest Python patch does not match the approved patch")
    python_relative = Path(str(python.get("relativePath", "")))
    if (
        python_relative.as_posix() != EXPECTED_MANAGED_PYTHON_RELATIVE
        or python_relative.is_absolute()
        or ".." in python_relative.parts
    ):
        failures.append(
            "runtime manifest approved Python identifier is not the expected safe relative path"
        )
    elif authenticate_local:
        import pwd

        account_home = Path(pwd.getpwuid(os.getuid()).pw_dir).resolve()
        python_path = (account_home / python_relative).resolve(strict=False)
        if account_home not in python_path.parents:
            failures.append("runtime manifest approved Python path escapes the account home")
        elif not python_path.is_file() or python_path.is_symlink():
            failures.append("runtime manifest approved Python path is not a regular file")
        elif sha256_file(python_path) != python.get("executableSha256"):
            failures.append("approved Python executable digest does not match the manifest")
        elif immutable_tree_sha256(python_path.parents[1]) != python.get(
            "immutableTreeSha256"
        ):
            failures.append("approved Python installation-tree digest does not match the manifest")
    if lock.get("path") != "requirements/voice-generation.lock":
        failures.append("runtime manifest lock path is not the committed voice lock")
    if lock.get("sha256") != lock_digest:
        failures.append("runtime manifest lock digest does not match the committed lock")

    launcher = Path(str(uv.get("launcher", "")))
    resolved = Path(str(uv.get("resolvedPath", "")))
    if not launcher.is_absolute() or not resolved.is_absolute():
        failures.append("approved uv launcher and target paths are not absolute")
    elif authenticate_local:
        if not launcher.exists() or launcher.resolve(strict=False) != resolved:
            failures.append("approved uv launcher no longer resolves to its manifest target")
        elif not resolved.is_file():
            failures.append("approved uv executable is unavailable")
        elif sha256_file(resolved) != uv.get("sha256"):
            failures.append("approved uv executable digest does not match the manifest")
    return failures


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def immutable_tree_sha256(root: Path) -> str:
    digest = hashlib.sha256()
    for path in sorted(root.rglob("*"), key=lambda item: item.relative_to(root).as_posix()):
        relative_path = path.relative_to(root)
        if "__pycache__" in relative_path.parts or path.suffix in {".pyc", ".pyo"}:
            continue
        relative = relative_path.as_posix().encode("utf-8")
        if path.is_symlink():
            digest.update(
                b"L\0" + relative + b"\0" + os.readlink(path).encode("utf-8") + b"\0"
            )
        elif path.is_file():
            digest.update(b"F\0" + relative + b"\0")
            with path.open("rb") as source:
                for block in iter(lambda: source.read(1024 * 1024), b""):
                    digest.update(block)
            digest.update(b"\0")
    return digest.hexdigest()


def check_wrapper() -> list[str]:
    failures: list[str] = []
    source = WRAPPER.read_text(encoding="utf-8")
    tree = ast.parse(source, filename=WRAPPER.as_posix())
    stdlib = set(getattr(sys, "stdlib_module_names", ())) | {"__future__"}
    third_party = [
        f"{module}@{node.lineno}"
        for node in tree.body
        for module in imported_roots(node)
        if module not in stdlib
    ]
    if third_party:
        failures.append(
            "runtime wrapper imports third-party code before authentication: "
            + ", ".join(third_party)
        )

    workflow_function = next(
        (
            node
            for node in tree.body
            if isinstance(node, ast.FunctionDef) and node.name == "run_locked"
        ),
        None,
    )
    if workflow_function is None:
        failures.append("runtime wrapper has no run_locked() workflow")
    else:
        calls: dict[str, list[int]] = {}
        for node in ast.walk(workflow_function):
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Name):
                calls.setdefault(node.func.id, []).append(node.lineno)
        ordered_calls = (
            "verified_toolchain",
            "resolve_and_verify_base_python",
            "create_runtime",
            "sync_runtime",
            "verify_synchronized_python",
            "run_generator",
            "run_reference_generator",
        )
        for required in ordered_calls:
            if required not in calls:
                failures.append(f"runtime wrapper run_locked() does not call {required}()")
        if all(required in calls for required in ordered_calls):
            if [min(calls[required]) for required in ordered_calls] != sorted(
                min(calls[required]) for required in ordered_calls
            ):
                failures.append("runtime wrapper can invoke the generator before verified sync")

    main_function = next(
        (node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == "main"),
        None,
    )
    if main_function is None:
        failures.append("runtime wrapper has no main() function")
    else:
        locked_workflows = [
            node
            for node in ast.walk(main_function)
            if isinstance(node, (ast.With, ast.AsyncWith))
            and any(
                isinstance(item.context_expr, ast.Call)
                and isinstance(item.context_expr.func, ast.Name)
                and item.context_expr.func.id == "release_command_lock"
                for item in node.items
            )
            and any(
                isinstance(child, ast.Call)
                and isinstance(child.func, ast.Name)
                and child.func.id == "run_locked"
                for child in ast.walk(node)
            )
        ]
        if not locked_workflows:
            failures.append("runtime wrapper does not serialize its complete release workflow")

    python_resolver = next(
        (
            node
            for node in tree.body
            if isinstance(node, ast.FunctionDef)
            and node.name == "resolve_and_verify_base_python"
        ),
        None,
    )
    if python_resolver is None:
        failures.append("runtime wrapper has no base-Python authenticator")
    else:
        hash_lines = [
            node.lineno
            for node in ast.walk(python_resolver)
            if isinstance(node, ast.Call)
            and isinstance(node.func, ast.Name)
            and node.func.id in {"sha256", "immutable_tree_sha256"}
        ]
        subprocess_lines = [
            node.lineno
            for node in ast.walk(python_resolver)
            if isinstance(node, ast.Call)
            and isinstance(node.func, ast.Attribute)
            and node.func.attr == "run"
        ]
        immutable_hash_lines = [
            node.lineno
            for node in ast.walk(python_resolver)
            if isinstance(node, ast.Call)
            and isinstance(node.func, ast.Name)
            and node.func.id == "immutable_tree_sha256"
        ]
        cache_removal_lines = [
            node.lineno
            for node in ast.walk(python_resolver)
            if isinstance(node, ast.Call)
            and isinstance(node.func, ast.Name)
            and node.func.id == "remove_generated_python_caches"
        ]
        if not hash_lines or not subprocess_lines or max(hash_lines) >= min(subprocess_lines):
            failures.append("base Python is not authenticated before uv inspects its selection")
        if (
            len(immutable_hash_lines) < 2
            or not cache_removal_lines
            or not subprocess_lines
            or not (
                min(immutable_hash_lines)
                < min(cache_removal_lines)
                < max(immutable_hash_lines)
                < min(subprocess_lines)
            )
        ):
            failures.append("managed-Python caches are not safely removed before uv inspection")

    required_fragments = {
        '"--require-hashes"': "hash-enforced installation",
        '"--only-binary=:all:"': "wheel-only installation",
        '"--strict"': "closed installed inventory",
        '"--no-sources"': "registry-only resolution",
        '"--no-python-downloads"': "disabled implicit Python downloads",
        '"--no-config"': "disabled ambient uv configuration",
        '"-I"': "isolated generator execution",
        '"PYTHONNOUSERSITE": "1"': "disabled user site packages",
        '"UV_OFFLINE": "1"': "offline uv synchronization",
        '"HF_HUB_OFFLINE": "1"': "offline model resolution",
        '"TRANSFORMERS_OFFLINE": "1"': "offline Transformers resolution",
        '"stage-reference-model"': "separate reference-model staging",
        '"prepare-references"': "authenticated reference preparation",
        '"generate-references"': "authenticated offline reference generation",
        '"verify-references"': "authenticated reference verification",
        "immutable_tree_sha256(python_root)": "approved immutable Python-tree verification",
        '"__pycache__" in relative_path.parts': "generated-cache exclusion from payload digest",
        '"-B"': "disabled bytecode writes",
        "pycache_prefix=": "isolated bytecode cache lookup",
        "reset_isolated_python_cache()": "fresh isolated Python cache",
        "remove_generated_python_caches(python_root)": "pre-execution cache removal",
        "cache.is_symlink()": "symlinked managed-Python cache rejection",
        "compiled.is_symlink()": "symlinked standalone-bytecode rejection",
        '"python",\n            "find"': "authenticated managed-Python lookup",
        '"--managed-python"': "managed-Python restriction",
        'str(base_python)': "verified absolute interpreter selection",
        "pwd.getpwuid(os.getuid()).pw_dir": "account-database home resolution",
        "MANAGED_PYTHON_RELATIVE": "stable managed-Python identifier",
        "remove_generated_runtime()": "fresh runtime reconstruction",
        "shutil.rmtree(RUNTIME_ROOT)": "validated generated-runtime removal",
        "PRIVATE_ROOT.is_symlink()": "symlinked private-root rejection",
        "RUNTIME_ROOT.parent.resolve()": "runtime-parent containment check",
        "RUNTIME_ROOT.resolve(strict=False)": "runtime-target containment check",
        "confined_private_argument(": "production private-path confinement",
        "os.chmod(PRIVATE_ROOT, 0o700)": "owner-only private-root permissions",
        "PRIVATE_ROOT.stat().st_mode & 0o077": "private-root permission verification",
        "fcntl.flock(": "advisory release-command serialization",
        "fcntl.LOCK_EX | fcntl.LOCK_NB": "non-blocking exclusive release lock",
        "os.O_NOFOLLOW": "symlink-safe release-lock opening",
        "os.O_CLOEXEC": "process-death-safe release-lock ownership",
        "release_command_lock(": "release lock around wrapper commands",
        "fcntl.LOCK_UN": "explicit advisory-lock release",
        "os.close(descriptor)": "process-lifetime lock descriptor cleanup",
        "Another voice release command is already running": "clear concurrent-command failure",
        "sha256(resolved_python)": "approved Python executable verification",
        "sha256(expected_uv)": "approved uv executable verification",
        "sha256(lock_path)": "runtime lock verification",
    }
    for fragment, label in required_fragments.items():
        if fragment not in source:
            failures.append(f"runtime wrapper is missing {label}")
    if "os.environ.copy" in source or "os.environ.items" in source:
        failures.append("runtime wrapper copies ambient environment variables")
    if '"PYTHONPATH"' in source:
        failures.append("runtime wrapper permits an ambient PYTHONPATH")
    if '"--allow-existing"' in source:
        failures.append("runtime wrapper can reuse an unverified virtualenv")
    return failures


def check_documentation() -> list[str]:
    text = DOCUMENTATION.read_text(encoding="utf-8")
    required_fragments = {
        "uv --offline --no-python-downloads --no-config venv": "offline exact venv creation",
        "--python 3.12.13": "exact Python patch",
        "MACOSX_DEPLOYMENT_TARGET=14.0": "explicit minimum macOS target",
        "--python-platform aarch64-apple-darwin": "explicit Apple-Silicon resolution target",
        "uv --offline --no-python-downloads --no-config pip sync": "offline lock sync",
        "--require-hashes": "hash enforcement",
        "--only-binary=:all:": "wheel-only enforcement",
        "--strict": "environment closure check",
        "requirements/voice-generation.lock": "committed runtime lock",
        "HF_HUB_OFFLINE=1": "offline model use",
        "TRANSFORMERS_OFFLINE=1": "offline Transformers use",
        ".voice-private/voice-runtime/bin/python -I": "isolated approved interpreter",
        "stage-reference-model": "separate reference-model staging workflow",
        "prepare-references": "authenticated reference-plan preparation",
        "generate-references": "authenticated offline reference generation",
        "verify-references": "authenticated reference verification",
        "mode `0700`": "owner-only private-root permissions",
        "paths outside this repository's real `.voice-private` root": "repository-private confinement",
    }
    failures = [
        f"documentation is missing {label}"
        for fragment, label in required_fragments.items()
        if fragment not in text
    ]
    if re.search(
        r"uv\s+run[\s\S]{0,500}scripts/generate-coach-voice-raw\.py",
        text,
    ):
        failures.append("documentation still runs the raw generator through uv run")
    if re.search(
        r"uv\s+run[\s\S]{0,500}scripts/generate-coach-voice-references\.py",
        text,
    ):
        failures.append("documentation still runs reference generation through uv run")
    if re.search(
        r"uv\s+--offline[\s\S]{0,300}venv[\s\S]{0,300}--allow-existing",
        text,
    ):
        failures.append("documentation still permits reuse of the production voice venv")
    return failures


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--local-toolchain",
        action="store_true",
        help="Also authenticate the manifest-bound uv and Python files on this Mac.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    failures: list[str] = []
    direct, direct_failures = parse_direct_requirements(DIRECT_REQUIREMENTS)
    locked, hash_count, lock_failures = parse_hashed_lock(RUNTIME_LOCK)
    failures.extend(direct_failures)
    failures.extend(lock_failures)
    lock_text = RUNTIME_LOCK.read_text(encoding="utf-8") if RUNTIME_LOCK.is_file() else ""
    if "MACOSX_DEPLOYMENT_TARGET=14.0" not in lock_text:
        failures.append("runtime lock header is missing the macOS 14.0 target")
    if "--python-platform aarch64-apple-darwin" not in lock_text:
        failures.append("runtime lock header is missing the Apple-Silicon target")
    for package, version in direct.items():
        if locked.get(package) != version:
            failures.append(
                f"direct/lock mismatch for {package}: {version} != {locked.get(package)}"
            )

    lock_digest = (
        hashlib.sha256(RUNTIME_LOCK.read_bytes()).hexdigest()
        if RUNTIME_LOCK.is_file()
        else "missing"
    )
    failures.extend(check_manifest(lock_digest, authenticate_local=args.local_toolchain))
    failures.extend(check_wrapper())
    failures.extend(check_generator(lock_digest))
    failures.extend(check_reference_generator(lock_digest))
    failures.extend(check_documentation())

    if failures:
        for failure in failures:
            print(f"[voice:runtime] FAIL — {failure}", file=sys.stderr)
        return 1
    print(
        "[voice:runtime] OK — "
        f"Python {EXPECTED_PYTHON}, {len(locked)} exact locked distributions, "
        f"{hash_count} authentic SHA-256 entries, delayed imports, and offline release commands"
        + (", including local toolchain authentication." if args.local_toolchain else ".")
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
