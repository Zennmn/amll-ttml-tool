import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { AmllLyricResult } from "$/modules/ttml-processor/types";
import type { TTMLLyric } from "$/types/ttml";
import { convertOnlineLyrics, OnlineLyricsConversionError } from "./adapter";
import { convertOnlineLyricsForPreview } from "./ttml-import";
import type { OnlineLyrics, OnlineTrack } from "./types";

type TtmlParser = NonNullable<
	Parameters<typeof convertOnlineLyricsForPreview>[3]
>;

const MAX_TTML_CONTENT_BYTES = 2 * 1024 * 1024;

function makeTrack(overrides: Partial<OnlineTrack> = {}): OnlineTrack {
	return {
		provider: "amll-ttml-db",
		id: "repo-record-id",
		title: "Index Title",
		artists: ["Index Artist"],
		album: "Index Album",
		durationMs: 60_000,
		...overrides,
	};
}

function makeBundle(content: string): OnlineLyrics {
	return { original: { format: "ttml", content } };
}

function normalizeBundledParserResult(
	result: AmllLyricResult,
): AmllLyricResult {
	return {
		lyricLines: result.lyricLines.map((line) => ({
			...line,
			words: line.words.flatMap((word) => {
				const trailingSpace = word.word.match(/(\s+)$/);
				if (!trailingSpace || trailingSpace[0] === word.word) return [word];
				return [
					{
						...word,
						word: word.word.slice(0, -trailingSpace[0].length),
					},
					{
						startTime: 0,
						endTime: 0,
						word: trailingSpace[0],
					},
				];
			}),
		})),
		metadata: result.metadata
			.filter((meta) => meta.key !== "timingMode")
			.map((meta) => ({
				...meta,
				key:
					meta.key === "songwriters"
						? "songwriter"
						: meta.key === "title"
							? "musicName"
							: meta.key,
			})),
	};
}

async function loadBundledTtmlParser(): Promise<TtmlParser> {
	const bindings = await import(
		"../ttml-processor/wasm/ttml_processor_wasm_bg.js"
	);
	const bytes = await readFile(
		new URL(
			"../ttml-processor/wasm/ttml_processor_wasm_bg.wasm",
			import.meta.url,
		),
	);
	const { instance } = await WebAssembly.instantiate(bytes, {
		"./ttml_processor_wasm_bg.js": bindings,
	});
	bindings.__wbg_set_wasm(instance.exports);
	(instance.exports.__wbindgen_start as () => void)();

	return ((content: string) => {
		const result = bindings.ttmlToAmll(content, undefined) as
			| { success: true; data: AmllLyricResult }
			| { success: false; error: unknown };
		if (!result.success) return result as ReturnType<TtmlParser>;
		return {
			success: true,
			data: normalizeBundledParserResult(result.data),
		};
	}) as TtmlParser;
}

const parserPromise = loadBundledTtmlParser();

const RICH_TTML = `<?xml version="1.0" encoding="UTF-8"?>
<tt xmlns="http://www.w3.org/ns/ttml" xmlns:itunes="http://music.apple.com/lyric-ttml-internal" xmlns:ttm="http://www.w3.org/ns/ttml#metadata" xmlns:tts="http://www.w3.org/ns/ttml#styling" xmlns:amll="http://www.example.com/ns/amll" xml:lang="ja">
	<head><metadata>
		<amll:meta key="musicName" value="TTML Title"/>
		<amll:meta key="artists" value="TTML Artist"/>
		<amll:meta key="custom" value="custom-value"/>
		<amll:meta key="author" value="TTML Author"/>
		<amll:meta key="ncmMusicId" value="ncm-from-ttml"/>
		<amll:meta key="appleMusicId" value="apple-from-ttml"/>
		<iTunesMetadata xmlns="http://music.apple.com/lyric-ttml-internal"><transliterations><transliteration><text for="L1"><span begin="1.234" end="1.500">kimi</span><span begin="1.500" end="1.600">no</span><span begin="1.600" end="1.900">na</span></text></transliteration></transliterations></iTunesMetadata>
	</metadata></head>
	<body dur="4.000"><div begin="1.234" end="4.000">
		<p begin="1.234" end="1.900" itunes:key="L1" ttm:agent="v1">
			<span tts:ruby="container"><span tts:ruby="base">君</span><span tts:ruby="textContainer"><span tts:ruby="text" begin="1.234" end="1.500">きみ</span></span></span><span begin="1.500" end="1.600">の</span><span begin="1.600" end="1.900" amll:obscene="true" amll:empty-beat="2">名</span><span ttm:role="x-translation" xml:lang="zh-Hans">你的名字</span><span ttm:role="x-bg" begin="2.000" end="2.300"><span begin="2.000" end="2.300">(echo)</span></span>
		</p>
		<p begin="3.000" end="4.000" ttm:agent="v2"><span begin="3.000" end="4.000">Second singer</span></p>
	</div></body>
</tt>`;

