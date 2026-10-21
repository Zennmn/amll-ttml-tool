import assert from "node:assert/strict";
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
import { newLyricLine, newLyricWord, type TTMLLyric } from "$/types/ttml";
import { fillMissingTranslationsAtom } from "./editor-state";
import { fillMissingTranslations } from "./fill-translations";

function sample(): TTMLLyric {
	return {
		metadata: [{ key: "musicName", value: ["Current project"] }],
		lyricLines: [
			{
				...newLyricLine(),
				startTime: 1000,
				endTime: 3000,
				romanLyric: "o",
				ignoreSync: true,
				endTimeLink: { originalEndTime: 2500, originalNextStartTime: 3000 },
				words: [
					{
						...newLyricWord(),
						word: "ohh",
						startTime: 1000,
						endTime: 2000,
						romanWord: "o",
						ruby: [{ word: "お", startTime: 1000, endTime: 2000 }],
					},
					{ ...newLyricWord(), word: "---", startTime: 2000, endTime: 3000 },
				],
			},
			{
				...newLyricLine(),
				translatedLyric: " 已有翻译 ",
				words: [{ ...newLyricWord(), word: "Hello" }],
			},
			{
				...newLyricLine(),
				isBG: true,
				translatedLyric: " \t ",
				words: [{ ...newLyricWord(), word: "background" }],
			},
			{
				...newLyricLine(),
				isDuet: true,
				translatedLyric: " \t ",
				words: [
					{ ...newLyricWord(), word: "  yeah" },
					{ ...newLyricWord(), word: " --  " },
				],
			},
		],
	};
}

test("fills foreground translations verbatim while preserving backgrounds, existing text and editor fields", () => {
	const input = sample();
	const before = structuredClone(input);
	const result = fillMissingTranslations(input);
	assert.equal(result.filledLines, 2);
	assert.equal(result.changed, true);
	assert.deepEqual(
		result.lyric.lyricLines.map((line) => line.translatedLyric),
		["ohh---", " 已有翻译 ", " \t ", "  yeah --  "],
	);
	assert.deepEqual(input, before);
	assert.equal(result.lyric.metadata, input.metadata);
	assert.equal(result.lyric.lyricLines[1], input.lyricLines[1]);
	assert.equal(result.lyric.lyricLines[2], input.lyricLines[2]);
	result.lyric.lyricLines.forEach((line, index) => {
		const original = input.lyricLines[index];
		assert.equal(line.words, original.words);
		assert.deepEqual(
			{ ...line, translatedLyric: original.translatedLyric },
			original,
		);
	});
});

test("blank originals and repeated fills are no-ops", () => {
	const blank: TTMLLyric = {
		metadata: [],
		lyricLines: [
			newLyricLine(),
			{ ...newLyricLine(), words: [{ ...newLyricWord(), word: " \t " }] },
			{
				...newLyricLine(),
				isBG: true,
				words: [{ ...newLyricWord(), word: "untranslated background" }],
			},
		],
	};
	assert.deepEqual(fillMissingTranslations(blank), {
		lyric: blank,
		filledLines: 0,
		changed: false,
	});
	assert.equal(fillMissingTranslations(blank).lyric, blank);
	const filled = fillMissingTranslations(sample()).lyric;
	assert.equal(fillMissingTranslations(filled).lyric, filled);
});

test("batch fill and a repeated no-op use one undo step without replacing project or selections", () => {
	const store = createStore();
	const input = sample();
	store.set(lyricLinesAtom, input);
	store.set(projectIdAtom, "current-project");
	store.set(saveFileNameAtom, "current.ttml");
	const selectedLines = new Set([input.lyricLines[0].id]);
	const selectedWords = new Set([input.lyricLines[0].words[0].id]);
	store.set(selectedLinesAtom, selectedLines);
	store.set(selectedWordsAtom, selectedWords);
	const unsubscribe = store.sub(undoableLyricLinesAtom, () => {});
	try {
		assert.equal(store.get(undoableLyricLinesAtom).canUndo, false);
		const result = store.set(fillMissingTranslationsAtom);
		assert.equal(result.filledLines, 2);
		assert.equal(store.get(lyricLinesAtom), result.lyric);
		assert.equal(store.set(fillMissingTranslationsAtom).changed, false);
		assert.equal(store.get(selectedLinesAtom), selectedLines);
		assert.equal(store.get(selectedWordsAtom), selectedWords);
		assert.equal(store.get(projectIdAtom), "current-project");
		assert.equal(store.get(saveFileNameAtom), "current.ttml");
		store.set(undoLyricLinesAtom);
		assert.equal(store.get(lyricLinesAtom), input);
		assert.equal(store.get(undoableLyricLinesAtom).canUndo, false);
		store.set(redoLyricLinesAtom);
		assert.equal(store.get(lyricLinesAtom), result.lyric);
	} finally {
		unsubscribe();
	}
});
