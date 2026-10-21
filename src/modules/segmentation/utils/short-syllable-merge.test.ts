import assert from "node:assert/strict";
import test from "node:test";
import { createStore } from "jotai";
import {
	editingWordStateAtom,
	lyricLinesAtom,
	projectIdAtom,
	redoLyricLinesAtom,
	saveFileNameAtom,
	selectedLinesAtom,
	selectedWordsAtom,
	undoableLyricLinesAtom,
	undoLyricLinesAtom,
} from "$/states/main";
import {
	type LyricWord,
	newLyricLine,
	newLyricWord,
	type TTMLLyric,
} from "$/types/ttml";
import { applyShortSyllableMergeAtom } from "../states/short-syllable-merge";
import {
	mergeShortSyllables,
	mergeShortSyllablesInLyrics,
} from "./short-syllable-merge";

function word(
	text: string,
	start: number,
	end: number,
	extra: Partial<LyricWord> = {},
): LyricWord {
	return {
		...newLyricWord(),
		word: text,
		startTime: start,
		endTime: end,
		...extra,
	};
}
const row = (words: LyricWord[]) => ({ ...newLyricLine(), words });
const texts = (words: LyricWord[]) => words.map((entry) => entry.word);

test("short unit merges despite a large duration difference, retaining text and timing bounds", () => {
	const input = row([word("你", 1000, 1500), word("好", 1500, 1550)]);
	const before = structuredClone(input);
	const result = mergeShortSyllables(input);
	assert.equal(result.mergedUnits, 1);
	assert.deepEqual(texts(result.line.words), ["你好"]);
	assert.equal(result.line.words[0].id, input.words[0].id);
	assert.deepEqual(
		[result.line.words[0].startTime, result.line.words[0].endTime],
		[1000, 1550],
	);
	assert.deepEqual(input, before);
});

test("automatic direction uses the closest gap, then the shorter neighbor", () => {
	const closerNext = row([
		word("我", 0, 500),
		word("爱", 550, 600),
		word("你", 610, 1110),
	]);
	assert.deepEqual(texts(mergeShortSyllables(closerNext).line.words), [
		"我",
		"爱你",
	]);
	const shorterNext = row([
		word("我", 0, 500),
		word("爱", 500, 550),
		word("你", 550, 750),
	]);
	assert.deepEqual(texts(mergeShortSyllables(shorterNext).line.words), [
		"我",
		"爱你",
	]);
	const tied = row([
		word("我", 0, 200),
		word("爱", 200, 250),
		word("你", 250, 450),
	]);
	assert.deepEqual(texts(mergeShortSyllables(tied).line.words), ["我爱", "你"]);
});

test("direction preferences and fallback work at line boundaries", () => {
	const input = row([
		word("我", 0, 500),
		word("爱", 500, 550),
		word("你", 550, 750),
	]);
	assert.deepEqual(
		texts(mergeShortSyllables(input, { direction: "previous" }).line.words),
		["我爱", "你"],
	);
	assert.deepEqual(
		texts(mergeShortSyllables(input, { direction: "next" }).line.words),
		["我", "爱你"],
	);
	assert.equal(
		mergeShortSyllables(row([word("你", 0, 50), word("好", 50, 550)]), {
			direction: "previous",
		}).mergedUnits,
		1,
	);
	assert.equal(
		mergeShortSyllables(row([word("你", 0, 500), word("好", 500, 550)]), {
			direction: "next",
		}).mergedUnits,
		1,
	);
});

test("threshold is strict, configurable and validated", () => {
	const input = row([word("你", 0, 500), word("好", 500, 600)]);
	assert.equal(mergeShortSyllables(input).line, input);
	assert.equal(mergeShortSyllables(input, { thresholdMs: 101 }).mergedUnits, 1);
	for (const thresholdMs of [
		0,
		-1,
		1.5,
		1001,
		Number.NaN,
		Number.POSITIVE_INFINITY,
	]) {
		assert.equal(mergeShortSyllables(input, { thresholdMs }).line, input);
	}
});

test("consecutive short units combine until no eligible short cluster remains", () => {
	const input = row([
		word("我", 0, 30),
		word("爱", 30, 60),
		word("你", 60, 90),
		word("呀", 90, 130),
	]);
	const result = mergeShortSyllables(input);
	assert.deepEqual(texts(result.line.words), ["我爱你呀"]);
	assert.equal(result.mergedUnits, 3);
	assert.equal(mergeShortSyllables(result.line).line, result.line);
});

test("spaces, punctuation-only units, mixed-language units and long pauses are boundaries", () => {
	for (const separator of [" ", "，", "hello", "a你", "123", "🎵"]) {
		const input = row([
			word("你", 0, 50),
			word(separator, 50, 100),
			word("好", 100, 500),
		]);
		assert.equal(mergeShortSyllables(input).line, input);
	}
	const pause = row([word("你", 0, 50), word("好", 151, 500)]);
	assert.equal(mergeShortSyllables(pause).line, pause);
	const spacedToken = row([word("你 ", 0, 50), word("好", 50, 500)]);
	assert.equal(mergeShortSyllables(spacedToken).line, spacedToken);
});

