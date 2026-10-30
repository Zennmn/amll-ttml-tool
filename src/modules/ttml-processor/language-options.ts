import { normalizeTtmlLanguage } from "./export-options";
import { detectOriginalLyricLanguage } from "./language-detection";
import type { AmllLyricResult, TTMLResult } from "./types";

/** Automatic detection is based on sung originals, never translations or readings. */
export function getAmllOriginalText(result: AmllLyricResult): string {
	const foreground = result.lyricLines
		.filter((line) => !line.isBG)
		.map((line) => line.words.map((word) => word.word).join(""))
		.join("\n");
	return /\p{L}/u.test(foreground)
		? foreground
		: result.lyricLines
				.map((line) => line.words.map((word) => word.word).join(""))
				.join("\n");
}

export function getAmllSourceLanguage(
	result: AmllLyricResult,
): string | undefined {
	for (const metadata of result.metadata) {
		if (metadata.key !== "language") continue;
		for (const value of metadata.value) {
			const normalized = normalizeTtmlLanguage(value);
			if (normalized) return normalized;
		}
	}
	return undefined;
}

export function resolveOriginalLanguage(
	selection: string | undefined,
	originalText: string,
	sourceLanguage?: string,
): string {
	const source = normalizeTtmlLanguage(sourceLanguage ?? "") ?? "und";
	if (selection?.trim() === "") return source;
	const explicit = normalizeTtmlLanguage(selection ?? "");
	if (explicit) return explicit;
	const detected = detectOriginalLyricLanguage(originalText);
	// Shared Han characters alone cannot disprove a known CJK language or script.
	if (detected === "zh" && /^(?:zh|ja|ko)(?:-|$)/u.test(source)) return source;
	return detected ?? source;
}

export function resolveAmllOriginalLanguage(
	selection: string | undefined,
	result: AmllLyricResult,
): string {
	return resolveOriginalLanguage(
		selection,
		getAmllOriginalText(result),
		getAmllSourceLanguage(result),
	);
}

export function resolveStructuredOriginalLanguage(
	selection: string | undefined,
	result: TTMLResult,
): string {
	const foreground = result.lines
		.map((line) => line.words?.map((word) => word.text).join("") || line.text)
		.join("\n");
	return resolveOriginalLanguage(
		selection,
		/\p{L}/u.test(foreground)
			? foreground
			: result.lines.map((line) => line.backgroundVocal?.text ?? "").join("\n"),
		result.metadata.language,
	);
}
