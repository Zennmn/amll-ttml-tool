import { francAll } from "franc-min";

const MAX_SAMPLE_CODE_UNITS = 12_000;
const CACHE_LIMIT = 32;
const MIN_CONFIDENT_RELATIVE_SCORE = 0.8;
const MIN_CONFIDENT_SCORE_MARGIN = 0.12;
const LATIN_SCRIPT_SHARE = 0.72;
const NON_LATIN_SCRIPT_SHARE = 0.55;
const FALLBACK_SCRIPT_SHARE = 0.72;
const MIN_LATIN_LETTERS = 32;
const MIN_LATIN_WORDS = 6;
const MIN_LATIN_VOCABULARY = 4;
const MIN_NON_LATIN_LETTERS = 8;
const MIN_JAPANESE_KANA = 3;
const MIN_KOREAN_HANGUL = 3;
const MIN_HAN_CHARACTERS = 4;

const scriptPatterns = {
	latin: /\p{Script=Latin}/gu,
	hiragana: /\p{Script=Hiragana}/gu,
	katakana: /\p{Script=Katakana}/gu,
	han: /\p{Script=Han}/gu,
	hangul: /\p{Script=Hangul}/gu,
	bopomofo: /\p{Script=Bopomofo}/gu,
} as const;

const latinWordPattern = /[\p{Script=Latin}]+(?:[’'][\p{Script=Latin}]+)*/gu;

// The pairs contain only characters whose simplified and traditional forms
// are distinct. Directional evidence is counted in pairs, so a single common
// Han lyric remains neutral instead of being assigned a script variant.
const chineseVariantPairs = [
	["这", "這"],
	["个", "個"],
	["们", "們"],
	["为", "為"],
	["国", "國"],
	["语", "語"],
	["说", "說"],
	["听", "聽"],
	["声", "聲"],
	["乐", "樂"],
	["爱", "愛"],
	["梦", "夢"],
	["时", "時"],
	["间", "間"],
	["长", "長"],
	["东", "東"],
	["风", "風"],
	["马", "馬"],
	["鸟", "鳥"],
	["龙", "龍"],
	["车", "車"],
	["门", "門"],
	["见", "見"],
	["还", "還"],
	["过", "過"],
	["来", "來"],
	["后", "後"],
	["发", "發"],
	["么", "麼"],
	["书", "書"],
	["学", "學"],
	["开", "開"],
	["关", "關"],
	["会", "會"],
	["对", "對"],
	["无", "無"],
	["与", "與"],
	["万", "萬"],
	["华", "華"],
	["儿", "兒"],
	["头", "頭"],
	["电", "電"],
	["气", "氣"],
	["动", "動"],
	["给", "給"],
	["让", "讓"],
	["认", "認"],
	["记", "記"],
	["忆", "憶"],
	["欢", "歡"],
	["恋", "戀"],
	["远", "遠"],
	["边", "邊"],
	["进", "進"],
	["种", "種"],
	["样", "樣"],
	["园", "園"],
	["泪", "淚"],
] as const;

const simplifiedMarkers: ReadonlySet<string> = new Set(
	chineseVariantPairs.map(([simplified]) => simplified),
);
const traditionalMarkers: ReadonlySet<string> = new Set(
	chineseVariantPairs.map(([, traditional]) => traditional),
);

const detectionCache = new Map<string, string | undefined>();

interface ScriptCounts {
	letters: number;
	latin: number;
	kana: number;
	han: number;
	hangul: number;
	bopomofo: number;
	japanese: number;
	korean: number;
	chinese: number;
}

function makeBoundedSample(value: string): string {
	if (value.length <= MAX_SAMPLE_CODE_UNITS) return value;

	const chunkLength = Math.floor((MAX_SAMPLE_CODE_UNITS - 2) / 3);
	const middleStart = Math.floor((value.length - chunkLength) / 2);
	return [
		value.slice(0, chunkLength),
		value.slice(middleStart, middleStart + chunkLength),
		value.slice(-chunkLength),
	].join("\n");
}

function normalizeInput(value: string): string {
	return makeBoundedSample(value)
		.normalize("NFKC")
		.toLowerCase()
		.replace(/\s+/gu, " ")
		.trim();
}

function countMatches(value: string, pattern: RegExp): number {
	return value.match(pattern)?.length ?? 0;
}

function getScriptCounts(value: string): ScriptCounts {
	const latin = countMatches(value, scriptPatterns.latin);
	const kana =
		countMatches(value, scriptPatterns.hiragana) +
		countMatches(value, scriptPatterns.katakana);
	const han = countMatches(value, scriptPatterns.han);
	const hangul = countMatches(value, scriptPatterns.hangul);
	const bopomofo = countMatches(value, scriptPatterns.bopomofo);

	return {
		letters: countMatches(value, /\p{L}/gu),
		latin,
		kana,
		han,
		hangul,
		bopomofo,
		japanese: kana + han,
		korean: hangul + han,
		chinese: han + bopomofo,
	};
}

function chineseVariant(value: string): "zh-Hans" | "zh-Hant" | "zh" {
	let simplified = 0;
	let traditional = 0;

	for (const character of value) {
		if (simplifiedMarkers.has(character)) simplified += 1;
		if (traditionalMarkers.has(character)) traditional += 1;
	}

	if (simplified >= 2 && simplified >= traditional * 2) return "zh-Hans";
	if (traditional >= 2 && traditional >= simplified * 2) return "zh-Hant";
	return "zh";
}

function canonicalizeIso3(code: string | undefined): string | undefined {
	if (!code || code === "und") return undefined;

	try {
		const canonical = Intl.getCanonicalLocales(code)[0];
		return canonical === "und" ? undefined : canonical;
	} catch {
		return undefined;
	}
}

function detectWithFranc(
	value: string,
	minimumLetters: number,
): string | undefined {
	const ranked = francAll(value, { minLength: 1 }).filter(
		([code, score]) => code !== "und" && score > 0,
	);
	const best = ranked[0];
	if (!best) return undefined;
	if (minimumLetters > 0 && countMatches(value, /\p{L}/gu) < minimumLetters) {
		return undefined;
	}

	const [code, relativeScore] = best;
	const runnerUpScore = ranked[1]?.[1] ?? 0;
	// Franc only ranks candidates. Its top relative score is not a calibrated
	// confidence, so detection also requires a clear lead over the runner-up.
	if (
		relativeScore < MIN_CONFIDENT_RELATIVE_SCORE ||
		relativeScore - runnerUpScore < MIN_CONFIDENT_SCORE_MARGIN
	) {
		return undefined;
	}

	return canonicalizeIso3(code);
}

function detectLatin(value: string, letters: number): string | undefined {
	if (letters < MIN_LATIN_LETTERS) return undefined;

	const words = value.match(latinWordPattern) ?? [];
	const distinctWords = new Set(words).size;
	if (words.length < MIN_LATIN_WORDS || distinctWords < MIN_LATIN_VOCABULARY) {
		return undefined;
	}

	return detectWithFranc(value, MIN_LATIN_LETTERS);
}

function detectCjk(value: string, counts: ScriptCounts): string | undefined {
	const { kana, han, hangul, letters } = counts;

	if (kana > 0 && hangul > 0) {
		if (kana >= MIN_JAPANESE_KANA && hangul * 4 <= kana) {
			const evidence = counts.japanese;
			if (evidence / letters >= NON_LATIN_SCRIPT_SHARE) return "ja";
		}
		if (hangul >= MIN_KOREAN_HANGUL && kana * 4 <= hangul) {
			const evidence = counts.korean;
			if (evidence / letters >= NON_LATIN_SCRIPT_SHARE) return "ko";
		}
		return undefined;
	}

	if (kana > 0 && kana >= MIN_JAPANESE_KANA) {
		if (
			counts.japanese / letters >= NON_LATIN_SCRIPT_SHARE &&
			kana / counts.japanese >= 0.1
		)
			return "ja";
	}

	if (hangul > 0 && hangul >= MIN_KOREAN_HANGUL) {
		if (counts.korean / letters >= NON_LATIN_SCRIPT_SHARE) return "ko";
	}

	if (
		han >= MIN_HAN_CHARACTERS &&
		counts.chinese / letters >= NON_LATIN_SCRIPT_SHARE
	) {
		return chineseVariant(value);
	}

	return undefined;
}

function detectUnboundedLanguage(value: string): string | undefined {
	if (!value) return undefined;

	const counts = getScriptCounts(value);
	if (counts.letters === 0) return undefined;

	const cjkLanguage = detectCjk(value, counts);
	if (cjkLanguage) return cjkLanguage;

	if (
		counts.latin >= MIN_LATIN_LETTERS &&
		counts.latin / counts.letters >= LATIN_SCRIPT_SHARE
	) {
		return detectLatin(value, counts.latin);
	}

	const otherLetters =
		counts.letters -
		counts.latin -
		counts.han -
		counts.kana -
		counts.hangul -
		counts.bopomofo;

	if (
		otherLetters >= MIN_NON_LATIN_LETTERS &&
		otherLetters / counts.letters >= FALLBACK_SCRIPT_SHARE
	) {
		return detectWithFranc(value, MIN_NON_LATIN_LETTERS);
	}

	return undefined;
}

function remember(key: string, language: string | undefined): void {
	if (detectionCache.size >= CACHE_LIMIT) {
		const oldestKey = detectionCache.keys().next().value;
		if (oldestKey !== undefined) detectionCache.delete(oldestKey);
	}
	detectionCache.set(key, language);
}

/**
 * Detects the language of original lyric text with an offline, bounded model.
 * Returns undefined when the sample is empty, short, ambiguous, or unsupported.
 */
export function detectOriginalLyricLanguage(
	originalText: string,
): string | undefined {
	const normalized = normalizeInput(originalText);
	if (!normalized) return undefined;
	if (detectionCache.has(normalized)) return detectionCache.get(normalized);

	const language = detectUnboundedLanguage(normalized);
	remember(normalized, language);
	return language;
}
