import assert from "node:assert/strict";
import test from "node:test";
import { mockIPC } from "@tauri-apps/api/mocks";
import { fetchProviderLyrics, searchProvider } from "./client";
import type { OnlineTrack } from "./types";

Object.defineProperty(globalThis, "window", {
	value: globalThis,
	configurable: true,
});
Object.defineProperty(globalThis, "isTauri", {
	value: true,
	configurable: true,
});
const qqTrack: OnlineTrack = {
	provider: "qq",
	id: "test-qq",
	title: "Song",
	artists: ["Artist"],
	album: "Album",
	durationMs: 180000,
};

test("malformed provider payloads reject without returning editor data", async () => {
	mockIPC(() => ({ original: { format: "qrc", content: 42 } }));
	await assert.rejects(
		fetchProviderLyrics(qqTrack),
		/Invalid lyric service text/,
	);
	mockIPC(() => ({ tracks: [{ ...qqTrack, artists: null }] }));
	await assert.rejects(
		searchProvider("qq", "Song"),
		/Invalid lyric service track/,
	);
});

test("a provider command failure can be followed by a successful request", async () => {
	mockIPC(() => {
		throw new Error("QQ unavailable");
	});
	await assert.rejects(searchProvider("qq", "Song"), /QQ unavailable/);
	mockIPC(() => ({
		tracks: [{ ...qqTrack, provider: "netease" }],
		hasMore: false,
	}));
	const result = await searchProvider("netease", "Song");
	assert.equal(result.tracks.length, 1);
});

test("lyrics are validated and cached, and consumers receive independent copies", async () => {
	let calls = 0;
	mockIPC(() => {
		calls++;
		return { original: { format: "lrc", content: "[00:01.00]Hello" } };
	});
	const first = await fetchProviderLyrics({ ...qqTrack, id: "cache-test" });
	first.original.content = "changed";
	const second = await fetchProviderLyrics({ ...qqTrack, id: "cache-test" });
	assert.equal(second.original.content, "[00:01.00]Hello");
	assert.equal(calls, 1);
});

test("desktop LRCLIB search and fetch use native IPC without WebView networking", async (t) => {
	const webFetch = t.mock.method(globalThis, "fetch", async () => {
		throw new Error("WebView networking must not be used");
	});
	const track: OnlineTrack = {
		...qqTrack,
		provider: "lrclib",
		id: "123456789",
	};
	const commands: string[] = [];
	mockIPC((command) => {
		commands.push(command);
		return command === "online_lyrics_search"
			? { tracks: [track], page: 1, hasMore: false }
			: { original: { format: "lrc", content: "[00:01.00]Native lyrics" } };
	});
	const result = await searchProvider("lrclib", "Song");
	assert.equal(result.tracks[0].id, track.id);
	const lyrics = await fetchProviderLyrics(result.tracks[0]);
	assert.equal(lyrics.original.content, "[00:01.00]Native lyrics");
	assert.deepEqual(commands, ["online_lyrics_search", "online_lyrics_fetch"]);
	assert.equal(webFetch.mock.callCount(), 0);
});

test("desktop TTML repositories bypass unsupported native provider commands", async (t) => {
	let ipcCalls = 0;
	mockIPC(() => {
		ipcCalls++;
		throw new Error("Unsupported native provider");
	});
	t.mock.method(
		globalThis,
		"fetch",
		async (url: Parameters<typeof fetch>[0]) =>
			String(url).endsWith("index.json")
				? new Response(
						JSON.stringify({
							version: 1,
							entries: [
								{
									appleMusicId: 123,
									artist: "Artist",
									title: "Song",
									path: "am-lyrics/Artist - Song - 123.ttml",
								},
							],
						}),
					)
				: String(url).endsWith(".jsonl")
					? new Response(
							JSON.stringify({
								rawLyricFile: "1760000000000-123-testfile.ttml",
								metadata: [
									["musicName", ["Song"]],
									["artists", ["Artist"]],
									["ncmMusicId", ["456"]],
								],
							}),
						)
					: new Response("<tt>repository</tt>"),
	);
	for (const provider of ["am-lyrics", "amll-ttml-db"] as const) {
		const page = await searchProvider(provider, "Song Artist");
		assert.equal(page.tracks.length, 1);
		assert.equal(
			(await fetchProviderLyrics(page.tracks[0])).original.format,
			"ttml",
		);
	}
	assert.equal(ipcCalls, 0);
});
