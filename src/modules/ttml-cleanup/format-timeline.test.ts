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
	type LyricLine,
	newLyricLine,
	newLyricWord,
	type TTMLLyric,
} from "$/types/ttml";
import { formatTimeline } from "./format-timeline";
import { formatTimelineAtom } from "./timeline-format-state";

function line(
	id: string,
	startTime: number,
	translatedLyric = "",
	patch: Partial<LyricLine> = {},
): LyricLine {
	return {
		...newLyricLine(),
		id,
		startTime,
		endTime: startTime + 2000,
		translatedLyric,
		words: [
			{
				...newLyricWord(),
				word: id,
				startTime,
				endTime: startTime + 1500,
				romanWord: "reading",
				ruby: [{ word: "よみ", startTime, endTime: startTime + 1000 }],
				obscene: true,
			},
		],
		romanLyric: "line reading",
		...patch,
	};
}

function document(lines: LyricLine[]): TTMLLyric {
	return {
		metadata: [{ key: "musicName", value: ["Current song"] }],
		lyricLines: lines,
	};
}

function freeze(value: object): void {
	Object.freeze(value);
	for (const child of Object.values(value))
		if (child && typeof child === "object") freeze(child);
}

test("stable timestamp sorting carries translations and attached backgrounds without touching word timing", () => {
	const input = document([
		line("late", 10000, "后句翻译"),
		line("late-bg", 12000, "和声翻译", { isBG: true }),
		line("early", 1000, "前句翻译"),
		line("early-bg", 2500, "前句和声", { isBG: true }),
		line("overlap", 2000, "交叠翻译"),
		line("same-time", 2000),
	]);
	freeze(input);
	const result = formatTimeline(input, { mergeTranslations: false });
	assert.equal(result.changed, true);
	assert.deepEqual(
		result.lyric.lyricLines.map((item) => item.id),
		["early", "early-bg", "overlap", "same-time", "late", "late-bg"],
	);
	assert.equal(result.reorderedLines, 6);
	assert.equal(result.lyric.metadata, input.metadata);
	for (const item of result.lyric.lyricLines)
		assert.equal(
			item,
			input.lyricLines.find((original) => original.id === item.id),
		);
	assert.equal(
		formatTimeline(result.lyric, { mergeTranslations: false }).lyric,
		result.lyric,
	);
});

test("merges only existing translations in source order and retains every original line and annotation", () => {
	const input = document([
		line("first", 1000, "第一段译文", {
			endTimeLink: { originalEndTime: 2800, originalNextStartTime: 3000 },
		}),
		line("second", 1000, "第二段译文"),
		line("duplicate", 1000, " 第一段译文 "),
		line("blank", 1000),
		line("different", 1001, "不同时间"),
	]);
	const before = structuredClone(input);
	freeze(input);
	const result = formatTimeline(input, { mergeTranslations: true });
	assert.equal(result.mergedGroups, 1);
	assert.equal(result.reorderedLines, 0);
	assert.deepEqual(
		result.lyric.lyricLines.map((item) => item.translatedLyric),
		["第一段译文 / 第二段译文", "", "", "", "不同时间"],
	);
	assert.deepEqual(input, before);
	assert.equal(result.lyric.metadata, input.metadata);
	assert.deepEqual(
		result.translationGroups[0].translations.map((item) => item.lineNumber),
		[1, 2, 3],
	);
	result.lyric.lyricLines.forEach((item, index) => {
		assert.equal(item.words, input.lyricLines[index].words);
		assert.deepEqual(
			{ ...item, translatedLyric: input.lyricLines[index].translatedLyric },
			input.lyricLines[index],
		);
	});
	assert.equal(
		formatTimeline(result.lyric, { mergeTranslations: true }).lyric,
		result.lyric,
	);
});

test("same timestamp keeps foreground, duet, ignored-sync and different parents' backgrounds separate", () => {
	const input = document([
		line("main", 1000, "主句译文"),
		line("bg", 1000, "主句和声", { isBG: true }),
		line("duet", 1000, "对唱译文", { isDuet: true }),
		line("duet-bg", 1000, "对唱和声", { isBG: true, isDuet: true }),
		line("ignored", 1000, "忽略打轴", { ignoreSync: true }),
		line("another-bg", 1000, "另句和声", { isBG: true }),
	]);
	const result = formatTimeline(input, { mergeTranslations: true });
	assert.equal(result.lyric, input);
	assert.equal(result.translationGroups.length, 0);
});

test("background translations can merge within their own parent without moving into the main translation", () => {
	const input = document([
		line("main", 1000, "主句"),
		line("bg-one", 1100, "和声一", { isBG: true }),
		line("bg-two", 1100, "和声二", { isBG: true }),
		line("next", 2000),
		line("other-bg", 1100, "下一句和声", { isBG: true }),
	]);
	const result = formatTimeline(input, { mergeTranslations: true });
	assert.deepEqual(
		result.lyric.lyricLines.map((item) => item.translatedLyric),
		["主句", "和声一 / 和声二", "", "", "下一句和声"],
	);
	assert.equal(result.translationGroups[0].isBG, true);
});

