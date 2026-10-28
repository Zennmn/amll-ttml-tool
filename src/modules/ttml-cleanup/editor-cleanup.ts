import { uid } from "uid";
import {
	type LyricLine,
	type LyricWord,
	newLyricWord,
	type TTMLLyric,
} from "$/types/ttml";
import type { CleanupOptions } from "./cleanup";

const BRACKETS = new Map([
	["(", ")"],
	["（", "）"],
]);
const CLOSING = new Map(Array.from(BRACKETS, ([open, close]) => [close, open]));

export interface EditorCleanupResult {
	lyric: TTMLLyric;
	harmonyGroups: number;
	punctuationMerged: number;
	changed: boolean;
}

interface WordPiece {
	word: LyricWord;
	background: boolean;
}

function bracketSelection(chars: readonly string[]): {
	matched: Set<number>;
	selected: Uint8Array;
} {
	const stack: { char: string; position: number }[] = [];
	const matched = new Set<number>();
	const deltas = new Int32Array(chars.length + 1);
	chars.forEach((char, position) => {
		if (BRACKETS.has(char)) stack.push({ char, position });
		else if (CLOSING.has(char)) {
			const opening = stack[stack.length - 1];
			if (opening?.char !== CLOSING.get(char)) return;
			stack.pop();
			matched.add(opening.position);
			matched.add(position);
			deltas[opening.position + 1] += 1;
			deltas[position] -= 1;
		}
	});
	const selected = new Uint8Array(chars.length);
	let depth = 0;
	for (let index = 0; index < chars.length; index++) {
		depth += deltas[index];
		selected[index] = depth > 0 ? 1 : 0;
	}
	return { matched, selected };
}

function splitTranslation(text: string): {
	main: string;
	background: string;
	unwrapped: string;
} {
	const chars = Array.from(text);
	const { matched, selected } = bracketSelection(chars);
	if (!matched.size) return { main: text, background: "", unwrapped: text };
	const fragments: { text: string; background: boolean }[] = [];
	chars.forEach((char, index) => {
		if (matched.has(index)) return;
		const background = selected[index] === 1;
		const previous = fragments.at(-1);
		if (previous?.background === background) previous.text += char;
		else fragments.push({ text: char, background });
	});
	let main = "";
	for (const fragment of fragments) {
		if (fragment.background) continue;
		// Normalize only the newly joined boundary, preserving spacing elsewhere.
		if (/[ \t]$/u.test(main) && /^[ \t]/u.test(fragment.text)) {
			main =
				main.replace(/[ \t]+$/u, "") + fragment.text.replace(/^[ \t]+/u, " ");
		} else {
			if (
				/[\p{Script=Latin}\p{N}]$/u.test(main) &&
				/^[\p{Script=Latin}\p{N}]/u.test(fragment.text)
			)
				main += " ";
			main += fragment.text;
		}
	}
	return {
		main: main.trim(),
		background: fragments
			.filter((fragment) => fragment.background)
			.map((fragment) => fragment.text.trim())
			.filter(Boolean)
			.join(" "),
		unwrapped: chars
			.filter((_char, index) => !matched.has(index))
			.join("")
			.trim(),
	};
}

function splitBrackets(line: LyricLine): {
	pieces: WordPiece[];
	groups: number;
	changed: boolean;
} {
	const chars: string[] = [];
	const offsets: number[] = [];
	for (const word of line.words) {
		offsets.push(chars.length);
		for (const char of word.word) chars.push(char);
	}
	const { matched, selected } = bracketSelection(chars);
	if (!matched.size)
		return {
			pieces: line.words.map((word) => ({ word, background: line.isBG })),
			groups: 0,
			changed: false,
		};
	const pieces: WordPiece[] = [];
	for (const [wordIndex, word] of line.words.entries()) {
		if (!word.word) {
			pieces.push({
				word,
				background: line.isBG || selected[offsets[wordIndex]] === 1,
			});
			continue;
		}
		const fragments: { text: string; background: boolean }[] = [];
		Array.from(word.word).forEach((char, index) => {
			const position = offsets[wordIndex] + index;
			if (matched.has(position)) return;
			const background = line.isBG || selected[position] === 1;
			const previous = fragments[fragments.length - 1];
			if (previous?.background === background) previous.text += char;
			else fragments.push({ text: char, background });
		});
		for (const [index, fragment] of fragments.entries())
			pieces.push({
				word: {
					...(index === 0 ? word : structuredClone(word)),
					id: index === 0 ? word.id : uid(),
					word: fragment.text,
				},
				background: fragment.background,
			});
	}
	let groups = 0;
	let previousBackground = false;
	for (const piece of pieces) {
		if (piece.background && !previousBackground && !line.isBG) groups++;
		previousBackground = piece.background;
	}
	return { pieces, groups, changed: true };
}

