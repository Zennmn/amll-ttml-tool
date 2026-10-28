import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { RepositorySources } from "./repository-sources";

const signal = () => new AbortController().signal;
const json = (value: unknown) => new Response(JSON.stringify(value));
const amEntry = (id: number, extra: Record<string, unknown> = {}) => ({
	appleMusicId: id,
	artist: "MIREI",
	title: `Song ${id}`,
	path: `am-lyrics/MIREI - Song ${id} - ${id}.ttml`,
	enabled: true,
	...extra,
});
const amIndex = (...entries: unknown[]) => ({ version: 1, entries });
const amllRow = (filename: string, metadata: [string, string[]][]) =>
	JSON.stringify({ rawLyricFile: filename, metadata });

test("am-lyrics searches title/artist case-insensitively and matches regional IDs exactly", async () => {
	const requests: string[] = [];
	const source = new RepositorySources(async (url) => {
		requests.push(String(url));
		return json(
			amIndex(
				amEntry(100, {
					title: "Ｗａｋｅ Atte (Live)",
					alternateIds: [200, "300", "../bad"],
				}),
				amEntry(1000),
			),
		);
	});
	const results = await source.search(
		"am-lyrics",
		"mirei wake-atte",
		1,
		signal(),
	);
	assert.equal(results.tracks.length, 1);
	assert.deepEqual(results.tracks[0].platformIds, {
		appleMusicId: ["100", "200", "300"],
	});
	assert.equal(
		(await source.search("am-lyrics", "200", 1, signal())).tracks[0].id,
		"100",
	);
	assert.equal(
		(await source.search("am-lyrics", "10", 1, signal())).tracks.length,
		0,
	);
	assert.equal(requests.length, 1);
});

test("disabled, oversized and unsafe index records are excluded before search", async () => {
	const source = new RepositorySources(async () =>
		json(
			amIndex(
				amEntry(1),
				amEntry(2, { enabled: false }),
				amEntry(3, { path: "am-lyrics/../bad.ttml" }),
				amEntry(4, { path: "https://example.com/bad.ttml" }),
				amEntry(5, { path: "am-lyrics/a\\b.ttml" }),
				amEntry(6, { sizeBytes: 2 * 1024 * 1024 + 1 }),
				amEntry(7, { appleMusicId: 1.5 }),
			),
		),
	);
	assert.deepEqual(
		(await source.search("am-lyrics", "MIREI", 1, signal())).tracks.map(
			(track) => track.id,
		),
		["1"],
	);
});

test("pagination, duplicate IDs and cached results are stable and independent", async () => {
	let time = 0;
	let calls = 0;
	const source = new RepositorySources(
		async () => {
			calls++;
			return json(
				amIndex(
					...Array.from({ length: 25 }, (_, index) => amEntry(index + 1)),
					amEntry(1),
				),
			);
		},
		() => time,
	);
	const first = await source.search("am-lyrics", "MIREI", 1, signal());
	assert.equal(first.tracks.length, 20);
	assert.equal(first.hasMore, true);
	first.tracks[0].title = "modified";
	first.tracks[0].platformIds?.appleMusicId?.push("999");
	const second = await source.search("am-lyrics", "MIREI", 2, signal());
	assert.equal(second.tracks.length, 5);
	assert.equal(second.hasMore, false);
	assert.equal(
		(await source.search("am-lyrics", "1", 1, signal())).tracks[0].title,
		"Song 1",
	);
	assert.equal(
		(await source.search("am-lyrics", "999", 1, signal())).tracks.length,
		0,
	);
	assert.equal(calls, 1);
	time = 15 * 60 * 1000 + 1;
	await source.search("am-lyrics", "MIREI", 1, signal());
	assert.equal(calls, 2);
	await assert.rejects(
		source.search("am-lyrics", "MIREI", 0, signal()),
		/Invalid page/,
	);
});

