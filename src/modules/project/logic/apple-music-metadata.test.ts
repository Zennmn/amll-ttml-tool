import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createStore } from "jotai";
import {
	lyricLinesAtom,
	projectIdAtom,
	redoLyricLinesAtom,
	saveFileNameAtom,
	selectedLinesAtom,
	selectedWordsAtom,
	undoableLyricLinesAtom,
	undoLyricLinesAtom,
} from "$/states/main";
import { newLyricLine, newLyricWord, type TTMLMetadata } from "$/types/ttml";
import {
	APPLE_MUSIC_IMPORT_FIELDS,
	AppleMusicMetadataError,
	fetchAppleMusicMetadata,
	getDefaultAppleMusicFields,
	mergeAppleMusicMetadata,
	parseAppleMusicLookupResponse,
	parseAppleMusicSongLink,
} from "./apple-music-metadata";
import { importAppleMusicMetadataAtom } from "./apple-music-metadata-state";

const songUrl = "https://music.apple.com/tr/song/wake-atte/1555193620";
const link = { storefront: "tr", songId: "1555193620" };
// Representative subset of the verified public lookup response.
const track = {
	wrapperType: "track",
	kind: "song",
	trackId: 1555193620,
	trackName: "Wake Atte",
	artistName: "MIREI",
	collectionName: "still",
	releaseDate: "2021-03-10T08:00:00Z",
	trackTimeMillis: 261680,
	artworkUrl100: "https://is1-ssl.mzstatic.com/image/thumb/cover/100x100bb.jpg",
};
const lookup = { resultCount: 1, results: [track] };
const preview = parseAppleMusicLookupResponse(lookup, link);
const json = (value: unknown, status = 200) =>
	new Response(JSON.stringify(value), { status });
const hasCode = (code: string) => (error: unknown) =>
	error instanceof AppleMusicMetadataError && error.code === code;

test("imported metadata survives the bundled TTML generator and parser", async () => {
	const bindings = await import(
		"../../ttml-processor/wasm/ttml_processor_wasm_bg.js"
	);
	const bytes = await readFile(
		new URL(
			"../../ttml-processor/wasm/ttml_processor_wasm_bg.wasm",
			import.meta.url,
		),
	);
	const { instance } = await WebAssembly.instantiate(bytes, {
		"./ttml_processor_wasm_bg.js": bindings,
	});
	bindings.__wbg_set_wasm(instance.exports);
	(instance.exports.__wbindgen_start as () => void)();
	const metadata = mergeAppleMusicMetadata([], preview, [
		...APPLE_MUSIC_IMPORT_FIELDS,
	]);
	const words = [
		{ startTime: 1000, endTime: 1500, word: "Hello" },
		{ startTime: 1500, endTime: 2200, word: "world" },
	];
	const generated = bindings.amllToTtml(
		{
			metadata,
			lyricLines: [
				{
					words,
					startTime: 1000,
					endTime: 2200,
					translatedLyric: "",
					romanLyric: "",
					isBG: false,
					isDuet: false,
				},
			],
		},
		undefined,
		{ useAppleFormatRules: true, lineTiming: false },
	);
	assert.equal(generated.success, true, JSON.stringify(generated));
	const restored = bindings.ttmlToAmll(generated.data, undefined);
	assert.equal(restored.success, true, JSON.stringify(restored));
	for (const item of metadata) {
		// The raw parser exposes the title as "title"; the editor import
		// wrapper maps that key back to "musicName".
		assert.deepEqual(
			restored.data.metadata.find(
				(entry: TTMLMetadata) =>
					entry.key === (item.key === "musicName" ? "title" : item.key),
			)?.value,
			item.value,
		);
	}
	assert.deepEqual(
		restored.data.lyricLines[0].words.map(
			(word: { word: string }) => word.word,
		),
		["Hello", "world"],
	);
});

test("song and selected album share links retain storefront and exact track identity", () => {
	for (const url of [
		songUrl,
		`  ${songUrl}?l=ja&uo=4  `,
		"music.apple.com/tr/song/1555193620/",
		"https://music.apple.com/TR/album/still/1555193619?i=1555193620&l=en",
		"https://itunes.apple.com/tr/album/still/id1555193619?i=1555193620",
	]) {
		assert.deepEqual(parseAppleMusicSongLink(url), link);
	}
	assert.deepEqual(
		parseAppleMusicSongLink("https://music.apple.com/song/1555193620"),
		{ ...link, storefront: "us" },
	);
});

test("an album without a selected song is not mistaken for the track", () => {
	assert.throws(
		() =>
			parseAppleMusicSongLink(
				"https://music.apple.com/tr/album/still/1555193619",
			),
		hasCode("albumLink"),
	);
});