test("translation-only rows attach to the first original without promoting original text into a translation", () => {
	const input = document([
		line("translation-only", 1000, "已有翻译", { words: [] }),
		line("original", 1000),
		line("another-original", 1000),
	]);
	const result = formatTimeline(input, { mergeTranslations: true });
	assert.equal(result.lyric.lyricLines[1].translatedLyric, "已有翻译");
	assert.equal(result.lyric.lyricLines[0].translatedLyric, "");
	assert.equal(result.lyric.lyricLines[2].translatedLyric, "");
	assert.equal(result.lyric.lyricLines.length, 3);
	assert.equal(result.translationGroups[0].targetLineNumber, 2);
});

test("untimed zero rows are not combined, real zero-based lyrics can merge, invalid times sort stably last", () => {
	const zero = (id: string) =>
		line(id, 0, id, { endTime: 0, words: [{ ...newLyricWord(), word: id }] });
	const input = document([
		line("nan", Number.NaN, "N"),
		zero("untimed-a"),
		zero("untimed-b"),
		line("real-zero-a", 0, "开头一"),
		line("real-zero-b", 0, "开头二"),
		line("negative", -1),
		line("infinity", Number.POSITIVE_INFINITY),
	]);
	const result = formatTimeline(input, { mergeTranslations: true });
	assert.deepEqual(
		result.lyric.lyricLines.map((item) => item.id),
		[
			"untimed-a",
			"untimed-b",
			"real-zero-a",
			"real-zero-b",
			"nan",
			"negative",
			"infinity",
		],
	);
	assert.equal(result.lyric.lyricLines[0].translatedLyric, "untimed-a");
	assert.equal(result.lyric.lyricLines[1].translatedLyric, "untimed-b");
	assert.equal(result.lyric.lyricLines[2].translatedLyric, "开头一 / 开头二");
	assert.equal(result.mergedGroups, 1);
});

test("previewed merge groups can be excluded independently or disabled while sorting still applies", () => {
	const input = document([
		line("later", 2000, "二一"),
		line("later-2", 2000, "二二"),
		line("early", 1000, "一一"),
		line("early-2", 1000, "一二"),
	]);
	const result = formatTimeline(input, {
		mergeTranslations: true,
		mergeGroupIds: new Set(["early"]),
	});
	assert.equal(result.mergedGroups, 1);
	assert.equal(result.translationGroups.length, 2);
	assert.deepEqual(
		result.lyric.lyricLines.map((item) => item.translatedLyric),
		["一一 / 一二", "", "二一", "二二"],
	);
	const disabled = formatTimeline(input, { mergeTranslations: false });
	const none = formatTimeline(input, {
		mergeTranslations: true,
		mergeGroupIds: new Set(),
	});
	assert.deepEqual(disabled.lyric, none.lyric);
	assert.equal(none.mergedGroups, 0);
});

test("empty and already sorted untranslated documents are no-ops", () => {
	for (const input of [
		document([]),
		document([line("one", 1000), line("two", 2000)]),
	]) {
		const result = formatTimeline(input, { mergeTranslations: true });
		assert.equal(result.lyric, input);
		assert.equal(result.changed, false);
	}
});

test("leading backgrounds stay unowned instead of acquiring a different parent during sorting", () => {
	const input = document([
		line("orphan", 5000, "和声", { isBG: true }),
		line("orphan-two", 1000, "另一个和声", { isBG: true }),
		line("late", 4000),
		line("early", 2000),
	]);
	const result = formatTimeline(input, { mergeTranslations: true });
	assert.deepEqual(
		result.lyric.lyricLines.map((item) => item.id),
		["orphan", "orphan-two", "early", "late"],
	);
	assert.equal(result.lyric.lyricLines[0], input.lyricLines[0]);
	assert.equal(result.lyric.lyricLines[1], input.lyricLines[1]);
});

test("format plus merging is a single undo/redo step and preserves project and ID-based selections", () => {
	const input = document([
		line("late", 2000),
		line("first", 1000, "甲"),
		line("second", 1000, "乙"),
	]);
	const store = createStore();
	store.set(lyricLinesAtom, input);
	store.set(projectIdAtom, "project");
	store.set(saveFileNameAtom, "song.ttml");
	const lines = new Set([input.lyricLines[1].id]);
	const words = new Set([input.lyricLines[1].words[0].id]);
	store.set(selectedLinesAtom, lines);
	store.set(selectedWordsAtom, words);
	store.set(editingWordStateAtom, {
		lineIndex: 1,
		wordIndex: 0,
		word: "first",
	});
	const unsub = store.sub(undoableLyricLinesAtom, () => {});
	try {
		const result = store.set(formatTimelineAtom, { mergeTranslations: true });
		assert.equal(store.get(lyricLinesAtom), result.lyric);
		assert.equal(store.get(selectedLinesAtom), lines);
		assert.equal(store.get(selectedWordsAtom), words);
		assert.equal(store.get(editingWordStateAtom).lineIndex, -1);
		assert.equal(store.get(projectIdAtom), "project");
		assert.equal(store.get(saveFileNameAtom), "song.ttml");
		assert.equal(
			store.set(formatTimelineAtom, { mergeTranslations: true }).changed,
			false,
		);
		store.set(undoLyricLinesAtom);
		assert.equal(store.get(lyricLinesAtom), input);
		assert.equal(store.get(undoableLyricLinesAtom).canUndo, false);
		store.set(redoLyricLinesAtom);
		assert.equal(store.get(lyricLinesAtom), result.lyric);
	} finally {
		unsub();
	}
});
