export interface DesktopSettingsIO<T> {
	readNative: (key: string) => Promise<{ value: T } | null>;
	writeNative: (key: string, value: T) => Promise<void>;
	readLegacy: (key: string) => T | undefined;
	removeLegacy: (key: string) => void;
	reportError: (operation: "read" | "write", error: unknown) => void;
}

/** Synchronous Jotai storage facade over an asynchronous native settings file. */
export function createDesktopSettingsStorage<T>(
	io: DesktopSettingsIO<T>,
	initialValue: T,
) {
	const current = new Map<string, T>();
	const initialized = new Set<string>();
	const pending = new Map<string, Promise<void>>();

	const write = (key: string, value: T) => {
		current.set(key, value);
		initialized.add(key);
		const previous = pending.get(key) ?? Promise.resolve();
		const next = previous
			.then(() => io.writeNative(key, value))
			.catch((error) => io.reportError("write", error));
		pending.set(key, next);
		void next.then(() => {
			if (pending.get(key) === next) pending.delete(key);
		});
	};

	return {
		getItem: (key: string, initialValue: T) => {
			const legacy = io.readLegacy(key);
			return legacy === undefined ? initialValue : legacy;
		},
		setItem: (key: string, value: T) => write(key, value),
		removeItem: (key: string) => {
			write(key, initialValue);
			try {
				io.removeLegacy(key);
			} catch {
				// The native reset is independent of WebView storage.
			}
		},
		subscribe: (key: string, callback: (value: T) => void) => {
			let active = true;
			if (!initialized.has(key)) {
				void Promise.resolve()
					.then(() => io.readNative(key))
					.then((stored) => {
						if (!active || initialized.has(key)) return;
						if (stored !== null) {
							current.set(key, stored.value);
							initialized.add(key);
							callback(stored.value);
							return;
						}
						const legacy = io.readLegacy(key);
						if (legacy !== undefined) {
							write(key, legacy);
							callback(legacy);
						}
					})
					.catch((error) => io.reportError("read", error));
			}
			return () => {
				active = false;
			};
		},
	};
}