test("TTML retrieval uses the canonical encoded index path and verifies bytes and SHA256", async () => {
	const content = "<tt>日本語</tt>";
	const requests: { url: string; init?: RequestInit }[] = [];
	const source = new RepositorySources(async (url, init) => {
		requests.push({ url: String(url), init });
		return String(url).endsWith("index.json")
			? json(
					amIndex(
						amEntry(1, {
							path: "am-lyrics/日本語 # ? %.ttml",
							sizeBytes: Buffer.byteLength(content),
							sha256: createHash("sha256").update(content).digest("hex"),
						}),
					),
				)
			: new Response(content);
	});
	const [track] = (await source.search("am-lyrics", "MIREI", 1, signal()))
		.tracks;
	const lyrics = await source.fetchLyrics(
		{ ...track, title: "ignored" },
		signal(),
	);
	assert.deepEqual(lyrics, { original: { format: "ttml", content } });
	assert.equal(
		requests[1].url,
		"https://raw.githubusercontent.com/Zennmn/am-lyrics/main/am-lyrics/%E6%97%A5%E6%9C%AC%E8%AA%9E%20%23%20%3F%20%25.ttml",
	);
	assert.equal(requests[1].init?.credentials, "omit");
	assert.equal(requests[1].init?.signal?.aborted, false);
	await assert.rejects(
		source.fetchLyrics({ ...track, id: "https://example.com" }, signal()),
		/no longer exists/,
	);
	assert.equal(requests.length, 2);
});

test("corrupt repository files reject before returning importable data", async () => {
	for (const extra of [{ sizeBytes: 100 }, { sha256: "0".repeat(64) }]) {
		const source = new RepositorySources(async (url) =>
			String(url).endsWith("index.json")
				? json(amIndex(amEntry(1, extra)))
				: new Response("<tt/>"),
		);
		const [track] = (await source.search("am-lyrics", "MIREI", 1, signal()))
			.tracks;
		await assert.rejects(source.fetchLyrics(track, signal()), /does not match/);
	}
});

test("failed or cancelled index requests do not poison retries", async () => {
	let calls = 0;
	const source = new RepositorySources(async (_url, init) => {
		calls++;
		if (calls <= 2) throw new TypeError("Offline");
		if (calls <= 4) return json({ wrong: [] });
		init?.signal?.throwIfAborted();
		return json(amIndex(amEntry(1)));
	});
	await assert.rejects(
		source.search("am-lyrics", "MIREI", 1, signal()),
		/Offline/,
	);
	await assert.rejects(
		source.search("am-lyrics", "MIREI", 1, signal()),
		/Invalid am-lyrics index/,
	);
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(
		source.search("am-lyrics", "MIREI", 1, controller.signal),
		{ name: "AbortError" },
	);
	assert.equal(calls, 4);
	assert.equal(
		(await source.search("am-lyrics", "MIREI", 1, signal())).tracks.length,
		1,
	);
});

test("streaming and declared response limits reject large payloads", async () => {
	const source = new RepositorySources(
		async () =>
			new Response("{}", {
				headers: { "Content-Length": String(33 * 1024 * 1024) },
			}),
	);
	await assert.rejects(
		source.search("am-lyrics", "MIREI", 1, signal()),
		/too large/,
	);
	const streaming = new RepositorySources(async (url) =>
		String(url).endsWith("index.json")
			? json(amIndex(amEntry(1)))
			: new Response(new Uint8Array(2 * 1024 * 1024 + 1)),
	);
	const [track] = (await streaming.search("am-lyrics", "MIREI", 1, signal()))
		.tracks;
	await assert.rejects(streaming.fetchLyrics(track, signal()), /too large/);
});

test("network fallback keeps file downloads on the working mirror and cancellation stops fallback", async () => {
	const paths: string[] = [];
	const source = new RepositorySources(async (url) => {
		paths.push(String(url));
		if (String(url).startsWith("https://raw.githubusercontent.com/"))
			throw new TypeError("DNS failed");
		return String(url).endsWith("index.json")
			? json(amIndex(amEntry(1)))
			: new Response("<tt/>");
	});
	const [track] = (await source.search("am-lyrics", "MIREI", 1, signal()))
		.tracks;
	await source.fetchLyrics(track, signal());
	assert.equal(paths.length, 3);
	assert.ok(paths[1].startsWith("https://cdn.jsdelivr.net/"));
	assert.ok(paths[2].startsWith("https://cdn.jsdelivr.net/"));
	const controller = new AbortController();
	let cancelledCalls = 0;
	const cancelled = new RepositorySources(async () => {
		cancelledCalls++;
		controller.abort();
		throw new DOMException("Cancelled", "AbortError");
	});
	await assert.rejects(
		cancelled.search("am-lyrics", "MIREI", 1, controller.signal),
		{ name: "AbortError" },
	);
	assert.equal(cancelledCalls, 1);
});

