import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { createStore } from "jotai";
import {
	lyricLinesAtom,
	projectIdAtom,
	redoLyricLinesAtom,
	selectedLinesAtom,
	undoableLyricLinesAtom,
	undoLyricLinesAtom,
} from "$/states/main";
import { newLyricLine, newLyricWord, type TTMLLyric } from "$/types/ttml";
import {
	AppleMusicMetadataError,
	fetchAppleMusicMetadata,
	getAvailableAppleMusicFields,
	getDefaultAppleMusicFields,
	mergeAppleMusicMetadata,
	parseAppleMusicCatalogResponse,
} from "./apple-music-metadata";
import { importAppleMusicMetadataAtom } from "./apple-music-metadata-state";

const songUrl = "https://music.apple.com/tr/song/wake-atte/1555193620";
const link = { songId: "1555193620", storefront: "tr" };
const attributes = {
	name: "Wake Atte",
	artistName: "MIREI",
	albumName: "still",
	isrc: "JPU902100426",
	composerName: "Shinya Ishihara",
	durationInMillis: 261680,
	releaseDate: "2021-03-10",
	artwork: {
		url: "https://is1-ssl.mzstatic.com/image/thumb/cover/{w}x{h}bb.jpg",
	},
};
const catalog = { data: [{ id: link.songId, type: "songs", attributes }] };
const basic = {
	resultCount: 1,
	results: [
		{
			wrapperType: "track",
			kind: "song",
			trackId: 1555193620,
			trackName: "Wake Atte",
			artistName: "MIREI",
			collectionName: "still",
		},
	],
};
const envelope = (data: unknown) => ({
	status: 200,
	body: JSON.stringify(data),
});
const invalidResponse = (error: unknown) =>
	error instanceof AppleMusicMetadataError && error.code === "invalidResponse";
const value = (metadata: { key: string; value: string[] }[], key: string) =>
	metadata.find((entry) => entry.key === key)?.value;

test("catalog response maps the exact song plus validated ISRC and whole composer display name", () => {
	const input = structuredClone(catalog);
	const result = parseAppleMusicCatalogResponse(input, link);
	assert.equal(result.retrievalMode, "enhanced");
	assert.equal(result.storefront, "tr");
	assert.equal(result.songId, link.songId);
	assert.deepEqual(value(result.metadata, "isrc"), ["JPU902100426"]);
	assert.deepEqual(value(result.metadata, "songwriter"), ["Shinya Ishihara"]);
	assert.equal(result.durationMs, 261680);
	assert.equal(result.releaseDate, "2021-03-10");
	assert.match(result.artworkUrl ?? "", /300x300bb\.jpg$/);
	assert.deepEqual(input, catalog);
	const named = parseAppleMusicCatalogResponse(
		{
			data: [
				{
					...catalog.data[0],
					attributes: {
						...attributes,
						artistName: "Earth, Wind & Fire",
						composerName: "One, Two & Three",
						isrc: "jp-u90-21-00426",
					},
				},
			],
		},
		link,
	);
	assert.deepEqual(value(named.metadata, "artists"), ["Earth, Wind & Fire"]);
	assert.deepEqual(value(named.metadata, "songwriter"), ["One, Two & Three"]);
	assert.deepEqual(value(named.metadata, "isrc"), ["JPU902100426"]);
});

test("missing or malformed optional catalog attributes never clear existing ISRC or credits", () => {
	for (const bad of [undefined, "", "NOT-AN-ISRC", 123, "<script>"]) {
		const result = parseAppleMusicCatalogResponse(
			{
				data: [
					{
						...catalog.data[0],
						attributes: {
							...attributes,
							isrc: bad,
							composerName: null,
							artwork: { url: "javascript:alert(1)" },
							releaseDate: "invalid",
							durationInMillis: Number.NaN,
						},
					},
				],
			},
			link,
		);
		assert.equal(value(result.metadata, "isrc"), undefined);
		assert.equal(value(result.metadata, "songwriter"), undefined);
		assert.equal(result.artworkUrl, undefined);
		assert.equal(result.releaseDate, undefined);
		assert.equal(result.durationMs, undefined);
		const current = [
			{ key: "isrc", value: ["USAAA2400001"] },
			{ key: "songwriter", value: ["Manual credit"] },
		];
		assert.equal(
			mergeAppleMusicMetadata(current, result, ["isrc", "songwriter"]),
			current,
		);
	}
});

