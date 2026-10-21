import assert from "node:assert/strict";
import test from "node:test";
import { parseAudioTrackMetadata } from "../audio/utils/metadata";
import { createAudioSearchContext, rankTracks } from "./audio-context";
import type { OnlineTrack } from "./types";

const metadata = {
	titles: [],
	artists: [],
	albums: [],
	composers: [],
	isrcs: [],
	fileName: "",
};

test("track tags never become titles before valid title tags", () => {
	const parsed = parseAudioTrackMetadata(
		{
			TRACK: "06",
			tracknumber: "06/12",
			TITLE: "West Coast",
			ARTIST: "Imagine Dragons",
		},
		new File([], "misleading file name.m4a"),
	);

	assert.deepEqual(parsed.titles, ["West Coast"]);
	assert.deepEqual(parsed.artists, ["Imagine Dragons"]);
	const context = createAudioSearchContext(parsed, 180000);
	assert.equal(context.title, "West Coast");
	assert.deepEqual(context.artists, ["Imagine Dragons"]);
	assert.equal(context.query, "West Coast Imagine Dragons");
});

test("musicName tags take precedence over misleading filenames", () => {
	const context = createAudioSearchContext(
		parseAudioTrackMetadata(
			{ musicName: "West Coast", artists: "Imagine Dragons" },
			new File([], "06 - unrelated title.m4a"),
		),
		0,
	);
	assert.equal(context.title, "West Coast");
	assert.deepEqual(context.artists, ["Imagine Dragons"]);
	assert.equal(context.query, "West Coast Imagine Dragons");
});

test("missing title uses the complete filename without appending tagged artists", () => {
	const parsed = parseAudioTrackMetadata(
		{ track: "06", artist: "Imagine Dragons" },
		new File([], "06 - West Coast.m4a"),
	);
	assert.deepEqual(parsed.titles, []);
	assert.deepEqual(parsed.artists, ["Imagine Dragons"]);

	const context = createAudioSearchContext(parsed, 0);
	assert.equal(context.title, "06 - West Coast");
	assert.deepEqual(context.artists, ["Imagine Dragons"]);
	assert.equal(context.query, "06 - West Coast");
});

test("untagged filenames remain intact without guessing artist and title", () => {
	const context = createAudioSearchContext(
		{ ...metadata, fileName: "01 - 歌手 - 歌名" },
		180000,
	);
	assert.equal(context.title, "01 - 歌手 - 歌名");
	assert.deepEqual(context.artists, []);
	assert.equal(context.query, "01 - 歌手 - 歌名");
});

test("numeric title tags remain valid while track tags stay excluded", () => {
	const parsed = parseAudioTrackMetadata(
		{ track: "06", TITLE: "6" },
		new File([], "06 - misleading.m4a"),
	);
	assert.deepEqual(parsed.titles, ["6"]);
	assert.equal(createAudioSearchContext(parsed, 0).title, "6");
});

test("track metadata without a title or filename does not start a search", () => {
	const context = createAudioSearchContext(
		parseAudioTrackMetadata({ track: "06", tracknumber: "06/12" }),
		0,
	);
	assert.equal(context.title, "");
	assert.deepEqual(context.artists, []);
	assert.equal(context.query, "");
});

test("numeric-looking filenames and track prefixes remain intact", () => {
	for (const fileName of ["7 Years", "99 Problems"]) {
		const context = createAudioSearchContext({ ...metadata, fileName }, 0);
		assert.equal(context.title, fileName);
		assert.equal(context.query, fileName);
	}
	const prefixed = createAudioSearchContext(
		{ ...metadata, fileName: "01 - Artist - 7 Years" },
		0,
	);
	assert.equal(prefixed.title, "01 - Artist - 7 Years");
	assert.deepEqual(prefixed.artists, []);
	assert.equal(prefixed.query, "01 - Artist - 7 Years");
});

test("ranking prefers matching title, artist and duration but retains other versions", () => {
	const context = createAudioSearchContext(
		{ ...metadata, titles: ["Song"], artists: ["Artist"], albums: ["Album"] },
		180000,
	);
	assert.equal(context.album, "Album");
	assert.equal(context.durationMs, 180000);
	const track: OnlineTrack = {
		provider: "qq",
		id: "1",
		title: "Song",
		artists: ["Artist"],
		album: "",
		durationMs: 180000,
	};
	const live: OnlineTrack = {
		...track,
		id: "2",
		title: "Song (Live)",
		durationMs: 220000,
	};
	assert.deepEqual(
		rankTracks([live, track], context).map((item) => item.id),
		["1", "2"],
	);
});
