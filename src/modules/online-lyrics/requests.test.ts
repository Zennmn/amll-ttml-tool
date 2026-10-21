import assert from "node:assert/strict";
import test from "node:test";
import { boundedRequest, searchIndependently } from "./requests";

test("a failing QQ source leaves other provider results available", async () => {
	const received: string[] = [];
	await searchIndependently(
		["qq", "netease", "kugou"],
		async (provider) => {
			if (provider === "qq") throw new Error("invalid response");
			return [provider];
		},
		(provider, outcome) => received.push(`${provider}:${outcome.status}`),
		new AbortController().signal,
	);
	assert.deepEqual(received.sort(), [
		"kugou:success",
		"netease:success",
		"qq:error",
	]);
});

test("a hung native request times out and signals cancellation", async () => {
	let aborted = false;
	await assert.rejects(
		boundedRequest(
			(signal) => {
				signal.addEventListener("abort", () => {
					aborted = true;
				});
				return new Promise<never>(() => {});
			},
			undefined,
			15,
		),
		{ name: "TimeoutError" },
	);
	assert.equal(aborted, true);
});

test("cancelling a search suppresses old provider completions", async () => {
	const controller = new AbortController();
	const received: string[] = [];
	let complete: (value: string) => void = () => {};
	const waiting = searchIndependently(
		["qq"],
		() =>
			new Promise<string>((resolve) => {
				complete = resolve;
			}),
		(provider) => received.push(provider),
		controller.signal,
	);
	controller.abort();
	complete("late result");
	await waiting;
	assert.deepEqual(received, []);
});

test("already-cancelled requests never start the operation", async () => {
	const controller = new AbortController();
	controller.abort();
	let started = false;
	await assert.rejects(
		boundedRequest(async () => {
			started = true;
			return 1;
		}, controller.signal),
		{ name: "AbortError" },
	);
	assert.equal(started, false);
});

test("a late native rejection after cancellation remains handled", async () => {
	const controller = new AbortController();
	let fail: (reason: Error) => void = () => {};
	const pending = boundedRequest(
		() =>
			new Promise<never>((_resolve, reject) => {
				fail = reject;
			}),
		controller.signal,
	);
	await Promise.resolve();
	controller.abort();
	await assert.rejects(pending, { name: "AbortError" });
	fail(new Error("late error"));
	await new Promise((resolve) => setTimeout(resolve, 5));
});
