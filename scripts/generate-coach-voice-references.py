#!/usr/bin/env python3
"""Prepare and execute reproducible Qwen VoiceDesign reference runs.

This release-only tool deliberately uses a two-step workflow. ``prepare`` writes
the complete immutable plan and its digest before a model is loaded or any audio
is generated. ``generate`` refuses to run without that receipt. Candidate audio
and receipts must stay below the gitignored ``.voice-private/`` directory.

Production commands must run through ``scripts/run-coach-voice-generation.py``.
The direct ``self-check`` command remains standard-library-only and portable.
This tool never promotes a candidate into the app or changes the v2 pack.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import json
import os
import platform
import random
import re
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


WORKFLOW_ID = "maritime-command-reference-design-v1"
REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
PRIVATE_ROOT = REPOSITORY_ROOT / ".voice-private"
MODEL_ID = "mlx-community/Qwen3-TTS-12Hz-1.7B-VoiceDesign-bf16"
MODEL_REVISION = "7d3824abff87e49756bb0f83fb5411de75d160c4"
UPSTREAM_MODEL_ID = "Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign"
UPSTREAM_MODEL_REVISION = "5ecdb67327fd37bb2e042aab12ff7391903235d3"
RECEIPT_NAME = "reference-generation-receipt.json"
REFERENCE_TEXT = (
    "After the last set, stand tall; keep your shoulders back, breathe steadily, "
    "and drive forward with purpose. Good—hold that standard. You are ready."
)
SHARED_DIRECTION = (
    "An adult kettlebell coach speaking contemporary Standard Southern British "
    "English. Use modern non-rhotic pronunciation, crisp consonants and word "
    "endings, and a natural stress-timed rhythm. Deliver calm urgency and "
    "disciplined warmth with brisk, compact phrasing, firm action-word onsets, "
    "purposeful pitch and intensity movement, and decisive falling sentence "
    "endings. The voice is full and non-breathy, inspiring and forward-driving "
    "without shouting, growling, bullying, military parody, vintage-posh "
    "theatricality, or imitation of any real or named person. Speak the supplied "
    "words exactly."
)
PROFILE_DELTAS = {
    "male-command": (
        "Use a clean mid-low adult male baritone with natural weight; never add "
        "artificial boom, gravel, or growl."
    ),
    "female-command": (
        "Use a clean mid-low adult female mezzo/alto with natural weight; keep "
        "the same brisk pace, firm attack, confidence, and disciplined warmth, "
        "without breathiness, shrillness, maternal softness, or cheerleader affect."
    ),
}
CANDIDATE_SEEDS = {
    "male-command": (
        2026080301,
        2026080302,
        2026080303,
        2026080304,
        2026080305,
        2026080306,
    ),
    "female-command": (
        2026080401,
        2026080402,
        2026080403,
        2026080404,
        2026080405,
        2026080406,
    ),
}
GENERATION_SETTINGS = {
    "language": "english",
    "temperature": 0.9,
    "topK": 50,
    "topP": 1.0,
    "repetitionPenalty": 1.05,
    "maxTokens": 512,
    "stream": False,
    "streamingInterval": 2.0,
    "verbose": False,
}
MIN_DURATION_SECONDS = 5.0
MAX_DURATION_SECONDS = 16.0
EXPECTED_PYTHON = "3.12.13"
VOICE_RUNTIME_LOCK_PATH = (
    REPOSITORY_ROOT / "requirements/voice-generation.lock"
)
VOICE_RUNTIME_LOCK_SHA256 = "2d8fc14de6f8c33fe817a59eb914cdef0fc7238626b51469fd4508084e59ccf8"
VOICE_RUNTIME_MANIFEST_PATH = REPOSITORY_ROOT / "requirements/voice-runtime.json"
VOICE_RUNTIME_MANIFEST_SHA256 = "f33a9d3d405a95d9589e18b8b4207d0735b0031835881fd9a6eedc211e3b657f"
REFERENCE_MODEL_ATTESTATION = (
    PRIVATE_ROOT / "attestations/reference-voice-design-model.json"
)
MODEL_ATTESTATION_SCHEMA = 1
REQUIREMENT_PATTERN = re.compile(
    r"^([A-Za-z0-9_.-]+)==([^\s;\\]+)(?:\s*\\)?$"
)
HASH_PATTERN = re.compile(r"--hash=sha256:([0-9a-f]{64})(?:\s*\\)?$")


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)

    prepare = commands.add_parser(
        "prepare",
        help="Persist the exact immutable generation plan; generate no audio.",
    )
    prepare.add_argument("output_root", type=Path)

    generate = commands.add_parser(
        "generate",
        help="Generate candidates only from an existing prepared receipt.",
    )
    generate.add_argument("output_root", type=Path)
    generate.add_argument(
        "--resume",
        action="store_true",
        help="Resume a receipt left in generating or failed state without overwriting outputs.",
    )

    verify = commands.add_parser(
        "verify",
        help="Verify the plan digest and all recorded candidate hashes.",
    )
    verify.add_argument("output_root", type=Path)

    commands.add_parser(
        "stage-model",
        help="Download only the exact public VoiceDesign model revision.",
    )
    commands.add_parser(
        "check-runtime",
        help="Verify the frozen runtime without importing a third-party package.",
    )

    commands.add_parser(
        "self-check",
        help="Exercise plan sealing, verification, tamper rejection, and path confinement.",
    )
    return parser.parse_args()


def canonical_json(value: Any) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")


def value_sha256(value: Any) -> str:
    return hashlib.sha256(canonical_json(value)).hexdigest()


def serialized_json(value: Any) -> bytes:
    return (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode("utf-8")


def serialized_json_sha256(value: Any) -> str:
    return hashlib.sha256(serialized_json(value)).hexdigest()


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def canonical_name(name: str) -> str:
    return re.sub(r"[-_.]+", "-", name).lower()


def locked_distributions() -> dict[str, str]:
    if not VOICE_RUNTIME_LOCK_PATH.is_file():
        raise SystemExit("The authenticated voice runtime lock is missing.")
    if file_sha256(VOICE_RUNTIME_LOCK_PATH) != VOICE_RUNTIME_LOCK_SHA256:
        raise SystemExit("The authenticated voice runtime lock SHA-256 does not match.")

    packages: dict[str, str] = {}
    hashes: dict[str, set[str]] = {}
    active_package: str | None = None
    for number, raw_line in enumerate(
        VOICE_RUNTIME_LOCK_PATH.read_text(encoding="utf-8").splitlines(), start=1
    ):
        stripped = raw_line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        if raw_line[0].isspace():
            match = HASH_PATTERN.fullmatch(stripped)
            if match is None or active_package is None:
                raise SystemExit(f"Unsupported voice lock continuation at line {number}.")
            digest = match.group(1)
            if digest == "0" * 64:
                raise SystemExit(f"Placeholder hash in voice lock at line {number}.")
            hashes[active_package].add(digest)
            continue

        match = REQUIREMENT_PATTERN.fullmatch(stripped)
        if match is None:
            raise SystemExit(f"Voice lock line {number} is not an exact registry pin.")
        active_package = canonical_name(match.group(1))
        if active_package in packages:
            raise SystemExit(f"Duplicate package in voice lock: {active_package}.")
        packages[active_package] = match.group(2)
        hashes[active_package] = set()

    unhashed = sorted(package for package, values in hashes.items() if not values)
    if not packages or unhashed:
        raise SystemExit(f"Voice lock contains unhashed packages: {', '.join(unhashed)}.")
    return packages


def authenticated_runtime_manifest() -> dict[str, Any]:
    if not VOICE_RUNTIME_MANIFEST_PATH.is_file():
        raise SystemExit("The authenticated voice runtime manifest is missing.")
    if file_sha256(VOICE_RUNTIME_MANIFEST_PATH) != VOICE_RUNTIME_MANIFEST_SHA256:
        raise SystemExit("The authenticated voice runtime manifest SHA-256 does not match.")
    try:
        manifest = json.loads(VOICE_RUNTIME_MANIFEST_PATH.read_text(encoding="utf-8"))
    except json.JSONDecodeError as error:
        raise SystemExit(f"The authenticated voice runtime manifest is invalid: {error}") from error
    if not isinstance(manifest, dict) or manifest.get("schemaVersion") != 1:
        raise SystemExit("The authenticated voice runtime manifest schema is unsupported.")
    if not all(isinstance(manifest.get(key), dict) for key in ("uv", "python", "lock")):
        raise SystemExit("The authenticated voice runtime manifest is incomplete.")
    if manifest["lock"].get("sha256") != VOICE_RUNTIME_LOCK_SHA256:
        raise SystemExit("The runtime manifest and voice dependency lock disagree.")
    return manifest


def runtime_plan() -> dict[str, Any]:
    packages = locked_distributions()
    manifest = authenticated_runtime_manifest()
    return {
        "pythonVersion": EXPECTED_PYTHON,
        "lockFile": "requirements/voice-generation.lock",
        "lockSha256": VOICE_RUNTIME_LOCK_SHA256,
        "packages": dict(sorted(packages.items())),
        "toolchainManifestFile": "requirements/voice-runtime.json",
        "toolchainManifestSha256": VOICE_RUNTIME_MANIFEST_SHA256,
        "uv": manifest["uv"],
        "python": manifest["python"],
        "lock": manifest["lock"],
    }


def atomic_write_json(path: Path, value: Any) -> None:
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    encoded = serialized_json(value)
    with temporary.open("xb") as target:
        os.chmod(temporary, 0o600)
        target.write(encoded)
        target.flush()
        os.fsync(target.fileno())
    os.replace(temporary, path)


def private_output_root(path: Path, *, repository_bound: bool = True) -> Path:
    resolved = path.expanduser().resolve()
    if not repository_bound:
        if ".voice-private" not in resolved.parts:
            raise SystemExit(
                "Reference runs must remain inside a .voice-private directory."
            )
        return resolved

    if (
        PRIVATE_ROOT.is_symlink()
        or not PRIVATE_ROOT.is_dir()
        or PRIVATE_ROOT.resolve() != PRIVATE_ROOT
        or PRIVATE_ROOT.stat().st_mode & 0o077
    ):
        raise SystemExit(
            "The repository .voice-private root must be a private, non-symlinked directory."
        )
    if resolved == PRIVATE_ROOT or not resolved.is_relative_to(PRIVATE_ROOT):
        raise SystemExit(
            "Reference runs must remain inside this repository's .voice-private directory."
        )
    return resolved


def snapshot_content_records(snapshot_root: Path) -> list[dict[str, Any]]:
    root = snapshot_root.resolve(strict=True)
    if snapshot_root.is_symlink() or not root.is_dir():
        raise RuntimeError("The reference-model snapshot root must be a real directory.")
    allowed_content_root = root.parent.parent if root.parent.name == "snapshots" else root
    records: list[dict[str, Any]] = []
    for path in sorted(root.rglob("*"), key=lambda item: item.relative_to(root).as_posix()):
        relative = path.relative_to(root).as_posix()
        if path.is_dir() and not path.is_symlink():
            continue
        resolved = path.resolve(strict=True)
        if not resolved.is_file():
            raise RuntimeError(f"Unsupported model-snapshot entry: {relative}.")
        if not resolved.is_relative_to(allowed_content_root):
            raise RuntimeError(f"Model-snapshot entry escapes its cache root: {relative}.")
        before = resolved.stat()
        digest = file_sha256(resolved)
        after = resolved.stat()
        identity_before = (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns)
        identity_after = (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns)
        if identity_before != identity_after:
            raise RuntimeError(f"Model-snapshot entry changed during attestation: {relative}.")
        records.append(
            {
                "relativeFile": relative,
                "bytes": after.st_size,
                "sha256": digest,
            }
        )
    if not records:
        raise RuntimeError("The reference-model snapshot contains no files.")
    return records


def build_model_attestation(
    snapshot_root: Path,
    *,
    generated_at: str | None = None,
) -> dict[str, Any]:
    records = snapshot_content_records(snapshot_root)
    return {
        "schemaVersion": MODEL_ATTESTATION_SCHEMA,
        "generatedAt": generated_at or utc_now(),
        "model": MODEL_ID,
        "modelRevision": MODEL_REVISION,
        "contentTreeSha256": value_sha256(records),
        "fileCount": len(records),
        "totalBytes": sum(record["bytes"] for record in records),
        "files": records,
    }


def validate_model_attestation(attestation: dict[str, Any]) -> None:
    if (
        not isinstance(attestation, dict)
        or attestation.get("schemaVersion") != MODEL_ATTESTATION_SCHEMA
    ):
        raise SystemExit("The reference-model attestation schema is unsupported.")
    if (
        attestation.get("model") != MODEL_ID
        or attestation.get("modelRevision") != MODEL_REVISION
    ):
        raise SystemExit("The reference-model attestation identifies another model.")
    if not isinstance(attestation.get("generatedAt"), str) or not attestation[
        "generatedAt"
    ].strip():
        raise SystemExit("The reference-model attestation timestamp is invalid.")
    files = attestation.get("files")
    if not isinstance(files, list) or not files:
        raise SystemExit("The reference-model attestation has no file inventory.")
    relative_files: list[str] = []
    total_bytes = 0
    for record in files:
        if not isinstance(record, dict):
            raise SystemExit("The reference-model attestation has an invalid file record.")
        relative_file = record.get("relativeFile")
        size = record.get("bytes")
        digest = record.get("sha256")
        if (
            not isinstance(relative_file, str)
            or not relative_file
            or Path(relative_file).is_absolute()
            or ".." in Path(relative_file).parts
            or type(size) is not int
            or size < 0
            or not isinstance(digest, str)
            or not re.fullmatch(r"[0-9a-f]{64}", digest)
        ):
            raise SystemExit("The reference-model attestation has an invalid file record.")
        relative_files.append(relative_file)
        total_bytes += size
    if relative_files != sorted(set(relative_files)):
        raise SystemExit(
            "The reference-model attestation file inventory is not unique and sorted."
        )
    if (
        attestation.get("fileCount") != len(files)
        or attestation.get("totalBytes") != total_bytes
    ):
        raise SystemExit("The reference-model attestation summary does not match its files.")
    if attestation.get("contentTreeSha256") != value_sha256(files):
        raise SystemExit("The reference-model attestation content-tree digest is invalid.")


def write_model_attestation(attestation: dict[str, Any]) -> Path:
    validate_model_attestation(attestation)
    attestation_root = private_output_root(REFERENCE_MODEL_ATTESTATION.parent)
    attestation_root.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(attestation_root, 0o700)
    path = attestation_root / REFERENCE_MODEL_ATTESTATION.name
    if path.is_symlink():
        raise SystemExit("Refusing to replace a symlinked reference-model attestation.")
    atomic_write_json(path, attestation)
    return path


def read_model_attestation() -> tuple[dict[str, Any], str]:
    attestation_root = private_output_root(REFERENCE_MODEL_ATTESTATION.parent)
    path = attestation_root / REFERENCE_MODEL_ATTESTATION.name
    if path.is_symlink():
        raise SystemExit("Refusing to read a symlinked reference-model attestation.")
    if not path.is_file():
        raise SystemExit(
            "Missing private reference-model attestation. Run stage-reference-model first."
        )
    try:
        attestation = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as error:
        raise SystemExit(f"The private reference-model attestation is invalid: {error}") from error
    if not isinstance(attestation, dict):
        raise SystemExit("The private reference-model attestation must be a JSON object.")
    validate_model_attestation(attestation)
    document_sha256 = file_sha256(path)
    if document_sha256 != serialized_json_sha256(attestation):
        raise SystemExit(
            "The private reference-model attestation is not canonically serialized. "
            "Run stage-reference-model again."
        )
    return attestation, document_sha256


def verify_model_snapshot(snapshot_root: Path, attestation: dict[str, Any]) -> None:
    validate_model_attestation(attestation)
    current = build_model_attestation(
        snapshot_root,
        generated_at=str(attestation.get("generatedAt", "")),
    )
    for field in ("contentTreeSha256", "fileCount", "totalBytes", "files"):
        if current[field] != attestation[field]:
            raise RuntimeError(
                f"Reference-model cache does not match its private attestation: {field}."
            )


def confined_output(root: Path, relative_file: str) -> Path:
    output = root / relative_file
    resolved = output.resolve(strict=False)
    if not resolved.is_relative_to(root):
        raise RuntimeError(f"Candidate path escapes the private run root: {relative_file}")
    return output


def exact_instruction(profile: str) -> str:
    return f"{SHARED_DIRECTION} {PROFILE_DELTAS[profile]}"


def immutable_plan(
    *,
    model_attestation: dict[str, Any] | None = None,
    model_attestation_sha256: str | None = None,
) -> dict[str, Any]:
    if model_attestation is None and model_attestation_sha256 is None:
        model_attestation, model_attestation_sha256 = read_model_attestation()
    if model_attestation is None or model_attestation_sha256 is None:
        raise RuntimeError("Model-attestation fixture arguments must be supplied together.")
    validate_model_attestation(model_attestation)
    if model_attestation_sha256 != serialized_json_sha256(model_attestation):
        raise RuntimeError(
            "The reference-model attestation document digest is invalid."
        )

    candidate_ids = tuple("abcdef")
    profiles: dict[str, Any] = {}
    for profile, seeds in CANDIDATE_SEEDS.items():
        profiles[profile] = {
            "sharedDirection": SHARED_DIRECTION,
            "profileDelta": PROFILE_DELTAS[profile],
            "exactInstruction": exact_instruction(profile),
            "candidates": [
                {
                    "candidateId": candidate_id,
                    "seed": seed,
                    "relativeFile": f"candidates/{profile}-{candidate_id}.wav",
                }
                for candidate_id, seed in zip(candidate_ids, seeds, strict=True)
            ],
        }
    return {
        "workflowId": WORKFLOW_ID,
        "purpose": (
            "Create auditable future replacement candidates; preserve the current "
            "maritime-command-v2 references and application assets."
        ),
        "model": {
            "repoId": MODEL_ID,
            "revision": MODEL_REVISION,
            "upstreamRepoId": UPSTREAM_MODEL_ID,
            "upstreamRevision": UPSTREAM_MODEL_REVISION,
            "attestation": {
                "file": ".voice-private/attestations/reference-voice-design-model.json",
                "modelAttestationSha256": model_attestation_sha256,
                "contentTreeSha256": model_attestation["contentTreeSha256"],
                "fileCount": model_attestation["fileCount"],
                "totalBytes": model_attestation["totalBytes"],
            },
        },
        "runtime": runtime_plan(),
        "script": {
            "file": Path(__file__).name,
            "sha256": file_sha256(Path(__file__).resolve()),
        },
        "referenceText": REFERENCE_TEXT,
        "generationSettings": GENERATION_SETTINGS,
        "outputValidation": {
            "format": "WAV",
            "subtype": "PCM_16",
            "expectedSampleRate": 24000,
            "channels": 1,
            "minimumDurationSeconds": MIN_DURATION_SECONDS,
            "maximumDurationSeconds": MAX_DURATION_SECONDS,
        },
        "profiles": profiles,
        "selectionGate": {
            "automatedPromotion": False,
            "humanListeningRequired": True,
            "criteria": [
                "Authentic contemporary British pronunciation",
                "Matched leadership energy, pace, attack, confidence, and warmth",
                "No shouting, growl, breathiness, caricature, or named-person imitation",
                "Exact spoken reference text with no omissions or additions",
            ],
        },
    }


def prepare(
    output_root: Path,
    *,
    repository_bound: bool = True,
    model_attestation: dict[str, Any] | None = None,
    model_attestation_sha256: str | None = None,
) -> None:
    root = private_output_root(output_root, repository_bound=repository_bound)
    root.mkdir(parents=True, exist_ok=True)
    receipt_path = root / RECEIPT_NAME
    if receipt_path.exists() or any(root.iterdir()):
        raise SystemExit(
            f"Refusing to replace a non-empty reference run: {root}"
        )

    plan = immutable_plan(
        model_attestation=model_attestation,
        model_attestation_sha256=model_attestation_sha256,
    )
    receipt = {
        "schemaVersion": 1,
        "status": "prepared",
        "preparedAt": utc_now(),
        "immutablePlan": plan,
        "immutablePlanSha256": value_sha256(plan),
        "execution": None,
        "outputs": {},
        "selection": {
            "status": "pending-human-listening",
            "selectedReferences": {},
        },
    }
    atomic_write_json(receipt_path, receipt)
    print(f"Prepared immutable receipt: {receipt_path}")
    print(f"Plan SHA-256: {receipt['immutablePlanSha256']}")
    print("No model was loaded and no audio was generated.")


def read_receipt(root: Path) -> tuple[Path, dict[str, Any]]:
    receipt_path = root / RECEIPT_NAME
    if receipt_path.is_symlink():
        raise SystemExit(f"Refusing to read a symlinked reference receipt: {receipt_path}")
    if not receipt_path.is_file():
        raise SystemExit(
            f"Missing prepared receipt: {receipt_path}. Run prepare first."
        )
    receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
    if not isinstance(receipt, dict):
        raise SystemExit("The reference receipt must contain a JSON object.")
    return receipt_path, receipt


def validate_plan(
    receipt: dict[str, Any],
    *,
    model_attestation: dict[str, Any] | None = None,
    model_attestation_sha256: str | None = None,
) -> dict[str, Any]:
    recorded_plan = receipt.get("immutablePlan")
    recorded_digest = receipt.get("immutablePlanSha256")
    if not isinstance(recorded_plan, dict) or not isinstance(recorded_digest, str):
        raise SystemExit("Receipt has no valid immutable plan and digest.")
    if value_sha256(recorded_plan) != recorded_digest:
        raise SystemExit("Receipt immutable-plan digest does not match its contents.")
    expected_plan = immutable_plan(
        model_attestation=model_attestation,
        model_attestation_sha256=model_attestation_sha256,
    )
    if recorded_plan != expected_plan:
        raise SystemExit(
            "Receipt plan does not match this exact script. Prepare a new run directory."
        )
    return recorded_plan


def validate_runtime(*, require_offline: bool = True) -> dict[str, Any]:
    actual_python = platform.python_version()
    if actual_python != EXPECTED_PYTHON:
        raise SystemExit(
            f"Python {actual_python} is active; expected exact Python {EXPECTED_PYTHON}."
        )
    if not sys.flags.isolated:
        raise SystemExit("Reference generation requires Python isolated mode (-I).")
    if sys.prefix == sys.base_prefix:
        raise SystemExit("Reference generation requires the authenticated private virtualenv.")
    if require_offline:
        offline_environment = {
            "UV_OFFLINE": os.environ.get("UV_OFFLINE"),
            "HF_HUB_OFFLINE": os.environ.get("HF_HUB_OFFLINE"),
            "TRANSFORMERS_OFFLINE": os.environ.get("TRANSFORMERS_OFFLINE"),
        }
        for variable, value in offline_environment.items():
            if value != "1":
                raise SystemExit(f"Reference generation requires {variable}=1.")

    approved_runtime = runtime_plan()
    expected = approved_runtime["packages"]
    actual_packages: dict[str, str] = {}
    for distribution in importlib.metadata.distributions():
        raw_name = distribution.metadata.get("Name")
        if not raw_name:
            raise SystemExit("An installed distribution has no authenticated package name.")
        package = canonical_name(raw_name)
        if package in actual_packages:
            raise SystemExit(f"Duplicate installed distribution: {package}.")
        actual_packages[package] = distribution.version
    if actual_packages != expected:
        missing = sorted(set(expected) - set(actual_packages))
        unexpected = sorted(set(actual_packages) - set(expected))
        mismatched = sorted(
            package
            for package in set(expected) & set(actual_packages)
            if expected[package] != actual_packages[package]
        )
        raise SystemExit(
            "Reference runtime inventory mismatch: "
            f"missing={missing}; unexpected={unexpected}; mismatched={mismatched}."
        )
    return {
        "python": actual_python,
        "lockSha256": VOICE_RUNTIME_LOCK_SHA256,
        "toolchainManifestSha256": VOICE_RUNTIME_MANIFEST_SHA256,
        "uv": approved_runtime["uv"],
        "pythonToolchain": approved_runtime["python"],
        "packages": dict(sorted(actual_packages.items())),
        "isolated": True,
        "offline": require_offline,
        "platform": platform.platform(),
        "machine": platform.machine(),
    }


def stage_model() -> None:
    from huggingface_hub import snapshot_download

    model_path = snapshot_download(repo_id=MODEL_ID, revision=MODEL_REVISION)
    attestation = build_model_attestation(Path(model_path))
    attestation_path = write_model_attestation(attestation)
    print(f"Staged exact VoiceDesign model snapshot at {model_path}")
    print(
        "Wrote private model attestation: "
        f"{attestation_path} ({attestation['fileCount']} files, "
        f"tree {attestation['contentTreeSha256']})."
    )


def verify_recorded_outputs(root: Path, receipt: dict[str, Any]) -> int:
    outputs = receipt.get("outputs", {})
    if not isinstance(outputs, dict):
        raise RuntimeError("Receipt outputs must be a JSON object.")
    verified = 0
    for output_id, record in outputs.items():
        if not isinstance(record, dict) or not isinstance(record.get("relativeFile"), str):
            raise RuntimeError(f"Invalid output record: {output_id}.")
        output = confined_output(root, record["relativeFile"])
        if output.is_symlink():
            raise RuntimeError(f"Recorded output must not be a symlink: {output}.")
        if not output.is_file():
            raise RuntimeError(f"Recorded output is missing: {output}.")
        if file_sha256(output) != record.get("sha256"):
            raise RuntimeError(f"Recorded output hash mismatch: {output}.")
        verified += 1
    return verified


def generate(output_root: Path, resume: bool, runtime: dict[str, Any]) -> None:
    root = private_output_root(output_root)
    model_attestation, model_attestation_sha256 = read_model_attestation()
    receipt_path, receipt = read_receipt(root)
    plan = validate_plan(
        receipt,
        model_attestation=model_attestation,
        model_attestation_sha256=model_attestation_sha256,
    )
    status = receipt.get("status")
    allowed = {"prepared"} if not resume else {"prepared", "generating", "failed"}
    if status not in allowed:
        raise SystemExit(
            f"Receipt status is {status!r}; allowed status for this command: {sorted(allowed)}."
        )
    verify_recorded_outputs(root, receipt)

    receipt["status"] = "generating"
    execution = receipt.get("execution")
    if not isinstance(execution, dict):
        execution = {
            "startedAt": utc_now(),
            "resumeCount": 0,
        }
        receipt["execution"] = execution
    elif resume:
        execution["resumeCount"] = int(execution.get("resumeCount", 0)) + 1
        execution["lastResumedAt"] = utc_now()
    execution["runtime"] = runtime
    atomic_write_json(receipt_path, receipt)

    # Heavy/runtime-sensitive imports intentionally occur only after the prepared
    # receipt and generating state have both been durably written.
    try:
        import mlx.core as mx
        import numpy as np
        import soundfile as sf
        from huggingface_hub import snapshot_download
        from mlx_audio.tts.utils import load_model

        model_path = snapshot_download(
            repo_id=MODEL_ID,
            revision=MODEL_REVISION,
            local_files_only=True,
        )
        verify_model_snapshot(Path(model_path), model_attestation)
        execution["modelAttestationSha256"] = model_attestation_sha256
        execution["modelContentTreeSha256"] = model_attestation[
            "contentTreeSha256"
        ]
        execution["resolvedModelSnapshot"] = str(Path(model_path).resolve())
        atomic_write_json(receipt_path, receipt)
        model = load_model(model_path)
        if model.sample_rate != 24000:
            raise RuntimeError(
                f"VoiceDesign sample rate is {model.sample_rate}; expected 24000."
            )
        generate_voice_design = getattr(model, "generate_voice_design", None)
        if not callable(generate_voice_design):
            raise RuntimeError(
                "Pinned MLX VoiceDesign model does not expose generate_voice_design()."
            )

        candidates_root = root / "candidates"
        candidates_root.mkdir(parents=True, exist_ok=True)
        outputs = receipt.setdefault("outputs", {})
        for profile, profile_plan in plan["profiles"].items():
            for candidate in profile_plan["candidates"]:
                candidate_id = candidate["candidateId"]
                output_id = f"{profile}/{candidate_id}"
                output = confined_output(root, candidate["relativeFile"])
                if output_id in outputs:
                    continue
                if output.exists():
                    raise RuntimeError(
                        f"Unrecorded output already exists; refusing to replace it: {output}"
                    )

                seed = int(candidate["seed"])
                random.seed(seed)
                np.random.seed(seed)
                mx.random.seed(seed)
                print(f"Generating {output_id} (seed {seed})", flush=True)
                settings = plan["generationSettings"]
                results = list(
                    generate_voice_design(
                        text=plan["referenceText"],
                        instruct=profile_plan["exactInstruction"],
                        language=settings["language"],
                        temperature=settings["temperature"],
                        top_k=settings["topK"],
                        top_p=settings["topP"],
                        repetition_penalty=settings["repetitionPenalty"],
                        max_tokens=settings["maxTokens"],
                        stream=settings["stream"],
                        streaming_interval=settings["streamingInterval"],
                        verbose=settings["verbose"],
                    )
                )
                if len(results) != 1:
                    raise RuntimeError(
                        f"Expected one result for {output_id}; got {len(results)}."
                    )
                audio = np.asarray(results[0].audio, dtype=np.float32).reshape(-1)
                if audio.size == 0 or not np.isfinite(audio).all():
                    raise RuntimeError(f"Invalid audio generated for {output_id}.")
                duration = audio.size / model.sample_rate
                if not MIN_DURATION_SECONDS <= duration <= MAX_DURATION_SECONDS:
                    raise RuntimeError(
                        f"Unexpected {duration:.3f}s duration for {output_id}."
                    )

                temporary = output.with_name(f".{output.name}.{os.getpid()}.partial.wav")
                sf.write(temporary, audio, model.sample_rate, subtype="PCM_16")
                os.replace(temporary, output)
                outputs[output_id] = {
                    "profile": profile,
                    "candidateId": candidate_id,
                    "relativeFile": candidate["relativeFile"],
                    "seed": seed,
                    "durationSeconds": round(duration, 3),
                    "sampleCount": int(audio.size),
                    "sampleRate": model.sample_rate,
                    "channels": 1,
                    "format": "WAV",
                    "subtype": "PCM_16",
                    "sha256": file_sha256(output),
                    "generatedAt": utc_now(),
                }
                atomic_write_json(receipt_path, receipt)

        receipt["status"] = "generated-awaiting-human-listening"
        execution["completedAt"] = utc_now()
        execution["outputCount"] = len(outputs)
        atomic_write_json(receipt_path, receipt)
        print(f"Generated {len(outputs)} candidates. Receipt: {receipt_path}")
        print("No candidate was selected or promoted; human listening is required.")
    except BaseException as error:
        receipt["status"] = "failed"
        execution["failedAt"] = utc_now()
        execution["failureType"] = type(error).__name__
        execution["failureMessage"] = str(error)
        atomic_write_json(receipt_path, receipt)
        raise


def verify(
    output_root: Path,
    *,
    repository_bound: bool = True,
    model_attestation: dict[str, Any] | None = None,
    model_attestation_sha256: str | None = None,
) -> None:
    root = private_output_root(output_root, repository_bound=repository_bound)
    _, receipt = read_receipt(root)
    validate_plan(
        receipt,
        model_attestation=model_attestation,
        model_attestation_sha256=model_attestation_sha256,
    )
    count = verify_recorded_outputs(root, receipt)
    print(f"Verified immutable plan and {count} recorded candidate file(s).")
    if receipt.get("status") == "generated-awaiting-human-listening":
        print(
            "Generation is complete; human accent and leadership-energy review "
            "remains required."
        )


def self_check() -> None:
    with tempfile.TemporaryDirectory(prefix="kb-form-voice-reference-") as temporary:
        temporary_root = Path(temporary)
        model_snapshot = temporary_root / "model-snapshot"
        model_snapshot.mkdir()
        (model_snapshot / "config.json").write_text(
            '{"fixture":true}\n', encoding="utf-8"
        )
        weights = model_snapshot / "weights.safetensors"
        weights.write_bytes(b"deterministic-model-fixture")
        model_attestation = build_model_attestation(
            model_snapshot,
            generated_at="2026-08-02T00:00:00+00:00",
        )
        model_attestation_sha256 = serialized_json_sha256(model_attestation)
        verify_model_snapshot(model_snapshot, model_attestation)

        private_root = temporary_root / ".voice-private" / "self-check"
        prepare(
            private_root,
            repository_bound=False,
            model_attestation=model_attestation,
            model_attestation_sha256=model_attestation_sha256,
        )
        verify(
            private_root,
            repository_bound=False,
            model_attestation=model_attestation,
            model_attestation_sha256=model_attestation_sha256,
        )

        try:
            prepare(
                private_root,
                repository_bound=False,
                model_attestation=model_attestation,
                model_attestation_sha256=model_attestation_sha256,
            )
        except SystemExit:
            pass
        else:
            raise RuntimeError("Self-check failed: a prepared run could be overwritten.")

        receipt_path, receipt = read_receipt(private_root)
        recorded_runtime = receipt["immutablePlan"]["runtime"]
        authenticated_manifest = authenticated_runtime_manifest()
        if (
            recorded_runtime.get("toolchainManifestSha256")
            != VOICE_RUNTIME_MANIFEST_SHA256
            or recorded_runtime.get("uv") != authenticated_manifest["uv"]
            or recorded_runtime.get("python") != authenticated_manifest["python"]
        ):
            raise RuntimeError(
                "Self-check failed: the immutable plan omitted toolchain provenance."
            )
        recorded_attestation = receipt["immutablePlan"]["model"]["attestation"]
        if (
            recorded_attestation.get("modelAttestationSha256")
            != model_attestation_sha256
            or recorded_attestation.get("contentTreeSha256")
            != model_attestation["contentTreeSha256"]
        ):
            raise RuntimeError(
                "Self-check failed: the immutable plan omitted model attestation."
            )

        changed_attestation = json.loads(json.dumps(model_attestation))
        changed_attestation["generatedAt"] = "2026-08-02T00:00:01+00:00"
        try:
            validate_plan(
                receipt,
                model_attestation=changed_attestation,
                model_attestation_sha256=serialized_json_sha256(changed_attestation),
            )
        except SystemExit:
            pass
        else:
            raise RuntimeError(
                "Self-check failed: a different model attestation matched the plan."
            )

        weights.write_bytes(b"tampered-model-fixture")
        try:
            verify_model_snapshot(model_snapshot, model_attestation)
        except RuntimeError:
            pass
        else:
            raise RuntimeError("Self-check failed: model-cache tampering was accepted.")

        receipt["immutablePlan"]["referenceText"] = "tampered"
        atomic_write_json(receipt_path, receipt)
        try:
            validate_plan(
                receipt,
                model_attestation=model_attestation,
                model_attestation_sha256=model_attestation_sha256,
            )
        except SystemExit:
            pass
        else:
            raise RuntimeError("Self-check failed: plan tampering was accepted.")

        symlink_receipt_root = (
            temporary_root / ".voice-private" / "symlink-receipt-check"
        )
        symlink_receipt_root.mkdir()
        receipt_target = symlink_receipt_root / "receipt-target.json"
        atomic_write_json(receipt_target, {})
        (symlink_receipt_root / RECEIPT_NAME).symlink_to(receipt_target.name)
        try:
            read_receipt(symlink_receipt_root)
        except SystemExit:
            pass
        else:
            raise RuntimeError("Self-check failed: a symlinked receipt was accepted.")

        symlink_output_root = (
            temporary_root / ".voice-private" / "symlink-output-check"
        )
        candidates_root = symlink_output_root / "candidates"
        candidates_root.mkdir(parents=True)
        output_target = candidates_root / "target.wav"
        output_target.write_bytes(b"not-an-audio-file")
        output_link = candidates_root / "linked.wav"
        output_link.symlink_to(output_target.name)
        symlink_output_receipt = {
            "outputs": {
                "fixture": {
                    "relativeFile": "candidates/linked.wav",
                    "sha256": file_sha256(output_target),
                }
            }
        }
        try:
            verify_recorded_outputs(symlink_output_root, symlink_output_receipt)
        except RuntimeError:
            pass
        else:
            raise RuntimeError(
                "Self-check failed: a symlinked recorded output was accepted."
            )

        try:
            private_output_root(temporary_root / "public", repository_bound=False)
        except SystemExit:
            pass
        else:
            raise RuntimeError("Self-check failed: a public output path was accepted.")

        try:
            private_output_root(private_root, repository_bound=True)
        except SystemExit:
            pass
        else:
            raise RuntimeError("Self-check failed: an external private root was accepted.")

        try:
            confined_output(private_root, "../../escaped.wav")
        except RuntimeError:
            pass
        else:
            raise RuntimeError("Self-check failed: an escaping candidate path was accepted.")

    print("Reference workflow self-check passed.")


def main() -> None:
    args = parse_args()
    if args.command == "self-check":
        self_check()
        return

    runtime = validate_runtime(require_offline=args.command != "stage-model")
    if args.command == "stage-model":
        stage_model()
    elif args.command == "check-runtime":
        print(
            "Reference runtime verified: "
            f"Python {runtime['python']}, {len(runtime['packages'])} locked distributions."
        )
    elif args.command == "prepare":
        prepare(args.output_root)
    elif args.command == "generate":
        generate(args.output_root, args.resume, runtime)
    elif args.command == "verify":
        verify(args.output_root)
    else:  # pragma: no cover - argparse prevents this branch.
        raise SystemExit(f"Unknown command: {args.command}")


if __name__ == "__main__":
    main()
