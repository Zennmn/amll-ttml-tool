import { atom } from "jotai";
import {
	editingWordStateAtom,
	lyricLinesAtom,
	selectedWordsAtom,
} from "$/states/main";
import {
	mergeShortSyllablesInLyrics,
	type ShortSyllableMergeOptions,
} from "../utils/short-syllable-merge";

export const applyShortSyllableMergeAtom = atom(
	null,
	(get, set, options: ShortSyllableMergeOptions) => {
		const result = mergeShortSyllablesInLyrics(get(lyricLinesAtom), options);
		if (result.changed) {
			// One history entry for the full operation; removed word IDs cannot stay selected.
			set(lyricLinesAtom, result.lyric);
			set(selectedWordsAtom, new Set());
			set(editingWordStateAtom, { wordIndex: -1, lineIndex: -1, word: "" });
		}
		return result;
	},
);
