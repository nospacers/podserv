from __future__ import annotations

import hashlib
import os
import re
import secrets
import sqlite3
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from functools import wraps
from pathlib import Path
from typing import Any, Callable
from urllib.parse import urlparse

import feedparser
import requests
from flask import (
    Flask,
    Response,
    jsonify,
    redirect,
    render_template,
    request,
    send_from_directory,
    session,
    url_for,
)
from werkzeug.security import check_password_hash, generate_password_hash

BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "data"
DOWNLOAD_DIR = DATA_DIR / "downloads"
DB_PATH = DATA_DIR / "podcasts.db"
DEFAULT_TIMEOUT = 20
USER_AGENT = "PodcastPiPlayer/2.1 (+https://localhost)"
CHUNK_SIZE = 1024 * 256
DEFAULT_USERNAME = os.environ.get("PODCASTPI_USERNAME", "admin")
DEFAULT_PASSWORD_HASH = os.environ.get("PODCASTPI_PASSWORD_HASH", "")
AUTH_ENABLED = os.environ.get("PODCASTPI_AUTH_ENABLED", "1").strip().lower() not in {"0", "false", "no"}
SECRET_KEY = os.environ.get("PODCASTPI_SECRET_KEY") or secrets.token_hex(32)

DATA_DIR.mkdir(exist_ok=True)
DOWNLOAD_DIR.mkdir(exist_ok=True)

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 1024 * 1024 * 10
app.config["SECRET_KEY"] = SECRET_KEY
app.config["SESSION_COOKIE_HTTPONLY"] = True
app.config["SESSION_COOKIE_SAMESITE"] = "Lax"
app.config["SESSION_COOKIE_SECURE"] = os.environ.get("PODCASTPI_SECURE_COOKIE", "0").strip().lower() in {"1", "true", "yes"}


def is_authenticated() -> bool:
    return session.get("authenticated") is True


def wants_json() -> bool:
    path = request.path or ""
    if path.startswith("/api/"):
        return True
    return "application/json" in request.headers.get("Accept", "")


def require_login(view: Callable[..., Any]) -> Callable[..., Any]:
    @wraps(view)
    def wrapped(*args: Any, **kwargs: Any) -> Any:
        if not AUTH_ENABLED or is_authenticated():
            return view(*args, **kwargs)
        if wants_json():
            return jsonify({"error": "Authentication required."}), 401
        return redirect(url_for("login", next=request.full_path if request.query_string else request.path))

    return wrapped


@app.before_request
def enforce_authentication() -> Any:
    if not AUTH_ENABLED:
        return None

    public_paths = {
        "/login",
        "/logout",
        "/health",
        "/favicon.ico",
    }
    if request.path in public_paths:
        return None

    if request.path.startswith("/static/"):
        return None

    if is_authenticated():
        return None

    if wants_json():
        return jsonify({"error": "Authentication required."}), 401

    return redirect(url_for("login", next=request.full_path if request.query_string else request.path))


@app.context_processor
def inject_auth_config() -> dict[str, Any]:
    return {
        "auth_enabled": AUTH_ENABLED,
        "logged_in": is_authenticated(),
        "current_user": session.get("username", ""),
    }


@app.get("/auth/hash")
def auth_hash_help() -> Any:
    password = clean_text(request.args.get("password"))
    if not password:
        return jsonify({
            "error": "Provide ?password=your-password to generate a hash.",
            "example": "/auth/hash?password=change-me",
        }), 400
    return jsonify({"hash": generate_password_hash(password)})


@app.route("/login", methods=["GET", "POST"])
def login() -> Any:
    if not AUTH_ENABLED:
        return redirect(url_for("index"))

    error = ""
    next_url = clean_text(request.values.get("next")) or url_for("index")
    if request.method == "POST":
        username = clean_text(request.form.get("username"))
        password = clean_text(request.form.get("password"))
        if not DEFAULT_PASSWORD_HASH:
            error = "Authentication is enabled, but PODCASTPI_PASSWORD_HASH is not set on the server."
        elif username != DEFAULT_USERNAME or not check_password_hash(DEFAULT_PASSWORD_HASH, password):
            error = "Invalid username or password."
        else:
            session.clear()
            session["authenticated"] = True
            session["username"] = username
            return redirect(next_url if next_url.startswith("/") else url_for("index"))

    if is_authenticated():
        return redirect(url_for("index"))
    return render_template("login.html", error=error, next_url=next_url)


