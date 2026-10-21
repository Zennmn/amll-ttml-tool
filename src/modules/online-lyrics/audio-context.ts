import type { AudioTrackMetadata } from "../audio/utils/metadata";
import type { AudioSearchContext, OnlineTrack } from "./types";

export function createAudioSearchContext(
	metadata: AudioTrackMetadata,
	durationMs: number,
): AudioSearchContext {
	const taggedTitle =
		metadata.titles.find((value) => value.trim())?.trim() ?? "";
	// The metadata parser already removes the extension. Use the remaining
	// filename verbatim when there is no title tag.
	const title = taggedTitle || metadata.fileName.trim();
	const artists = metadata.artists.map((value) => value.trim()).filter(Boolean);
	return {
		title,
		artists,
		album: metadata.albums[0] ?? "",
		durationMs: Number.isFinite(durationMs) ? Math.max(0, durationMs) : 0,
		query: taggedTitle
			? [taggedTitle, artists.join(" ")].filter(Boolean).join(" ")
			: title,
	};
}

function normalize(value: string): string {
	return value.toLocaleLowerCase().replace(/[\s\p{P}\p{S}]/gu, "");
}

function similarity(a: string, b: string): number {
	const left = normalize(a);
	const right = normalize(b);
	if (!left || !right) return 0;
	if (left === right) return 1;
	if (left.includes(right) || right.includes(left)) return 0.65;
	return 0;
}

export function rankTracks(
	tracks: OnlineTrack[],
	context: AudioSearchContext | null,
): OnlineTrack[] {
	if (!context) return tracks;
	const score = (track: OnlineTrack) => {
		const titleScore = similarity(track.title, context.title) * 6;
		const artistScore =
			Math.max(
				0,
				...track.artists.flatMap((artist) =>
					context.artists.map((expected) => similarity(artist, expected)),
				),
			) * 3;
		const albumScore = similarity(track.album, context.album);
		const durationScore =
			track.durationMs > 0 && context.durationMs > 0
				? Math.max(
						0,
						2 - Math.abs(track.durationMs - context.durationMs) / 2000,
					)
				: 0;
		return titleScore + artistScore + albumScore + durationScore;
	};
	return [...tracks].sort((a, b) => score(b) - score(a));
}
