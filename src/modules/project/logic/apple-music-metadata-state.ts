import { atom } from "jotai";
import { lyricLinesAtom, projectIdAtom } from "$/states/main";
import {
	type AppleMusicMetadataField,
	type AppleMusicMetadataPreview,
	mergeAppleMusicMetadata,
} from "./apple-music-metadata";

export const importAppleMusicMetadataAtom = atom(
	null,
	(
		get,
		set,
		request: {
			projectId: string;
			preview: AppleMusicMetadataPreview;
			fields: AppleMusicMetadataField[];
		},
	) => {
		if (get(projectIdAtom) !== request.projectId) return "staleProject";
		const current = get(lyricLinesAtom);
		const metadata = mergeAppleMusicMetadata(
			current.metadata,
			request.preview,
			request.fields,
		);
		if (metadata === current.metadata) return "unchanged";
		set(lyricLinesAtom, { ...current, metadata });
		return "changed";
	},
);
