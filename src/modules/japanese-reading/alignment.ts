import { toHiragana, toRomaji } from "wanakana";

export interface JapaneseReadingToken {
	surface: string;
	reading?: string;
	pronunciation?: string;
	start: number;
	end: number;
}

type SurfaceKind = "han" | "kana" | "other";

interface SurfaceUnit {
	kind: SurfaceKind;
	text: string;
	start: number;
	end: number;
	normalizedKana: string;
}

interface CellRange {
	start: number;
	end: number;
}

interface IndexedToken {
	token: JapaneseReadingToken;
	order: number;
}

const JAPANESE_SCRIPT =
	/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
const HAN_SCRIPT = /^\p{Script=Han}$/u;
const HIRAGANA_SCRIPT = /^\p{Script=Hiragana}$/u;
const KATAKANA_SCRIPT = /^\p{Script=Katakana}$/u;
const PROLONGED_SOUND_MARK = "ー";
const ATTACHING_SMALL_KANA = new Set(
	Array.from("ぁぃぅぇぉゃゅょゎゕゖァィゥェォャュョヮヵヶ"),
);
const SOKUON = new Set(["っ", "ッ"]);
const COMBINING_MARKS = new Set(["\u3099", "\u309a"]);

function isAttachingKana(character: string): boolean {
	return (
		ATTACHING_SMALL_KANA.has(character) ||
		character === PROLONGED_SOUND_MARK ||
		COMBINING_MARKS.has(character)
	);
}

function isKanaGlyph(character: string): boolean {
	return (
		HIRAGANA_SCRIPT.test(character) ||
		KATAKANA_SCRIPT.test(character) ||
		character === PROLONGED_SOUND_MARK
	);
}

function surfaceKind(character: string): SurfaceKind {
	if (HAN_SCRIPT.test(character)) return "han";
	if (isKanaGlyph(character)) return "kana";
	return "other";
}

function normalizeKana(value: string): string | undefined {
	const trimmed = value.trim();
	if (!trimmed || trimmed === "*") return;
	const normalized = toHiragana(trimmed, { passRomaji: false });
	if (Array.from(normalized).some((character) => !isKanaGlyph(character)))
		return;
	return normalized;
}

function splitMorae(kana: string): string[] {
	const morae: string[] = [];
	for (const character of kana) {
		const previousIndex = morae.length - 1;
		const previous = morae[previousIndex];
		if (
			previous !== undefined &&
			!SOKUON.has(previous) &&
			isAttachingKana(character)
		) {
			morae[previousIndex] += character;
		} else {
			morae.push(character);
		}
	}
	return morae;
}

function preferredMorae(token: JapaneseReadingToken): string[] {
	for (const value of [token.pronunciation, token.reading]) {
		if (typeof value !== "string") continue;
		const normalized = normalizeKana(value);
		if (normalized) return splitMorae(normalized);
	}
	return [];
}

function buildSurfaceUnits(
	surface: string,
	absoluteStart: number,
): SurfaceUnit[] {
	const units: SurfaceUnit[] = [];
	let offset = 0;
	for (const character of surface) {
		const start = absoluteStart + offset;
		const end = start + character.length;
		offset += character.length;
		const kind = surfaceKind(character);
		const previous = units[units.length - 1];
		if (
			kind === "kana" &&
			previous?.kind === "kana" &&
			isAttachingKana(character)
		) {
			previous.text += character;
			previous.end = end;
			continue;
		}
		units.push({
			kind,
			text: character,
			start,
			end,
			normalizedKana: "",
		});
	}
	for (const unit of units) {
		if (unit.kind === "kana")
			unit.normalizedKana = normalizeKana(unit.text) ?? "";
	}
	return units;
}

function latestIndexBefore(
	positions: readonly number[],
	upperBound: number,
): number {
	let low = 0;
	let high = positions.length;
	while (low < high) {
		const middle = (low + high) >>> 1;
		if (positions[middle] < upperBound) low = middle + 1;
		else high = middle;
	}
	return low > 0 ? positions[low - 1] : -1;
}

function findKanaAnchors(
	units: readonly SurfaceUnit[],
	morae: readonly string[],
): Array<number | undefined> {
	const positions = new Map<string, number[]>();
	morae.forEach((mora, index) => {
		const existing = positions.get(mora);
		if (existing) existing.push(index);
		else positions.set(mora, [index]);
	});
	const anchors: Array<number | undefined> = Array.from(
		{ length: units.length },
		() => undefined,
	);
	let upperBound = morae.length;
	for (let index = units.length - 1; index >= 0; index--) {
		const unit = units[index];
		if (unit.kind !== "kana" || !unit.normalizedKana) continue;
		const candidates = positions.get(unit.normalizedKana);
		if (!candidates) continue;
		const match = latestIndexBefore(candidates, upperBound);
		if (match < 0) continue;
		anchors[index] = match;
		upperBound = match;
	}
	return anchors;
}

