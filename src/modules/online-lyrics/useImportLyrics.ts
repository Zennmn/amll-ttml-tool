import { useStore } from "jotai";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { uid } from "uid";
import { audioEngine } from "$/modules/audio/audio-engine";
import { applyDefaultTtmlAuthorMetadata } from "$/modules/project/logic/default-metadata";
import { getSuggestedTtmlFileName } from "$/modules/project/logic/metadata-filename";
import {
	defaultTtmlAuthorGithubAtom,
	defaultTtmlAuthorGithubLoginAtom,
} from "$/modules/settings/states";
import { confirmDialogAtom } from "$/states/dialogs";
import {
	isDirtyAtom,
	newLyricLinesAtom,
	projectIdAtom,
	saveFileNameAtom,
} from "$/states/main";
import type { TTMLLyric, TTMLMetadata } from "$/types/ttml";

export function useImportLyrics() {
	const store = useStore();
	const { t } = useTranslation();
	return useCallback(
		(data: TTMLLyric, onImported: () => void) => {
			// Prepare completely before showing confirmation or touching the document.
			const prepared = structuredClone(data);
			const metadata = prepared.metadata;
			const addMissing = (key: string, values: string[]) => {
				if (
					values.length &&
					!metadata.some(
						(entry) => entry.key === key && entry.value.some(Boolean),
					)
				) {
					metadata.push({ key, value: [...values] });
				}
			};
			if (audioEngine.musicLoaded) {
				const audio = audioEngine.audioTrackMetadata;
				const extras: TTMLMetadata[] = [
					{ key: "isrc", value: audio.isrcs },
					{ key: "songwriter", value: audio.composers },
				];
				for (const extra of extras) addMissing(extra.key, extra.value);
			}
			applyDefaultTtmlAuthorMetadata(metadata, {
				githubId: store.get(defaultTtmlAuthorGithubAtom),
				githubLogin: store.get(defaultTtmlAuthorGithubLoginAtom),
			});
			const proposedName =
				getSuggestedTtmlFileName(metadata)?.fileName ?? "lyric.ttml";
			const fileName = Array.from(proposedName, (character) =>
				character.charCodeAt(0) < 32 || '\\/:*?"<>|'.includes(character)
					? "_"
					: character,
			).join("");
			const commit = () => {
				store.set(projectIdAtom, uid());
				store.set(newLyricLinesAtom, prepared);
				store.set(saveFileNameAtom, fileName);
				onImported();
			};
			if (store.get(isDirtyAtom)) {
				store.set(confirmDialogAtom, {
					open: true,
					title: t("confirmDialog.importFile.title", "确认导入歌词"),
					description: t(
						"confirmDialog.importFile.description",
						"当前文件有未保存的更改。如果继续，这些更改将会丢失。确定要导入歌词吗？",
					),
					onConfirm: commit,
				});
			} else {
				commit();
			}
		},
		[store, t],
	);
}