test("catalog parser rejects wrong IDs, non-song resources, malformed records and absent required names", () => {
	for (const data of [
		null,
		{},
		{ data: {} },
		{ data: [null] },
		{ data: [{ ...catalog.data[0], id: "1555193621" }] },
		{ data: [{ ...catalog.data[0], type: "albums" }] },
		{
			data: [{ ...catalog.data[0], attributes: { ...attributes, name: " " } }],
		},
		{
			data: [
				{ ...catalog.data[0], attributes: { ...attributes, artistName: null } },
			],
		},
	])
		assert.throws(
			() => parseAppleMusicCatalogResponse(data, link),
			invalidResponse,
		);
	assert.throws(
		() => parseAppleMusicCatalogResponse({ data: [] }, link),
		(error) =>
			error instanceof AppleMusicMetadataError && error.code === "notFound",
	);
});

test("enhanced native success does not depend on or call the basic transport", async () => {
	let basicCalls = 0;
	const result = await fetchAppleMusicMetadata(songUrl, {
		mode: "enhanced",
		nativeCatalogLookup: async (actual) => {
			assert.deepEqual(actual, link);
			return envelope(catalog);
		},
		nativeLookup: async () => {
			basicCalls++;
			throw new Error("basic unavailable");
		},
		fetcher: async () => {
			throw new Error("WebView blocked");
		},
	});
	assert.equal(result.retrievalMode, "enhanced");
	assert.deepEqual(value(result.metadata, "isrc"), ["JPU902100426"]);
	assert.equal(basicCalls, 0);
});

test("desktop enhancement selects the registered catalog IPC command with the original storefront and song ID", async () => {
	const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
	const previousMarker = Object.getOwnPropertyDescriptor(globalThis, "isTauri");
	Object.defineProperty(globalThis, "window", {
		configurable: true,
		value: {},
	});
	Object.defineProperty(globalThis, "isTauri", {
		configurable: true,
		value: true,
	});
	let calls = 0;
	mockIPC((command, args) => {
		calls++;
		assert.equal(command, "apple_music_catalog_lookup");
		assert.deepEqual(args, { songId: link.songId, storefront: "tr" });
		return envelope(catalog);
	});
	try {
		const result = await fetchAppleMusicMetadata(songUrl, { mode: "enhanced" });
		assert.equal(result.retrievalMode, "enhanced");
		assert.deepEqual(value(result.metadata, "isrc"), ["JPU902100426"]);
		assert.equal(calls, 1);
	} finally {
		clearMocks();
		if (previousWindow)
			Object.defineProperty(globalThis, "window", previousWindow);
		else Reflect.deleteProperty(globalThis, "window");
		if (previousMarker)
			Object.defineProperty(globalThis, "isTauri", previousMarker);
		else Reflect.deleteProperty(globalThis, "isTauri");
	}
});

test("enhancement rejection, malformed/oversized/wrong-song replies and HTTP failures all retain basic lookup", async () => {
	for (const failure of [
		undefined,
		{ status: 403, body: "" },
		{ status: 429, body: "" },
		{ status: 200, body: "invalid json" },
		{ status: 200, body: "x".repeat(512 * 1024 + 1) },
		envelope({ data: [{ ...catalog.data[0], id: "1234567890" }] }),
		envelope({ data: [] }),
	]) {
		let basicCalls = 0;
		const result = await fetchAppleMusicMetadata(songUrl, {
			mode: "enhanced",
			nativeCatalogLookup: async () => {
				if (!failure) throw new Error("old desktop command");
				return failure;
			},
			nativeLookup: async () => {
				basicCalls++;
				return envelope(basic);
			},
		});
		assert.equal(basicCalls, 1);
		assert.equal(result.retrievalMode, "basic");
		assert.equal(result.enhancementUnavailable, true);
		assert.equal(value(result.metadata, "isrc"), undefined);
		assert.deepEqual(value(result.metadata, "musicName"), ["Wake Atte"]);
	}
});

