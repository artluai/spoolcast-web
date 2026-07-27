#!/usr/bin/env python3
"""
publish_template.py — publish one template folder as a GLOBAL cloud asset.

Unlike publish.py (operator tool writing R2/D1 directly with wrangler), this
goes through the admin site API — the real admin gate, and the same surface a
future CLI client will use. You must be signed in on the site as an admin:

  1. Sign in at https://spoolcast-web.pages.dev with the admin account.
  2. DevTools → Application → Cookies → copy the sc_session value.
  3. python3 site/publish_template.py --dir ../spoolcast/templates/ad \\
         --session <sc_session> [--poster art.png] [--preview clip.mp4]

Every regular file in --dir is uploaded (template.json required — its "id" is
the slug; rules.md etc. ride along). Re-running republishes: version bumps,
files overwrite, the template goes live again.

  --unpublish ad     hide a template from the public roster (files kept)
  --base URL         defaults to https://spoolcast-web.pages.dev; use
                     http://localhost:8788 against `wrangler pages dev`
"""

from __future__ import annotations

import argparse
import json
import mimetypes
import sys
import urllib.error
import urllib.request
import uuid
from pathlib import Path


def call(base: str, path: str, session: str, body: bytes, content_type: str) -> dict:
    req = urllib.request.Request(
        base.rstrip("/") + path,
        data=body,
        method="POST",
        headers={"Content-Type": content_type, "Cookie": f"sc_session={session}"},
    )
    try:
        with urllib.request.urlopen(req, timeout=300) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        try:
            detail = json.loads(e.read()).get("data", {}).get("error", "")
        except Exception:
            detail = ""
        print(f"API ERROR {e.code}: {detail or e.reason}", file=sys.stderr)
        sys.exit(1)


def multipart(parts: list[tuple[str, str, bytes]]) -> tuple[bytes, str]:
    """parts = [(field, filename, data)] → (body, content type)."""
    boundary = uuid.uuid4().hex
    out = bytearray()
    for field, filename, data in parts:
        mime = mimetypes.guess_type(filename)[0] or "application/octet-stream"
        out += (
            f"--{boundary}\r\n"
            f'Content-Disposition: form-data; name="{field}"; filename="{filename}"\r\n'
            f"Content-Type: {mime}\r\n\r\n"
        ).encode()
        out += data + b"\r\n"
    out += f"--{boundary}--\r\n".encode()
    return bytes(out), f"multipart/form-data; boundary={boundary}"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dir", help="template folder containing template.json")
    ap.add_argument("--session", required=True, help="sc_session cookie value of an admin login")
    ap.add_argument("--poster", default="", help="optional picker art image")
    ap.add_argument("--preview", default="", help="optional picker preview video")
    ap.add_argument("--unpublish", default="", metavar="SLUG", help="hide SLUG instead of publishing")
    ap.add_argument("--base", default="https://spoolcast-web.pages.dev")
    args = ap.parse_args()

    if args.unpublish:
        result = call(args.base, "/api/admin/templates/unpublish", args.session,
                      json.dumps({"slug": args.unpublish}).encode(), "application/json")
        print(f"unpublished: {result['data']['unpublished']}")
        return 0

    if not args.dir:
        print("pass --dir (or --unpublish SLUG)", file=sys.stderr)
        return 1
    folder = Path(args.dir).expanduser().resolve()
    tpl = folder / "template.json"
    if not tpl.is_file():
        print(f"no template.json in {folder}", file=sys.stderr)
        return 1

    parts = [("template", "template.json", tpl.read_bytes())]
    for f in sorted(folder.iterdir()):
        if f.is_file() and f.name != "template.json" and not f.name.startswith("."):
            parts.append(("file", f.name, f.read_bytes()))
    for field, arg in (("poster", args.poster), ("preview", args.preview)):
        if arg:
            art = Path(arg).expanduser().resolve()
            if not art.is_file():
                print(f"{field} not found: {art}", file=sys.stderr)
                return 1
            parts.append((field, art.name, art.read_bytes()))

    body, content_type = multipart(parts)
    result = call(args.base, "/api/admin/templates/publish", args.session, body, content_type)
    data = result["data"]
    print(f"published: {data['published']} v{data['version']}")
    for key in data["files"]:
        print(f"  {key}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
