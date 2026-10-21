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
import {
	type LyricWord,
	newLyricLine,
	newLyricWord,
	type TTMLLyric,
} from "$/types/ttml";
import { cleanupEditorLyrics } from "./editor-cleanup";
import { applyTtmlCleanupAtom } from "./editor-state";

let nextId = 0;
function word(
	text: string,
	start: number,
	extra: Partial<LyricWord> = {},
): LyricWord {
	return {
		...newLyricWord(),
		id: `word-${nextId++}`,
		word: text,
		startTime: start,
		endTime: start + 100,
		...extra,
	};
}
function sample(): TTMLLyric {
	return {
		metadata: [{ key: "musicName", value: ["Current project"] }],
		lyricLines: [
			{
				...newLyricLine(),
				id: "line-main",
				startTime: 1000,
				endTime: 9000,
				isDuet: true,
				ignoreSync: true,
				translatedLyric: "翻译（保持原样）",
				romanLyric: "line romanization",
				endTimeLink: { originalEndTime: 8000, originalNextStartTime: 9000 },
				words: [
					word("Hello", 1000),
					word(",", 1100),
					word("(", 1200),
					word("echo", 1300, {
						romanWord: "e-ko",
						obscene: true,
						emptyBeat: 2,
						ruby: [{ word: "えこ", startTime: 1300, endTime: 1400 }],
					}),
					word(")", 1400),
					word("!", 1500),
				],
			},
		],
	};
}
const text = (words: LyricWord[]) => words.map((item) => item.word).join("");

test("cleans current editor words without losing timestamps or editing fields", () => {
	const input = sample();
	const before = structuredClone(input);
	const result = cleanupEditorLyrics(input, {
		harmony: true,
		punctuation: true,
	});
	assert.equal(result.changed, true);
	assert.equal(result.harmonyGroups, 1);
	assert.equal(result.punctuationMerged, 2);
	assert.deepEqual(input, before);
	assert.deepEqual(result.lyric.metadata, input.metadata);
	const [main, background] = result.lyric.lyricLines;
	assert.equal(main.id, input.lyricLines[0].id);
	assert.equal(text(main.words), "Hello,");
	assert.deepEqual(
		[main.words[0].startTime, main.words[0].endTime],
		[1000, 1100],
	);
	assert.deepEqual(main.endTimeLink, input.lyricLines[0].endTimeLink);
	assert.equal(main.translatedLyric, input.lyricLines[0].translatedLyric);
	assert.equal(main.romanLyric, input.lyricLines[0].romanLyric);
	assert.equal(background.isBG, true);
	assert.equal(background.isDuet, true);
	assert.equal(background.ignoreSync, true);
	assert.equal(background.translatedLyric, "");
	assert.equal(background.endTimeLink, undefined);
	assert.equal(text(background.words), "echo!");
	const expected = input.lyricLines[0].words[3];
	assert.deepEqual(background.words[0], { ...expected, word: "echo!" });
	assert.deepEqual([background.startTime, background.endTime], [1300, 1400]);
});

test("editor cleanup supports independent switches and unchanged documents", () => {
	const input = sample();
	const punctuation = cleanupEditorLyrics(input, {
		harmony: false,
		punctuation: true,
	});
	assert.equal(punctuation.harmonyGroups, 0);
	assert.equal(punctuation.punctuationMerged, 4);
	assert.equal(punctuation.lyric.lyricLines.length, 1);
	assert.equal(text(punctuation.lyric.lyricLines[0].words), "Hello,(echo)!");
	const harmony = cleanupEditorLyrics(input, {
		harmony: true,
		punctuation: false,
	});
	assert.equal(harmony.harmonyGroups, 1);
	assert.equal(harmony.punctuationMerged, 0);
	const disabled = cleanupEditorLyrics(input, {
		harmony: false,
		punctuation: false,
	});
	assert.equal(disabled.changed, false);
	assert.equal(disabled.lyric, input);
	const repeated = cleanupEditorLyrics(harmony.lyric, {
		harmony: true,
		punctuation: false,
	});
	assert.equal(repeated.changed, false);
	assert.equal(repeated.lyric, harmony.lyric);
});

