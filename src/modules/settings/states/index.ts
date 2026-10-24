import { atom } from "jotai";
import { atomWithStorage } from "jotai/utils";
import type { SyncPronunciationMode } from "$/modules/lyric-editor/utils/sync-pronunciation.ts";
import type { TtmlTimingMode } from "$/modules/ttml-processor/export-options";

export enum SyncJudgeMode {
	FirstKeyDownTime = "first-keydown-time",
	FirstKeyDownTimeLegacy = "first-keydown-time-legacy",
	LastKeyUpTime = "last-keyup-time",
	MiddleKeyTime = "middle-key-time",
}

export enum LayoutMode {
	Simple = "simple",
	Advance = "advance",
}

export enum TranslationOutputMode {
	/** Apple Music 样式：逐行翻译/音译写入 `<head>` 的 `<iTunesMetadata>` 中 */
	AppleMusic = "apple-music",
	/** AMLL 样式：逐行翻译/音译写入为内嵌的 `x-translation` / `x-roman` */
	Amll = "amll",
}

export const latencyTestBPMAtom = atomWithStorage("latencyTestBPM", 120);

export const syncJudgeModeAtom = atomWithStorage(
	"syncJudgeMode",
	SyncJudgeMode.FirstKeyDownTime,
);

export const layoutModeAtom = atomWithStorage("layoutMode", LayoutMode.Simple);

export const translationOutputModeAtom = atomWithStorage(
	"translationOutputMode",
	TranslationOutputMode.AppleMusic,
);

export const ttmlTimingModeAtom = atomWithStorage<TtmlTimingMode>(
	"ttmlTimingMode",
	"auto",
	undefined,
	{ getOnInit: true },
);

export const ttmlLanguageAtom = atomWithStorage("ttmlLanguage", "", undefined, {
	getOnInit: true,
});

export const showWordRomanizationInputAtom = atomWithStorage(
	"showWordRomanizationInput",
	false,
);

export const displayRomanizationInSyncAtom = atomWithStorage(
	"displayRomanizationInSync",
	false,
	undefined,
	{ getOnInit: true },
);

const syncPronunciationModeStorageAtom =
	atomWithStorage<SyncPronunciationMode | null>(
		"syncPronunciationMode",
		null,
		undefined,
		{ getOnInit: true },
	);

const syncPronunciationModes: ReadonlySet<string> = new Set([
	"off",
	"original-primary",
	"romanization-primary",
]);

function isSyncPronunciationMode(
	value: unknown,
): value is SyncPronunciationMode {
	return typeof value === "string" && syncPronunciationModes.has(value);
}

export const syncPronunciationModeAtom = atom(
	(get): SyncPronunciationMode => {
		const storedMode = get(syncPronunciationModeStorageAtom);
		if (isSyncPronunciationMode(storedMode)) return storedMode;

		return get(displayRomanizationInSyncAtom) === true
			? "romanization-primary"
			: "original-primary";
	},
	(_get, set, mode: SyncPronunciationMode) => {
		set(syncPronunciationModeStorageAtom, mode);
		set(displayRomanizationInSyncAtom, mode === "romanization-primary");
	},
);

export const showLineTranslationAtom = atomWithStorage(
	"showLineTranslation",
	true,
);

export const showLineRomanizationAtom = atomWithStorage(
	"showLineRomanization",
	true,
);

export const hideSubmitAMLLDBWarningAtom = atomWithStorage(
	"hideSubmitAMLLDBWarning",
	false,
);
export const generateNameFromMetadataAtom = atomWithStorage(
	"generateNameFromMetadata",
	true,
);

export const autosaveEnabledAtom = atomWithStorage("autosaveEnabled", true);
export const autosaveIntervalAtom = atomWithStorage("autosaveInterval", 10);
export const autosaveLimitAtom = atomWithStorage("autosaveLimit", 10);

export const defaultTtmlAuthorGithubAtom = atomWithStorage(
	"defaultTtmlAuthorGithub",
	"",
);

export const defaultTtmlAuthorGithubLoginAtom = atomWithStorage(
	"defaultTtmlAuthorGithubLogin",
	"",
);

export const showTimestampsAtom = atomWithStorage("showTimestamps", true);

export const highlightActiveWordAtom = atomWithStorage(
	"highlightActiveWord",
	true,
);

export const highlightErrorsAtom = atomWithStorage("highlightErrors", false);

export const smartFirstWordAtom = atomWithStorage("smartFirstWord", false);
export const smartLastWordAtom = atomWithStorage("smartLastWord", false);

export const enableAutoRomanizationPredictionAtom = atomWithStorage(
	"enableAutoRomanizationPrediction",
	false,
);

export { stretchAlgorithmAtom } from "$/modules/audio/states";
export type { StretchAlgorithm } from "$/modules/ffmpeg/types.ts";
