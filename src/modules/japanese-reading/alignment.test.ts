import assert from "node:assert/strict";
import test from "node:test";
import { alignJapaneseReadings, type JapaneseReadingToken } from "./alignment";

const words = (...values: string[]) => values.map((word) => ({ word }));

const token = (
	surface: string,
	reading: string | undefined,
	start: number,
	end: number,
	pronunciation?: string,
): JapaneseReadingToken => ({ surface, reading, start, end, pronunciation });

test("splits compound readings across editor cells without repetition", () => {
	const result = alignJapaneseReadings(
		words("夢", "中", "で", "生", "き", "る"),
		[
			token("夢中", "ムチュウ", 0, 2),
			token("で", "デ", 2, 3),
			token("生きる", "イキル", 3, 6),
		],
	);

	assert.deepEqual(result, ["mu", "chuu", "de", "i", "ki", "ru"]);
});

test("uses kana anchors and token pronunciation for particles", () => {
	const result = alignJapaneseReadings(words("今", "日", "は", "晴", "れ"), [
		token("今日", "キョウ", 0, 2),
		token("は", "ハ", 2, 3, "ワ"),
		token("晴れ", "ハレ", 3, 5),
	]);

	assert.deepEqual(result, ["kyo", "u", "wa", "ha", "re"]);
});

test("keeps okurigana anchors while assigning the preceding kanji reading", () => {
	const result = alignJapaneseReadings(words("言", "い", "切", "れ"), [
		token("言い切れ", "イイキレ", 0, 4),
	]);

	assert.deepEqual(result, ["i", "i", "ki", "re"]);
});

test("handles cells that span tokens and tokens that span cells", () => {
	const result = alignJapaneseReadings(words("夢中で", "生", "きる"), [
		token("夢中", "ムチュウ", 0, 2),
		token("で", "デ", 2, 3),
		token("生きる", "イキル", 3, 6),
	]);

	assert.deepEqual(result, ["muchuude", "i", "kiru"]);
});

test("returns no supplement for Latin, blank, punctuation, and unknown kanji", () => {
	const result = alignJapaneseReadings(
		words("Hello", ",", " ", "世界", "!", "龘", "の"),
		[
			token("Hello", undefined, 0, 5),
			token(",", undefined, 5, 6),
			token(" ", undefined, 6, 7),
			token("世界", "セカイ", 7, 9),
			token("!", undefined, 9, 10),
			token("龘", undefined, 10, 11),
			token("の", "ノ", 11, 12),
		],
	);

	assert.deepEqual(result, ["", "", "", "sekai", "", "", "no"]);
});

test("invalidates only cells covered by mismatched or overlapping tokens", () => {
	const badText = alignJapaneseReadings(words("夢", "中", "で"), [
		token("夢X", "ム", 0, 2),
		token("で", "デ", 2, 3),
	]);
	const badOffsets = alignJapaneseReadings(words("夢", "中", "で"), [
		token("夢", "ム", -1, 1),
		token("で", "デ", 2, 3),
	]);
	const overlapping = alignJapaneseReadings(words("夢", "中", "で"), [
		token("夢中", "ムチュウ", 0, 2),
		token("中", "ナカ", 1, 2),
		token("で", "デ", 2, 3),
	]);

	assert.deepEqual(badText, ["", "", "de"]);
	assert.deepEqual(badOffsets, ["", "", "de"]);
	assert.deepEqual(overlapping, ["", "", "de"]);
});

test("uses UTF-16 token offsets for supplementary characters", () => {
	const result = alignJapaneseReadings(words("𠮷", "る"), [
		token("𠮷る", "ヨシル", 0, 3),
	]);

	assert.deepEqual(result, ["yoshi", "ru"]);
});

test("keeps small-kana digraphs and long vowels intact", () => {
	const digraph = alignJapaneseReadings(words("き", "ょ"), [
		token("きょ", "キョ", 0, 2),
	]);
	const longVowel = alignJapaneseReadings(words("コー", "ヒー"), [
		token("コーヒー", "コーヒー", 0, 4),
	]);
	const splitMark = alignJapaneseReadings(words("コ", "ー"), [
		token("コー", "コー", 0, 2),
	]);

	assert.deepEqual(digraph, ["kyo", ""]);
	assert.deepEqual(longVowel, ["kou", "hii"]);
	assert.deepEqual(splitMark, ["kou", ""]);
});

test("carries sokuon romanization into the following kana", () => {
	const result = alignJapaneseReadings(words("行", "っ", "た"), [
		token("行った", "イッタ", 0, 3),
	]);

	assert.deepEqual(result, ["i", "t", "ta"]);
});

test("does not mutate words or tokens and needs no existing romanization", () => {
	const inputWords = Object.freeze([
		Object.freeze({
			word: "今日",
			id: "cell-1",
			romanWord: "existing",
			startTime: 120,
			endTime: 480,
		}),
		Object.freeze({
			word: "は",
			id: "cell-2",
			romanWord: "",
			startTime: 480,
			endTime: 720,
		}),
	]);
	const inputTokens = Object.freeze([
		Object.freeze(token("今日", "キョウ", 0, 2)),
		Object.freeze(token("は", "ハ", 2, 3, "ワ")),
	]);
	const beforeWords = structuredClone(inputWords);
	const beforeTokens = structuredClone(inputTokens);

	const result = alignJapaneseReadings(inputWords, inputTokens);

	assert.deepEqual(result, ["kyou", "wa"]);
	assert.deepEqual(inputWords, beforeWords);
	assert.deepEqual(inputTokens, beforeTokens);
});