test("an entirely bracketed line becomes background without a blank main row", () => {
	const input = sample();
	input.lyricLines[0].words = [word(" (echo) ", 1000)];
	const result = cleanupEditorLyrics(input, {
		harmony: true,
		punctuation: true,
	});
	assert.equal(result.lyric.lyricLines.length, 1);
	assert.equal(result.lyric.lyricLines[0].id, input.lyricLines[0].id);
	assert.equal(result.lyric.lyricLines[0].isBG, true);
	assert.equal(text(result.lyric.lyricLines[0].words).trim(), "echo");
});

test("whole background lines retain their identity and annotations", () => {
	const input = sample();
	input.lyricLines[0].isBG = true;
	const result = cleanupEditorLyrics(input, {
		harmony: true,
		punctuation: true,
	});
	assert.equal(result.harmonyGroups, 0);
	assert.equal(result.lyric.lyricLines.length, 1);
	assert.equal(result.lyric.lyricLines[0].id, "line-main");
	assert.equal(result.lyric.lyricLines[0].isBG, true);
	assert.equal(text(result.lyric.lyricLines[0].words), "Hello,echo!");
	assert.equal(
		result.lyric.lyricLines[0].translatedLyric,
		input.lyricLines[0].translatedLyric,
	);
});

test("leaves every non-round bracket pair literal without background lines", () => {
	const pairs = [
		["[", "]"],
		["【", "】"],
		["{", "}"],
		["〔", "〕"],
		["「", "」"],
		["『", "』"],
	] as const;
	const input: TTMLLyric = {
		metadata: [],
		lyricLines: [
			{
				...newLyricLine(),
				words: pairs.flatMap(([opening, closing], index) => [
					word(opening, index * 300),
					word("inside", index * 300 + 100),
					word(closing, index * 300 + 200),
				]),
			},
		],
	};

	const result = cleanupEditorLyrics(input, {
		harmony: true,
		punctuation: false,
	});
	assert.equal(result.harmonyGroups, 0);
	assert.equal(result.punctuationMerged, 0);
	assert.equal(result.changed, false);
	assert.equal(result.lyric, input);
	assert.equal(result.lyric.lyricLines.length, 1);
	assert.equal(result.lyric.lyricLines[0].isBG, false);
	assert.equal(
		text(result.lyric.lyricLines[0].words),
		pairs.map(([opening, closing]) => `${opening}inside${closing}`).join(""),
	);
});

test("groups ASCII and fullwidth parentheses split across editor words", () => {
	const input: TTMLLyric = {
		metadata: [],
		lyricLines: [
			{
				...newLyricLine(),
				words: [
					word("lead", 0),
					word("(", 100),
					word("ascii", 200),
					word(")", 300),
					word("bridge", 400),
					word("（", 500),
					word("full", 600),
					word("）", 700),
					word("tail", 800),
				],
			},
		],
	};

	const result = cleanupEditorLyrics(input, {
		harmony: true,
		punctuation: false,
	});
	assert.equal(result.harmonyGroups, 2);
	assert.equal(result.punctuationMerged, 0);
	const [main, background] = result.lyric.lyricLines;
	assert.equal(text(main.words), "lead bridge tail");
	assert.equal(text(background.words), "ascii full");
	assert.deepEqual(
		background.words
			.filter((item) => item.word.trim())
			.map((item) => [item.word, item.startTime, item.endTime]),
		[
			["ascii", 200, 300],
			["full", 600, 700],
		],
	);
});

test("preserves mixed non-round and nested literals while retaining word times", () => {
	const input: TTMLLyric = {
		metadata: [],
		lyricLines: [
			{
				...newLyricLine(),
				words: [
					word("main", 0),
					word("(", 100),
					word("echo", 200),
					word("[keep]", 300),
					word("（", 400),
					word("inner", 500),
					word("）", 600),
					word("【literal】", 700),
					word(")", 800),
					word("tail", 900),
				],
			},
		],
	};

	const result = cleanupEditorLyrics(input, {
		harmony: true,
		punctuation: false,
	});
	assert.equal(result.harmonyGroups, 1);
	const [main, background] = result.lyric.lyricLines;
	assert.equal(text(main.words), "main tail");
	assert.equal(text(background.words), "echo[keep]inner【literal】");
	assert.deepEqual(
		background.words.map((item) => [item.word, item.startTime, item.endTime]),
		[
			["echo", 200, 300],
			["[keep]", 300, 400],
			["inner", 500, 600],
			["【literal】", 700, 800],
		],
	);
});

