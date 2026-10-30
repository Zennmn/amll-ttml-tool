import assert from "node:assert/strict";
import test from "node:test";
import { detectOriginalLyricLanguage } from "./language-detection";

test("empty, short Latin, punctuation, and unsupported scripts are unknown", () => {
	for (const value of [
		"",
		"  \n\t ",
		"...!? 12345 💿",
		"Hello, hello, my dear friend",
		"La vida es bella",
		"Bonjour tout le monde",
		"la la la la la la la la la la",
		"𓀀𓀁𓀂𓀃𓀄𓀅𓀆𓀇",
	]) {
		assert.equal(detectOriginalLyricLanguage(value), undefined);
	}
});

test("confident Latin samples use the detected language instead of English by default", () => {
	const samples = new Map([
		[
			"en",
			"When morning light reaches the quiet harbor, fishermen prepare their boats and share stories before the tide returns. Every narrow street carries the smell of fresh bread while neighbors greet each other.",
		],
		[
			"es",
			"Cada mañana caminamos juntos por el parque, compartimos historias con los vecinos y bebemos café antes de volver a casa. Los niños juegan cerca de la fuente.",
		],
		[
			"fr",
			"Chaque matin nous traversons le jardin, parlons des histoires anciennes et préparons du café avant de rentrer chez nous. Les enfants jouent près de la fontaine.",
		],
	]);

	for (const [language, sample] of samples) {
		assert.equal(detectOriginalLyricLanguage(sample), language);
	}
});

test("script evidence detects short Japanese and Korean lyrics", () => {
	assert.equal(detectOriginalLyricLanguage("きみの声"), "ja");
	assert.equal(detectOriginalLyricLanguage("사랑해"), "ko");
});

test("Chinese uses clear simplified or traditional evidence and stays neutral otherwise", () => {
	assert.equal(
		detectOriginalLyricLanguage("我们今天一起听音乐，明天去公园散步。"),
		"zh-Hans",
	);
	assert.equal(
		detectOriginalLyricLanguage("我們今天一起聽音樂，明天去公園散步。"),
		"zh-Hant",
	);
	assert.equal(detectOriginalLyricLanguage("春秋山水日月天地"), "zh");
});

test("a long song body wins over a short foreign hook or quote", () => {
	const japaneseSong = `
		I need you here tonight
		君の声が聞こえる
		星が静かに眠る
		この街の朝を待って
		遠い夢を追いかけて
	`;
	assert.equal(detectOriginalLyricLanguage(japaneseSong), "ja");

	const koreanSong = `
		We will meet again
		오늘도 너의 목소리를 기억해
		밤이 지나면 다시 웃을 거야
		우리의 작은 마음이 별빛 아래 잠들어
	`;
	assert.equal(detectOriginalLyricLanguage(koreanSong), "ko");

	const englishSong = `
		When the morning light reaches the quiet harbor, fishermen prepare
		their boats and share stories before the tide returns. Every narrow
		street carries the smell of fresh bread while neighbors greet each
		other and trade news from distant towns. ありがとう
	`;
	assert.equal(detectOriginalLyricLanguage(englishSong), "en");
});

test("oversized repeated inputs are bounded, deterministic, and survive cache rotation", () => {
	const oversized = [
		"When the harbor is sleeping, the lamp stays bright beside the water.",
		...Array.from(
			{ length: 600 },
			(_, index) => `夜の風が第${index}の街を静かに通り過ぎる`,
		),
	].join("\n");

	const expected = detectOriginalLyricLanguage(oversized);
	assert.equal(expected, "ja");
	for (let index = 0; index < 12; index += 1) {
		assert.equal(detectOriginalLyricLanguage(oversized), expected);
	}

	for (let index = 0; index < 40; index += 1) {
		detectOriginalLyricLanguage(`${index}...`);
	}
	assert.equal(detectOriginalLyricLanguage(oversized), expected);
});