function distributeReading(
	unitIndices: readonly number[],
	start: number,
	end: number,
	assignments: number[][],
): void {
	const count = Math.max(0, end - start);
	if (!count || !unitIndices.length) return;
	const sizes = new Array<number>(unitIndices.length).fill(0);
	if (count >= unitIndices.length) {
		sizes.fill(1);
		let extra = count - unitIndices.length;
		let index = unitIndices.length - 1;
		while (extra > 0) {
			sizes[index]++;
			extra--;
			index = (index - 1 + unitIndices.length) % unitIndices.length;
		}
	} else {
		for (
			let index = unitIndices.length - count;
			index < unitIndices.length;
			index++
		)
			sizes[index] = 1;
	}

	let readingIndex = start;
	for (let index = 0; index < unitIndices.length; index++) {
		for (let amount = 0; amount < sizes[index]; amount++) {
			assignments[unitIndices[index]].push(readingIndex);
			readingIndex++;
		}
	}
}

function tokenAssignments(
	units: readonly SurfaceUnit[],
	morae: readonly string[],
): Array<number[]> {
	const oralUnits: SurfaceUnit[] = [];
	const oralIndices: number[] = [];
	units.forEach((unit, index) => {
		if (unit.kind === "han" || unit.kind === "kana") {
			oralUnits.push(unit);
			oralIndices.push(index);
		}
	});
	const assignments: number[][] = Array.from(
		{ length: units.length },
		() => [],
	);
	if (!oralUnits.length || !morae.length) return assignments;

	const anchors = findKanaAnchors(oralUnits, morae);
	const hasAnchor = anchors.some((value) => value !== undefined);
	if (!hasAnchor) {
		distributeReading(oralIndices, 0, morae.length, assignments);
		return assignments;
	}

	let unitCursor = 0;
	let readingCursor = 0;
	let lastAnchor = -1;
	for (let index = 0; index < anchors.length; index++) {
		const anchor = anchors[index];
		if (anchor === undefined) continue;
		const gapUnits = oralIndices.slice(unitCursor, index);
		if (gapUnits.length) {
			distributeReading(gapUnits, readingCursor, anchor, assignments);
		} else if (anchor > readingCursor) {
			for (let reading = readingCursor; reading < anchor; reading++)
				assignments[oralIndices[index]].push(reading);
		}
		assignments[oralIndices[index]].push(anchor);
		unitCursor = index + 1;
		readingCursor = anchor + 1;
		lastAnchor = index;
	}

	const tailUnits = oralIndices.slice(unitCursor);
	if (tailUnits.length) {
		distributeReading(tailUnits, readingCursor, morae.length, assignments);
	} else if (readingCursor < morae.length) {
		const target =
			lastAnchor >= 0 ? oralIndices[lastAnchor] : oralIndices.at(-1);
		if (target !== undefined) {
			for (let reading = readingCursor; reading < morae.length; reading++)
				assignments[target].push(reading);
		}
	}
	return assignments;
}

function prefixBeforeNextRomanization(
	combined: string,
	nextRomanization: string,
): string {
	return combined.endsWith(nextRomanization)
		? combined.slice(0, combined.length - nextRomanization.length)
		: "";
}

function romanizeMorae(morae: readonly string[]): string[] {
	const direct = morae.map((mora) => toRomaji(mora, { upcaseKatakana: false }));
	const result = [...direct];
	for (let index = 0; index < morae.length; index++) {
		const mora = morae[index];
		const nextMora = morae[index + 1];
		if (SOKUON.has(mora)) {
			result[index] =
				nextMora === undefined
					? ""
					: prefixBeforeNextRomanization(
							toRomaji(mora + nextMora, { upcaseKatakana: false }),
							direct[index + 1],
						);
		} else if (mora === "ん" && nextMora !== undefined) {
			const contextualPrefix = prefixBeforeNextRomanization(
				toRomaji(mora + nextMora, { upcaseKatakana: false }),
				direct[index + 1],
			);
			if (contextualPrefix) result[index] = contextualPrefix;
		}
	}
	return result;
}

function hasLoneSurrogate(value: string): boolean {
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index);
		if (code >= 0xd800 && code <= 0xdbff) {
			const next = value.charCodeAt(index + 1);
			if (next >= 0xdc00 && next <= 0xdfff) {
				index++;
				continue;
			}
			return true;
		}
		if (code >= 0xdc00 && code <= 0xdfff) return true;
	}
	return false;
}

function isLowSurrogate(code: number): boolean {
	return code >= 0xdc00 && code <= 0xdfff;
}

function isHighSurrogate(code: number): boolean {
	return code >= 0xd800 && code <= 0xdbff;
}

