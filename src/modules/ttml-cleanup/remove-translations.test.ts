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
import { removeTranslations } from "./remove-translations";
import { removeTranslationsAtom } from "./translation-removal-state";

function sample(): TTMLLyric {
	return {
		metadata: [{ key: "musicName", value: ["Current project"] }],
		lyricLines: [
			{
				...newLyricLine(),
				startTime: 1000,
				endTime: 3000,
				translatedLyric: "主句翻译",
				romanLyric: "main romanization",
				words: [
					{ ...newLyricWord(), word: "main", startTime: 1000 },
					{ ...newLyricWord(), word: " lyric", startTime: 2000 },
				],
			},
			{
				...newLyricLine(),
				isBG: true,
				translatedLyric: "和声翻译",
				words: [{ ...newLyricWord(), word: "background" }],
			},
			{
				...newLyricLine(),
				isDuet: true,
				translatedLyric: "对唱翻译",
				words: [{ ...newLyricWord(), word: "duet" }],
			},
			{
				...newLyricLine(),
				translatedLyric: "保留翻译",
				words: [{ ...newLyricWord(), word: "keep" }],
			},
			{
				...newLyricLine(),
				translatedLyric: "仅翻译",
				words: [],
			},
			{
				...newLyricLine(),
				translatedLyric: " \t ",
				words: [{ ...newLyricWord(), word: "blank translation" }],
			},
		],
	};
}

function deepFreeze<T>(value: T): T {
	if (value && typeof value === "object" && !Object.isFrozen(value)) {
		Object.freeze(value);
		for (const child of Object.values(value)) deepFreeze(child);
	}
	return value;
}

test("removes translations only for selected lines, including BG and duet fields", () => {
	const input = sample();
	const before = structuredClone(input);
	deepFreeze(input);
	const selectedIds = new Set([
		input.lyricLines[0].id,
		input.lyricLines[1].id,
		input.lyricLines[2].id,
	]);

	const result = removeTranslations(input, selectedIds);

	assert.equal(result.changed, true);
	assert.equal(result.removedLines, 3);
	assert.deepEqual(
		result.lyric.lyricLines.map((line) => line.translatedLyric),
		["", "", "", "保留翻译", "仅翻译", " \t "],
	);
	assert.deepEqual(input, before);
	assert.equal(result.lyric.metadata, input.metadata);
	assert.equal(result.lyric.lyricLines[3], input.lyricLines[3]);
	assert.equal(result.lyric.lyricLines[4], input.lyricLines[4]);
	assert.equal(result.lyric.lyricLines[5], input.lyricLines[5]);
	for (const index of [0, 1, 2]) {
		const changed = result.lyric.lyricLines[index];
		const original = input.lyricLines[index];
		assert.equal(changed.words, original.words);
		assert.equal(changed.romanLyric, original.romanLyric);
		assert.equal(changed.isBG, original.isBG);
		assert.equal(changed.isDuet, original.isDuet);
		assert.equal(changed.startTime, original.startTime);
		assert.equal(changed.endTime, original.endTime);
	}
});

test("select-all removes every meaningful translation, including translated-only lines", () => {
	const input = sample();
	const selectedIds = new Set(input.lyricLines.map((line) => line.id));

	const result = removeTranslations(input, selectedIds);

	assert.equal(result.changed, true);
	assert.equal(result.removedLines, 5);
	assert.equal(
		result.lyric.lyricLines.filter((line) => line.translatedLyric.trim())
			.length,
		0,
	);
	assert.equal(result.lyric.lyricLines[4].words.length, 0);
	assert.equal(result.lyric.lyricLines[5].translatedLyric, " \t ");
});

test("empty, unknown and whitespace-only selections are no-ops and repeated removal is idempotent", () => {
	const input = sample();
	const empty = removeTranslations(input, new Set());
	assert.deepEqual(empty, { lyric: input, removedLines: 0, changed: false });
	assert.equal(empty.lyric, input);

	const unknown = removeTranslations(input, new Set(["missing-line"]));
	assert.deepEqual(unknown, { lyric: input, removedLines: 0, changed: false });
	const whitespace = removeTranslations(
		input,
		new Set([input.lyricLines[5].id]),
	);
	assert.deepEqual(whitespace, {
		lyric: input,
		removedLines: 0,
		changed: false,
	});

	const selectedIds = new Set([input.lyricLines[0].id]);
	const once = removeTranslations(input, selectedIds);
	const twice = removeTranslations(once.lyric, selectedIds);
	assert.deepEqual(twice, {
		lyric: once.lyric,
		removedLines: 0,
		changed: false,
	});
	assert.equal(twice.lyric, once.lyric);
});

test("editor batch removal uses one undo step while preserving selections and project state", () => {
	const store = createStore();
	const input = sample();
	store.set(lyricLinesAtom, input);
	store.set(projectIdAtom, "current-project");
	store.set(saveFileNameAtom, "current.ttml");
	const selectedLines = new Set([
		input.lyricLines[0].id,
		input.lyricLines[1].id,
	]);
	const selectedWords = new Set([input.lyricLines[0].words[0].id]);
	store.set(selectedLinesAtom, selectedLines);
	store.set(selectedWordsAtom, selectedWords);
	const unsubscribe = store.sub(undoableLyricLinesAtom, () => {});
	try {
		assert.equal(store.get(undoableLyricLinesAtom).canUndo, false);
		const selectedIds = new Set([
			input.lyricLines[0].id,
			input.lyricLines[1].id,
		]);
		const result = store.set(removeTranslationsAtom, selectedIds);
		assert.equal(result.removedLines, 2);
		assert.equal(result.changed, true);
		assert.equal(store.get(lyricLinesAtom), result.lyric);
		assert.equal(
			store.get(lyricLinesAtom).lyricLines[2].translatedLyric,
			"对唱翻译",
		);
		assert.equal(store.get(undoableLyricLinesAtom).canUndo, true);
		assert.equal(store.get(selectedLinesAtom), selectedLines);
		assert.equal(store.get(selectedWordsAtom), selectedWords);
		assert.equal(store.get(projectIdAtom), "current-project");
		assert.equal(store.get(saveFileNameAtom), "current.ttml");

		assert.equal(store.set(removeTranslationsAtom, selectedIds).changed, false);
		store.set(undoLyricLinesAtom);
		assert.equal(store.get(lyricLinesAtom), input);
		assert.equal(store.get(undoableLyricLinesAtom).canUndo, false);
		store.set(redoLyricLinesAtom);
		assert.equal(store.get(lyricLinesAtom), result.lyric);
	} finally {
		unsubscribe();
	}
});
