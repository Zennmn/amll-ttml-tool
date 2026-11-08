import assert from "node:assert/strict";
import test from "node:test";
import { createStore } from "jotai";
import { atomWithStorage } from "jotai/utils";
import { createDesktopPreviewStorage } from "./preview-persistence";

const key = "showTranslationLines";
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

function openPreview(
	readNative: () => Promise<unknown>,
	writeNative: (value: boolean) => Promise<void>,
	readLegacy: () => unknown = () => undefined,
) {
	const setting = atomWithStorage(
		key,
		false,
		createDesktopPreviewStorage<boolean>(false, {
			readNative,
			writeNative,
			readLegacy,
			writeLegacy: () => {
				throw new Error("WebView storage is unavailable");
			},
			removeLegacy: () => {},
			reportError: (operation, error) => assert.fail(`${operation}: ${error}`),
		}),
	);
	const store = createStore();
	const close = store.sub(setting, () => {});
	return {
		value: () => store.get(setting),
		set: (value: boolean) => store.set(setting, value),
		close,
	};
}

test("desktop preview restores the last choice when WebView storage loses it", async () => {
	let saved: boolean | null = null;
	const read = async () => saved;
	const write = async (value: boolean) => {
		saved = value;
	};

	const first = openPreview(read, write);
	first.set(true);
	await settle();
	first.close();

	const reopened = openPreview(read, write);
	await settle();
	assert.equal(reopened.value(), true);
	reopened.close();
});

test("a native read in flight cannot undo a new choice", async () => {
	let finishRead: (value: boolean) => void = () => {};
	const read = new Promise<boolean>((resolve) => {
		finishRead = resolve;
	});
	const saved: boolean[] = [];
	const preview = openPreview(
		() => read,
		async (value) => {
			saved.push(value);
		},
	);
	await settle();
	preview.set(true);
	finishRead(false);
	await settle();

	assert.equal(preview.value(), true);
	assert.deepEqual(saved, [true]);
	preview.close();
});

test("desktop preview migrates an existing choice only if the native file is missing", async () => {
	let saved: boolean | null = null;
	const read = async () => saved;
	const write = async (value: boolean) => {
		saved = value;
	};
	const first = openPreview(read, write, () => true);
	await settle();
	assert.equal(saved, true);
	first.close();

	const reopened = openPreview(read, write, () => false);
	await settle();
	assert.equal(reopened.value(), true);
	assert.equal(saved, true);
	reopened.close();
});

test("the most recent click wins even if an earlier write takes longer", async () => {
	let finishFirstWrite: () => void = () => {};
	const firstWrite = new Promise<void>((resolve) => {
		finishFirstWrite = resolve;
	});
	let saved: boolean | null = null;
	const read = async () => saved;
	const write = async (value: boolean) => {
		if (value) await firstWrite;
		saved = value;
	};
	const first = openPreview(read, write);
	first.set(true);
	first.set(false);
	finishFirstWrite();
	await settle();
	first.close();

	const reopened = openPreview(read, write, () => true);
	await settle();
	assert.equal(saved, false);
	assert.equal(reopened.value(), false);
	reopened.close();
});