@app.post("/logout")
def logout() -> Any:
    session.clear()
    return redirect(url_for("login"))


def get_db() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db() -> None:
    conn = get_db()
    try:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS downloads (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                episode_id TEXT NOT NULL,
                podcast_title TEXT,
                episode_title TEXT NOT NULL,
                audio_url TEXT NOT NULL UNIQUE,
                local_filename TEXT NOT NULL,
                local_path TEXT NOT NULL,
                mime_type TEXT,
                file_size INTEGER DEFAULT 0,
                downloaded_at TEXT NOT NULL
            )
            """
        )
        conn.commit()
    finally:
        conn.close()


def clean_text(value: Any) -> str:
    if value is None:
        return ""
    return str(value).strip()


def parse_date(entry: dict[str, Any]) -> tuple[str, str]:
    raw = clean_text(entry.get("published") or entry.get("updated") or "")
    parsed_struct = entry.get("published_parsed") or entry.get("updated_parsed")

    if parsed_struct:
        try:
            dt = datetime(*parsed_struct[:6], tzinfo=timezone.utc)
            return raw, dt.isoformat()
        except Exception:
            pass

    if raw:
        try:
            dt = parsedate_to_datetime(raw)
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            return raw, dt.isoformat()
        except Exception:
            pass

    return raw, ""


def slugify(value: str, fallback: str = "episode") -> str:
    value = re.sub(r"[^a-zA-Z0-9._-]+", "-", value).strip("-._ ")
    return value[:120] or fallback


def get_episode_image(entry: dict[str, Any], fallback: str) -> str:
    image = ""
    itunes_image = entry.get("itunes_image")
    if isinstance(itunes_image, dict):
        image = clean_text(itunes_image.get("href"))
    if not image:
        media_thumbnail = entry.get("media_thumbnail") or []
        if media_thumbnail and isinstance(media_thumbnail, list):
            image = clean_text(media_thumbnail[0].get("url"))
    if not image:
        media_content = entry.get("media_content") or []
        if media_content and isinstance(media_content, list):
            image = clean_text(media_content[0].get("url"))
    return image or fallback


def get_audio_url(entry: dict[str, Any]) -> str:
    enclosures = entry.get("enclosures") or []
    for enclosure in enclosures:
        url = clean_text(enclosure.get("href") or enclosure.get("url"))
        if url:
            return url
    links = entry.get("links") or []
    for link in links:
        rel = clean_text(link.get("rel"))
        media_type = clean_text(link.get("type"))
        href = clean_text(link.get("href"))
        if href and (rel == "enclosure" or media_type.startswith("audio/")):
            return href
    return ""


def parse_feed(feed_url: str) -> dict[str, Any]:
    headers = {
        "User-Agent": USER_AGENT,
        "Accept": "application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.8",
    }
    response = requests.get(feed_url, headers=headers, timeout=DEFAULT_TIMEOUT)
    response.raise_for_status()

    parsed = feedparser.parse(response.content)
    if parsed.bozo and not parsed.entries:
        raise ValueError("Feed could not be parsed")

    feed = parsed.feed or {}
    image = ""
    if isinstance(feed.get("image"), dict):
        image = clean_text(feed.get("image", {}).get("href") or feed.get("image", {}).get("url"))
    if not image:
        image = clean_text(feed.get("itunes_image", {}).get("href") if isinstance(feed.get("itunes_image"), dict) else "")

    episodes: list[dict[str, Any]] = []
    for index, entry in enumerate(parsed.entries or []):
        display_date, iso_date = parse_date(entry)
        title = clean_text(entry.get("title")) or f"Episode {index + 1}"
        summary = clean_text(entry.get("summary") or entry.get("description") or entry.get("subtitle"))
        audio_url = get_audio_url(entry)
        guid = clean_text(entry.get("id") or entry.get("guid") or entry.get("link") or f"episode-{index + 1}")
        duration = clean_text(entry.get("itunes_duration") or entry.get("duration"))
        download = get_download_by_audio_url(audio_url) if audio_url else None

        episodes.append(
            {
                "id": guid,
                "title": title,
                "description": summary,
                "pub_date": display_date,
                "pub_date_iso": iso_date,
                "link": clean_text(entry.get("link")),
                "audio_url": audio_url,
                "duration": duration,
                "image": get_episode_image(entry, image),
                "downloaded": bool(download),
                "download_url": f"/media/{download['local_filename']}" if download else "",
            }
        )

    episodes.sort(key=lambda item: item.get("pub_date_iso") or "", reverse=True)

    return {
        "title": clean_text(feed.get("title")) or "Podcast",
        "description": clean_text(feed.get("subtitle") or feed.get("description")),
        "image": image,
        "link": clean_text(feed.get("link")),
        "feed_url": feed_url,
        "items": episodes,
    }


def is_http_url(url: str) -> bool:
    return url.startswith("http://") or url.startswith("https://")


def fetch_head(url: str) -> tuple[str, str]:
    headers = {"User-Agent": USER_AGENT}
    try:
        response = requests.head(url, headers=headers, timeout=DEFAULT_TIMEOUT, allow_redirects=True)
        mime = clean_text(response.headers.get("Content-Type")).split(";")[0]
        final_url = response.url or url
        return final_url, mime
    except requests.RequestException:
        return url, ""


def choose_extension(url: str, mime_type: str) -> str:
    path = urlparse(url).path
    ext = Path(path).suffix.lower()
    if ext in {".mp3", ".m4a", ".aac", ".ogg", ".wav", ".flac", ".opus"}:
        return ext
    mime_map = {
        "audio/mpeg": ".mp3",
        "audio/mp3": ".mp3",
        "audio/mp4": ".m4a",
        "audio/x-m4a": ".m4a",
        "audio/aac": ".aac",
        "audio/ogg": ".ogg",
        "audio/wav": ".wav",
        "audio/x-wav": ".wav",
        "audio/flac": ".flac",
        "audio/opus": ".opus",
    }
    return mime_map.get(mime_type, ".bin")


def get_download_by_audio_url(audio_url: str) -> dict[str, Any] | None:
    conn = get_db()
    try:
        row = conn.execute("SELECT * FROM downloads WHERE audio_url = ?", (audio_url,)).fetchone()
        return dict(row) if row else None
    finally:
        conn.close()


def list_downloads() -> list[dict[str, Any]]:
    conn = get_db()
    try:
        rows = conn.execute("SELECT * FROM downloads ORDER BY downloaded_at DESC").fetchall()
        return [dict(row) for row in rows]
    finally:
        conn.close()


def save_download_record(record: dict[str, Any]) -> None:
    conn = get_db()
    try:
        conn.execute(
            """
            INSERT OR REPLACE INTO downloads
            (episode_id, podcast_title, episode_title, audio_url, local_filename, local_path, mime_type, file_size, downloaded_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                record["episode_id"],
                record["podcast_title"],
                record["episode_title"],
                record["audio_url"],
                record["local_filename"],
                record["local_path"],
                record.get("mime_type", ""),
                record.get("file_size", 0),
                record["downloaded_at"],
            ),
        )
        conn.commit()
    finally:
        conn.close()