test("explicit basic mode skips catalog even when an enhancement operation is available", async () => {
	let enhancedCalls = 0;
	await fetchAppleMusicMetadata(songUrl, {
		mode: "basic",
		nativeCatalogLookup: async () => {
			enhancedCalls++;
			return envelope(catalog);
		},
		nativeLookup: async () => envelope(basic),
	});
	assert.equal(enhancedCalls, 0);
});

test("an unresponsive enhancement falls back within its budget and late catalog completions are discarded", async () => {
	let complete: (value: ReturnType<typeof envelope>) => void = () => {};
	const operation = fetchAppleMusicMetadata(songUrl, {
		mode: "enhanced",
		enhancementTimeoutMs: 3,
		nativeCatalogLookup: () =>
			new Promise((resolve) => {
				complete = resolve;
			}),
		nativeLookup: async () => envelope(basic),
	});
	const result = await operation;
	complete(envelope(catalog));
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.equal(result.retrievalMode, "basic");
	assert.equal(value(result.metadata, "isrc"), undefined);
});

test("user cancellation and whole-operation timeout suppress fallback and never publish late enhanced data", async () => {
	const controller = new AbortController();
	let basicCalls = 0;
	let complete: (value: ReturnType<typeof envelope>) => void = () => {};
	const operation = fetchAppleMusicMetadata(songUrl, {
		mode: "enhanced",
		signal: controller.signal,
		nativeCatalogLookup: () =>
			new Promise((resolve) => {
				complete = resolve;
			}),
		nativeLookup: async () => {
			basicCalls++;
			return envelope(basic);
		},
	});
	await Promise.resolve();
	await Promise.resolve();
	controller.abort();
	await assert.rejects(
		operation,
		(error) => error instanceof Error && error.name === "AbortError",
	);
	complete(envelope(catalog));
	await assert.rejects(
		fetchAppleMusicMetadata(songUrl, {
			mode: "enhanced",
			timeoutMs: 3,
			nativeCatalogLookup: () => new Promise(() => {}),
			nativeLookup: async () => {
				basicCalls++;
				return envelope(basic);
			},
		}),
		(error) =>
			error instanceof AppleMusicMetadataError && error.code === "timeout",
	);
	assert.equal(basicCalls, 0);
});

test("invalid links and already cancelled enhanced requests never start any transport", async () => {
	let calls = 0;
	const nativeCatalogLookup = async () => {
		calls++;
		return envelope(catalog);
	};
	await assert.rejects(
		fetchAppleMusicMetadata("https://example.com/1555193620", {
			mode: "enhanced",
			nativeCatalogLookup,
		}),
	);
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(
		fetchAppleMusicMetadata(songUrl, {
			mode: "enhanced",
			nativeCatalogLookup,
			signal: controller.signal,
		}),
	);
	assert.equal(calls, 0);
});

