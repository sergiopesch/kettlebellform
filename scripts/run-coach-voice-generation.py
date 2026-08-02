#!/usr/bin/env python3
"""Stage and run the production voice generator through its locked runtime."""

from __future__ import annotations

import argparse
import fcntl
import hashlib
import json
import os
import platform
import pwd
import shutil
import stat
import subprocess
import sys
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any


REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
TOOLCHAIN_MANIFEST = REPOSITORY_ROOT / "requirements/voice-runtime.json"
GENERATOR = REPOSITORY_ROOT / "scripts/generate-coach-voice-raw.py"
REFERENCE_GENERATOR = REPOSITORY_ROOT / "scripts/generate-coach-voice-references.py"
PRIVATE_ROOT = REPOSITORY_ROOT / ".voice-private"
RUNTIME_ROOT = PRIVATE_ROOT / "voice-runtime"
RUNTIME_PYTHON = RUNTIME_ROOT / "bin/python"
PRIVATE_TEMP = PRIVATE_ROOT / "voice-runtime-tmp"
PYTHON_CACHE_ROOT = PRIVATE_TEMP / "isolated-python-cache"
RELEASE_LOCK = PRIVATE_ROOT / ".voice-generation-release.lock"
MANAGED_PYTHON_RELATIVE = Path(
    ".local/share/uv/python/cpython-3.12.13-macos-aarch64-none/bin/python3.12"
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser(
        "stage-runtime",
        help="Fetch only hash-approved wheels and synchronize the exact runtime.",
    )
    commands.add_parser(
        "stage-model",
        help="Fetch the exact public model revision after the runtime is verified.",
    )
    commands.add_parser(
        "stage-reference-model",
        help="Fetch the exact public VoiceDesign revision after runtime verification.",
    )
    commands.add_parser(
        "check-runtime",
        help="Re-synchronize offline and run the generator's import-free preflight.",
    )
    generate = commands.add_parser(
        "generate",
        help="Re-synchronize offline, then generate raw private WAVs.",
    )
    generate.add_argument("reference_root", type=Path)
    generate.add_argument("output_root", type=Path)
    generate.add_argument("--seed-offset", type=int, default=0)
    generate.add_argument(
        "--override",
        action="append",
        default=[],
        metavar="PROFILE/CUE=SEED",
    )
    prepare_references = commands.add_parser(
        "prepare-references",
        help="Create an immutable future-reference plan in the frozen runtime.",
    )
    prepare_references.add_argument("output_root", type=Path)
    generate_references = commands.add_parser(
        "generate-references",
        help="Generate future references offline from a reviewed plan.",
    )
    generate_references.add_argument("output_root", type=Path)
    generate_references.add_argument("--resume", action="store_true")
    verify_references = commands.add_parser(
        "verify-references",
        help="Verify a future-reference plan and its recorded outputs.",
    )
    verify_references.add_argument("output_root", type=Path)
    return parser.parse_args()


def sha256(path: Path) -> str:
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
            digest.update(b"L\0" + relative + b"\0" + os.readlink(path).encode("utf-8") + b"\0")
        elif path.is_file():
            digest.update(b"F\0" + relative + b"\0")
            with path.open("rb") as source:
                for block in iter(lambda: source.read(1024 * 1024), b""):
                    digest.update(block)
            digest.update(b"\0")
    return digest.hexdigest()


def remove_generated_python_caches(root: Path) -> None:
    resolved_root = root.resolve()
    cache_directories = sorted(
        (path for path in root.rglob("__pycache__")),
        key=lambda path: len(path.parts),
        reverse=True,
    )
    for cache in cache_directories:
        if cache.is_symlink() or not cache.is_dir():
            raise SystemExit(f"Refusing unsafe managed-Python cache path: {cache}")
        if not cache.resolve().is_relative_to(resolved_root):
            raise SystemExit(f"Managed-Python cache escaped its installation: {cache}")
        shutil.rmtree(cache)

    for compiled in root.rglob("*"):
        if compiled.suffix not in {".pyc", ".pyo"}:
            continue
        if compiled.is_symlink() or not compiled.is_file():
            raise SystemExit(f"Refusing unsafe managed-Python bytecode path: {compiled}")
        if not compiled.resolve().is_relative_to(resolved_root):
            raise SystemExit(f"Managed-Python bytecode escaped its installation: {compiled}")
        compiled.unlink()


def read_manifest() -> dict[str, Any]:
    try:
        manifest = json.loads(TOOLCHAIN_MANIFEST.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise SystemExit(f"Voice runtime manifest is unavailable or invalid: {error}") from error
    if not isinstance(manifest, dict) or manifest.get("schemaVersion") != 1:
        raise SystemExit("Voice runtime manifest schema is not supported.")
    if manifest.get("platform") != "macos-aarch64":
        raise SystemExit("Voice runtime manifest platform is not macos-aarch64.")
    if sys.platform != "darwin" or platform.machine() != "arm64":
        raise SystemExit("Production voice generation requires macOS on Apple Silicon.")
    if manifest.get("minimumMacosVersion") != "14.0":
        raise SystemExit("Voice runtime manifest minimum macOS version is not 14.0.")
    macos_fields = platform.mac_ver()[0].split(".")
    if not macos_fields[0].isdigit() or int(macos_fields[0]) < 14:
        raise SystemExit("Production voice generation requires macOS 14.0 or newer.")
    return manifest


def validated_private_root() -> Path:
    if PRIVATE_ROOT.is_symlink():
        raise SystemExit("Refusing to use a symlinked .voice-private directory.")
    if not PRIVATE_ROOT.exists():
        PRIVATE_ROOT.mkdir(mode=0o700)
    if not PRIVATE_ROOT.is_dir():
        raise SystemExit("The repository-local .voice-private path is not a directory.")
    if (
        PRIVATE_ROOT.parent.resolve() != REPOSITORY_ROOT
        or PRIVATE_ROOT.resolve() != PRIVATE_ROOT
    ):
        raise SystemExit("The private voice root is not directly inside this repository.")
    if PRIVATE_ROOT.stat().st_mode & 0o077:
        os.chmod(PRIVATE_ROOT, 0o700)
    if PRIVATE_ROOT.stat().st_mode & 0o077:
        raise SystemExit("The private voice root grants group or other access.")
    return PRIVATE_ROOT


def confined_private_argument(path: Path, *, label: str) -> Path:
    private_root = validated_private_root()
    resolved = path.expanduser().resolve(strict=False)
    if resolved == private_root or not resolved.is_relative_to(private_root):
        raise SystemExit(
            f"{label} must resolve below this repository's non-symlinked .voice-private root."
        )
    return resolved


@contextmanager
def release_command_lock(command: list[str]) -> Iterator[None]:
    private_root = validated_private_root()
    if RELEASE_LOCK.parent.resolve() != private_root:
        raise SystemExit("The release-command lock escaped .voice-private.")
    try:
        descriptor = os.open(
            RELEASE_LOCK,
            os.O_RDWR | os.O_CREAT | os.O_CLOEXEC | os.O_NOFOLLOW,
            0o600,
        )
    except OSError as error:
        raise SystemExit(
            f"Unable to open the release-command lock safely: {error}"
        ) from error
    acquired = False
    try:
        facts = os.fstat(descriptor)
        if not stat.S_ISREG(facts.st_mode):
            raise SystemExit("The release-command lock is not a regular file.")
        os.fchmod(descriptor, 0o600)
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
            acquired = True
        except BlockingIOError as error:
            os.lseek(descriptor, 0, os.SEEK_SET)
            owner = os.read(descriptor, 4096).decode("utf-8", errors="replace").strip()
            details = f" Current owner: {owner}" if owner else ""
            raise SystemExit(
                "Another voice release command is already running; retry after it exits."
                + details
            ) from error

        metadata = json.dumps(
            {"pid": os.getpid(), "command": command},
            ensure_ascii=True,
            separators=(",", ":"),
        ).encode("utf-8")
        os.ftruncate(descriptor, 0)
        os.lseek(descriptor, 0, os.SEEK_SET)
        written = 0
        while written < len(metadata):
            written += os.write(descriptor, metadata[written:])
        os.fsync(descriptor)
        yield
    finally:
        if acquired:
            fcntl.flock(descriptor, fcntl.LOCK_UN)
        os.close(descriptor)


def ensure_private_temp() -> None:
    private_root = validated_private_root()
    if PRIVATE_TEMP.is_symlink():
        raise SystemExit("Refusing to use a symlinked voice runtime temp directory.")
    if not PRIVATE_TEMP.exists():
        PRIVATE_TEMP.mkdir(mode=0o700)
    if (
        not PRIVATE_TEMP.is_dir()
        or PRIVATE_TEMP.parent.resolve() != private_root
        or PRIVATE_TEMP.resolve() != private_root / "voice-runtime-tmp"
    ):
        raise SystemExit("The voice runtime temp directory escaped .voice-private.")


def reset_isolated_python_cache() -> Path:
    ensure_private_temp()
    if PYTHON_CACHE_ROOT.is_symlink():
        raise SystemExit("Refusing to use a symlinked isolated Python cache.")
    if PYTHON_CACHE_ROOT.exists():
        if not PYTHON_CACHE_ROOT.is_dir():
            raise SystemExit("The isolated Python cache path is not a directory.")
        shutil.rmtree(PYTHON_CACHE_ROOT)
    PYTHON_CACHE_ROOT.mkdir(mode=0o700)
    if PYTHON_CACHE_ROOT.resolve() != PRIVATE_TEMP / "isolated-python-cache":
        raise SystemExit("The isolated Python cache escaped the private runtime temp root.")
    return PYTHON_CACHE_ROOT


def isolated_python_command(script_arguments: list[str]) -> list[str]:
    cache_root = reset_isolated_python_cache()
    return [
        str(RUNTIME_PYTHON),
        "-I",
        "-B",
        "-X",
        f"pycache_prefix={cache_root}",
        *script_arguments,
    ]


def clean_environment(*, offline: bool) -> dict[str, str]:
    ensure_private_temp()
    account_home = Path(pwd.getpwuid(os.getuid()).pw_dir).resolve()
    environment = {
        "HOME": str(account_home),
        "PATH": "/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin",
        "TMPDIR": str(PRIVATE_TEMP),
        "LC_ALL": "C",
        "PYTHONNOUSERSITE": "1",
        "PYTHONDONTWRITEBYTECODE": "1",
        "UV_NO_CONFIG": "1",
        "UV_PYTHON_DOWNLOADS": "never",
        "HF_HUB_DISABLE_TELEMETRY": "1",
        "DO_NOT_TRACK": "1",
    }
    if offline:
        environment.update(
            {
                "UV_OFFLINE": "1",
                "HF_HUB_OFFLINE": "1",
                "TRANSFORMERS_OFFLINE": "1",
            }
        )
    return environment


def verified_toolchain(manifest: dict[str, Any]) -> tuple[Path, Path]:
    uv_manifest = manifest.get("uv")
    python_manifest = manifest.get("python")
    lock_manifest = manifest.get("lock")
    if not all(isinstance(item, dict) for item in (uv_manifest, python_manifest, lock_manifest)):
        raise SystemExit("Voice runtime manifest is missing toolchain sections.")

    uv_launcher = Path(str(uv_manifest.get("launcher", "")))
    expected_uv = Path(str(uv_manifest.get("resolvedPath", "")))
    if not uv_launcher.is_absolute() or not expected_uv.is_absolute():
        raise SystemExit("The approved uv paths must be absolute.")
    if not uv_launcher.exists() or uv_launcher.resolve() != expected_uv:
        raise SystemExit(
            f"Unexpected uv launcher target: {uv_launcher} -> {uv_launcher.resolve(strict=False)}"
        )
    if not expected_uv.is_file() or not os.access(expected_uv, os.X_OK):
        raise SystemExit(f"Approved uv executable is unavailable: {expected_uv}")
    if sha256(expected_uv) != uv_manifest.get("sha256"):
        raise SystemExit("Approved uv executable SHA-256 mismatch.")

    completed = subprocess.run(
        [str(expected_uv), "--version"],
        cwd=REPOSITORY_ROOT,
        env=clean_environment(offline=True),
        check=True,
        capture_output=True,
        text=True,
        timeout=30,
    )
    version_fields = completed.stdout.strip().split()
    if len(version_fields) < 2 or version_fields[:2] != ["uv", uv_manifest.get("version")]:
        raise SystemExit(f"Unexpected uv version output: {completed.stdout.strip()}")

    lock_path = (REPOSITORY_ROOT / str(lock_manifest.get("path", ""))).resolve()
    if REPOSITORY_ROOT not in lock_path.parents or not lock_path.is_file():
        raise SystemExit("Voice runtime lock path is outside the repository or missing.")
    if sha256(lock_path) != lock_manifest.get("sha256"):
        raise SystemExit("Voice runtime lock SHA-256 mismatch.")
    return expected_uv, lock_path


def resolve_and_verify_base_python(
    uv: Path,
    manifest: dict[str, Any],
) -> Path:
    python_manifest = manifest["python"]
    account_home = Path(pwd.getpwuid(os.getuid()).pw_dir).resolve()
    relative_python = Path(str(python_manifest.get("relativePath", "")))
    if (
        relative_python != MANAGED_PYTHON_RELATIVE
        or relative_python.is_absolute()
        or ".." in relative_python.parts
    ):
        raise SystemExit("Approved managed Python path must be account-home-relative.")
    expected_python = (account_home / relative_python).resolve(strict=False)
    if (
        account_home not in expected_python.parents
        or not expected_python.is_file()
        or expected_python.is_symlink()
        or not os.access(expected_python, os.X_OK)
    ):
        raise SystemExit(f"Approved managed Python is unavailable: {expected_python}")
    python_root = expected_python.parents[1]
    if sha256(expected_python) != python_manifest.get("executableSha256"):
        raise SystemExit("Approved base Python executable SHA-256 mismatch.")
    if immutable_tree_sha256(python_root) != python_manifest.get("immutableTreeSha256"):
        raise SystemExit("Approved base Python immutable-content SHA-256 mismatch.")
    remove_generated_python_caches(python_root)
    if immutable_tree_sha256(python_root) != python_manifest.get("immutableTreeSha256"):
        raise SystemExit("Managed Python changed while generated caches were removed.")

    # The already-authenticated uv binary confirms its managed-Python lookup maps
    # to the manifest-bound interpreter; no candidate interpreter is executed.
    completed = subprocess.run(
        [
            str(uv),
            "--offline",
            "--no-python-downloads",
            "--no-config",
            "python",
            "find",
            "--no-project",
            "--managed-python",
            "--resolve-links",
            str(python_manifest["version"]),
        ],
        cwd=REPOSITORY_ROOT,
        env=clean_environment(offline=True),
        check=True,
        capture_output=True,
        text=True,
        timeout=30,
    )
    fields = completed.stdout.strip().splitlines()
    if len(fields) != 1:
        raise SystemExit(f"Unexpected uv Python lookup output: {completed.stdout.strip()}")
    resolved_python = Path(fields[0])
    if not resolved_python.is_absolute() or resolved_python != expected_python:
        raise SystemExit(f"Unexpected managed Python interpreter: {resolved_python}")
    return resolved_python


def remove_generated_runtime() -> None:
    private_root = validated_private_root()
    if (
        RUNTIME_ROOT.parent.resolve() != private_root
        or RUNTIME_ROOT.resolve(strict=False) != private_root / "voice-runtime"
    ):
        raise SystemExit("Refusing to replace a runtime outside .voice-private.")
    if RUNTIME_ROOT.is_symlink():
        raise SystemExit("Refusing to replace a symlinked voice runtime directory.")
    if not RUNTIME_ROOT.exists():
        return
    if not RUNTIME_ROOT.is_dir() or not (RUNTIME_ROOT / "pyvenv.cfg").is_file():
        raise SystemExit("Refusing to replace a voice runtime path that is not a virtualenv.")
    shutil.rmtree(RUNTIME_ROOT)


def create_runtime(uv: Path, base_python: Path, *, offline: bool) -> None:
    remove_generated_runtime()
    uv_command = [str(uv)]
    if offline:
        uv_command.append("--offline")
    uv_command.extend(
        [
            "--no-python-downloads",
            "--no-config",
            "venv",
            "--no-project",
            "--python",
            str(base_python),
            str(RUNTIME_ROOT),
        ]
    )
    subprocess.run(
        uv_command,
        cwd=REPOSITORY_ROOT,
        env=clean_environment(offline=offline),
        check=True,
        timeout=120,
    )


def verify_synchronized_python(
    base_python: Path,
    manifest: dict[str, Any],
    *,
    offline: bool,
) -> None:
    python_manifest = manifest["python"]
    if not RUNTIME_PYTHON.is_file() or not RUNTIME_PYTHON.is_symlink():
        raise SystemExit("Voice runtime Python must be a symlink to the approved managed runtime.")
    resolved_python = RUNTIME_PYTHON.resolve()
    if resolved_python != base_python:
        raise SystemExit("Voice runtime Python does not resolve to the authenticated interpreter.")
    if sha256(resolved_python) != python_manifest.get("executableSha256"):
        raise SystemExit("Voice runtime Python executable SHA-256 mismatch.")
    if immutable_tree_sha256(resolved_python.parents[1]) != python_manifest.get(
        "immutableTreeSha256"
    ):
        raise SystemExit("Voice runtime Python immutable-content SHA-256 mismatch.")

    completed = subprocess.run(
        isolated_python_command(
            ["-c", "import platform; print(platform.python_version())"]
        ),
        cwd=REPOSITORY_ROOT,
        env=clean_environment(offline=offline),
        check=True,
        capture_output=True,
        text=True,
        timeout=30,
    )
    if completed.stdout.strip() != python_manifest.get("version"):
        raise SystemExit(f"Unexpected voice runtime Python version: {completed.stdout.strip()}")


def sync_runtime(uv: Path, lock_path: Path, *, offline: bool) -> None:
    uv_command = [str(uv)]
    if offline:
        uv_command.append("--offline")
    uv_command.extend(
        [
            "--no-python-downloads",
            "--no-config",
            "pip",
            "sync",
            "--python",
            str(RUNTIME_PYTHON),
            "--require-hashes",
            "--only-binary=:all:",
            "--strict",
            "--no-sources",
            str(lock_path),
        ]
    )
    subprocess.run(
        uv_command,
        cwd=REPOSITORY_ROOT,
        env=clean_environment(offline=offline),
        check=True,
        timeout=600,
    )


def run_generator(arguments: list[str], *, offline: bool) -> None:
    subprocess.run(
        isolated_python_command([str(GENERATOR), *arguments]),
        cwd=REPOSITORY_ROOT,
        env=clean_environment(offline=offline),
        check=True,
        timeout=None,
    )


def run_reference_generator(arguments: list[str], *, offline: bool) -> None:
    subprocess.run(
        isolated_python_command([str(REFERENCE_GENERATOR), *arguments]),
        cwd=REPOSITORY_ROOT,
        env=clean_environment(offline=offline),
        check=True,
        timeout=None,
    )


def run_locked(args: argparse.Namespace) -> int:
    if args.command == "generate":
        args.reference_root = confined_private_argument(
            args.reference_root,
            label="reference_root",
        )
        args.output_root = confined_private_argument(
            args.output_root,
            label="output_root",
        )
    elif args.command in {
        "prepare-references",
        "generate-references",
        "verify-references",
    }:
        args.output_root = confined_private_argument(
            args.output_root,
            label="reference output_root",
        )

    manifest = read_manifest()
    uv, lock_path = verified_toolchain(manifest)
    base_python = resolve_and_verify_base_python(uv, manifest)
    online_staging = args.command == "stage-runtime"
    create_runtime(uv, base_python, offline=not online_staging)
    sync_runtime(uv, lock_path, offline=not online_staging)
    verify_synchronized_python(base_python, manifest, offline=not online_staging)

    if args.command == "stage-runtime":
        run_generator(["--check-runtime"], offline=True)
        run_reference_generator(["check-runtime"], offline=True)
        print("Voice runtime staged from hash-approved wheels; generation did not run.")
        return 0
    if args.command == "stage-model":
        run_generator(["--stage-model"], offline=False)
        return 0
    if args.command == "stage-reference-model":
        run_reference_generator(["stage-model"], offline=False)
        return 0
    if args.command == "check-runtime":
        run_generator(["--check-runtime"], offline=True)
        run_reference_generator(["check-runtime"], offline=True)
        return 0
    if args.command == "prepare-references":
        run_reference_generator(["prepare", str(args.output_root)], offline=True)
        return 0
    if args.command == "generate-references":
        reference_arguments = ["generate", str(args.output_root)]
        if args.resume:
            reference_arguments.append("--resume")
        run_reference_generator(reference_arguments, offline=True)
        return 0
    if args.command == "verify-references":
        run_reference_generator(["verify", str(args.output_root)], offline=True)
        return 0

    generator_arguments = [str(args.reference_root), str(args.output_root)]
    if args.seed_offset:
        generator_arguments.extend(["--seed-offset", str(args.seed_offset)])
    for override in args.override:
        generator_arguments.extend(["--override", override])
    run_generator(generator_arguments, offline=True)
    return 0


def main() -> int:
    args = parse_args()
    with release_command_lock(sys.argv[1:]):
        return run_locked(args)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except subprocess.CalledProcessError as error:
        raise SystemExit(
            f"Voice runtime command failed before generation completed (exit {error.returncode})."
        ) from error
