from __future__ import annotations

import ctypes
import errno
import json
import os
import shutil
import subprocess
import sys
import tempfile
from hashlib import sha256
from pathlib import Path

ROOT = Path(__file__).parents[2]
DIST = Path(os.environ.get("KALEIDOSCOPE_ARTIFACT_DIR", ROOT / "dist")).resolve()
WHEELHOUSE = DIST / "wheelhouse"
WHEEL_NAME = "vapoursynth_kaleidoscope-0.1.0-py3-none-any.whl"
MANIFEST_NAME = "manifest.json"
AT_FDCWD = -100
RENAME_EXCHANGE = 2
UNSUPPORTED_EXCHANGE_ERRORS = {
    errno.ENOSYS,
    errno.EINVAL,
    errno.EOPNOTSUPP,
}
RECOVERY_GLOB = ".wheelhouse-download-*"


def only_wheel() -> Path:
    wheel = DIST / WHEEL_NAME
    if not wheel.is_file():
        raise RuntimeError(f"Expected wheel artifact {wheel}")
    return wheel


def pip_environment() -> dict[str, str]:
    environment = {
        key: value for key, value in os.environ.items() if not key.startswith("PIP_")
    }
    for variable in ("PYTHONHOME", "PYTHONPATH"):
        environment.pop(variable, None)
    environment.update(
        {
            "PIP_CONFIG_FILE": os.devnull,
            "PIP_DISABLE_PIP_VERSION_CHECK": "1",
        }
    )
    return environment


def file_hash(path: Path) -> str:
    return sha256(path.read_bytes()).hexdigest()


def require_supported_host() -> None:
    if not sys.platform.startswith("linux"):
        raise RuntimeError("Linux renameat2 is required for wheelhouse publication")
    library = ctypes.CDLL(None, use_errno=True)
    if not hasattr(library, "renameat2"):
        raise RuntimeError("Linux renameat2 is required for wheelhouse publication")


def reject_interrupted_publication() -> None:
    recovery_directories = sorted(DIST.glob(RECOVERY_GLOB))
    if recovery_directories:
        locations = ", ".join(str(path) for path in recovery_directories)
        raise RuntimeError(
            "Interrupted wheelhouse publication requires manual recovery; "
            f"preserved directories: {locations}"
        )


def sync_directory(directory: Path) -> None:
    descriptor = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def write_manifest(directory: Path, release_wheel: Path) -> None:
    entries = sorted(directory.iterdir())
    if not entries or any(
        entry.is_symlink() or not entry.is_file() or entry.suffix != ".whl"
        for entry in entries
    ):
        raise RuntimeError("Wheelhouse download must contain only regular wheel files")
    downloaded_wheel = directory / WHEEL_NAME
    if not downloaded_wheel.is_file():
        raise RuntimeError(f"Downloaded wheelhouse is missing {WHEEL_NAME}")
    if downloaded_wheel.read_bytes() != release_wheel.read_bytes():
        raise RuntimeError(
            "Downloaded package wheel does not match the release artifact"
        )
    manifest = {
        "algorithm": "sha256",
        "files": {entry.name: file_hash(entry) for entry in entries},
    }
    for entry in entries:
        with entry.open("rb") as wheel:
            os.fsync(wheel.fileno())
    with (directory / MANIFEST_NAME).open("w") as manifest_file:
        manifest_file.write(json.dumps(manifest, indent=2, sort_keys=True) + "\n")
        manifest_file.flush()
        os.fsync(manifest_file.fileno())
    sync_directory(directory)


def copy_prefetched_wheels(
    source: Path,
    destination: Path,
    release_wheel: Path,
) -> None:
    if not source.is_absolute() or source.is_symlink() or not source.is_dir():
        raise RuntimeError(f"Expected prefetched wheel directory at {source}")
    entries = sorted(source.iterdir())
    if not entries or any(
        entry.is_symlink() or not entry.is_file() or entry.suffix != ".whl"
        for entry in entries
    ):
        raise RuntimeError("Prefetched dependencies must contain only wheel files")
    for entry in entries:
        shutil.copyfile(entry, destination / entry.name)
    shutil.copyfile(release_wheel, destination / release_wheel.name)


