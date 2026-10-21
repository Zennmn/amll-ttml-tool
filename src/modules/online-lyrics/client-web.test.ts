import assert from "node:assert/strict";
import { after, test } from "node:test";
import {
	discoverAvailableProviders,
	fetchProviderLyrics,
	searchProvider,
	supportsProvider,
} from "./client";
import type { OnlineTrack } from "./types";

const originalFetch = globalThis.fetch;
Object.defineProperty(globalThis, "window", {
	value: globalThis,
	configurable: true,
});
Object.defineProperty(globalThis, "isTauri", {
	value: false,
	configurable: true,
});
after(() => {
	globalThis.fetch = originalFetch;
});

const track: OnlineTrack = {
	provider: "kugou",
	id: "local-track",
	title: "Song",
	artists: ["Artist"],
	album: "Album",
	durationMs: 180000,
	hash: "abc123",
};
const health = {
	service: "amll-lyrics-service",
	protocolVersion: 1,
	providers: ["netease", "qq", "kugou", "lrclib"],
};
const json = (value: unknown, status = 200) =>
	new Response(JSON.stringify(value), {
		status,
		headers: { "Content-Type": "application/json" },
	});

test("a verified local service enables browser sources and carries lyric candidates over HTTP", async () => {
	const requests: { path: string; init?: RequestInit }[] = [];
	globalThis.fetch = async (input, init) => {
		const path = String(input);
		requests.push({ path, init });
		if (path.endsWith("/health")) return json(health);
		if (path.endsWith("/search"))
			return json({ tracks: [track], hasMore: true, page: 2 });
		return json({
			original: { format: "krc", content: "[1000,1000]<0,1000,0>Hello" },
		});
	};
	assert.deepEqual(await discoverAvailableProviders(), health.providers);
	assert.equal(supportsProvider("qq"), true);
	const result = await searchProvider("kugou", "Song", 2);
	assert.equal(result.tracks[0].hash, "abc123");
	assert.equal(result.hasMore, true);
	const candidate = { id: "version2", accessKey: "key", label: "Version 2" };
	const lyrics = await fetchProviderLyrics(track, candidate);
	assert.equal(lyrics.original.format, "krc");
	assert.deepEqual(JSON.parse(String(requests[1].init?.body)), {
		provider: "kugou",
		query: "Song",
		page: 2,
	});
	assert.deepEqual(JSON.parse(String(requests[2].init?.body)), {
		track,
		candidate,
	});
	assert.equal(requests[2].init?.method, "POST");
	assert.equal(
		requests.every((request) => request.path.startsWith("/api/online-lyrics/")),
		true,
	);
});

test("HTTP provider failures remain recoverable while successful sources validate their payloads", async () => {
	globalThis.fetch = async (input, init) => {
		if (String(input).endsWith("/health")) return json(health);
		const args = JSON.parse(String(init?.body));
		return args.provider === "qq"
			? json({ error: "QQ Music API error: 2001" }, 502)
			: json({
					tracks: [{ ...track, provider: "netease", artists: null }],
					hasMore: false,
				});
	};
	await discoverAvailableProviders();
	await assert.rejects(searchProvider("qq", "Song"), /2001/);
	await assert.rejects(
		searchProvider("netease", "Song"),
		/Invalid lyric service track/,
	);
	globalThis.fetch = async () =>
		json({ tracks: [{ ...track, provider: "netease" }], hasMore: false });
	assert.equal((await searchProvider("netease", "Song")).tracks.length, 1);
});

test("local LRCLIB requests use the same-origin service instead of direct browser networking", async () => {
	const paths: string[] = [];
	globalThis.fetch = async (input) => {
		const path = String(input);
		paths.push(path);
		if (path.endsWith("/health")) return json(health);
		if (path.endsWith("/search"))
			return json({
				tracks: [{ ...track, provider: "lrclib", id: "42" }],
				hasMore: false,
			});
		return json({ original: { format: "lrc", content: "[00:01]Hello" } });
	};
	await discoverAvailableProviders();
	const result = await searchProvider("lrclib", "Song");
	await fetchProviderLyrics(result.tracks[0]);
	assert.deepEqual(paths, [
		"/api/online-lyrics/health",
		"/api/online-lyrics/search",
		"/api/online-lyrics/fetch",
	]);
});

test("an absent or unrelated service preserves the static website's LRCLIB fallback", async () => {
	for (const response of [
		new Response("Not found", { status: 404 }),
		json({
			service: "different-app",
			protocolVersion: 1,
			providers: health.providers,
		}),
	]) {
		globalThis.fetch = async () => response;
		assert.deepEqual(await discoverAvailableProviders(), ["lrclib"]);
		assert.equal(supportsProvider("qq"), false);
	}
	globalThis.fetch = async () => {
		throw new TypeError("Failed to fetch");
	};
	assert.deepEqual(await discoverAvailableProviders(), ["lrclib"]);
	await assert.rejects(searchProvider("qq", "Song"), /local lyric service/);
});

test("cancelled service discovery does not change available sources", async () => {
	globalThis.fetch = async () => json(health);
	await discoverAvailableProviders();
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(discoverAvailableProviders(controller.signal));
	assert.equal(supportsProvider("qq"), true);
});
