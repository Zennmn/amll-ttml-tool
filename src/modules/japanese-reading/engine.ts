import { isKanaOnly } from "$/modules/segmentation/utils/Transliteration/TransliterationUtils";
import { alignJapaneseReadings } from "./alignment";
import type { JapaneseReadingToken, JapaneseTokenizer } from "./types";

export const containsJapaneseScript = (text: string) =>
	/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text);

// Common literary spellings absent from IPADIC's usual kana entries.
const supplementalReadings = new Map([
	["此処", "ココ"],
	["其処", "ソコ"],
	["何処", "ドコ"],
	["彼処", "アソコ"],
]);

export function tokenizeJapaneseReading(
	tokenizer: JapaneseTokenizer,
	text: string,
): JapaneseReadingToken[] {
	let cursor = 0;
	let tokens = tokenizer.tokenize(text).flatMap((token) => {
		const surface = token.surface_form;
		if (!surface) return [];
		// Search sequentially instead of trusting code-point positions as UTF-16
		// offsets, so emoji and supplementary characters cannot shift readings.
		const start = text.indexOf(surface, cursor);
		if (start < 0) return [];
		cursor = start + surface.length;
		const reading =
			token.reading && token.reading !== "*"
				? token.reading
				: isKanaOnly(surface)
					? surface
					: undefined;
		return [
			{
				surface,
				reading,
				// Particles use their actual pronunciation (は→wa, へ→e).
				// Else retain dictionary spelling, including long vowels such as きょう.
				pronunciation:
					token.pos === "助詞" && token.pronunciation !== "*"
						? surface === "を"
							? "オ"
							: token.pronunciation
						: undefined,
				start,
				end: cursor,
			},
		];
	});
	for (const [surface, reading] of supplementalReadings) {
		let start = text.indexOf(surface);
		while (start >= 0) {
			const end = start + surface.length;
			const covered = tokens.filter(
				(token) => token.start < end && token.end > start,
			);
			if (
				covered.length &&
				covered[0].start === start &&
				covered.at(-1)?.end === end &&
				covered.some((token) => !token.reading)
			) {
				tokens = tokens.filter(
					(token) => token.start >= end || token.end <= start,
				);
				tokens.push({ surface, reading, pronunciation: undefined, start, end });
				tokens.sort((left, right) => left.start - right.start);
			}
			start = text.indexOf(surface, end);
		}
	}
	return tokens;
}

export function generateJapaneseReadings(
	tokenizer: JapaneseTokenizer,
	words: readonly string[],
): string[] {
	const text = words.join("");
	if (!containsJapaneseScript(text)) return words.map(() => "");
	if (words.length > 2048 || text.length > 8192) {
		throw new Error("Japanese lyric line is too long");
	}
	const tokens = tokenizeJapaneseReading(tokenizer, text);
	const readings = alignJapaneseReadings(
		words.map((word) => ({ word })),
		tokens,
	);
	let offset = 0;
	return readings.map((reading, index) => {
		const start = offset;
		offset += words[index].length;
		// Do not present a partial reading as the pronunciation of an unknown name.
		return tokens.some(
			(token) =>
				!token.reading &&
				/\p{Script=Han}/u.test(token.surface) &&
				token.start < offset &&
				token.end > start,
		)
			? ""
			: reading;
	});
}
