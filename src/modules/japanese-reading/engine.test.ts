import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";
import { generateJapaneseReadings, tokenizeJapaneseReading } from "./engine";
import type { JapaneseTokenizer, JapaneseTokenizerFactory } from "./types";

const require = createRequire(import.meta.url);
const factory = require("kuromoji") as JapaneseTokenizerFactory;
const dictionaryPath = join(
	dirname(require.resolve("kuromoji/package.json")),
	"dict",
);
const tokenizerPromise = new Promise<JapaneseTokenizer>((resolve, reject) => {
	factory
		.builder({ dicPath: dictionaryPath })
		.build((error, tokenizer) => (error ? reject(error) : resolve(tokenizer)));
});

test("real local dictionary generates the reference Japanese readings without any supplied romanization", async () => {
	const tokenizer = await tokenizerPromise;
	const words = Object.freeze(["夢", "中", "で", "生", "き", "る"]);
	assert.deepEqual(generateJapaneseReadings(tokenizer, words), [
		"mu",
		"chuu",
		"de",
		"i",
		"ki",
		"ru",
	]);
	assert.deepEqual(words, ["夢", "中", "で", "生", "き", "る"]);
	assert.deepEqual(
		generateJapaneseReadings(tokenizer, [
			"其処",
			"に",
			"忽ち",
			"花",
			"が",
			"咲",
			"く",
		]),
		["soko", "ni", "tachimachi", "hana", "ga", "sa", "ku"],
	);
});

test("contextual compound readings and Japanese particles use natural pronunciations", async () => {
	const tokenizer = await tokenizerPromise;
	assert.deepEqual(
		generateJapaneseReadings(tokenizer, ["今日", "は", "晴れ"]),
		["kyou", "wa", "hare"],
	);
	assert.deepEqual(
		generateJapaneseReadings(tokenizer, ["学校", "へ", "行く"]),
		["gakkou", "e", "iku"],
	);
	assert.deepEqual(generateJapaneseReadings(tokenizer, ["花", "を", "見る"]), [
		"hana",
		"o",
		"miru",
	]);
	assert.deepEqual(generateJapaneseReadings(tokenizer, ["明日", "は", "雨"]), [
		"ashita",
		"wa",
		"ame",
	]);
});

test("emoji, empty cells, Latin text and punctuation do not shift following Japanese readings", async () => {
	const tokenizer = await tokenizerPromise;
	assert.deepEqual(
		generateJapaneseReadings(tokenizer, ["😀", "今日", "は", "晴れ", "！"]),
		["", "kyou", "wa", "hare", ""],
	);
	assert.deepEqual(
		generateJapaneseReadings(tokenizer, ["Hello", " ", "world"]),
		["", "", ""],
	);
	assert.deepEqual(
		generateJapaneseReadings(tokenizer, ["", "花", "", "が", "咲く"]),
		["", "hana", "", "ga", "saku"],
	);
});

test("unknown kanji cannot become a misleading partial pronunciation", () => {
	const unknown: JapaneseTokenizer = {
		tokenize: () => [
			{ surface_form: "𠮷" },
			{ surface_form: "野", reading: "ノ" },
		],
	};
	assert.deepEqual(generateJapaneseReadings(unknown, ["𠮷野"]), [""]);
	assert.equal(
		tokenizeJapaneseReading(
			{ tokenize: () => [{ surface_form: "unrelated" }] },
			"花",
		).length,
		0,
	);
});