def exchange_directories(left: Path, right: Path) -> None:
    require_supported_host()
    library = ctypes.CDLL(None, use_errno=True)
    try:
        renameat2 = library.renameat2
    except AttributeError as error:
        raise RuntimeError(
            "Linux renameat2 is required for wheelhouse publication"
        ) from error
    renameat2.argtypes = [
        ctypes.c_int,
        ctypes.c_char_p,
        ctypes.c_int,
        ctypes.c_char_p,
        ctypes.c_uint,
    ]
    renameat2.restype = ctypes.c_int
    if (
        renameat2(
            AT_FDCWD,
            os.fsencode(left),
            AT_FDCWD,
            os.fsencode(right),
            RENAME_EXCHANGE,
        )
        != 0
    ):
        error_number = ctypes.get_errno()
        error = OSError(
            error_number,
            os.strerror(error_number),
            f"{left} <-> {right}",
        )
        if error_number in UNSUPPORTED_EXCHANGE_ERRORS:
            raise RuntimeError(
                "Linux renameat2(RENAME_EXCHANGE) filesystem support is required "
                "for crash-atomic wheelhouse publication"
            ) from error
        raise error


def replace_wheelhouse(fresh_directory: Path) -> None:
    require_supported_host()
    if WHEELHOUSE.exists():
        if WHEELHOUSE.is_symlink() or not WHEELHOUSE.is_dir():
            raise RuntimeError(f"Expected wheelhouse directory at {WHEELHOUSE}")
        try:
            exchange_directories(fresh_directory, WHEELHOUSE)
        except BaseException:
            shutil.rmtree(fresh_directory, ignore_errors=True)
            raise
        try:
            sync_directory(DIST)
        except BaseException as publish_error:
            try:
                exchange_directories(fresh_directory, WHEELHOUSE)
            except BaseException as rollback_error:
                raise RuntimeError(
                    "Wheelhouse publication durability failed and rollback failed; "
                    f"the previous wheelhouse is preserved at {fresh_directory} "
                    f"and the candidate remains at {WHEELHOUSE}"
                ) from ExceptionGroup(
                    "Wheelhouse publication and rollback failures",
                    [publish_error, rollback_error],
                )
            try:
                sync_directory(DIST)
            except BaseException as rollback_sync_error:
                raise RuntimeError(
                    f"The previous wheelhouse was restored at {WHEELHOUSE}, but "
                    "rollback durability could not be confirmed; the replacement "
                    f"is preserved at {fresh_directory}"
                ) from ExceptionGroup(
                    "Wheelhouse publication and rollback sync failures",
                    [publish_error, rollback_sync_error],
                )
            try:
                shutil.rmtree(fresh_directory)
                sync_directory(DIST)
            except BaseException as cleanup_error:
                raise RuntimeError(
                    f"The previous wheelhouse was restored at {WHEELHOUSE}, but "
                    f"the replacement could not be removed from {fresh_directory}"
                ) from ExceptionGroup(
                    "Wheelhouse publication and cleanup failures",
                    [publish_error, cleanup_error],
                )
            raise
        shutil.rmtree(fresh_directory)
        sync_directory(DIST)
        return
    os.replace(fresh_directory, WHEELHOUSE)
    sync_directory(DIST)


def main() -> None:
    DIST.mkdir(parents=True, exist_ok=True)
    require_supported_host()
    reject_interrupted_publication()
    release_wheel = only_wheel()
    fresh_directory = Path(tempfile.mkdtemp(prefix=".wheelhouse-download-", dir=DIST))
    try:
        prefetched = os.environ.get("KALEIDOSCOPE_WHEELHOUSE_SOURCE")
        if prefetched is None:
            subprocess.run(
                [
                    sys.executable,
                    "-m",
                    "pip",
                    "--isolated",
                    "download",
                    "--no-cache-dir",
                    "--dest",
                    str(fresh_directory),
                    "--only-binary=:all:",
                    "hatchling==1.31.0",
                    "ipykernel>=7,<8",
                    "nbclient>=0.10,<0.11",
                    "nbformat>=5.10,<6",
                    str(release_wheel),
                ],
                cwd=ROOT,
                env=pip_environment(),
                check=True,
            )
        else:
            copy_prefetched_wheels(
                Path(prefetched),
                fresh_directory,
                release_wheel,
            )
        write_manifest(fresh_directory, release_wheel)
    except BaseException:
        shutil.rmtree(fresh_directory, ignore_errors=True)
        raise
    replace_wheelhouse(fresh_directory)


if __name__ == "__main__":
    main()