test("unrelated hosts, credentials, unsupported resources and ambiguous IDs are rejected", () => {
	for (const url of [
		"",
		"1555193620",
		"https://music.apple.com.evil.test/tr/song/1555193620",
		"https://music.apple.com@evil.test/tr/song/1555193620",
		"https://user@music.apple.com/tr/song/1555193620",
		"http://music.apple.com/tr/song/1555193620",
		"https://music.apple.com:444/tr/song/1555193620",
		"https://music.apple.com/tr/artist/mirei/882739606",
		"https://music.apple.com/tr/song/foo/0",
		"https://music.apple.com/tr/song/9007199254740992",
		"https://music.apple.com/tr/album/still/1555193619?i=bad",
		"https://music.apple.com/tr/album/still/1555193619?i=1555193620&i=1555193621",
	]) {
		assert.throws(
			() => parseAppleMusicSongLink(url),
			hasCode("invalidLink"),
			url,
		);
	}
});

test("lookup maps only the four supported fields and exposes optional preview context", () => {
	assert.deepEqual(preview.metadata, [
		{ key: "musicName", value: ["Wake Atte"] },
		{ key: "artists", value: ["MIREI"] },
		{ key: "album", value: ["still"] },
		{ key: "appleMusicId", value: ["1555193620"] },
	]);
	assert.equal(preview.releaseDate, "2021-03-10");
	assert.equal(preview.durationMs, 261680);
	assert.equal(preview.artworkUrl, track.artworkUrl100);
	assert.equal(preview.sourceUrl, "https://music.apple.com/tr/song/1555193620");
});

test("artist punctuation remains part of the supplied name and missing optional data stays absent", () => {
	const result = parseAppleMusicLookupResponse(
		{
			results: [
				{
					...track,
					artistName: "Earth, Wind & Fire",
					collectionName: " ",
					releaseDate: "bad date",
					trackTimeMillis: -1,
					artworkUrl100: "javascript:alert(1)",
				},
			],
		},
		link,
	);
	assert.deepEqual(
		result.metadata.find((item) => item.key === "artists")?.value,
		["Earth, Wind & Fire"],
	);
	assert.equal(
		result.metadata.some((item) => item.key === "album"),
		false,
	);
	assert.equal(result.durationMs, undefined);
	assert.equal(result.releaseDate, undefined);
	assert.equal(result.artworkUrl, undefined);
});

test("unavailable tracks and malformed, wrong-ID or non-song responses never become a preview", () => {
	assert.throws(
		() => parseAppleMusicLookupResponse({ resultCount: 0, results: [] }, link),
		hasCode("notFound"),
	);
	for (const data of [
		null,
		{},
		{ results: {} },
		{ results: [] },
		{ results: [{ ...track, trackId: 1555193619 }] },
		{ results: [{ ...track, kind: "music-video" }] },
		{ results: [{ ...track, wrapperType: "collection" }] },
		{ results: [{ ...track, trackName: " " }] },
		{ results: [{ ...track, artistName: [] }] },
	]) {
		assert.throws(
			() => parseAppleMusicLookupResponse(data, link),
			hasCode("invalidResponse"),
		);
	}
});

test("network lookup is constrained to Apple's endpoint and does not carry credentials", async () => {
	const result = await fetchAppleMusicMetadata(songUrl, {
		fetcher: async (input, init) => {
			assert.equal(
				String(input),
				"https://itunes.apple.com/lookup?id=1555193620&country=tr",
			);
			assert.equal(init?.credentials, "omit");
			assert.equal(init?.referrerPolicy, "no-referrer");
			assert.ok(init?.signal);
			return json(lookup);
		},
	});
	assert.deepEqual(result, preview);
});

test("bad links and already-cancelled requests make no network call", async () => {
	let calls = 0;
	const fetcher: typeof fetch = async () => {
		calls++;
		return json(lookup);
	};
	await assert.rejects(
		fetchAppleMusicMetadata("https://example.com", { fetcher }),
		hasCode("invalidLink"),
	);
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(
		fetchAppleMusicMetadata(songUrl, { fetcher, signal: controller.signal }),
		{ name: "AbortError" },
	);
	assert.equal(calls, 0);
});

test("HTTP failures and invalid JSON have actionable recoverable error codes", async () => {
	for (const [status, code] of [
		[429, "rateLimited"],
		[404, "notFound"],
		[503, "network"],
	] as const) {
		await assert.rejects(
			fetchAppleMusicMetadata(songUrl, {
				fetcher: async () => json({}, status),
			}),
			hasCode(code),
		);
	}
	await assert.rejects(
		fetchAppleMusicMetadata(songUrl, {
			fetcher: async () => new Response("<html>error</html>"),
		}),
		hasCode("invalidResponse"),
	);
	await assert.rejects(
		fetchAppleMusicMetadata(songUrl, {
			fetcher: async () => {
				throw new TypeError("Failed to fetch");
			},
		}),
		hasCode("network"),
	);
	assert.deepEqual(
		await fetchAppleMusicMetadata(songUrl, {
			fetcher: async () => json(lookup),
		}),
		preview,
	);
});

