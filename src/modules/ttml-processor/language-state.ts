import { atom } from "jotai";
import { selectAtom } from "jotai/utils";
import { lyricLinesAtom, projectIdAtom } from "$/states/main";
import {
	getAmllOriginalText,
	getAmllSourceLanguage,
	resolveOriginalLanguage,
} from "./language-options";

const languageSelectionAtom = atom<{
	projectId: string;
	language: string;
} | null>(null);

/** Overrides belong to this project, so the previous song cannot force its language. */
export const ttmlLanguageAtom = atom(
	(get) => {
		const selection = get(languageSelectionAtom);
		return selection?.projectId === get(projectIdAtom)
			? selection.language
			: "auto";
	},
	(get, set, language: string) => {
		set(languageSelectionAtom, { projectId: get(projectIdAtom), language });
	},
);

const originalTextAtom = selectAtom(lyricLinesAtom, getAmllOriginalText);
const sourceLanguageAtom = selectAtom(lyricLinesAtom, getAmllSourceLanguage);

export const resolvedTtmlLanguageAtom = atom((get) =>
	resolveOriginalLanguage(
		get(ttmlLanguageAtom),
		get(originalTextAtom),
		get(sourceLanguageAtom),
	),
);
