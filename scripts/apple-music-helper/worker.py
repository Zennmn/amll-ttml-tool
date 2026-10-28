"""Private NDJSON bridge to the unchanged, vendored gamdl media pipeline.

The subscriber token arrives through stdin only. Neither it nor raw provider
exceptions are ever written to a log, command argument, result or media tag.
"""
from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
from pathlib import Path
import queue
import re
import sys
from urllib.parse import parse_qs, urlsplit

MAX_AUDIO_BYTES = 64 * 1024 * 1024
MAX_REQUEST_BYTES = 64 * 1024
PROTOCOL_OUT = sys.stdout


class BridgeError(Exception):
    def __init__(self, code: str):
        self.code = code


def emit(state: str, **fields) -> None:
    PROTOCOL_OUT.write(json.dumps({"state": state, **fields}, separators=(",", ":")) + "\n")
    PROTOCOL_OUT.flush()


def song_id_from_url(raw: str) -> str:
    if not isinstance(raw, str) or len(raw) > 2048:
        raise BridgeError("invalidLink")
    try:
        url = urlsplit(raw)
        if url.scheme != "https" or url.netloc != "music.apple.com" or url.fragment:
            raise BridgeError("invalidLink")
        parts = url.path.strip("/").split("/")
        if len(parts) not in (3, 4) or not re.fullmatch(r"[a-zA-Z]{2}", parts[0]):
            raise BridgeError("invalidLink")
        if parts[1] == "song":
            value = parts[-1]
        elif parts[1] == "album":
            candidates = parse_qs(url.query).get("i", [])
            if len(candidates) != 1:
                raise BridgeError("invalidLink")
            value = candidates[0]
        else:
            raise BridgeError("invalidLink")
        if not re.fullmatch(r"[1-9][0-9]{0,15}", value) or int(value) > 9007199254740991:
            raise BridgeError("invalidLink")
        return value
    except (ValueError, IndexError):
        raise BridgeError("invalidLink") from None


def read_request(stream) -> dict:
    line = stream.readline(MAX_REQUEST_BYTES + 1)
    if not line or len(line.encode("utf-8")) > MAX_REQUEST_BYTES:
        raise BridgeError("failed")
    try:
        data = json.loads(line)
    except (ValueError, TypeError):
        raise BridgeError("failed") from None
    if not isinstance(data, dict):
        raise BridgeError("failed")
    song_id_from_url(data.get("url"))
    token = data.get("mediaUserToken")
    if not isinstance(token, str) or not 1 <= len(token) <= 16384 or any(ord(c) < 32 for c in token):
        raise BridgeError("notAuthenticated")
    directory = data.get("outputDir")
    if not isinstance(directory, str) or len(directory) > 32768:
        raise BridgeError("failed")
    root = Path(directory)
    # Rust creates and owns an empty per-job directory before starting us.
    if not root.is_absolute() or not root.is_dir() or root.is_symlink():
        raise BridgeError("failed")
    return data


def validate_audio(path: Path) -> None:
    if path.is_symlink() or not path.is_file() or not 32 <= path.stat().st_size <= MAX_AUDIO_BYTES:
        raise BridgeError("invalidAudio")
    with path.open("rb") as file:
        if file.read(12)[4:8] != b"ftyp":
            raise BridgeError("invalidAudio")
    from mutagen.mp4 import MP4
    try:
        info = MP4(path).info
        # Fragmented MP4 can report zero duration before a decoder scans its
        # fragments. Keep those valid streams; require an audio description.
        if not info or info.channels < 1 or info.sample_rate < 1:
            raise BridgeError("invalidAudio")
    except BridgeError:
        raise
    except Exception:
        raise BridgeError("invalidAudio") from None


def error_code(error: Exception) -> str:
    if isinstance(error, BridgeError):
        return error.code
    # Classify in memory, then discard provider text. Never forward it.
    name = type(error).__name__.lower()
    status = getattr(error, "status_code", None)
    response = getattr(error, "response", None)
    if status is None:
        status = getattr(response, "status_code", None)
    if status in (401, 403):
        return "notAuthenticated"
    if "timeout" in name:
        return "timeout"
    if any(word in name for word in ("connect", "network", "transport")):
        return "network"
    if any(word in name for word in ("notstreamable", "decryptionnotavailable", "codecnotavailable")):
        return "unavailable"
    return "failed"