function splitsSurrogate(text: string, offset: number): boolean {
	return (
		offset > 0 &&
		offset < text.length &&
		isHighSurrogate(text.charCodeAt(offset - 1)) &&
		isLowSurrogate(text.charCodeAt(offset))
	);
}

function cellIndexAt(ranges: readonly CellRange[], offset: number): number {
	let low = 0;
	let high = ranges.length;
	while (low < high) {
		const middle = (low + high) >>> 1;
		if (ranges[middle].end <= offset) low = middle + 1;
		else high = middle;
	}
	const candidate = ranges[low];
	if (
		candidate !== undefined &&
		candidate.start <= offset &&
		offset < candidate.end
	)
		return low;
	return -1;
}

/**
 * Aligns tokenizer readings to existing lyric cells without mutating either
 * input. Token offsets are UTF-16 offsets into `words.map((word) => word.word).join("")`.
 *
 * Exact kana anchors keep okurigana in place. A reading that covers multiple
 * kanji cells is split at mora boundaries; the dictionary does not expose
 * per-kanji readings, so that split is deterministic rather than lexical.
 */
export function alignJapaneseReadings(
	words: readonly { word: string }[],
	tokens: readonly JapaneseReadingToken[],
): string[] {
	const ranges: CellRange[] = [];
	let lyric = "";
	for (const word of words) {
		const start = lyric.length;
		lyric += word.word;
		ranges.push({ start, end: lyric.length });
	}
	const contributions: string[][] = Array.from(
		{ length: words.length },
		() => [],
	);
	const invalidCells = words.map((word) => hasLoneSurrogate(word.word));
	const invalidDelta = new Int32Array(lyric.length + 1);
	const invalidateRange = (start: number, end: number) => {
		const from = Math.max(0, Math.min(lyric.length, Math.trunc(start)));
		const to = Math.max(from, Math.min(lyric.length, Math.trunc(end)));
		if (from === to) return;
		invalidDelta[from]++;
		invalidDelta[to]--;
	};

	const candidates: IndexedToken[] = [];
	for (const [order, token] of tokens.entries()) {
		if (
			!token ||
			typeof token.surface !== "string" ||
			!Number.isFinite(token.start) ||
			!Number.isFinite(token.end)
		) {
			continue;
		}
		if (
			!Number.isSafeInteger(token.start) ||
			!Number.isSafeInteger(token.end)
		) {
			invalidateRange(token.start, token.end);
			continue;
		}
		if (
			token.start < 0 ||
			token.end > lyric.length ||
			token.start >= token.end
		) {
			invalidateRange(token.start, token.end);
			continue;
		}
		if (
			splitsSurrogate(lyric, token.start) ||
			splitsSurrogate(lyric, token.end) ||
			lyric.slice(token.start, token.end) !== token.surface
		) {
			invalidateRange(token.start, token.end);
			continue;
		}
		candidates.push({ token, order });
	}
	const sorted = [...candidates].sort(
		(left, right) =>
			left.token.start - right.token.start || left.order - right.order,
	);

	let clusterStart = -1;
	let clusterEnd = -1;
	let clusterSize = 0;
	const finishCluster = () => {
		if (clusterSize > 1) invalidateRange(clusterStart, clusterEnd);
	};
	for (const candidate of sorted) {
		const token = candidate.token;
		if (clusterSize > 0 && token.start < clusterEnd) {
			clusterSize++;
			clusterEnd = Math.max(clusterEnd, token.end);
		} else {
			finishCluster();
			clusterStart = token.start;
			clusterEnd = token.end;
			clusterSize = 1;
		}
	}
	finishCluster();

	for (const { token } of sorted) {
		if (!JAPANESE_SCRIPT.test(token.surface)) continue;
		const morae = preferredMorae(token);
		if (!morae.length) continue;
		const units = buildSurfaceUnits(token.surface, token.start);
		const assignments = tokenAssignments(units, morae);
		const romanizations = romanizeMorae(morae);
		for (let index = 0; index < units.length; index++) {
			const unit = units[index];
			if (unit.kind === "other") continue;
			const romanization = assignments[index]
				.sort((left, right) => left - right)
				.map((readingIndex) => romanizations[readingIndex] ?? "")
				.join("");
			if (!romanization) continue;
			const cell = cellIndexAt(ranges, unit.start);
			if (cell >= 0) contributions[cell].push(romanization);
		}
	}

	let depth = 0;
	let offset = 0;
	for (let index = 0; index < ranges.length; index++) {
		const range = ranges[index];
		while (offset < range.end) {
			depth += invalidDelta[offset];
			if (depth > 0) invalidCells[index] = true;
			offset++;
		}
		// A zero-width cell at the boundary inherits the interval state.
		if (range.start === range.end && depth > 0) invalidCells[index] = true;
	}

	return words.map((word, index) => {
		if (invalidCells[index] || !JAPANESE_SCRIPT.test(word.word)) return "";
		return contributions[index].join("");
	});
}
