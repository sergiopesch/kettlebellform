#!/usr/bin/env python3
"""Generate the private raw WAV inputs for the Maritime Command voice pack.

This is a release tool, not an application or CI dependency. Run it only through
scripts/run-coach-voice-generation.py. References and generated WAVs must remain
below the gitignored `.voice-private/` directory.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import json
import os
import platform
import re
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

MODEL_ID = "mlx-community/Qwen3-TTS-12Hz-1.7B-Base-bf16"
REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
PRIVATE_ROOT = REPOSITORY_ROOT / ".voice-private"
MODEL_REVISION = "a6eb4f68e4b056f1215157bb696209bc82a6db48"
UPSTREAM_MODEL_ID = "Qwen/Qwen3-TTS-12Hz-1.7B-Base"
UPSTREAM_MODEL_REVISION = "fd4b254389122332181a7c3db7f27e918eec64e3"
REFERENCE_TEXT = (
    "After the last set, stand tall; keep your shoulders back, breathe steadily, "
    "and drive forward with purpose. Good—hold that standard. You are ready."
)
PROFILE_IDS = ("male-command", "female-command")
CUES = {
    "finding": "Step into the camera view.",
    "adjust-frame": "Bring your full body into view.",
    "move-left": "Move a little left in the frame.",
    "move-right": "Move a little right in the frame.",
    "step-back": (
        "Step away from the camera. Keep your head, hands, and feet in view."
    ),
    "move-closer": "Move a little closer.",
    "turn-side-on": "Turn side-on to the camera.",
    "ready": "Great. You are in a good position.",
    "coach-on": "Voice framing coach on.",
    "male-command-selected": "Male British coach selected.",
    "female-command-selected": "Female British coach selected.",
}
BASE_SEED = 2026080100
EXPECTED_PYTHON = "3.12.13"
VOICE_RUNTIME_LOCK_PATH = (
    REPOSITORY_ROOT / "requirements/voice-generation.lock"
)
VOICE_RUNTIME_LOCK_SHA256 = "2d8fc14de6f8c33fe817a59eb914cdef0fc7238626b51469fd4508084e59ccf8"
REQUIREMENT_PATTERN = re.compile(
    r"^([A-Za-z0-9_.-]+)==([^\s;\\]+)(?:\s*\\)?$"
)
HASH_PATTERN = re.compile(r"--hash=sha256:([0-9a-f]{64})(?:\s*\\)?$")
GENERATION_SETTINGS = {
    "language": "english",
    "temperature": 0.7,
    "topP": 0.9,
    "topK": 50,
    "repetitionPenalty": 1.5,
    "maxTokens": 384,
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    actions = parser.add_mutually_exclusive_group()
    actions.add_argument(
        "--check-runtime",
        action="store_true",
        help="Verify the frozen runtime without importing a third-party package.",
    )
    actions.add_argument(
        "--stage-model",
        action="store_true",
        help="Download only the exact public model revision into the local cache.",
    )
    parser.add_argument(
        "reference_root",
        type=Path,
        nargs="?",
        help="Private directory containing male-command.wav and female-command.wav.",
    )
    parser.add_argument(
        "output_root",
        type=Path,
        nargs="?",
        help="Private output directory for profile/cue WAV files.",
    )
    parser.add_argument(
        "--seed-offset",
        type=int,
        default=0,
        help="Recorded offset for deliberately regenerating a complete candidate pack.",
    )
    parser.add_argument(
        "--override",
        action="append",
        default=[],
        metavar="PROFILE/CUE=SEED",
        help=(
            "Regenerate only this cue with an exact recorded seed. Repeat for more "
            "cues; the existing receipt is updated in place."
        ),
    )
    args = parser.parse_args()
    if args.check_runtime or args.stage_model:
        if args.reference_root is not None or args.output_root is not None:
            parser.error("runtime and model checks do not accept private paths")
    elif args.reference_root is None or args.output_root is None:
        parser.error("reference_root and output_root are required for generation")
    return args


def sha256(path: Path) -> str:
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
    if sha256(VOICE_RUNTIME_LOCK_PATH) != VOICE_RUNTIME_LOCK_SHA256:
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


def validate_runtime(*, require_offline: bool = True) -> dict[str, Any]:
    """Fail closed using only the standard library before any third-party import."""

    if platform.python_version() != EXPECTED_PYTHON:
        raise SystemExit(
            f"Voice generation requires exact Python {EXPECTED_PYTHON}; "
            f"found {platform.python_version()}."
        )
    if not sys.flags.isolated:
        raise SystemExit("Voice generation requires Python isolated mode (-I).")
    if sys.prefix == sys.base_prefix:
        raise SystemExit("Voice generation requires the authenticated private virtualenv.")
    if require_offline:
        offline_environment = {
            "UV_OFFLINE": os.environ.get("UV_OFFLINE"),
            "HF_HUB_OFFLINE": os.environ.get("HF_HUB_OFFLINE"),
            "TRANSFORMERS_OFFLINE": os.environ.get("TRANSFORMERS_OFFLINE"),
        }
        for variable, value in offline_environment.items():
            if value != "1":
                raise SystemExit(f"Voice generation requires {variable}=1.")

    expected = locked_distributions()
    installed: dict[str, str] = {}
    for distribution in importlib.metadata.distributions():
        raw_name = distribution.metadata.get("Name")
        if not raw_name:
            raise SystemExit("An installed distribution has no authenticated package name.")
        name = canonical_name(raw_name)
        if name in installed:
            raise SystemExit(f"Duplicate installed distribution: {name}.")
        installed[name] = distribution.version
    if installed != expected:
        missing = sorted(set(expected) - set(installed))
        unexpected = sorted(set(installed) - set(expected))
        mismatched = sorted(
            name
            for name in set(expected) & set(installed)
            if expected[name] != installed[name]
        )
        details = []
        if missing:
            details.append(f"missing={missing}")
        if unexpected:
            details.append(f"unexpected={unexpected}")
        if mismatched:
            details.append(
                "mismatched="
                + repr(
                    {
                        name: {"expected": expected[name], "installed": installed[name]}
                        for name in mismatched
                    }
                )
            )
        raise SystemExit("Voice runtime inventory mismatch: " + "; ".join(details))

    return {
        "pythonVersion": platform.python_version(),
        "isolated": True,
        "offline": require_offline,
        "lockSha256": VOICE_RUNTIME_LOCK_SHA256,
        "distributions": dict(sorted(installed.items())),
    }


def parse_overrides(values: list[str]) -> dict[tuple[str, str], int]:
    overrides: dict[tuple[str, str], int] = {}
    for value in values:
        try:
            target, raw_seed = value.rsplit("=", 1)
            profile, cue_id = target.split("/", 1)
            seed = int(raw_seed)
        except ValueError as error:
            raise SystemExit(
                f"Invalid --override {value!r}; expected PROFILE/CUE=SEED."
            ) from error
        if profile not in PROFILE_IDS or cue_id not in CUES or seed < 0:
            raise SystemExit(f"Invalid --override target or seed: {value!r}.")
        overrides[(profile, cue_id)] = seed
    return overrides


def confined_private_path(path: Path, *, label: str) -> Path:
    if (
        PRIVATE_ROOT.is_symlink()
        or not PRIVATE_ROOT.is_dir()
        or PRIVATE_ROOT.resolve() != PRIVATE_ROOT
        or PRIVATE_ROOT.stat().st_mode & 0o077
    ):
        raise SystemExit(
            "The repository .voice-private root must be a private, non-symlinked directory."
        )
    resolved = path.expanduser().resolve(strict=False)
    if resolved == PRIVATE_ROOT or not resolved.is_relative_to(PRIVATE_ROOT):
        raise SystemExit(
            f"{label} must resolve below this repository's .voice-private directory."
        )
    return resolved


def write_receipt_atomically(path: Path, receipt: dict[str, Any]) -> None:
    serialized = json.dumps(receipt, indent=2) + "\n"
    temporary_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            dir=path.parent,
            prefix=f".{path.name}.",
            suffix=".tmp",
            delete=False,
        ) as temporary:
            temporary_path = Path(temporary.name)
            os.chmod(temporary_path, 0o600)
            temporary.write(serialized)
            temporary.flush()
            os.fsync(temporary.fileno())
        os.replace(temporary_path, path)
        temporary_path = None
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if temporary_path is not None:
            temporary_path.unlink(missing_ok=True)


def stage_exact_model() -> Path:
    from huggingface_hub import snapshot_download

    return Path(snapshot_download(repo_id=MODEL_ID, revision=MODEL_REVISION))


def main() -> None:
    args = parse_args()
    runtime = validate_runtime(require_offline=not args.stage_model)

    if args.check_runtime:
        print(
            "Voice runtime verified: "
            f"Python {runtime['pythonVersion']}, "
            f"{len(runtime['distributions'])} locked distributions."
        )
        return

    if args.stage_model:
        model_path = stage_exact_model()
        print(f"Staged exact model snapshot at {model_path}")
        return

    overrides = parse_overrides(args.override)
    assert args.reference_root is not None
    assert args.output_root is not None
    reference_root = confined_private_path(args.reference_root, label="reference_root")
    output_root = confined_private_path(args.output_root, label="output_root")
    references = {
        profile: reference_root / f"{profile}.wav" for profile in PROFILE_IDS
    }
    missing = [str(path) for path in references.values() if not path.is_file()]
    if missing:
        raise SystemExit(f"Missing reference WAV(s): {', '.join(missing)}")

    output_root.mkdir(parents=True, exist_ok=True)
    receipt_path = output_root / "generation-receipt.json"
    now = datetime.now(timezone.utc).isoformat()
    reference_receipt = {
        profile: {
            "file": str(path),
            "sha256": sha256(path),
        }
        for profile, path in references.items()
    }
    receipt: dict[str, Any] = {
        "schemaVersion": 1,
        "status": "planned",
        "plannedAt": now,
        "generatedAt": now,
        "model": MODEL_ID,
        "modelRevision": MODEL_REVISION,
        "upstreamModel": UPSTREAM_MODEL_ID,
        "upstreamModelRevision": UPSTREAM_MODEL_REVISION,
        "runtime": runtime,
        "pythonVersion": platform.python_version(),
        "mlxVersion": importlib.metadata.version("mlx"),
        "mlxAudioVersion": importlib.metadata.version("mlx-audio"),
        "soundfileVersion": importlib.metadata.version("soundfile"),
        "referenceText": REFERENCE_TEXT,
        "generationSettings": GENERATION_SETTINGS,
        "seedOffset": args.seed_offset,
        "references": reference_receipt,
        "clips": {},
    }
    if overrides and receipt_path.is_file():
        receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
        if (
            receipt.get("model") != MODEL_ID
            or receipt.get("modelRevision") != MODEL_REVISION
            or receipt.get("referenceText") != REFERENCE_TEXT
            or receipt.get("generationSettings", GENERATION_SETTINGS)
            != GENERATION_SETTINGS
        ):
            raise SystemExit(
                "Existing generation receipt does not match this toolchain."
            )
        # Backfill receipts created before generation settings were recorded.
        receipt["status"] = "planned"
        receipt["plannedAt"] = now
        receipt["generationSettings"] = GENERATION_SETTINGS
        receipt["runtime"] = runtime
        receipt["references"] = reference_receipt
        receipt["lastUpdatedAt"] = now

    # Persist the authenticated toolchain and complete generation plan before any
    # model code is imported or loaded and before private voice inference begins.
    write_receipt_atomically(receipt_path, receipt)

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
    model = load_model(model_path)
    receipt["sampleRate"] = model.sample_rate
    receipt["status"] = "generating"
    receipt["generationStartedAt"] = datetime.now(timezone.utc).isoformat()
    write_receipt_atomically(receipt_path, receipt)

    for profile_index, profile in enumerate(PROFILE_IDS):
        profile_root = output_root / profile
        profile_root.mkdir(parents=True, exist_ok=True)
        profile_receipt = receipt.setdefault("clips", {}).setdefault(profile, {})
        for cue_index, (cue_id, text) in enumerate(CUES.items()):
            if overrides and (profile, cue_id) not in overrides:
                continue
            seed = overrides.get(
                (profile, cue_id),
                BASE_SEED + args.seed_offset + profile_index * 100 + cue_index,
            )
            mx.random.seed(seed)
            print(f"Generating {profile}/{cue_id} (seed {seed})", flush=True)
            results = list(
                model.generate(
                    text=text,
                    lang_code=GENERATION_SETTINGS["language"],
                    ref_audio=str(references[profile]),
                    ref_text=REFERENCE_TEXT,
                    temperature=GENERATION_SETTINGS["temperature"],
                    top_p=GENERATION_SETTINGS["topP"],
                    top_k=GENERATION_SETTINGS["topK"],
                    repetition_penalty=GENERATION_SETTINGS["repetitionPenalty"],
                    max_tokens=GENERATION_SETTINGS["maxTokens"],
                    verbose=False,
                )
            )
            if len(results) != 1:
                raise RuntimeError(
                    f"Expected one result for {profile}/{cue_id}; got {len(results)}."
                )
            audio = np.asarray(results[0].audio, dtype=np.float32).reshape(-1)
            if audio.size == 0 or not np.isfinite(audio).all():
                raise RuntimeError(f"Invalid audio for {profile}/{cue_id}.")
            duration = audio.size / model.sample_rate
            if duration < 0.3 or duration > 8:
                raise RuntimeError(
                    f"Unexpected {duration:.2f}s duration for {profile}/{cue_id}."
                )
            output = profile_root / f"{cue_id}.wav"
            sf.write(output, audio, model.sample_rate, subtype="PCM_16")
            profile_receipt[cue_id] = {
                "text": text,
                "seed": seed,
                "durationSeconds": round(duration, 3),
                "sha256": sha256(output),
            }
            receipt["lastUpdatedAt"] = datetime.now(timezone.utc).isoformat()
            write_receipt_atomically(receipt_path, receipt)

    receipt["status"] = "complete"
    receipt["completedAt"] = datetime.now(timezone.utc).isoformat()
    write_receipt_atomically(receipt_path, receipt)
    print(f"Wrote {receipt_path}", flush=True)


if __name__ == "__main__":
    main()