test("select-all includes every available field while defaults preserve manual ISRC and songwriter values", () => {
	const preview = parseAppleMusicCatalogResponse(catalog, link);
	const current = [
		{ key: "isrc", value: ["USAAA2400001"] },
		{ key: "songwriter", value: ["Manual credit"] },
	];
	const selected = getAvailableAppleMusicFields(preview);
	assert.deepEqual(selected, [
		"musicName",
		"artists",
		"album",
		"appleMusicId",
		"isrc",
		"songwriter",
	]);
	assert.deepEqual(getDefaultAppleMusicFields(current, preview), [
		"musicName",
		"artists",
		"album",
		"appleMusicId",
	]);
	const merged = mergeAppleMusicMetadata(current, preview, selected);
	assert.deepEqual(value(merged, "isrc"), ["JPU902100426"]);
	assert.deepEqual(value(merged, "songwriter"), ["Shinya Ishihara"]);
	assert.equal(mergeAppleMusicMetadata(current, preview, []), current);
	const partial = {
		...preview,
		metadata: preview.metadata.filter(
			(entry) => entry.key !== "isrc" && entry.key !== "songwriter",
		),
	};
	assert.deepEqual(getAvailableAppleMusicFields(partial), [
		"musicName",
		"artists",
		"album",
		"appleMusicId",
	]);
});

test("six-field import uses one undo step and keeps current lyrics, selections and project identity", () => {
	const preview = parseAppleMusicCatalogResponse(catalog, link);
	const input: TTMLLyric = {
		metadata: [{ key: "custom", value: ["keep"] }],
		lyricLines: [
			{
				...newLyricLine(),
				words: [
					{
						...newLyricWord(),
						word: "Original",
						startTime: 1234,
						endTime: 2345,
					},
				],
				translatedLyric: "原译文",
			},
		],
	};
	const snapshot = structuredClone(input);
	const store = createStore();
	store.set(lyricLinesAtom, input);
	store.set(projectIdAtom, "current");
	const selected = new Set([input.lyricLines[0].id]);
	store.set(selectedLinesAtom, selected);
	const unsub = store.sub(undoableLyricLinesAtom, () => {});
	try {
		assert.equal(
			store.set(importAppleMusicMetadataAtom, {
				projectId: "other",
				preview,
				fields: getAvailableAppleMusicFields(preview),
			}),
			"staleProject",
		);
		assert.equal(store.get(lyricLinesAtom), input);
		assert.equal(
			store.set(importAppleMusicMetadataAtom, {
				projectId: "current",
				preview,
				fields: getAvailableAppleMusicFields(preview),
			}),
			"changed",
		);
		const imported = store.get(lyricLinesAtom);
		assert.equal(imported.lyricLines, input.lyricLines);
		assert.equal(store.get(selectedLinesAtom), selected);
		assert.deepEqual(value(imported.metadata, "custom"), ["keep"]);
		assert.deepEqual(value(imported.metadata, "isrc"), ["JPU902100426"]);
		store.set(undoLyricLinesAtom);
		assert.equal(store.get(lyricLinesAtom), input);
		assert.equal(store.get(undoableLyricLinesAtom).canUndo, false);
		store.set(redoLyricLinesAtom);
		assert.equal(store.get(lyricLinesAtom), imported);
		assert.deepEqual(input, snapshot);
	} finally {
		unsub();
	}
});

test("ISRC and composer imports survive both bundled Apple and AMLL TTML export formats", async () => {
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
	const preview = parseAppleMusicCatalogResponse(catalog, link);
	const lyric: TTMLLyric = {
		metadata: preview.metadata,
		lyricLines: [
			{
				...newLyricLine(),
				startTime: 1000,
				endTime: 2000,
				words: [
					{ ...newLyricWord(), word: "Test", startTime: 1000, endTime: 2000 },
				],
			},
		],
	};
	for (const apple of [false, true]) {
		const generated = bindings.amllToTtml(lyric, undefined, {
			useAppleFormatRules: apple,
			lineTiming: false,
		});
		assert.equal(generated.success, true, JSON.stringify(generated));
		const restored = bindings.ttmlToAmll(generated.data, undefined);
		assert.equal(restored.success, true, JSON.stringify(restored));
		assert.deepEqual(value(restored.data.metadata, "isrc"), ["JPU902100426"]);
		assert.deepEqual(
			value(restored.data.metadata, "songwriters") ??
				value(restored.data.metadata, "songwriter"),
			["Shinya Ishihara"],
		);
	}
});