def delete_download(download_id: int) -> bool:
    conn = get_db()
    try:
        row = conn.execute("SELECT * FROM downloads WHERE id = ?", (download_id,)).fetchone()
        if not row:
            return False
        path = Path(row["local_path"])
        if path.exists():
            path.unlink()
        conn.execute("DELETE FROM downloads WHERE id = ?", (download_id,))
        conn.commit()
        return True
    finally:
        conn.close()


def download_episode(payload: dict[str, Any]) -> dict[str, Any]:
    audio_url = clean_text(payload.get("audio_url"))
    if not audio_url or not is_http_url(audio_url):
        raise ValueError("A valid audio_url is required.")

    existing = get_download_by_audio_url(audio_url)
    if existing and Path(existing["local_path"]).exists():
        existing["download_url"] = f"/media/{existing['local_filename']}"
        return existing

    final_url, mime_type = fetch_head(audio_url)
    episode_title = clean_text(payload.get("episode_title")) or "Episode"
    podcast_title = clean_text(payload.get("podcast_title")) or "Podcast"
    episode_id = clean_text(payload.get("episode_id")) or hashlib.sha1(audio_url.encode("utf-8")).hexdigest()

    extension = choose_extension(final_url, mime_type)
    stem = slugify(f"{podcast_title}-{episode_title}")
    suffix = hashlib.sha1(audio_url.encode("utf-8")).hexdigest()[:10]
    filename = f"{stem}-{suffix}{extension}"
    path = DOWNLOAD_DIR / filename

    headers = {"User-Agent": USER_AGENT}
    with requests.get(audio_url, headers=headers, timeout=DEFAULT_TIMEOUT, stream=True) as response:
        response.raise_for_status()
        actual_mime = clean_text(response.headers.get("Content-Type")).split(";")[0] or mime_type
        total_size = 0
        with open(path, "wb") as handle:
            for chunk in response.iter_content(chunk_size=CHUNK_SIZE):
                if not chunk:
                    continue
                handle.write(chunk)
                total_size += len(chunk)

    record = {
        "episode_id": episode_id,
        "podcast_title": podcast_title,
        "episode_title": episode_title,
        "audio_url": audio_url,
        "local_filename": filename,
        "local_path": str(path),
        "mime_type": actual_mime,
        "file_size": total_size,
        "downloaded_at": datetime.now(timezone.utc).isoformat(),
    }
    save_download_record(record)
    record["download_url"] = f"/media/{filename}"
    return record


