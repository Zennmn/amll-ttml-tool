import { toRomaji } from "wanakana";
import { isKanaOnly } from "$/modules/segmentation/utils/Transliteration/TransliterationUtils";

export type SyncPronunciationMode =
	| "off"
	| "original-primary"
	| "romanization-primary";

export interface SyncPronunciationText {
	primary: string;
	secondary?: string;
}

export function getAlignedSyncRomanization(
	words: readonly { word: string }[],
	romanization: string,
): string[] | undefined {
	const text = romanization.trim();
	if (!text) return;
	const nonblankCount = words.filter((word) => word.word.trim()).length;
	if (nonblankCount === 1) {
		return words.map((word) => (word.word.trim() ? text : ""));
	}
	const tokens = text.split(/\s+/);
	if (tokens.length !== nonblankCount) return;
	let index = 0;
	return words.map((word) => (word.word.trim() ? tokens[index++] : ""));
}

export function getSyncPronunciationText(
	original: string,
	romanization: string | undefined,
	mode: SyncPronunciationMode,
): SyncPronunciationText {
	const reading = romanization?.trim();
	if (
		mode === "off" ||
		!original.trim() ||
		!reading ||
		reading === original.trim()
	) {
		return { primary: original };
	}
	return mode === "romanization-primary"
		? { primary: reading, secondary: original }
		: { primary: original, secondary: reading };
}

// Ruby entries are separate timing units. Convert their own kana readings;
// assigning the parent's full romanization to each entry would misalign them.
export function getRubySyncRomanization(reading: string): string | undefined {
	if (!isKanaOnly(reading)) return;
	const romaji = toRomaji(reading, { upcaseKatakana: false }).trim();
	return romaji && romaji !== reading.trim() ? romaji : undefined;
}