test("timeout and user cancellation are distinguishable and late responses are discarded", async () => {
	const waitUntilCancelled: typeof fetch = async (_input, init) =>
		new Promise((_resolve, reject) => {
			init?.signal?.addEventListener(
				"abort",
				() => reject(init.signal?.reason),
				{ once: true },
			);
		});
	await assert.rejects(
		fetchAppleMusicMetadata(songUrl, {
			fetcher: waitUntilCancelled,
			timeoutMs: 5,
		}),
		hasCode("timeout"),
	);
	const controller = new AbortController();
	await assert.rejects(
		fetchAppleMusicMetadata(songUrl, {
			signal: controller.signal,
			fetcher: async () => {
				controller.abort();
				return json(lookup);
			},
		}),
		{ name: "AbortError" },
	);
});

test("default selection only fills empty fields, including duplicate-key edge cases", () => {
	const current: TTMLMetadata[] = [
		{ key: "musicName", value: ["Existing title"] },
		{ key: "artists", value: [" "] },
		{ key: "album", value: [] },
		{ key: "album", value: ["Existing album"] },
	];
	assert.deepEqual(getDefaultAppleMusicFields(current, preview), [
		"artists",
		"appleMusicId",
	]);
	const next = mergeAppleMusicMetadata(
		current,
		preview,
		getDefaultAppleMusicFields(current, preview),
	);
	assert.deepEqual(next.find((item) => item.key === "musicName")?.value, [
		"Existing title",
	]);
	assert.deepEqual(
		next.filter((item) => item.key === "album"),
		current.filter((item) => item.key === "album"),
	);
	assert.deepEqual(next.find((item) => item.key === "artists")?.value, [
		"MIREI",
	]);
});

test("explicit field selection replaces duplicates once, preserves other metadata and never mutates input", () => {
	const current: TTMLMetadata[] = [
		{ key: "musicName", value: ["Old"], error: true },
		{ key: "musicName", value: ["Duplicate"] },
		{ key: "artists", value: ["Keep A", "Keep B"] },
		{ key: "isrc", value: ["JP0002100001"] },
		{ key: "songwriter", value: ["Keep writer"] },
		{ key: "custom", value: ["Untouched"] },
	];
	const before = structuredClone(current);
	const next = mergeAppleMusicMetadata(current, preview, [
		"musicName",
		"appleMusicId",
	]);
	assert.deepEqual(current, before);
	assert.deepEqual(
		next.filter((item) => item.key === "musicName"),
		[{ key: "musicName", value: ["Wake Atte"] }],
	);
	for (const key of ["artists", "isrc", "songwriter", "custom"]) {
		assert.equal(
			next.find((item) => item.key === key),
			current.find((item) => item.key === key),
		);
	}
	assert.equal(
		mergeAppleMusicMetadata(next, preview, ["musicName", "appleMusicId"]),
		next,
	);
	assert.equal(mergeAppleMusicMetadata(current, preview, []), current);
	assert.equal(
		mergeAppleMusicMetadata(current, { ...preview, metadata: [] }, [
			"musicName",
		]),
		current,
	);
});

test("all imported fields form one undo step and preserve lyric timings, selections and project identity", () => {
	const store = createStore();
	const line = {
		...newLyricLine(),
		startTime: 1200,
		endTime: 3400,
		translatedLyric: "保留翻译",
		isBG: true,
		words: [
			{ ...newLyricWord(), word: "Original", startTime: 1200, endTime: 3400 },
		],
	};
	const initial = {
		metadata: [{ key: "songwriter", value: ["Writer"] }],
		lyricLines: [line],
	};
	store.set(lyricLinesAtom, initial);
	store.set(projectIdAtom, "active");
	store.set(saveFileNameAtom, "original.ttml");
	const selectedLines = new Set([line.id]);
	const selectedWords = new Set([line.words[0].id]);
	store.set(selectedLinesAtom, selectedLines);
	store.set(selectedWordsAtom, selectedWords);
	const stop = store.sub(undoableLyricLinesAtom, () => {});
	try {
		const request = {
			projectId: "active",
			preview,
			fields: [...APPLE_MUSIC_IMPORT_FIELDS],
		};
		assert.equal(store.set(importAppleMusicMetadataAtom, request), "changed");
		const imported = store.get(lyricLinesAtom);
		assert.equal(imported.lyricLines, initial.lyricLines);
		assert.equal(store.get(projectIdAtom), "active");
		assert.equal(store.get(saveFileNameAtom), "original.ttml");
		assert.equal(store.get(selectedLinesAtom), selectedLines);
		assert.equal(store.get(selectedWordsAtom), selectedWords);
		assert.equal(store.set(importAppleMusicMetadataAtom, request), "unchanged");
		store.set(undoLyricLinesAtom);
		assert.equal(store.get(lyricLinesAtom), initial);
		assert.equal(store.get(undoableLyricLinesAtom).canUndo, false);
		store.set(redoLyricLinesAtom);
		assert.equal(store.get(lyricLinesAtom), imported);
		store.set(projectIdAtom, "other");
		assert.equal(
			store.set(importAppleMusicMetadataAtom, request),
			"staleProject",
		);
		assert.equal(store.get(lyricLinesAtom), imported);
	} finally {
		stop();
	}
});