def run_original_transport(stream_url: str, download_path: str) -> None:
    from gamdl.downloader.base import _download_ytdlp_process
    result = queue.Queue()
    _download_ytdlp_process(stream_url, download_path, True, result)
    if not result.empty():
        # Upstream queues detailed URL/trace information on failure. Discard it.
        result.get_nowait()
        raise BridgeError("network")


async def monitor_download(folder: Path, finished: asyncio.Event) -> None:
    while not finished.is_set():
        size = 0
        for path in folder.rglob("*"):
            if path.is_file() and not path.is_symlink():
                size += path.stat().st_size
        if size > MAX_AUDIO_BYTES * 3:
            raise BridgeError("invalidAudio")
        emit("downloading", progress=None, bytesReceived=size, totalBytes=None)
        try:
            await asyncio.wait_for(finished.wait(), timeout=0.5)
        except TimeoutError:
            pass


async def acquire(request: dict) -> None:
    # Lazy imports keep validation independent of native/runtime dependencies.
    import structlog
    from gamdl.api import AppleMusicApi
    from gamdl.downloader import (
        AppleMusicBaseDownloader, AppleMusicDownloader,
        AppleMusicSongDownloader, AppleMusicMusicVideoDownloader,
        AppleMusicUploadedVideoDownloader,
    )
    from gamdl.interface import (
        AppleMusicBaseInterface, AppleMusicInterface, AppleMusicSongInterface,
        AppleMusicMusicVideoInterface, AppleMusicUploadedVideoInterface,
        AppleMusicMedia, SongCodec,
    )

    structlog.configure(logger_factory=structlog.ReturnLoggerFactory())
    logging.disable(logging.CRITICAL)
    output = Path(request["outputDir"]).resolve()
    target = output / "audio.m4a"
    if target.exists():
        raise BridgeError("failed")
    media_id = song_id_from_url(request["url"])
    emit("authenticating")
    api = await AppleMusicApi.create(media_user_token=request.pop("mediaUserToken"))
    base = None
    try:
        if not api.active_subscription:
            raise BridgeError("subscriptionRequired")
        base = await AppleMusicBaseInterface.create(apple_music_api=api)
        song = AppleMusicSongInterface(base=base, codec_priority=[SongCodec.AAC_WEB])
        interface = AppleMusicInterface(
            song=song,
            music_video=AppleMusicMusicVideoInterface(base=base),
            uploaded_video=AppleMusicUploadedVideoInterface(base=base),
        )

        class BridgeDownloader(AppleMusicBaseDownloader):
            async def _download_ytdlp_async(self, stream_url, download_path):
                done = asyncio.Event()
                monitor = asyncio.create_task(monitor_download(output, done))
                try:
                    await asyncio.to_thread(run_original_transport, stream_url, download_path)
                finally:
                    done.set()
                    await monitor
                emit("processing")

        downloader_base = BridgeDownloader(
            interface=interface, output_path=str(output), temp_path=str(output / "work"), silent=True,
        )
        downloader = AppleMusicDownloader(
            song=AppleMusicSongDownloader(base=downloader_base),
            music_video=AppleMusicMusicVideoDownloader(base=downloader_base),
            uploaded_video=AppleMusicUploadedVideoDownloader(base=downloader_base),
            no_synced_lyrics=True,
        )
        media = AppleMusicMedia(media_id=media_id)
        complete = None
        async for item in song.get_media(media):
            if not item.partial:
                complete = item
        if complete is None or complete.media_metadata.get("id") != media_id:
            raise BridgeError("unavailable")
        download_item = await downloader.parse_download_item(complete)
        download_item.final_path = str(target)
        emit("downloading", progress=None, bytesReceived=0, totalBytes=None)
        await downloader.download(download_item)
        validate_audio(target)
        emit("ready", fileName="audio.m4a")
    finally:
        await api.client.aclose()
        if base is not None:
            await base.itunes_api.client.aclose()


def main() -> int:
    try:
        request = read_request(sys.stdin)
        # All upstream diagnostics are suppressed; stdout belongs to protocol.
        with open(os.devnull, "w", encoding="utf-8") as sink:
            with contextlib.redirect_stdout(sink), contextlib.redirect_stderr(sink):
                asyncio.run(asyncio.wait_for(acquire(request), timeout=540))
        return 0
    except Exception as error:
        emit("error", errorCode=error_code(error))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
