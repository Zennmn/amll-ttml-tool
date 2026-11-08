type PreviewValue = boolean | number;

interface PreferenceIO<T extends PreviewValue> {
	readNative: () => Promise<unknown>;
	writeNative: (value: T) => Promise<void>;
	readLegacy: () => unknown;
	writeLegacy: (value: T) => void;
	removeLegacy: () => void;
	reportError: (operation: "read" | "write", error: unknown) => void;
}

/** Keep the atom synchronous while reading and writing the desktop file. */
export function createDesktopPreviewStorage<T extends PreviewValue>(
	initial: T,
	io: PreferenceIO<T>,
) {
	let current: T | undefined;
	let pending: Promise<void> | undefined;

	const valid = (value: unknown): value is T =>
		typeof value === typeof initial &&
		(typeof value !== "number" || Number.isFinite(value));

	const readLegacy = () => {
		try {
			const value = io.readLegacy();
			return valid(value) ? value : undefined;
		} catch {
			return undefined;
		}
	};

	const persist = (value: T) => {
		current = value;
		const write = async () => {
			try {
				await io.writeNative(value);
			} catch (error) {
				io.reportError("write", error);
			}
		};
		const next = pending ? pending.then(write) : write();
		pending = next;
		void next.then(() => {
			if (pending === next) pending = undefined;
		});
	};

	return {
		getItem: () => current ?? readLegacy() ?? initial,
		setItem: (_key: string, value: T) => {
			persist(value);
			try {
				io.writeLegacy(value);
			} catch {
				// The desktop file is independent of the WebView's storage.
			}
		},
		removeItem: () => {
			persist(initial);
			try {
				io.removeLegacy();
			} catch {
				// The desktop reset is still saved.
			}
		},
		subscribe: (_key: string, notify: (value: T) => void) => {
			let active = true;
			if (current === undefined) {
				void Promise.resolve()
					.then(io.readNative)
					.then((value) => {
						// A late read must not replace a choice made in this session.
						if (!active || current !== undefined) return;
						if (valid(value)) {
							current = value;
							notify(value);
						} else if (value === null) {
							const legacy = readLegacy();
							if (legacy !== undefined) {
								persist(legacy);
								notify(legacy);
							}
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
