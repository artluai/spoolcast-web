#!/usr/bin/env python3
"""
publish.py — put one finished video on the public viewer site.

Uploads the file to the spoolcast-videos R2 bucket and registers it in the
spoolcast-site D1 database (creator + optional series rows are created on
first use). The site only shows rows with public=1 — publish with --private
to stage something without showing it.

Usage:
  python3 site/publish.py --file /path/to/episode.mp4 \
      --title "Dev Log #06" --slug dev-log-06 \
      --creator artlu --creator-name "Artlu" \
      --series spoolcast-dev-log --series-title "Spoolcast Dev Log" \
      --episode 6 [--poster cover.jpg] [--private] [--local]

--local targets wrangler's local simulator (for `wrangler pages dev`) instead
of the real cloud. Run with --local AND without it to keep both in step.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
BUCKET = "spoolcast-videos"
DB = "spoolcast-site"


def run(cmd: list[str]) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, capture_output=True, text=True, cwd=REPO_ROOT, timeout=600)


def sql_str(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def d1(command: str, local: bool) -> list[dict]:
    cmd = ["npx", "wrangler", "d1", "execute", DB, "--json", "--command", command]
    cmd.append("--local" if local else "--remote")
    result = run(cmd)
    if result.returncode != 0:
        print(f"D1 ERROR: {(result.stderr or result.stdout).strip()[:400]}", file=sys.stderr)
        sys.exit(1)
    try:
        out = json.loads(result.stdout)
        return out[0].get("results", []) if isinstance(out, list) else []
    except Exception:
        return []


def r2_put(key: str, path: Path, content_type: str, local: bool) -> None:
    cmd = ["npx", "wrangler", "r2", "object", "put", f"{BUCKET}/{key}",
           "--file", str(path), "--content-type", content_type]
    if not local:
        cmd.append("--remote")
    result = run(cmd)
    if result.returncode != 0:
        print(f"R2 ERROR: {(result.stderr or result.stdout).strip()[:400]}", file=sys.stderr)
        sys.exit(1)


def probe(path: Path) -> tuple[float | None, int | None, int | None]:
    """Duration/size via ffprobe when available; nulls otherwise."""
    try:
        result = run(["ffprobe", "-v", "quiet", "-print_format", "json",
                      "-show_format", "-show_streams", str(path)])
        info = json.loads(result.stdout)
        duration = float(info.get("format", {}).get("duration") or 0) or None
        video = next((s for s in info.get("streams", []) if s.get("codec_type") == "video"), {})
        return duration, video.get("width"), video.get("height")
    except Exception:
        return None, None, None


def slugify(text: str) -> str:
    return re.sub(r"[^a-z0-9-]", "", text.lower().replace(" ", "-"))[:60].strip("-")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--file", required=True)
    ap.add_argument("--title", required=True)
    ap.add_argument("--slug", default="", help="URL slug; derived from the title if omitted")
    ap.add_argument("--description", default="")
    ap.add_argument("--creator", required=True, help="creator handle (/u/<handle>)")
    ap.add_argument("--creator-name", default="", help="display name; defaults to the handle")
    ap.add_argument("--series", default="", help="series slug; omit for a stand-alone video")
    ap.add_argument("--series-title", default="")
    ap.add_argument("--episode", type=int, default=None)
    ap.add_argument("--poster", default="", help="optional poster image file")
    ap.add_argument("--private", action="store_true", help="register but do not show on the site")
    ap.add_argument("--local", action="store_true", help="target wrangler's local simulator")
    args = ap.parse_args()

    src = Path(args.file).expanduser().resolve()
    if not src.is_file():
        print(f"no such file: {src}", file=sys.stderr)
        return 1
    slug = slugify(args.slug or args.title)
    if not slug:
        print("cannot derive a slug — pass --slug", file=sys.stderr)
        return 1
    handle = slugify(args.creator)
    series_slug = slugify(args.series) if args.series else ""
    public = 0 if args.private else 1

    # 1. media → R2
    key = f"videos/{handle}/{series_slug or 'videos'}/{slug}{src.suffix.lower()}"
    print(f"uploading {src.name} → {key} …")
    r2_put(key, src, "video/mp4", args.local)
    poster_key = ""
    if args.poster:
        poster = Path(args.poster).expanduser().resolve()
        if poster.is_file():
            poster_key = f"videos/{handle}/{series_slug or 'videos'}/{slug}-poster{poster.suffix.lower()}"
            r2_put(poster_key, poster, "image/jpeg" if poster.suffix.lower() in (".jpg", ".jpeg") else "image/png", args.local)
        else:
            print(f"poster not found, skipping: {poster}", file=sys.stderr)

    # 2. rows → D1 (creator and series are find-or-create by unique key)
    d1(f"INSERT OR IGNORE INTO creators (handle, name) VALUES ({sql_str(handle)}, {sql_str(args.creator_name or handle)})", args.local)
    creator_id = d1(f"SELECT id FROM creators WHERE handle = {sql_str(handle)}", args.local)[0]["id"]

    series_id = "NULL"
    if series_slug:
        d1(
            f"INSERT OR IGNORE INTO series (creator_id, slug, title, public) VALUES "
            f"({creator_id}, {sql_str(series_slug)}, {sql_str(args.series_title or series_slug)}, {public})",
            args.local,
        )
        series_id = str(d1(f"SELECT id FROM series WHERE slug = {sql_str(series_slug)}", args.local)[0]["id"])
        if public:
            d1(f"UPDATE series SET public = 1 WHERE id = {series_id}", args.local)

    duration, width, height = probe(src)
    episode = "NULL" if args.episode is None else str(args.episode)
    d1(
        "INSERT INTO videos (creator_id, series_id, episode, slug, title, description, r2_key, poster_key, duration_s, width, height, public) "
        f"VALUES ({creator_id}, {series_id}, {episode}, {sql_str(slug)}, {sql_str(args.title)}, {sql_str(args.description)}, "
        f"{sql_str(key)}, {sql_str(poster_key)}, {duration or 'NULL'}, {width or 'NULL'}, {height or 'NULL'}, {public}) "
        "ON CONFLICT(slug) DO UPDATE SET title=excluded.title, description=excluded.description, r2_key=excluded.r2_key, "
        "poster_key=excluded.poster_key, duration_s=excluded.duration_s, width=excluded.width, height=excluded.height, "
        "public=excluded.public, series_id=excluded.series_id, episode=excluded.episode",
        args.local,
    )
    where = "local simulator" if args.local else "live site"
    print(f"published ({'private' if args.private else 'PUBLIC'}) on the {where}: /watch/v/{slug}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