function metadataValues(result: TTMLLyric, key: string): string[] | undefined {
	return result.metadata.find((meta) => meta.key === key)?.value;
}

function withoutIds(result: TTMLLyric): TTMLLyric {
	return {
		metadata: result.metadata.map((meta) => ({
			...meta,
			value: [...meta.value],
		})),
		lyricLines: result.lyricLines.map((line) => ({
			...line,
			id: "",
			words: line.words.map((word) => ({ ...word, id: "" })),
		})),
	};
}

function isConversionError(error: unknown): boolean {
	return error instanceof OnlineLyricsConversionError;
}

test("rich TTML uses the bundled parser and preserves timing and annotations", async () => {
	const parser = await parserPromise;
	const track = makeTrack({
		platformIds: {
			appleMusicId: ["apple-from-index"],
			ncmMusicId: ["ncm-from-index"],
			qqMusicId: ["qq-from-index"],
			spotifyId: ["spotify-from-index"],
		},
	});
	const bundle = makeBundle(RICH_TTML);
	const originalTrack = structuredClone(track);
	const originalBundle = structuredClone(bundle);

	const result = await convertOnlineLyricsForPreview(
		track,
		bundle,
		60_000,
		parser,
	);

	assert.deepEqual(track, originalTrack);
	assert.deepEqual(bundle, originalBundle);
	assert.equal(result.lyricLines.length, 3);
	const [main, background, duet] = result.lyricLines;
	assert.deepEqual([main.startTime, main.endTime], [1_234, 1_900]);
	assert.deepEqual([background.startTime, background.endTime], [2_000, 2_300]);
	assert.deepEqual([duet.startTime, duet.endTime], [3_000, 4_000]);
	assert.equal(main.isBG, false);
	assert.equal(background.isBG, true);
	assert.equal(duet.isDuet, true);
	assert.equal(main.translatedLyric, "你的名字");
	assert.equal(background.words.map((word) => word.word).join(""), "echo");
	assert.equal(main.ignoreSync, false);
	assert.ok(typeof main.id === "string" && main.id.length > 0);

	assert.deepEqual(
		main.words.map((word) => ({
			word: word.word,
			startTime: word.startTime,
			endTime: word.endTime,
			romanWord: word.romanWord,
			obscene: word.obscene,
			emptyBeat: word.emptyBeat,
		})),
		[
			{
				word: "君",
				startTime: 1_234,
				endTime: 1_500,
				romanWord: "kimi",
				obscene: false,
				emptyBeat: 0,
			},
			{
				word: "の",
				startTime: 1_500,
				endTime: 1_600,
				romanWord: "no",
				obscene: false,
				emptyBeat: 0,
			},
			{
				word: "名",
				startTime: 1_600,
				endTime: 1_900,
				romanWord: "na",
				obscene: true,
				emptyBeat: 2,
			},
		],
	);
	assert.deepEqual(main.words[0].ruby, [
		{ startTime: 1_234, endTime: 1_500, word: "きみ" },
	]);
	assert.equal(
		new Set(main.words.map((word) => word.id)).size,
		main.words.length,
	);

	assert.deepEqual(metadataValues(result, "musicName"), ["TTML Title"]);
	assert.deepEqual(metadataValues(result, "artists"), ["TTML Artist"]);
	assert.deepEqual(metadataValues(result, "album"), ["Index Album"]);
	assert.deepEqual(metadataValues(result, "language"), ["ja"]);
	assert.deepEqual(metadataValues(result, "custom"), ["custom-value"]);
	assert.deepEqual(metadataValues(result, "author"), ["TTML Author"]);
	assert.deepEqual(metadataValues(result, "ncmMusicId"), ["ncm-from-ttml"]);
	assert.deepEqual(metadataValues(result, "appleMusicId"), ["apple-from-ttml"]);
	assert.deepEqual(metadataValues(result, "qqMusicId"), ["qq-from-index"]);
	assert.deepEqual(metadataValues(result, "spotifyId"), ["spotify-from-index"]);
	assert.equal(
		result.metadata.some((meta) => meta.value.includes(track.id)),
		false,
	);
});

