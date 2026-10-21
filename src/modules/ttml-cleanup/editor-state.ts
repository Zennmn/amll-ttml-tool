import { atom } from "jotai";
import {
	editingWordStateAtom,
	lyricLinesAtom,
	selectedLinesAtom,
	selectedWordsAtom,
} from "$/states/main";
import type { CleanupOptions } from "./cleanup";
import { cleanupEditorLyrics } from "./editor-cleanup";
import { fillMissingTranslations } from "./fill-translations";

export const applyTtmlCleanupAtom = atom(
	null,
	(get, set, options: CleanupOptions) => {
		const result = cleanupEditorLyrics(get(lyricLinesAtom), options);
		if (result.changed) {
			// One document update gives the complete cleanup a single undo step.
			set(lyricLinesAtom, result.lyric);
			set(selectedLinesAtom, new Set());
			set(selectedWordsAtom, new Set());
			set(editingWordStateAtom, { wordIndex: -1, lineIndex: -1, word: "" });
		}
		return result;
	},
);

export const fillMissingTranslationsAtom = atom(null, (get, set) => {
	const result = fillMissingTranslations(get(lyricLinesAtom));
	if (result.changed) {
		// All lines are filled in one undo step; IDs and selections stay valid.
		set(lyricLinesAtom, result.lyric);
	}
	return result;
});
