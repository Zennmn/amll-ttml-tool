import assert from "node:assert/strict";
import test from "node:test";
import { createDesktopSettingsStorage } from "./desktop-settings-persistence";

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

function createStorage<T>(saved: Map<string, T>, legacy = new Map<string, T>()) {
	return createDesktopSettingsStorage<T>(
		{
			readNative: async (key) => {
				const value = saved.get(key);
				return value === undefined && !saved.has(key) ? null : { value: value as T };
			},
			writeNative: async (key, value) => {
				saved.set(key, value);
			},
			readLegacy: (key) => legacy.get(key),
			removeLegacy: (key) => legacy.delete(key),
			reportError: (operation, error) => assert.fail(`${operation}: ${error}`),
		},
		"" as T,
	);
}

test("native settings survive a new store instance and stay isolated by key", async () => {
	const saved = new Map<string, string>();
	const first = createStorage(saved);
	first.setItem("defaultTtmlAuthorGithub", "1111111");
	first.setItem("defaultTtmlAuthorGithubLogin", "zen");
	await settle();

	const reopened = createStorage(saved);
	let id = "";
	let login = "";
	const stopId = reopened.subscribe("defaultTtmlAuthorGithub", (value) => {
		id = value;
	});
	const stopLogin = reopened.subscribe("defaultTtmlAuthorGithubLogin", (value) => {
		login = value;
	});
	await settle();
	assert.equal(id, "1111111");
	assert.equal(login, "zen");
	stopId();
	stopLogin();
});

test("legacy values migrate once and native values take precedence", async () => {
	const saved = new Map<string, number>();
	const legacy = new Map([["sidebarWidth", 420]]);
	const first = createStorage(saved, legacy);
	assert.equal(first.getItem("sidebarWidth", 300), 420);
	const stop = first.subscribe("sidebarWidth", () => {});
	await settle();
	assert.equal(saved.get("sidebarWidth"), 420);
	stop();

	legacy.set("sidebarWidth", 200);
	const reopened = createStorage(saved, legacy);
	let width = 0;
	const stopReopened = reopened.subscribe("sidebarWidth", (value) => {
		width = value;
	});
	await settle();
	assert.equal(width, 420);
	stopReopened();
});

test("a delayed native read does not overwrite a newer selection", async () => {
	let finishRead: (value: { value: boolean } | null) => void = () => {};
	const saved: boolean[] = [];
	const storage = createDesktopSettingsStorage<boolean>(
		{
			readNative: () => new Promise((resolve) => (finishRead = resolve)),
			writeNative: async (_key, value) => saved.push(value),
			readLegacy: () => undefined,
			removeLegacy: () => {},
			reportError: (operation, error) => assert.fail(`${operation}: ${error}`),
		},
		false,
	);
	const stop = storage.subscribe("showTranslationLines", () => {});
	await settle();
	storage.setItem("showTranslationLines", true);
	finishRead({ value: false });
	await settle();
	assert.deepEqual(saved, [true]);
	stop();
});

test("explicit null is restored without being mistaken for a missing file", async () => {
	const saved = new Map<string, null>([["syncPronunciationMode", null]]);
	const storage = createStorage(saved);
	let value: null | "unexpected" = "unexpected";
	const stop = storage.subscribe("syncPronunciationMode", (next) => {
		value = next;
	});
	await settle();
	assert.equal(value, null);
	stop();
});