test("untimed, reversed, negative and non-finite timestamps are left alone", () => {
	for (const [start, end] of [
		[0, 0],
		[50, 0],
		[-50, 0],
		[Number.NaN, 50],
		[0, Number.POSITIVE_INFINITY],
	]) {
		const input = row([word("你", start, end), word("好", 100, 500)]);
		assert.equal(mergeShortSyllables(input).line, input);
	}
	const unordered = row([word("你", 100, 150), word("好", 0, 100)]);
	assert.equal(mergeShortSyllables(unordered).line, unordered);
});

test("Han, kana, Hangul and Bopomofo support attached punctuation and combining marks", () => {
	for (const [left, right] of [
		["你，", "好"],
		["あ", "い"],
		["カ", "ー"],
		["か\u3099", "く"],
		["안", "녕"],
		["ㄋ", "ㄧ"],
		["𠮷", "野"],
	]) {
		const result = mergeShortSyllables(
			row([word(left, 0, 50), word(right, 50, 500)]),
		);
		assert.deepEqual(texts(result.line.words), [left + right]);
	}
});

test("annotations, original ruby times, row roles and document metadata survive", () => {
	const first = word("你", 1000, 1050, {
		romanWord: "ni",
		ruby: [{ word: "に", startTime: 1000, endTime: 1050 }],
		emptyBeat: 1,
	});
	const second = word("好", 1050, 1500, {
		romanWord: "hao",
		ruby: [
			{ word: "は", startTime: 1050, endTime: 1200 },
			{ word: "お", startTime: 1200, endTime: 1500 },
		],
		obscene: true,
		romanWarning: true,
		emptyBeat: 2,
	});
	const line = {
		...row([first, second]),
		isBG: true,
		isDuet: true,
		startTime: 900,
		endTime: 1700,
		ignoreSync: true,
		translatedLyric: "hello",
		romanLyric: "ni hao",
		endTimeLink: { originalEndTime: 1700, originalNextStartTime: 1800 },
	};
	const input: TTMLLyric = {
		metadata: [{ key: "language", value: ["zh-Hans"] }],
		lyricLines: [line],
	};
	const before = structuredClone(input);
	const result = mergeShortSyllablesInLyrics(input);
	const merged = result.lyric.lyricLines[0].words[0];
	assert.equal(result.lyric.metadata, input.metadata);
	assert.deepEqual({ ...result.lyric.lyricLines[0], words: line.words }, line);
	assert.equal(merged.romanWord, "ni hao");
	assert.equal(merged.obscene, true);
	assert.equal(merged.romanWarning, true);
	assert.equal(merged.emptyBeat, 3);
	assert.deepEqual(merged.ruby, [
		...(first.ruby ?? []),
		...(second.ruby ?? []),
	]);
	assert.deepEqual(input, before);
});

test("scope is respected and units never merge across rows", () => {
	const input: TTMLLyric = {
		metadata: [],
		lyricLines: [
			row([word("你", 0, 50)]),
			row([word("好", 50, 500)]),
			row([word("再", 600, 650), word("见", 650, 900)]),
		],
	};
	assert.equal(
		mergeShortSyllablesInLyrics(input, { targetLineIndices: new Set([0, 1]) })
			.lyric,
		input,
	);
	assert.equal(
		mergeShortSyllablesInLyrics(input, { targetLineIndices: new Set() }).lyric,
		input,
	);
	const result = mergeShortSyllablesInLyrics(input, {
		targetLineIndices: new Set([2]),
	});
	assert.equal(result.changedLines, 1);
	assert.equal(result.lyric.lyricLines[0], input.lyricLines[0]);
	assert.equal(result.lyric.lyricLines[1], input.lyricLines[1]);
	assert.deepEqual(texts(result.lyric.lyricLines[2].words), ["再见"]);
});

test("multiple changed rows use one undo step, preserve identity and clear removed-word selection", () => {
	const store = createStore();
	const input: TTMLLyric = {
		metadata: [],
		lyricLines: [
			row([word("你", 0, 50), word("好", 50, 500)]),
			row([word("再", 600, 650), word("见", 650, 900)]),
		],
	};
	store.set(lyricLinesAtom, input);
	store.set(projectIdAtom, "same-project");
	store.set(saveFileNameAtom, "same.ttml");
	const selection = new Set([input.lyricLines[0].id]);
	store.set(selectedLinesAtom, selection);
	store.set(selectedWordsAtom, new Set([input.lyricLines[0].words[1].id]));
	store.set(editingWordStateAtom, { lineIndex: 0, wordIndex: 1, word: "好" });
	const unsubscribe = store.sub(undoableLyricLinesAtom, () => {});
	try {
		const result = store.set(applyShortSyllableMergeAtom, {});
		assert.equal(result.changedLines, 2);
		assert.equal(result.mergedUnits, 2);
		assert.equal(store.get(selectedLinesAtom), selection);
		assert.equal(store.get(selectedWordsAtom).size, 0);
		assert.equal(store.get(editingWordStateAtom).wordIndex, -1);
		assert.equal(store.get(projectIdAtom), "same-project");
		assert.equal(store.get(saveFileNameAtom), "same.ttml");
		assert.equal(store.set(applyShortSyllableMergeAtom, {}).changed, false);
		store.set(undoLyricLinesAtom);
		assert.equal(store.get(lyricLinesAtom), input);
		assert.equal(store.get(undoableLyricLinesAtom).canUndo, false);
		store.set(redoLyricLinesAtom);
		assert.equal(store.get(lyricLinesAtom), result.lyric);
	} finally {
		unsubscribe();
	}
});
