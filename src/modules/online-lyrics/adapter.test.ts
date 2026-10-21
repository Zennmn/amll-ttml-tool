import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { test } from "node:test";
import { convertOnlineLyrics, OnlineLyricsConversionError } from "./adapter";
import type { LyricChannel, OnlineLyrics, OnlineTrack } from "./types";

function makeTrack(overrides: Partial<OnlineTrack> = {}): OnlineTrack {
	return {
		provider: "qq",
		id: "song-id",
		mid: "song-mid",
		title: "Song",
		artists: ["Singer"],
		album: "Album",
		durationMs: 10_000,
		...overrides,
	};
}

function makeBundle(
	original: LyricChannel,
	extra: Partial<OnlineLyrics> = {},
): OnlineLyrics {
	return { original, ...extra };
}

function lineText(line: { words: { word: string }[] }): string {
	return line.words.map((word) => word.word).join("");
}

test("LRC applies offset, keeps simultaneous source rows, and uses duration for the last row", () => {
	const result = convertOnlineLyrics(
		makeTrack(),
		makeBundle({
			format: "lrc",
			content:
				"[offset:+500]\n[00:01.00]same time\n[00:01.00]second source\n[00:02.00]last",
		}),
		4_000,
	);

	assert.equal(result.lyricLines.length, 3);
	assert.deepEqual(
		result.lyricLines.map((line) => line.startTime),
		[1_500, 1_500, 2_500],
	);
	assert.deepEqual(
		result.lyricLines.map((line) => line.endTime),
		[2_500, 2_500, 4_000],
	);
	assert.deepEqual(result.lyricLines.map(lineText), [
		"same time",
		"second source",
		"last",
	]);
	assert.deepEqual(
		result.lyricLines.map((line) => line.translatedLyric),
		["", "", ""],
	);
	for (const line of result.lyricLines) {
		assert.equal(typeof line.id, "string");
		assert.equal(line.ignoreSync, false);
		assert.equal(line.words.length, 1);
		assert.equal(line.words[0].obscene, false);
		assert.equal(line.words[0].emptyBeat, 0);
	}
});

test("LRC translation and romanization channels align independently", () => {
	const result = convertOnlineLyrics(
		makeTrack(),
		makeBundle(
			{
				format: "lrc",
				content: "[00:01.00]君の名\n[00:02.00]second",
			},
			{
				translation: {
					format: "lrc",
					content:
						"[00:01.00]<00:01.00>你<00:01.20>的<00:01.40>名字<00:02.00>\n[00:02.00]第二",
				},
				romanization: {
					format: "lrc",
					content: "[00:01.00]kimi no na\n[00:02.00]sekando",
				},
			},
		),
		3_500,
	);

	assert.equal(result.lyricLines.length, 2);
	assert.equal(result.lyricLines[0].translatedLyric, "你的名字");
	assert.equal(result.lyricLines[0].romanLyric, "kimi no na");
	assert.equal(result.lyricLines[1].translatedLyric, "第二");
	assert.equal(result.lyricLines[1].romanLyric, "sekando");
});

test("LRCLIB restores translation and romanization from same-timestamp rows", () => {
	const result = convertOnlineLyrics(
		makeTrack({ provider: "lrclib", id: "lrclib-grouped" }),
		makeBundle({
			format: "lrc",
			content:
				"[00:01.00]Hello\n[00:01.00]你好\n[00:01.00]ni hao\n[00:02.00]Next",
		}),
		3_000,
	);

	assert.deepEqual(result.lyricLines.map(lineText), ["Hello", "Next"]);
	assert.equal(result.lyricLines[0].translatedLyric, "你好");
	assert.equal(result.lyricLines[0].romanLyric, "ni hao");
});

test("LRCLIB keeps same-timestamp rows separate when language channels exist", () => {
	const result = convertOnlineLyrics(
		makeTrack({ provider: "lrclib", id: "lrclib-channel" }),
		makeBundle(
			{
				format: "lrc",
				content:
					"[00:01.00]Hello\n[00:01.00]你好\n[00:01.00]ni hao\n[00:02.00]Next",
			},
			{
				translation: {
					format: "lrc",
					content: "[00:01.00]翻译\n[00:02.00]下一句",
				},
			},
		),
		3_000,
	);

	assert.deepEqual(result.lyricLines.map(lineText), [
		"Hello",
		"你好",
		"ni hao",
		"Next",
	]);
	assert.equal(result.lyricLines[0].translatedLyric, "翻译");
});

