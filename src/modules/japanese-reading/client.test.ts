import assert from "node:assert/strict";
import test from "node:test";
import { JapaneseReadingClient } from "./client";
import type { JapaneseReadingRequest, JapaneseReadingResponse } from "./types";

class FakeWorker {
	onmessage?: (event: { data: JapaneseReadingResponse }) => void;
	onerror?: () => void;
	requests: JapaneseReadingRequest[] = [];
	terminated = false;
	postMessage(request: JapaneseReadingRequest) {
		this.requests.push(request);
	}
	terminate() {
		this.terminated = true;
	}
	reply(data: JapaneseReadingResponse) {
		this.onmessage?.({ data });
	}
}

function setup(timeoutMs = 1000) {
	const workers: FakeWorker[] = [];
	const client = new JapaneseReadingClient({
		createWorker: () => {
			const worker = new FakeWorker();
			workers.push(worker);
			return worker as unknown as Worker;
		},
		dictionaryPath: "/dictionaries/kuromoji/",
		timeoutMs,
	});
	return { client, workers };
}

test("one lazy worker deduplicates same text and caches independent copies without using word times", async () => {
	const { client, workers } = setup();
	try {
		assert.deepEqual(await client.read(["hello", "world"]), ["", ""]);
		assert.equal(workers.length, 0);
		const first = client.read(["今日", "は"]);
		const second = client.read(["今日", "は"]);
		assert.equal(workers.length, 1);
		assert.equal(workers[0].requests.length, 1);
		assert.equal(client.getStatus().state, "loading");
		workers[0].reply({ type: "ready" });
		workers[0].reply({ id: 1, readings: ["kyou", "wa"] });
		const [left, right] = await Promise.all([first, second]);
		left[0] = "changed";
		assert.deepEqual(right, ["kyou", "wa"]);
		assert.deepEqual(await client.read(["今日", "は"]), ["kyou", "wa"]);
		assert.equal(workers[0].requests.length, 1);
		assert.equal(client.getStatus().state, "ready");
	} finally {
		client.dispose();
	}
});

test("cancelling an obsolete consumer does not cancel another consumer of the same line", async () => {
	const { client, workers } = setup();
	const controller = new AbortController();
	try {
		const old = client.read(["花"], controller.signal);
		const current = client.read(["花"]);
		controller.abort();
		await assert.rejects(old, { name: "AbortError" });
		workers[0].reply({ id: 1, readings: ["hana"] });
		assert.deepEqual(await current, ["hana"]);
		assert.equal(workers[0].terminated, false);
	} finally {
		client.dispose();
	}
});

test("already cancelled requests do not initialize the dictionary", async () => {
	const { client, workers } = setup();
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(client.read(["夢"], controller.signal), {
		name: "AbortError",
	});
	assert.equal(workers.length, 0);
});

test("failure is visible and retry starts a new worker while rejecting stale old responses", async () => {
	const { client, workers } = setup();
	try {
		const failed = client.read(["夢"]);
		workers[0].reply({ id: 1, error: "dictionary missing" });
		await assert.rejects(failed, /failed/);
		assert.equal(client.getStatus().state, "error");
		client.retry();
		assert.equal(workers[0].terminated, true);
		assert.equal(client.getStatus().revision, 1);
		const retry = client.read(["夢"]);
		assert.equal(workers.length, 2);
		workers[0].reply({ id: 2, readings: ["stale"] });
		workers[1].reply({ id: 2, readings: ["yume"] });
		assert.deepEqual(await retry, ["yume"]);
	} finally {
		client.dispose();
	}
});

test("malformed readings and a hung worker reject cleanly without keeping a failed worker alive", async () => {
	const { client, workers } = setup(10);
	try {
		const wrongCount = client.read(["今日", "は"]);
		workers[0].reply({ id: 1, readings: ["wrong"] });
		await assert.rejects(wrongCount, /failed/);
		const hanging = client.read(["明日"]);
		await assert.rejects(hanging, /timed out/);
		assert.equal(workers[0].terminated, true);
		assert.equal(client.getStatus().state, "error");
	} finally {
		client.dispose();
	}
});
