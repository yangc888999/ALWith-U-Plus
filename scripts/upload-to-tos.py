"""Mirror tagged GitHub release binaries to TOS; leave updater metadata unchanged."""

import os
import re
import sys
from collections.abc import Callable
from pathlib import Path

# Two explicit asset classes instead of an optional "(\.sig)?" tail: archives and their updater
# signatures are both mirrored, and the pairing below makes signatures mandatory. DMGs, EXEs, MSIs
# and .app.tar.gz archives all stay recognisable.
ARCHIVE = re.compile(r"\.(?:dmg|exe|msi|app\.tar\.gz)$")
SIGNATURE = re.compile(r"\.(?:dmg|exe|msi|app\.tar\.gz)\.sig$")
# DMGs are full installers, not updater packages; Tauri does not produce a signature for them.
SIGNED_ARCHIVE = re.compile(r"\.(?:exe|msi|app\.tar\.gz)$")


def mirror_release(directory: Path, tag: str, upload: Callable[[Path, str], None]) -> int:
    number = r"(?:0|[1-9][0-9]*)"
    identifier = rf"(?:{number}|[0-9]*[A-Za-z-][0-9A-Za-z-]*)"
    if not re.fullmatch(rf"v{number}\.{number}\.{number}(?:-{identifier}(?:\.{identifier})*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?", tag):
        raise ValueError("Expected a v<semver> release tag")
    files = sorted(
        file for file in directory.iterdir()
        if file.is_file() and not file.is_symlink()
        and (ARCHIVE.search(file.name) or SIGNATURE.search(file.name))
    )
    if not files:
        raise ValueError("No release assets found to mirror")
    names = {file.name for file in files}
    # Validate the whole set before the first write to TOS.
    for file in files:
        if not file.name.startswith(f"alwith-u_{tag[1:]}_"):
            raise ValueError(f"Asset version does not match {tag}: {file.name}")
        if file.stat().st_size == 0:
            raise ValueError(f"Release asset is empty: {file.name}")
    # Signatures and archives must pair by name; every signed archive needs a nonempty signature.
    for file in files:
        if SIGNATURE.search(file.name):
            if file.name[:-4] not in names:
                raise ValueError(f"Updater signature has no matching archive: {file.name}")
        elif SIGNED_ARCHIVE.search(file.name):
            if f"{file.name}.sig" not in names:
                raise ValueError(f"Missing updater signature: {file.name}")
    for file in files:
        upload(file, f"alwith-u/release/{tag}/{file.name}")
    return len(files)


def main() -> int:
    try:
        if len(sys.argv) != 3:
            raise ValueError("Usage: python scripts/upload-to-tos.py <directory> <tag>")
        required = ("TOS_ACCESS_KEY", "TOS_SECRET_KEY", "TOS_ENDPOINT", "TOS_REGION", "TOS_BUCKET")
        missing = [name for name in required if not os.environ.get(name)]
        if missing:
            raise ValueError(f"Missing required variables: {', '.join(missing)}")

        import tos

        client = tos.TosClientV2(
            os.environ["TOS_ACCESS_KEY"], os.environ["TOS_SECRET_KEY"],
            os.environ["TOS_ENDPOINT"], os.environ["TOS_REGION"],
        )
        bucket = os.environ["TOS_BUCKET"]

        def upload(file: Path, key: str) -> None:
            try:
                result = client.put_object_from_file(bucket, key, str(file))
            except Exception as error:
                # Do not print SDK request objects that may contain authentication headers.
                raise RuntimeError(f"TOS upload failed: tos://{bucket}/{key} ({type(error).__name__})") from error
            print(f"Uploaded: tos://{bucket}/{key} (request_id={result.request_id})")

        count = mirror_release(Path(sys.argv[1]).resolve(), sys.argv[2], upload)
        print(f"Mirrored {count} release assets to TOS")
        return 0
    except Exception as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
