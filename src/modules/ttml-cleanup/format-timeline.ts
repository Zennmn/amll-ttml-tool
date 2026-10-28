import type { LyricLine, TTMLLyric } from "$/types/ttml";

export interface TimelineFormatOptions {
	mergeTranslations: boolean;
	/** Omitted means all previewed groups; an empty set means none. */
	mergeGroupIds?: ReadonlySet<string>;
}

export interface TranslationMergeGroup {
	id: string;
	startTime: number;
	targetLineId: string;
	targetLineNumber: number;
	original: string;
	isBG: boolean;
	isDuet: boolean;
	translations: { lineNumber: number; text: string }[];
	mergedTranslation: string;
}

export interface TimelineFormatResult {
	lyric: TTMLLyric;
	reorderedLines: number;
	mergedGroups: number;
	translationGroups: TranslationMergeGroup[];
	changed: boolean;
}

interface LineEntry {
	line: LyricLine;
	index: number;
	/** Background vocals belong to the preceding foreground line. */
	owner: string;
}

function validTime(time: number): boolean {
	return Number.isFinite(time) && time >= 0;
}

function isTimed(line: LyricLine): boolean {
	return (
		validTime(line.startTime) &&
		(line.startTime > 0 ||
			(validTime(line.endTime) && line.endTime > 0) ||
			line.words.some((word) => word.startTime > 0 || word.endTime > 0))
	);
}

/** Sort complete vocal groups without changing a word's timestamp or ownership. */
export function formatTimeline(
	lyric: TTMLLyric,
	options: TimelineFormatOptions,
): TimelineFormatResult {
	const blocks: LineEntry[][] = [];
	const orphanedBackgrounds: LineEntry[] = [];
	lyric.lyricLines.forEach((line, index) => {
		const previous = blocks.at(-1);
		if (line.isBG && !previous) {
			// Keep unowned leading backgrounds in place rather than inventing a parent.
			orphanedBackgrounds.push({ line, index, owner: line.id });
		} else if (line.isBG && previous && !previous[0].line.isBG) {
			previous.push({ line, index, owner: previous[0].line.id });
		} else blocks.push([{ line, index, owner: line.id }]);
	});
	blocks.sort((a, b) => {
		const aTime = validTime(a[0].line.startTime)
			? a[0].line.startTime
			: Number.POSITIVE_INFINITY;
		const bTime = validTime(b[0].line.startTime)
			? b[0].line.startTime
			: Number.POSITIVE_INFINITY;
		return aTime - bTime || a[0].index - b[0].index;
	});
	const entries = [...orphanedBackgrounds, ...blocks.flat()];
	const groups = new Map<string, LineEntry[]>();
	for (const entry of entries) {
		const { line } = entry;
		// Zero timestamps on an untimed document are not a shared musical moment.
		if (!isTimed(line)) continue;
		const key = JSON.stringify([
			line.startTime,
			line.isBG,
			line.isDuet,
			line.ignoreSync,
			line.isBG ? entry.owner : "",
		]);
		const group = groups.get(key);
		if (group) group.push(entry);
		else groups.set(key, [entry]);
	}

	const replacements = new Map<string, string>();
	const translationGroups: TranslationMergeGroup[] = [];
	let mergedGroups = 0;
	for (const group of groups.values()) {
		if (group.length < 2) continue;
		const target =
			group.find(({ line }) => line.words.some((word) => word.word.trim())) ??
			group[0];
		const translated = group.filter(({ line }) => line.translatedLyric.trim());
		if (!translated.some((entry) => entry !== target)) continue;
		const translations = Array.from(
			new Set(translated.map(({ line }) => line.translatedLyric.trim())),
		);
		// The TTML processor collapses literal newlines; keep a visible separator.
		const mergedTranslation = translations.join(" / ");
		const preview: TranslationMergeGroup = {
			id: target.line.id,
			startTime: target.line.startTime,
			targetLineId: target.line.id,
			targetLineNumber: target.index + 1,
			original: target.line.words.map((word) => word.word).join(""),
			isBG: target.line.isBG,
			isDuet: target.line.isDuet,
			translations: translated.map(({ line, index }) => ({
				lineNumber: index + 1,
				text: line.translatedLyric,
			})),
			mergedTranslation,
		};
		translationGroups.push(preview);
		if (
			!options.mergeTranslations ||
			(options.mergeGroupIds && !options.mergeGroupIds.has(preview.id))
		)
			continue;
		mergedGroups++;
		for (const { line } of group) {
			const translation = line === target.line ? mergedTranslation : "";
			if (line.translatedLyric !== translation)
				replacements.set(line.id, translation);
		}
	}

	const reorderedLines = entries.filter(
		(entry, index) => entry.index !== index,
	).length;
	const changed = reorderedLines > 0 || replacements.size > 0;
	return {
		lyric: changed
			? {
					...lyric,
					lyricLines: entries.map(({ line }) =>
						replacements.has(line.id)
							? { ...line, translatedLyric: replacements.get(line.id) ?? "" }
							: line,
					),
				}
			: lyric,
		reorderedLines,
		mergedGroups,
		translationGroups,
		changed,
	};
}
