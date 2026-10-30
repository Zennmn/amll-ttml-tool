import assert from "node:assert/strict";
import test from "node:test";
import {
	getAmllOriginalText,
	resolveAmllOriginalLanguage,
	resolveOriginalLanguage,
	resolveStructuredOriginalLanguage,
} from "./language-options";
import type { AmllLyricResult, TTMLResult } from "./types";

const english =
	"We are walking down the quiet street together. I can hear your voice in the evening and I know we will find our way home. The sun is rising over the river and every morning brings another chance to begin.";
const japanese =
	"今日も君と歩いている。静かな道を進みながら、新しい朝を待っている。遠くに見える空の色は、昨日よりも少し明るくなっていた。";

function lyrics(original = english): AmllLyricResult {
	return {
		metadata: [{ key: "language", value: ["ja"] }],
		lyricLines: [
			{
				words: [{ word: original, startTime: 1234, endTime: 5678 }],
				translatedLyric: japanese.repeat(12),
				romanLyric: "kimi to aruite iru",
				isBG: false,
				isDuet: false,
				startTime: 1234,
				endTime: 5678,
			},
		],
	};
}

test("auto corrects a stale file language using originals, never translations, romanization or metadata", () => {
	const input = lyrics();
	input.metadata.push({ key: "musicName", value: [japanese.repeat(20)] });
	const before = structuredClone(input);
	assert.equal(resolveAmllOriginalLanguage("auto", input), "en");
	assert.equal(resolveAmllOriginalLanguage(undefined, input), "en");
	assert.deepEqual(input, before);
});

test("source mode and manual common/custom/unknown choices win over detection", () => {
	const input = lyrics();
	assert.equal(resolveAmllOriginalLanguage("", input), "ja");
	assert.equal(resolveAmllOriginalLanguage("ko", input), "ko");
	assert.equal(resolveAmllOriginalLanguage(" pt-br ", input), "pt-BR");
	assert.equal(resolveAmllOriginalLanguage("und", input), "und");
});

test("uncertain automatic results retain valid source language, with und as the final fallback", () => {
	assert.equal(resolveOriginalLanguage("auto", "42 ♪", "fr-fr"), "fr-FR");
	assert.equal(resolveOriginalLanguage("auto", "", "und"), "und");
	assert.equal(resolveOriginalLanguage("auto", "", "invalid_code"), "und");
	assert.equal(resolveOriginalLanguage("", english), "und");
	assert.equal(resolveOriginalLanguage("auto", "hello"), "und");
});

test("foreground originals determine language even with many foreign background lines", () => {
	const input = lyrics();
	input.lyricLines.push({
		...input.lyricLines[0],
		isBG: true,
		words: [{ word: japanese.repeat(20), startTime: 0, endTime: 1000 }],
	});
	assert.equal(getAmllOriginalText(input), english);
	assert.equal(resolveAmllOriginalLanguage("auto", input), "en");
	input.lyricLines[0].words = [];
	assert.equal(resolveAmllOriginalLanguage("auto", input), "ja");
});

test("structured TTML resolves timed syllable originals without auxiliary languages", () => {
	const input: TTMLResult = {
		metadata: { language: "ja" },
		lines: [
			{
				text: english,
				words: [{ text: english, startTime: 1234, endTime: 5678 }],
				startTime: 1234,
				endTime: 5678,
				translations: [{ language: "ja", text: japanese.repeat(20) }],
				romanizations: [{ text: japanese.repeat(20) }],
				backgroundVocal: {
					text: japanese.repeat(20),
					startTime: 2000,
					endTime: 3000,
				},
			},
		],
	};
	const before = structuredClone(input);
	assert.equal(resolveStructuredOriginalLanguage("auto", input), "en");
	assert.equal(resolveStructuredOriginalLanguage("", input), "ja");
	assert.deepEqual(input, before);
});

test("malformed metadata values do not prevent a later valid language fallback", () => {
	const input = lyrics("");
	input.metadata = [{ key: "language", value: ["", "invalid_code", "pt-br"] }];
	assert.equal(resolveAmllOriginalLanguage("auto", input), "pt-BR");
});

test("ambiguous shared Han text retains a known CJK language or Chinese script", () => {
	const ambiguous = "天地山水日月星辰";
	for (const language of ["ja", "ko", "zh-Hans", "zh-Hant"])
		assert.equal(
			resolveOriginalLanguage("auto", ambiguous, language),
			language,
		);
	assert.equal(resolveOriginalLanguage("auto", ambiguous), "zh");
});

test("a tiny kana quote does not relabel a Chinese original as Japanese", () => {
	const chinese =
		"這個世界的聲音帶著我們走過很長的時間，遠方的風讓我想起從前聽過的故事。我們在這條街上看見了新的風景，也記住了那些溫暖的聲音。";
	assert.equal(
		resolveOriginalLanguage("auto", `${chinese} ありがとう`, "zh-Hant"),
		"zh-Hant",
	);
});
