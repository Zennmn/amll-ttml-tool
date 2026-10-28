import assert from "node:assert/strict";
import { test } from "node:test";
import {
	type AppleMusicAudioClient,
	type AudioJob,
	acquireAppleMusicAudio,
	audioBytes,
	canonicalAudioLink,
	createAppleMusicAudioClient,
} from "./client";

const audio = () => {
	const data = new Uint8Array(40);
	data.set([102, 116, 121, 112], 4);
	return data.buffer;
};
const job = (state: AudioJob["state"] = "ready"): AudioJob => ({
	id: "abc-123",
	state,
	fileName: "audio.m4a",
	errorCode: null,
	progress: null,
	bytesReceived: null,
	totalBytes: null,
});
function fake(overrides: Partial<AppleMusicAudioClient> = {}) {
	const calls: string[] = [];
	const client: AppleMusicAudioClient = {
		status: async () => ({
			authenticated: true,
			loginOpen: false,
			runtimeReady: true,
		}),
		login: async () => ({
			authenticated: false,
			loginOpen: true,
			runtimeReady: true,
		}),
		logout: async () => ({
			authenticated: false,
			loginOpen: false,
			runtimeReady: true,
		}),
		start: async () => {
			calls.push("start");
			return job();
		},
		job: async () => job(),
		cancel: async () => {
			calls.push("cancel");
		},
		release: async () => {
			calls.push("release");
		},
		read: async () => {
			calls.push("read");
			return audio();
		},
		...overrides,
	};
	return { client, calls };
}
const link = "https://music.apple.com/tr/song/wake-atte/1555193620";

test("single-song canonical URL validation rejects arbitrary sources and collections", () => {
	assert.equal(
		canonicalAudioLink(link),
		"https://music.apple.com/tr/song/1555193620",
	);
	assert.equal(
		canonicalAudioLink("https://music.apple.com/us/album/a/1?i=2"),
		"https://music.apple.com/us/song/2",
	);
	for (const raw of [
		"http://music.apple.com/tr/song/1",
		"https://evil.com/tr/song/1",
		"https://user@music.apple.com/tr/song/1",
		"https://music.apple.com/tr/album/a/1",
		"https://music.apple.com/tr/song/0",
		"https://music.apple.com/tr/song/9007199254740992",
		"https://music.apple.com/tr/album/a/1?i=2&i=3",
	])
		assert.throws(() => canonicalAudioLink(raw));
});
test("web mode never invokes native commands", async () => {
	const client = createAppleMusicAudioClient(async () => {
		throw new Error("should not invoke");
	}, false);
	await assert.rejects(client.login(), { code: "desktopOnly" });
});
test("webpage login contract exposes booleans only, never Cookie values", async () => {
	const calls: unknown[] = [];
	const client = createAppleMusicAudioClient(
		async <T>(command: string, args?: Record<string, unknown>) => {
			calls.push([command, args]);
			return {
				authenticated: false,
				loginOpen: true,
				runtimeReady: true,
				mediaUserToken: "must-not-escape",
			} as T;
		},
		true,
	);
	assert.deepEqual(await client.login(), {
		authenticated: false,
		loginOpen: true,
		runtimeReady: true,
	});
	assert.deepEqual(calls, [["apple_music_audio_login", undefined]]);
});
test("native binary response is validated and errors hide provider detail", async () => {
	assert.equal(audioBytes(audio()).byteLength, 40);
	assert.equal(audioBytes([...new Uint8Array(audio())]).byteLength, 40);
	assert.throws(
		() => audioBytes(new TextEncoder().encode("<html>login</html>")),
		{ code: "invalidAudio" },
	);
	const client = createAppleMusicAudioClient(async () => {
		throw "private token and server response";
	}, true);
	await assert.rejects(client.status(), { code: "failed", message: "failed" });
});
test("success reads audio then releases the native job and final disk cache", async () => {
	const { client, calls } = fake();
	const file = await acquireAppleMusicAudio(client, link, {
		signal: new AbortController().signal,
		isCurrent: () => true,
		onProgress: () => {},
	});
	assert.equal(file.name, "Apple Music.m4a");
	assert.equal(file.size, 40);
	assert.deepEqual(calls, ["start", "read", "cancel", "release"]);
});
test("cancel while start is unresolved still cancels/releases the late job", async () => {
	let resolveStart: (value: AudioJob) => void = () => {};
	const { client, calls } = fake({
		start: () =>
			new Promise((resolve) => {
				resolveStart = resolve;
			}),
	});
	const controller = new AbortController();
	const promise = acquireAppleMusicAudio(client, link, {
		signal: controller.signal,
		isCurrent: () => true,
		onProgress: () => {},
	});
	controller.abort();
	resolveStart(job("downloading"));
	await assert.rejects(promise, { code: "cancelled" });
	assert.deepEqual(calls, ["cancel", "release"]);
});
test("cancel during polling never reads or loads the audio", async () => {
	const controller = new AbortController();
	const { client, calls } = fake({ start: async () => job("downloading") });
	await assert.rejects(
		acquireAppleMusicAudio(client, link, {
			signal: controller.signal,
			isCurrent: () => true,
			onProgress: () => controller.abort(),
			pollMs: 0,
		}),
		{ code: "cancelled" },
	);
	assert.deepEqual(calls, ["cancel", "release"]);
});
test("switching project or audio during binary read discards the result", async () => {
	let current = true;
	const { client, calls } = fake({
		read: async () => {
			current = false;
			return audio();
		},
	});
	await assert.rejects(
		acquireAppleMusicAudio(client, link, {
			signal: new AbortController().signal,
			isCurrent: () => current,
			onProgress: () => {},
		}),
		{ code: "stale" },
	);
	assert.deepEqual(calls, ["start", "cancel", "release"]);
});
test("provider failure still cleans native state", async () => {
	const { client, calls } = fake({
		start: async () => ({ ...job("error"), errorCode: "subscriptionRequired" }),
	});
	await assert.rejects(
		acquireAppleMusicAudio(client, link, {
			signal: new AbortController().signal,
			isCurrent: () => true,
			onProgress: () => {},
		}),
		{ code: "subscriptionRequired" },
	);
	assert.deepEqual(calls, ["cancel", "release"]);
});
test("mismatched job polling cannot read another download", async () => {
	const { client, calls } = fake({
		start: async () => job("downloading"),
		job: async () => ({ ...job(), id: "def-456" }),
	});
	await assert.rejects(
		acquireAppleMusicAudio(client, link, {
			signal: new AbortController().signal,
			isCurrent: () => true,
			onProgress: () => {},
			pollMs: 0,
		}),
		{ code: "failed" },
	);
	assert.deepEqual(calls, ["cancel", "release"]);
});
