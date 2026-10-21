import type { TTMLLyric } from "$/types/ttml";

export interface TranslationFillResult {
	lyric: TTMLLyric;
	filledLines: number;
	changed: boolean;
}

/** Copy untranslated foreground lines verbatim without altering their words. */
export function fillMissingTranslations(
	lyric: TTMLLyric,
): TranslationFillResult {
	let filledLines = 0;
	const lyricLines = lyric.lyricLines.map((line) => {
		if (line.isBG || line.translatedLyric.trim()) return line;
		const original = line.words.map((word) => word.word).join("");
		if (!original.trim()) return line;
		filledLines++;
		return { ...line, translatedLyric: original };
	});
	return {
		lyric: filledLines ? { ...lyric, lyricLines } : lyric,
		filledLines,
		changed: filledLines > 0,
	};
}