function mergePunctuation(pieces: WordPiece[]): {
	pieces: WordPiece[];
	count: number;
} {
	const result: WordPiece[] = [];
	let count = 0;
	for (const piece of pieces) {
		const punctuation = piece.word.word.trim();
		let previousIndex = result.length - 1;
		while (previousIndex >= 0 && !result[previousIndex].word.word.trim())
			previousIndex--;
		const previous = result[previousIndex];
		if (
			previous &&
			punctuation &&
			/^\p{P}+$/u.test(punctuation) &&
			!/[*＊]/u.test(punctuation + previous.word.word) &&
			(!piece.background || previous.background)
		) {
			previous.word.word += punctuation;
			result.splice(previousIndex + 1);
			count++;
		} else result.push(piece);
	}
	return { pieces: result, count };
}

function wordsFor(pieces: WordPiece[], background: boolean): LyricWord[] {
	const words: LyricWord[] = [];
	let previousIndex = -1;
	for (const [index, piece] of pieces.entries()) {
		if (piece.background !== background) continue;
		const previous = words[words.length - 1];
		if (
			previous &&
			index > previousIndex + 1 &&
			!/\s$/u.test(previous.word) &&
			!/^\s/u.test(piece.word.word)
		) {
			words.push({ ...newLyricWord(), word: " " });
		}
		words.push(piece.word);
		previousIndex = index;
	}
	return words;
}

function backgroundLine(
	original: LyricLine,
	words: LyricWord[],
	translatedLyric: string,
): LyricLine {
	const timed = words.filter(
		(word) => word.startTime !== 0 || word.endTime !== 0,
	);
	const { endTimeLink: _endTimeLink, ...line } = original;
	return {
		...line,
		id: uid(),
		isBG: true,
		words,
		translatedLyric,
		romanLyric: "",
		startTime: timed.length
			? Math.min(...timed.map((word) => word.startTime))
			: original.startTime,
		endTime: timed.length
			? Math.max(...timed.map((word) => word.endTime))
			: original.endTime,
	};
}

/** Transform editor words directly, retaining metadata and editor-only fields. */
export function cleanupEditorLyrics(
	lyric: TTMLLyric,
	options: CleanupOptions,
): EditorCleanupResult {
	let harmonyGroups = 0;
	let punctuationMerged = 0;
	let changed = false;
	const result = structuredClone(lyric);
	result.lyricLines = result.lyricLines.flatMap((line) => {
		const split = options.harmony
			? splitBrackets(line)
			: {
					pieces: line.words.map((word) => ({ word, background: line.isBG })),
					groups: 0,
					changed: false,
				};
		const merged = options.punctuation
			? mergePunctuation(split.pieces)
			: { pieces: split.pieces, count: 0 };
		harmonyGroups += split.groups;
		punctuationMerged += merged.count;
		changed ||= split.changed || merged.count > 0;
		if (!split.changed && merged.count === 0) return [line];
		if (line.isBG)
			return [{ ...line, words: merged.pieces.map((piece) => piece.word) }];
		const main = wordsFor(merged.pieces, false);
		const background = wordsFor(merged.pieces, true);
		if (!background.length) return [{ ...line, words: main }];
		const translation = splitTranslation(line.translatedLyric);
		if (!main.some((word) => word.word.trim())) {
			return [
				{
					...line,
					words: merged.pieces.map((piece) => piece.word),
					translatedLyric: translation.unwrapped,
					isBG: true,
				},
			];
		}
		return [
			{ ...line, words: main, translatedLyric: translation.main },
			backgroundLine(line, background, translation.background),
		];
	});
	return {
		lyric: changed ? result : lyric,
		harmonyGroups,
		punctuationMerged,
		changed,
	};
}
