import type { TTMLLyric } from "$/types/ttml";

export interface TranslationRemovalResult {
	lyric: TTMLLyric;
	removedLines: number;
	changed: boolean;
}

/** Remove translations only from the requested editor line IDs. */
export function removeTranslations(
	lyric: TTMLLyric,
	lineIds: ReadonlySet<string>,
): TranslationRemovalResult {
	if (lineIds.size === 0) {
		return { lyric, removedLines: 0, changed: false };
	}

	let removedLines = 0;
	const lyricLines = lyric.lyricLines.map((line) => {
		if (!lineIds.has(line.id) || line.translatedLyric.trim().length === 0) {
			return line;
		}
		removedLines++;
		return { ...line, translatedLyric: "" };
	});

	if (removedLines === 0) {
		return { lyric, removedLines: 0, changed: false };
	}
	return {
		lyric: { ...lyric, lyricLines },
		removedLines,
		changed: true,
	};
}