test("missing TTML metadata falls back to index metadata without inferring platform IDs", async () => {
	const parser = await parserPromise;
	const track = makeTrack({
		artists: ["Artist One", "Artist Two"],
		platformIds: {
			appleMusicId: ["apple-index"],
			ncmMusicId: ["ncm-index"],
			qqMusicId: ["qq-index"],
			spotifyId: ["spotify-index"],
		},
	});
	const content = `<tt xmlns="http://www.w3.org/ns/ttml" xml:lang="en"><body><div><p begin="0.500" end="1.500"><span begin="0.500" end="1.500">line</span></p></div></body></tt>`;

	const result = await convertOnlineLyricsForPreview(
		track,
		makeBundle(content),
		undefined,
		parser,
	);
	assert.deepEqual(metadataValues(result, "musicName"), ["Index Title"]);
	assert.deepEqual(metadataValues(result, "artists"), [
		"Artist One",
		"Artist Two",
	]);
	assert.deepEqual(metadataValues(result, "album"), ["Index Album"]);
	assert.deepEqual(metadataValues(result, "appleMusicId"), ["apple-index"]);
	assert.deepEqual(metadataValues(result, "ncmMusicId"), ["ncm-index"]);
	assert.deepEqual(metadataValues(result, "qqMusicId"), ["qq-index"]);
	assert.deepEqual(metadataValues(result, "spotifyId"), ["spotify-index"]);
	assert.equal(
		result.metadata.some((meta) => meta.value.includes(track.id)),
		false,
	);
});

test("non-TTML bundles use the existing synchronous converter unchanged", async () => {
	const track = makeTrack({
		provider: "qq",
		id: "qq-id",
		mid: "qq-mid",
		durationMs: 10_000,
	});
	const bundle: OnlineLyrics = {
		original: {
			format: "lrc",
			content: "[00:01.00]first\n[00:02.00]last",
		},
	};
	const originalTrack = structuredClone(track);
	const originalBundle = structuredClone(bundle);

	const preview = await convertOnlineLyricsForPreview(track, bundle, 4_000);
	const existing = convertOnlineLyrics(track, bundle, 4_000);

	assert.deepEqual(withoutIds(preview), withoutIds(existing));
	assert.equal(preview.lyricLines.at(-1)?.endTime, 4_000);
	assert.deepEqual(track, originalTrack);
	assert.deepEqual(bundle, originalBundle);
});

test("unsafe, oversized, empty and non-TTML content is rejected before parsing", async () => {
	const parser = await parserPromise;
	let parserCalls = 0;
	const countedParser: TtmlParser = (content) => {
		parserCalls++;
		return parser(content);
	};
	const oversized = `<tt>${"€".repeat(Math.floor(MAX_TTML_CONTENT_BYTES / 3) + 1)}</tt>`;
	for (const content of [
		"",
		"   \n\t",
		"<html><body>not TTML</body></html>",
		'<!DOCTYPE tt [<!ENTITY x "boom">]><tt><body/></tt>',
		'<tt><!ENTITY x "boom"><body/></tt>',
		oversized,
	]) {
		await assert.rejects(
			() =>
				convertOnlineLyricsForPreview(
					makeTrack(),
					makeBundle(content),
					undefined,
					countedParser,
				),
			isConversionError,
		);
	}
	assert.equal(parserCalls, 0);
});

test("malformed and lyric-empty TTML rejects with OnlineLyricsConversionError", async () => {
	const parser = await parserPromise;
	for (const content of [
		'<tt xmlns="http://www.w3.org/ns/ttml"><body><div><p begin="1.000" end="2.000">x</p></div></tt>',
		'<tt xmlns="http://www.w3.org/ns/ttml"><body><div/></body></tt>',
		'<tt xmlns="http://www.w3.org/ns/ttml"><head><metadata><amll:meta xmlns:amll="http://www.example.com/ns/amll" key="musicName" value="title only"/></metadata></head><body><div/></body></tt>',
		'<tt xmlns="http://www.w3.org/ns/ttml"><body><div><p begin="1.000" end="2.000">   </p></div></body></tt>',
	]) {
		await assert.rejects(
			() =>
				convertOnlineLyricsForPreview(
					makeTrack(),
					makeBundle(content),
					undefined,
					parser,
				),
			(error: unknown) => {
				assert.ok(error instanceof OnlineLyricsConversionError);
				assert.match(error.message, /TTML/);
				return true;
			},
		);
	}
});