test("AMLL JSONL searches aliases and every platform ID while preferring current revisions", async () => {
	const oldFile = "1700000000000-123-oldhash.ttml";
	const currentFile = "1766419644119-207428447,45750526-ehjthdko.ttml";
	const paths: string[] = [];
	const index = [
		amllRow(oldFile, [
			["musicName", ["Old title"]],
			["artists", ["Artist"]],
			["ncmMusicId", ["100", "200"]],
		]),
		amllRow(currentFile, [
			["musicName", ["祝福", "The Blessing"]],
			["artists", ["YOASOBI"]],
			["album", ["THE BOOK 3"]],
			["ncmMusicId", ["100"]],
			["appleMusicId", ["1645308331"]],
			["qqMusicId", ["001KEjQl07j8DG"]],
			["spotifyId", ["7ajpbW6tBpqUI9foCtwlLw"]],
		]),
		"{bad JSON}",
		amllRow("../unsafe.ttml", [
			["musicName", ["Bad"]],
			["ncmMusicId", ["100"]],
		]),
		amllRow("1766419644119-123-missingfields.ttml", [["ncmMusicId", ["300"]]]),
	].join("\r\n");
	const source = new RepositorySources(async (url) => {
		paths.push(String(url));
		return new Response(String(url).endsWith(".jsonl") ? index : "<tt/>");
	});
	assert.equal(
		(await source.search("amll-ttml-db", "yoasobi blessing", 1, signal()))
			.tracks[0].id,
		currentFile,
	);
	assert.equal(
		(await source.search("amll-ttml-db", "100", 1, signal())).tracks[0].id,
		currentFile,
	);
	assert.equal(
		(await source.search("amll-ttml-db", "200", 1, signal())).tracks[0].id,
		oldFile,
	);
	for (const id of ["1645308331", "001KEjQl07j8DG", "7ajpbW6tBpqUI9foCtwlLw"])
		assert.equal(
			(await source.search("amll-ttml-db", id, 1, signal())).tracks[0].id,
			currentFile,
		);
	assert.equal(
		(await source.search("amll-ttml-db", "300", 1, signal())).tracks.length,
		1,
	);
	const [track] = (await source.search("amll-ttml-db", "100", 1, signal()))
		.tracks;
	await source.fetchLyrics(track, signal());
	assert.deepEqual(paths, [
		"https://raw.githubusercontent.com/amll-dev/amll-ttml-db/main/metadata/raw-lyrics-index.jsonl",
		`https://raw.githubusercontent.com/amll-dev/amll-ttml-db/main/raw-lyrics/${encodeURIComponent(currentFile)}`,
	]);
});

test("AMLL rejects an unrelated index response and does not confuse source caches", async () => {
	const source = new RepositorySources(async (url) =>
		String(url).endsWith(".jsonl")
			? new Response("<html>unavailable</html>")
			: json(amIndex(amEntry(1))),
	);
	await assert.rejects(
		source.search("amll-ttml-db", "Song", 1, signal()),
		/Invalid AMLL/,
	);
	assert.equal(
		(await source.search("am-lyrics", "Song", 1, signal())).tracks.length,
		1,
	);
});

test("an empty or malformed successful index response falls back before caching", async () => {
	const valid = amllRow("1760000000000-123-currentfile.ttml", [
		["musicName", ["Song"]],
		["artists", ["Artist"]],
		["ncmMusicId", ["100"]],
	]);
	for (const invalid of ["", " \r\n\t", "<html>proxy error</html>"]) {
		const paths: string[] = [];
		const source = new RepositorySources(async (url) => {
			paths.push(String(url));
			return new Response(
				String(url).startsWith("https://raw.githubusercontent.com/")
					? invalid
					: valid,
			);
		});
		assert.equal(
			(await source.search("amll-ttml-db", "Song", 1, signal())).tracks.length,
			1,
		);
		assert.equal(
			(await source.search("amll-ttml-db", "100", 1, signal())).tracks.length,
			1,
		);
		assert.equal(paths.length, 2);
		assert.ok(paths[1].startsWith("https://cdn.jsdelivr.net/"));
	}
});

test("empty responses from both mirrors reject without poisoning the next retry", async () => {
	let calls = 0;
	const source = new RepositorySources(async () => {
		calls++;
		return new Response(
			calls <= 2
				? ""
				: amllRow("1760000000000-123-currentfile.ttml", [
						["musicName", ["Song"]],
						["artists", ["Artist"]],
						["ncmMusicId", ["100"]],
					]),
		);
	});
	await assert.rejects(
		source.search("amll-ttml-db", "Song", 1, signal()),
		/Invalid AMLL/,
	);
	assert.equal(
		(await source.search("amll-ttml-db", "Song", 1, signal())).tracks.length,
		1,
	);
	assert.equal(calls, 3);
});