test("QRC XML wrapper, character entity, and absolute word times are preserved", () => {
	const result = convertOnlineLyrics(
		makeTrack(),
		makeBundle({
			format: "qrc",
			content:
				'<?xml version="1.0"?><Qrc><Lyric_1 LyricType="1" LyricContent="[ti:Demo]&#10;[1000,2000]你(1000,200)好(1200,400)&amp;世(1600,500)界(2100,400)"/></Qrc>',
		}),
		3_500,
	);

	assert.equal(result.lyricLines.length, 1);
	const line = result.lyricLines[0];
	assert.equal(lineText(line), "你好&世界");
	assert.equal(line.startTime, 1_000);
	assert.equal(line.endTime, 3_000);
	assert.deepEqual(
		line.words.map((word) => word.startTime),
		[1_000, 1_200, 1_600, 2_100],
	);
	assert.deepEqual(
		line.words.map((word) => word.endTime),
		[1_200, 1_600, 2_100, 2_500],
	);
});

test("YRC keeps the provider word axis", () => {
	const result = convertOnlineLyrics(
		makeTrack({ provider: "netease", id: "42" }),
		makeBundle({
			format: "yrc",
			content: "[1000,2000](1000,200,0)你(1200,300,0)好(1500,500,0)",
		}),
		4_000,
	);

	const line = result.lyricLines[0];
	assert.equal(lineText(line), "你好");
	assert.equal(line.startTime, 1_000);
	assert.equal(line.endTime, 3_000);
	assert.deepEqual(
		line.words.map((word) => [word.word, word.startTime, word.endTime]),
		[
			["你", 1_000, 1_200],
			["好", 1_200, 1_500],
		],
	);
});

test("KRC uses line-relative word times and language translations and romanization", () => {
	const language = Buffer.from(
		JSON.stringify({
			content: [
				{
					type: 0,
					lyricContent: [["ni", "hao"], [], ["zai", "jian"]],
				},
				{
					type: 1,
					lyricContent: [["hello"], [""], ["bye"]],
				},
			],
		}),
	).toString("base64");
	const result = convertOnlineLyrics(
		makeTrack({ provider: "kugou", id: "kg", hash: "hash" }),
		makeBundle({
			format: "krc",
			content:
				"[ti:Demo]\n[0,2000]<0,500,0>你<500,500,0>好\n[2000,2000]\n[4000,2000]<0,1000,0>再<1000,500,0>见\n[language:" +
				language +
				"]",
		}),
		6_000,
	);

	assert.equal(result.lyricLines.length, 2);
	assert.deepEqual(result.lyricLines.map(lineText), ["你好", "再见"]);
	assert.deepEqual(
		result.lyricLines.map((line) => line.translatedLyric),
		["hello", "bye"],
	);
	assert.deepEqual(
		result.lyricLines[0].words.map((word) => [
			word.startTime,
			word.endTime,
			word.romanWord,
		]),
		[
			[0, 500, "ni"],
			[500, 1_000, "hao"],
		],
	);
	assert.deepEqual(
		result.lyricLines[1].words.map((word) => [
			word.startTime,
			word.endTime,
			word.romanWord,
		]),
		[
			[4_000, 5_000, "zai"],
			[5_000, 5_500, "jian"],
		],
	);
});

test("KRC preserves spaces between timed English words", () => {
	const result = convertOnlineLyrics(
		makeTrack({ provider: "kugou", id: "kg-spaces" }),
		makeBundle({
			format: "krc",
			content: "[0,1000]<0,500,0>Hello <500,500,0>world",
		}),
		2_000,
	);

	assert.equal(lineText(result.lyricLines[0]), "Hello world");
	assert.deepEqual(
		result.lyricLines[0].words.map((word) => word.word),
		["Hello ", "world"],
	);
});

test("KRC compact language rows preserve empty-row positions and do not shift later text", () => {
	const language = Buffer.from(
		JSON.stringify({
			content: [
				{
					type: 1,
					lyricContent: [["first"], [""], ["third"]],
				},
			],
		}),
	).toString("base64");
	const result = convertOnlineLyrics(
		makeTrack({
			provider: "kugou",
			id: "kg2",
			durationMs: 5_000,
		}),
		makeBundle({
			format: "krc",
			content:
				"[0,1000]<0,500,0>A\n[1000,1000]\n[2000,1000]<0,500,0>B\n[3000,1000]<0,500,0>C\n[language:" +
				language +
				"]",
		}),
	);

	assert.deepEqual(
		result.lyricLines.map((line) => line.translatedLyric),
		["first", "", "third"],
	);
});

test("plain text without timestamps is retained without inventing word timing", () => {
	const result = convertOnlineLyrics(
		makeTrack(),
		makeBundle(
			{
				format: "plain",
				content: "第一行\n\n  second line  ",
			},
			{
				translation: {
					format: "plain",
					content: "line one\nline two",
				},
			},
		),
		5_000,
	);

	assert.equal(result.lyricLines.length, 2);
	assert.deepEqual(result.lyricLines.map(lineText), ["第一行", "second line"]);
	assert.deepEqual(
		result.lyricLines.map((line) => line.translatedLyric),
		["line one", "line two"],
	);
	for (const line of result.lyricLines) {
		assert.equal(line.startTime, 0);
		assert.equal(line.endTime, 0);
		assert.equal(line.words[0].startTime, 0);
		assert.equal(line.words[0].endTime, 0);
	}
});

