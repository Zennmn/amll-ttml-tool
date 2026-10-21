import type { LyricLine, LyricWord, TTMLLyric } from "$/types/ttml";

export type ShortSyllableMergeDirection = "auto" | "previous" | "next";

export interface ShortSyllableMergeOptions {
	thresholdMs?: number;
	direction?: ShortSyllableMergeDirection;
	targetLineIndices?: ReadonlySet<number>;
}

const CJK_CHARACTER =
	/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Bopomofo}ーｰ]/u;
const CJK_UNIT =
	/^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Bopomofo}\p{Mark}\p{Punctuation}ーｰ]+$/u;

function isTimedCjk(word: LyricWord): boolean {
	return (
		CJK_CHARACTER.test(word.word) &&
		CJK_UNIT.test(word.word) &&
		Number.isFinite(word.startTime) &&
		Number.isFinite(word.endTime) &&
		word.startTime >= 0 &&
		word.endTime > word.startTime
	);
}

function getMergeGap(
	left: LyricWord | undefined,
	right: LyricWord | undefined,
	thresholdMs: number,
): number | undefined {
	if (!left || !right || !isTimedCjk(left) || !isTimedCjk(right)) return;
	// Reject reversed timing, and keep pauses longer than the short-unit threshold.
	if (left.startTime > right.startTime || left.endTime > right.endTime) return;
	const gap = Math.max(0, right.startTime - left.endTime);
	return gap <= thresholdMs ? gap : undefined;
}

function mergePair(left: LyricWord, right: LyricWord): LyricWord {
	const ruby = [...(left.ruby ?? []), ...(right.ruby ?? [])];
	return {
		...left,
		word: left.word + right.word,
		startTime: left.startTime,
		endTime: right.endTime,
		romanWord: [left.romanWord, right.romanWord].filter(Boolean).join(" "),
		obscene: left.obscene || right.obscene,
		emptyBeat: left.emptyBeat + right.emptyBeat,
		...(left.romanWarning || right.romanWarning ? { romanWarning: true } : {}),
		...(ruby.length > 0 ? { ruby: ruby.map((entry) => ({ ...entry })) } : {}),
	};
}

/** Merge only short CJK units; leave the row's timing and annotations intact. */
export function mergeShortSyllables(
	line: LyricLine,
	options: ShortSyllableMergeOptions = {},
): { line: LyricLine; mergedUnits: number } {
	const thresholdMs = options.thresholdMs ?? 100;
	if (
		!Number.isInteger(thresholdMs) ||
		thresholdMs < 1 ||
		thresholdMs > 1000 ||
		line.words.length < 2
	) {
		return { line, mergedUnits: 0 };
	}
	const direction = options.direction ?? "auto";
	const words = [...line.words];
	let mergedUnits = 0;
	let index = 0;
	while (index < words.length) {
		const current = words[index];
		if (
			!isTimedCjk(current) ||
			current.endTime - current.startTime >= thresholdMs
		) {
			index++;
			continue;
		}
		const previous = words[index - 1];
		const next = words[index + 1];
		const previousGap = getMergeGap(previous, current, thresholdMs);
		const nextGap = getMergeGap(current, next, thresholdMs);
		if (previousGap === undefined && nextGap === undefined) {
			index++;
			continue;
		}
		let usePrevious = previousGap !== undefined;
		if (previousGap !== undefined && nextGap !== undefined) {
			if (direction === "previous") usePrevious = true;
			else if (direction === "next") usePrevious = false;
			else {
				usePrevious =
					previousGap < nextGap ||
					(previousGap === nextGap &&
						previous.endTime - previous.startTime <=
							next.endTime - next.startTime);
			}
		}
		const leftIndex = usePrevious ? index - 1 : index;
		words.splice(
			leftIndex,
			2,
			mergePair(words[leftIndex], words[leftIndex + 1]),
		);
		mergedUnits++;
		// A cluster still below the threshold can absorb another eligible neighbor.
		index = leftIndex;
	}
	return { line: mergedUnits ? { ...line, words } : line, mergedUnits };
}

export function mergeShortSyllablesInLyrics(
	lyric: TTMLLyric,
	options: ShortSyllableMergeOptions = {},
) {
	let mergedUnits = 0;
	let changedLines = 0;
	const lyricLines = lyric.lyricLines.map((line, index) => {
		if (options.targetLineIndices && !options.targetLineIndices.has(index)) {
			return line;
		}
		const result = mergeShortSyllables(line, options);
		mergedUnits += result.mergedUnits;
		if (result.mergedUnits) changedLines++;
		return result.line;
	});
	return {
		lyric: mergedUnits ? { ...lyric, lyricLines } : lyric,
		changed: mergedUnits > 0,
		mergedUnits,
		changedLines,
	};
}