test("separated background groups keep word boundaries, stars and unmatched brackets", () => {
	const input: TTMLLyric = {
		metadata: [],
		lyricLines: [
			{
				...newLyricLine(),
				words: [
					word("lead ", 0),
					word("（one）", 100),
					word(" middle ", 200),
					word("(two)", 300),
					word(" end[", 400),
					word("＊", 500),
					word("!", 600),
				],
			},
		],
	};
	const result = cleanupEditorLyrics(input, {
		harmony: true,
		punctuation: true,
	});
	assert.equal(result.harmonyGroups, 2);
	assert.equal(result.punctuationMerged, 0);
	const [main, background] = result.lyric.lyricLines;
	assert.match(text(main.words), /end\[＊!$/);
	assert.equal(text(background.words), "one two");
	assert.deepEqual(
		background.words
			.filter((item) => item.word.trim())
			.map((item) => [item.startTime, item.endTime]),
		[
			[100, 200],
			[300, 400],
		],
	);
});

test("splitting a mixed word copies exact times and keeps unique editable objects", () => {
	const mixed = word("main(echo)tail", 0.25, {
		endTime: 500.75,
		ruby: [{ word: "ruby", startTime: 0.25, endTime: 500.75 }],
	});
	const input: TTMLLyric = {
		metadata: [],
		lyricLines: [{ ...newLyricLine(), words: [mixed] }],
	};
	const result = cleanupEditorLyrics(input, {
		harmony: true,
		punctuation: false,
	});
	const words = result.lyric.lyricLines
		.flatMap((line) => line.words)
		.filter((item) => item.word.trim());
	assert.equal(new Set(words.map((item) => item.id)).size, 3);
	assert.equal(text(result.lyric.lyricLines[0].words), "main tail");
	assert.equal(text(result.lyric.lyricLines[1].words), "echo");
	for (const item of words)
		assert.deepEqual([item.startTime, item.endTime], [0.25, 500.75]);
	assert.notEqual(words[0].ruby, words[1].ruby);
	assert.notEqual(words[0].ruby, words[2].ruby);
});

test("applying to the current project uses one undo step and keeps project identity", () => {
	const store = createStore();
	const input = sample();
	store.set(lyricLinesAtom, input);
	store.set(projectIdAtom, "current-project");
	store.set(saveFileNameAtom, "current.ttml");
	store.set(selectedLinesAtom, new Set([input.lyricLines[0].id]));
	store.set(selectedWordsAtom, new Set([input.lyricLines[0].words[1].id]));
	const unsubscribe = store.sub(undoableLyricLinesAtom, () => {});
	try {
		assert.equal(store.get(undoableLyricLinesAtom).canUndo, false);
		const result = store.set(applyTtmlCleanupAtom, {
			harmony: true,
			punctuation: true,
		});
		assert.equal(result.changed, true);
		assert.equal(store.get(lyricLinesAtom), result.lyric);
		assert.equal(store.get(selectedWordsAtom).size, 0);
		assert.equal(store.get(selectedLinesAtom).size, 0);
		assert.equal(store.get(projectIdAtom), "current-project");
		assert.equal(store.get(saveFileNameAtom), "current.ttml");
		assert.equal(store.get(undoableLyricLinesAtom).canUndo, true);
		store.set(undoLyricLinesAtom);
		assert.deepEqual(store.get(lyricLinesAtom), input);
		assert.equal(store.get(undoableLyricLinesAtom).canUndo, false);
		store.set(redoLyricLinesAtom);
		assert.deepEqual(store.get(lyricLinesAtom), result.lyric);
	} finally {
		unsubscribe();
	}
});