test("provider ids use separate metadata keys and QQ prefers mid", () => {
	const cases: Array<{
		provider: OnlineTrack["provider"];
		key: string;
		expected: string;
	}> = [
		{ provider: "netease", key: "ncmMusicId", expected: "ncm-id" },
		{ provider: "qq", key: "qqMusicId", expected: "qq-mid" },
		{ provider: "kugou", key: "kugouMusicId", expected: "kg-id" },
		{ provider: "lrclib", key: "lrclibId", expected: "lrc-id" },
	];

	for (const item of cases) {
		const result = convertOnlineLyrics(
			makeTrack({
				provider: item.provider,
				id: `${item.provider}-id`,
				mid: "qq-mid",
				title: "Title",
				artists: ["A", "B"],
				album: "Album",
			}),
			makeBundle({ format: "plain", content: "lyric" }),
		);
		const metadata = new Map(
			result.metadata.map((item) => [item.key, item.value]),
		);
		assert.deepEqual(metadata.get("musicName"), ["Title"]);
		assert.deepEqual(metadata.get("artists"), ["A", "B"]);
		assert.deepEqual(metadata.get("album"), ["Album"]);
		assert.deepEqual(metadata.get(item.key), [
			item.provider === "qq" ? item.expected : `${item.provider}-id`,
		]);
		for (const other of cases) {
			if (other.key !== item.key) assert.equal(metadata.has(other.key), false);
		}
	}
});

test("NetEase orig_lrc anchors translation while direct time matching stays bounded", () => {
	const languageTrack = makeTrack({ provider: "netease", id: "ne" });
	const result = convertOnlineLyrics(
		languageTrack,
		makeBundle(
			{
				format: "yrc",
				content:
					"[1500,1000](1500,100,0)Hello(1600,900,0)\n[3500,1000](3500,100,0)World(3600,900,0)",
			},
			{
				translation: {
					format: "lrc",
					content: "[00:01.00]你好\n[00:03.00]世界",
				},
				originalLrc: "[00:01.00]Hello\n[00:03.00]World",
			},
		),
		7_000,
	);

	assert.deepEqual(
		result.lyricLines.map((line) => line.translatedLyric),
		["你好", "世界"],
	);

	const bounded = convertOnlineLyrics(
		makeTrack({ provider: "qq" }),
		makeBundle(
			{
				format: "lrc",
				content: "[00:01.00]far apart\n[00:10.00]also far",
			},
			{
				translation: {
					format: "lrc",
					content: "[00:02.00]wrong line",
				},
			},
		),
		11_000,
	);
	assert.deepEqual(
		bounded.lyricLines.map((line) => line.translatedLyric),
		["", ""],
	);
});

test("enhanced LRC clears the parser's open-ended final timestamp", () => {
	const result = convertOnlineLyrics(
		makeTrack(),
		makeBundle({
			format: "lrc",
			content: "[00:01.00]<00:01.00>Hello <00:01.50>world\n[00:05.00]last",
		}),
		6_000,
	);

	assert.equal(result.lyricLines[1].startTime, 5_000);
	assert.equal(result.lyricLines[1].endTime, 6_000);
	assert.equal(result.lyricLines[1].words[0].endTime, 6_000);
});

test("QRC and YRC explicit line ends are not clamped to audio duration", () => {
	for (const channel of [
		{ format: "qrc" as const, content: "[1000,3000]a(1000,3000)" },
		{ format: "yrc" as const, content: "[1000,3000](1000,3000,0)a" },
	]) {
		const result = convertOnlineLyrics(
			makeTrack({ durationMs: 2_000 }),
			makeBundle(channel),
			2_000,
		);
		assert.equal(result.lyricLines[0].endTime, 4_000);
		assert.equal(result.lyricLines[0].words[0].endTime, 4_000);
	}
});

test("malformed KRC language metadata reports a typed error", () => {
	assert.throws(
		() =>
			convertOnlineLyrics(
				makeTrack({ provider: "kugou" }),
				makeBundle({
					format: "krc",
					content: "[0,1000]<0,500,0>A\n[language:not-base64!]",
				}),
			),
		(error: unknown) =>
			error instanceof OnlineLyricsConversionError &&
			/base64/.test(error.message),
	);

	assert.throws(
		() =>
			convertOnlineLyrics(
				makeTrack({ provider: "kugou" }),
				makeBundle({
					format: "krc",
					content:
						"[0,1000]<0,500,0>A\n[language:" +
						Buffer.from("{}").toString("base64") +
						"]",
				}),
			),
		(error: unknown) =>
			error instanceof OnlineLyricsConversionError &&
			/structure/.test(error.message),
	);
});