@app.get("/")
@require_login
def index() -> str:
    return render_template("index.html")


@app.get("/health")
def health() -> Any:
    return jsonify({"ok": True, "auth_enabled": AUTH_ENABLED})


@app.get("/api/feed")
@require_login
def api_feed() -> Any:
    feed_url = clean_text(request.args.get("url"))
    if not feed_url:
        return jsonify({"error": "Missing url parameter."}), 400
    if not is_http_url(feed_url):
        return jsonify({"error": "Feed URL must start with http:// or https://"}), 400

    try:
        data = parse_feed(feed_url)
        return jsonify(data)
    except requests.HTTPError as exc:
        status_code = exc.response.status_code if exc.response is not None else 502
        return jsonify({"error": f"Upstream feed returned HTTP {status_code}."}), 502
    except requests.RequestException:
        return jsonify({"error": "Could not fetch the feed from the remote server."}), 502
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 422
    except Exception:
        return jsonify({"error": "Unexpected server error while loading the feed."}), 500


@app.get("/api/downloads")
@require_login
def api_downloads() -> Any:
    rows = list_downloads()
    payload = []
    for row in rows:
        payload.append(
            {
                **row,
                "download_url": f"/media/{row['local_filename']}",
            }
        )
    return jsonify({"items": payload})


@app.post("/api/download")
@require_login
def api_download() -> Any:
    payload = request.get_json(silent=True) or {}
    try:
        record = download_episode(payload)
        return jsonify({"ok": True, "item": record})
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    except requests.HTTPError as exc:
        status_code = exc.response.status_code if exc.response is not None else 502
        return jsonify({"error": f"Audio host returned HTTP {status_code}."}), 502
    except requests.RequestException:
        return jsonify({"error": "Could not download the episode from the remote host."}), 502
    except Exception:
        return jsonify({"error": "Unexpected server error while downloading episode."}), 500


@app.delete("/api/download/<int:download_id>")
@require_login
def api_delete_download(download_id: int) -> Any:
    deleted = delete_download(download_id)
    if not deleted:
        return jsonify({"error": "Download not found."}), 404
    return jsonify({"ok": True})


@app.get("/media/<path:filename>")
@require_login
def media_file(filename: str) -> Response:
    return send_from_directory(DOWNLOAD_DIR, filename, conditional=True)


init_db()


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=True)
