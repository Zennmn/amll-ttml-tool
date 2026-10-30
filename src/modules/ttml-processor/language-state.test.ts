import assert from "node:assert/strict";
import test from "node:test";
import { createStore } from "jotai";
import {
	lyricLinesAtom,
	projectIdAtom,
	undoableLyricLinesAtom,
} from "$/states/main";
import { newLyricLine, newLyricWord } from "$/types/ttml";
import { resolvedTtmlLanguageAtom, ttmlLanguageAtom } from "./language-state";

test("every new project defaults to automatic detection rather than the last song's manual language", () => {
	const store = createStore();
	const unsubscribe = store.sub(resolvedTtmlLanguageAtom, () => {});
	store.set(projectIdAtom, "first-song");
	store.set(lyricLinesAtom, {
		metadata: [],
		lyricLines: [
			{
				...newLyricLine(),
				words: [
					{
						...newLyricWord(),
						word: "今日も君と歩いている。新しい朝を待ちながら、明日について話していた。",
					},
				],
			},
		],
	});
	assert.equal(store.get(ttmlLanguageAtom), "auto");
	assert.equal(store.get(resolvedTtmlLanguageAtom), "ja");
	store.set(ttmlLanguageAtom, "ko");
	assert.equal(store.get(resolvedTtmlLanguageAtom), "ko");
	store.set(projectIdAtom, "second-song");
	store.set(lyricLinesAtom, {
		metadata: [{ key: "language", value: ["ja"] }],
		lyricLines: [
			{
				...newLyricLine(),
				words: [
					{
						...newLyricWord(),
						word: "We are walking through the city together. I can hear your voice and I know that we will find our way home before the evening comes.",
					},
				],
			},
		],
	});
	assert.equal(store.get(ttmlLanguageAtom), "auto");
	assert.equal(store.get(resolvedTtmlLanguageAtom), "en");
	store.set(ttmlLanguageAtom, "");
	assert.equal(store.get(resolvedTtmlLanguageAtom), "ja");
	store.set(ttmlLanguageAtom, "auto");
	assert.equal(store.get(resolvedTtmlLanguageAtom), "en");
	unsubscribe();
});

test("changing language never edits lyric data or makes an undo entry", () => {
	const store = createStore();
	const original = store.get(lyricLinesAtom);
	const unsubscribe = store.sub(undoableLyricLinesAtom, () => {});
	store.set(ttmlLanguageAtom, "pt-BR");
	assert.equal(store.get(resolvedTtmlLanguageAtom), "pt-BR");
	assert.equal(store.get(lyricLinesAtom), original);
	assert.equal(store.get(undoableLyricLinesAtom).canUndo, false);
	store.set(projectIdAtom, "another-project");
	assert.equal(store.get(ttmlLanguageAtom), "auto");
	unsubscribe();
});
