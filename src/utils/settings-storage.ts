import { invoke } from "@tauri-apps/api/core";
import { atomWithStorage as jotaiAtomWithStorage } from "jotai/utils";
import { createDesktopSettingsStorage } from "./desktop-settings-persistence";

interface DesktopStorage<T> {
	getItem: (key: string, initialValue: T) => T;
	setItem: (key: string, value: T) => void;
	removeItem: (key: string) => void;
	subscribe: (key: string, callback: (value: T) => void) => () => void;
}

function createDesktopStorage<T>(initialValue: T): DesktopStorage<T> {
	return createDesktopSettingsStorage<T>({
		readNative: (key) =>
			invoke<{ value: T } | null>("setting_storage_read", { key }),
		writeNative: (key, value) =>
			invoke<void>("setting_storage_write", { key, value }),
		readLegacy: (key) => {
			try {
				const raw = window.localStorage.getItem(key);
				return raw === null ? undefined : (JSON.parse(raw) as T);
			} catch {
				return undefined;
			}
		},
		removeLegacy: (key) => window.localStorage.removeItem(key),
		reportError: (operation, error) =>
			console.warn(`Could not ${operation} desktop setting`, error),
	}, initialValue);
}

const isWindowsDesktop = import.meta.env?.TAURI_ENV_PLATFORM === "windows";

/** Use the native settings directory for Windows builds; keep browser storage elsewhere. */
export function atomWithStorage<T>(
	key: string,
	initialValue: T,
	storage?: Parameters<typeof jotaiAtomWithStorage<T>>[2],
	options?: Parameters<typeof jotaiAtomWithStorage<T>>[3],
) {
	if (!isWindowsDesktop || storage) {
		return jotaiAtomWithStorage(key, initialValue, storage, options);
	}
	return jotaiAtomWithStorage(
		key,
		initialValue,
		createDesktopStorage<T>(initialValue),
		options,
	);
}
