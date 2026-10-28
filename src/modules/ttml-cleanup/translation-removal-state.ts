import { atom } from "jotai";
import { lyricLinesAtom } from "$/states/main";
import { removeTranslations } from "./remove-translations";

export const removeTranslationsAtom = atom(
	null,
	(get, set, lineIds: ReadonlySet<string>) => {
		const result = removeTranslations(get(lyricLinesAtom), lineIds);
		if (result.changed) {
			// Remove all selected translations in one document update for one undo step.
			set(lyricLinesAtom, result.lyric);
		}
		return result;
	},
);
