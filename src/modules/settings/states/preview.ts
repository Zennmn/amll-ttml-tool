import { invoke } from "@tauri-apps/api/core";
import { atomWithStorage } from "jotai/utils";
import { createDesktopPreviewStorage } from "../preview-persistence";

interface PreviewPreferences {
	showTranslationLines: boolean;
	showRomanLines: boolean;
	hideObsceneWords: boolean;
	lyricWordFadeWidth: number;
}

function previewAtom<K extends keyof PreviewPreferences>(
	key: K,
	initial: PreviewPreferences[K],
) {
	if (import.meta.env?.TAURI_ENV_PLATFORM !== "windows") {
		return atomWithStorage(key, initial);
	}
	return atomWithStorage(
		key,
		initial,
		createDesktopPreviewStorage(initial, {
			readNative: () => invoke("preview_preference_read", { key }),
			writeNative: (value) =>
				invoke<void>("preview_preference_write", { key, value }),
			readLegacy: () => {
				const value = window.localStorage.getItem(key);
				return value === null ? undefined : JSON.parse(value);
			},
			writeLegacy: (value) =>
				window.localStorage.setItem(key, JSON.stringify(value)),
			removeLegacy: () => window.localStorage.removeItem(key),
			reportError: (operation, error) => {
				console.warn(`Could not ${operation} preview preference ${key}`, error);
			},
		}),
	);
}

export const showTranslationLinesAtom = previewAtom(
	"showTranslationLines",
	false,
);
export const showRomanLinesAtom = previewAtom("showRomanLines", false);
export const hideObsceneWordsAtom = previewAtom("hideObsceneWords", false);
export const lyricWordFadeWidthAtom = previewAtom("lyricWordFadeWidth", 0.5);
