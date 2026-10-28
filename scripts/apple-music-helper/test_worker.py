"""Offline bridge regression tests; synthetic audio, no Apple account/session."""
import asyncio
import io
import functools
import http.server
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(Path(__file__).parent))
import worker


class RequestTests(unittest.TestCase):
    def test_single_song_links(self):
        for link in (
            "https://music.apple.com/tr/song/wake-atte/1555193620",
            "https://music.apple.com/tr/song/1555193620",
            "https://music.apple.com/us/album/a/123?i=1555193620",
        ):
            self.assertEqual(worker.song_id_from_url(link), "1555193620")

    def test_reject_non_song_or_unsafe_links(self):
        for link in (None, "http://music.apple.com/tr/song/1", "https://evil.com/tr/song/1",
                     "https://music.apple.com@evil.com/tr/song/1", "https://music.apple.com/tr/album/a/1",
                     "https://music.apple.com/tr/playlist/p/1", "https://music.apple.com/tr/song/0",
                     "https://music.apple.com/tr/song/9999999999999999", "https://music.apple.com/tr/song/1#x"):
            with self.subTest(link=link), self.assertRaises(worker.BridgeError):
                worker.song_id_from_url(link)

    def test_request_limits_and_token_are_private(self):
        with tempfile.TemporaryDirectory() as temp:
            data = {"url": "https://music.apple.com/tr/song/1", "outputDir": temp, "mediaUserToken": "fixture-only"}
            self.assertEqual(worker.read_request(io.StringIO(json.dumps(data)))["mediaUserToken"], "fixture-only")
            for token in ("", "x\ny", "x" * 16385, None):
                data["mediaUserToken"] = token
                with self.assertRaises(worker.BridgeError):
                    worker.read_request(io.StringIO(json.dumps(data)))
        with self.assertRaises(worker.BridgeError):
            worker.read_request(io.StringIO("x" * (worker.MAX_REQUEST_BYTES + 1)))

    def test_provider_errors_never_expose_raw_text(self):
        error = RuntimeError("fixture-token https://private.invalid/audio?token=secret")
        self.assertEqual(worker.error_code(error), "failed")
        self.assertEqual(worker.error_code(TimeoutError("secret")), "timeout")
        self.assertEqual(worker.error_code(worker.BridgeError("subscriptionRequired")), "subscriptionRequired")

    def test_reject_missing_or_non_mp4_output(self):
        with tempfile.TemporaryDirectory() as temp:
            file = Path(temp) / "audio.m4a"
            with self.assertRaises(worker.BridgeError):
                worker.validate_audio(file)
            file.write_bytes(b"<html>provider returned error</html>" * 4)
            with self.assertRaises(worker.BridgeError):
                worker.validate_audio(file)


class PipelineTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        cls.fixture = Path(cls.temp.name) / "sine.m4a"
        ffmpeg = shutil.which("ffmpeg")
        if not ffmpeg:
            raise RuntimeError("FFmpeg is required to generate the offline regression fixture")
        subprocess.run([ffmpeg, "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=0.15",
                        "-c:a", "aac", "-movflags", "+frag_keyframe+empty_moov+default_base_moof", "-y", str(cls.fixture)], check=True,
                       creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)

    @classmethod
    def tearDownClass(cls):
        cls.temp.cleanup()

    def test_actual_native_muxer_abi_and_audio_decode(self):
        from gamdl import _ammuxer
        from mutagen.mp4 import MP4
        with tempfile.TemporaryDirectory() as temp:
            output = Path(temp) / "muxed.m4a"
            _ammuxer.decrypt_and_mux_hex_native("00" * 16, str(self.fixture), str(output), None, None, False, False, False)
            worker.validate_audio(output)
            audio = MP4(output)
            self.assertGreater(audio.info.length, 0)
            self.assertEqual(audio.info.sample_rate, 44100)

    def test_original_song_downloader_stage_tag_finalize_cleanup(self):
        from gamdl.api import AppleMusicApi
        from gamdl.interface import AppleMusicBaseInterface, AppleMusicSongInterface, AppleMusicMedia, MediaTags, Cover, Lyrics, StreamInfoAv, StreamInfo, MediaFileFormat
        from gamdl.api.itunes import ItunesApi
        from mutagen.mp4 import MP4

        async def fixture_media(song, media):
            # Replace provider acquisition only; use actual gamdl downloader,
            # tagging/finalization/cleanup and actual helper result protocol.
            yield media
            media.partial = False
            media.media_metadata = {"type": "songs", "id": media.media_id}
            media.tags = MediaTags(title="Offline bridge fixture", artist="Fixture", title_id=int(media.media_id))
            media.cover = Cover(file_extension=".jpg", url=None)
            media.lyrics = Lyrics()
            media.stream_info = StreamInfoAv(file_format=MediaFileFormat.M4A, audio_track=StreamInfo(drm_free=True, stream_url="https://fixture.invalid/a.m4a"))
            yield media

        async def storefront(_):
            return 143480

        capture = io.StringIO()
        class QuietHandler(http.server.SimpleHTTPRequestHandler):
            def log_message(self, *_):
                pass
        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(QuietHandler, directory=self.temp.name))
        server_thread = threading.Thread(target=server.serve_forever, daemon=True)
        server_thread.start()
        original_media = fixture_media

        async def local_media(song, media):
            async for item in original_media(song, media):
                if item.stream_info:
                    item.stream_info.audio_track.stream_url = f"http://127.0.0.1:{server.server_port}/sine.m4a"
                yield item

        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        with tempfile.TemporaryDirectory() as temp:
            data = {"url": "https://music.apple.com/tr/song/1555193620", "outputDir": temp, "mediaUserToken": "offline-fixture-only"}
            with patch.object(AppleMusicApi, "get_token", AsyncMock(return_value="public-fixture")), \
                 patch.object(AppleMusicApi, "get_account_info", AsyncMock(return_value={"meta":{"subscription":{"active":True,"storefront":"tr"}}})), \
                 patch.object(ItunesApi, "get_storefront_id", storefront), \
                 patch.object(AppleMusicBaseInterface, "get_cover_bytes", AsyncMock(return_value=None)), \
                 patch.object(AppleMusicSongInterface, "get_media", local_media), patch.object(worker, "PROTOCOL_OUT", capture):
                asyncio.run(worker.acquire(data))
            target = Path(temp) / "audio.m4a"
            worker.validate_audio(target)
            self.assertEqual(MP4(target)["\xa9nam"], ["Offline bridge fixture"])
            self.assertEqual(list((Path(temp) / "work").glob("*")), [])
            messages = [json.loads(line) for line in capture.getvalue().splitlines()]
            self.assertEqual(messages[0]["state"], "authenticating")
            self.assertEqual(messages[-1], {"state":"ready", "fileName":"audio.m4a"})
            self.assertNotIn("offline-fixture-only", capture.getvalue())
            self.assertNotIn("mediaUserToken", data)

    def test_no_active_subscription_stops_before_media_acquisition(self):
        from gamdl.api import AppleMusicApi
        capture = io.StringIO()
        with tempfile.TemporaryDirectory() as temp, \
             patch.object(AppleMusicApi, "get_token", AsyncMock(return_value="public-fixture")), \
             patch.object(AppleMusicApi, "get_account_info", AsyncMock(return_value={"meta":{"subscription":{"active":False,"storefront":"tr"}}})), \
             patch.object(worker, "PROTOCOL_OUT", capture):
            with self.assertRaises(worker.BridgeError) as error:
                asyncio.run(worker.acquire({"url":"https://music.apple.com/tr/song/1", "outputDir":temp,"mediaUserToken":"fixture"}))
            self.assertEqual(error.exception.code, "subscriptionRequired")
            self.assertEqual(list(Path(temp).iterdir()), [])


if __name__ == "__main__":
    unittest.main()
