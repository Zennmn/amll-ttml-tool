import { atom } from "jotai";
import { editingWordStateAtom, lyricLinesAtom } from "$/states/main";
import { formatTimeline, type TimelineFormatOptions } from "./format-timeline";

export const formatTimelineAtom = atom(
	null,
	(get, set, options: TimelineFormatOptions) => {
		const result = formatTimeline(get(lyricLinesAtom), options);
		if (result.changed) {
			set(lyricLinesAtom, result.lyric);
			if (result.reorderedLines > 0)
				set(editingWordStateAtom, { lineIndex: -1, wordIndex: -1, word: "" });
		}
		return result;
	},
);
