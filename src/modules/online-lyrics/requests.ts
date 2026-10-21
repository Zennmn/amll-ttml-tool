/** Reject promptly even when a native command cannot cancel its underlying task. */
export function boundedRequest<T>(
	operation: (signal: AbortSignal) => Promise<T>,
	signal?: AbortSignal,
	timeoutMs = 25_000,
): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const controller = new AbortController();
		let settled = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const finish = (callback: () => void) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal?.removeEventListener("abort", abort);
			callback();
		};
		const abort = () => {
			controller.abort();
			finish(() => reject(new DOMException("Request cancelled", "AbortError")));
		};
		if (signal?.aborted) {
			abort();
			return;
		}
		signal?.addEventListener("abort", abort, { once: true });
		timer = setTimeout(() => {
			controller.abort();
			finish(() =>
				reject(new DOMException("Request timed out", "TimeoutError")),
			);
		}, timeoutMs);
		Promise.resolve()
			.then(() => {
				if (controller.signal.aborted) throw controller.signal.reason;
				return operation(controller.signal);
			})
			.then(
				(value) => finish(() => resolve(value)),
				(error: unknown) => finish(() => reject(error)),
			);
	});
}

export function isCancellation(error: unknown): boolean {
	return error instanceof Error && error.name === "AbortError";
}

export type RequestOutcome<T> =
	| { status: "success"; data: T }
	| { status: "error"; error: unknown };

/** Each provider reports independently; one failure never rejects the group. */
export async function searchIndependently<K extends string, T>(
	providers: readonly K[],
	search: (provider: K) => Promise<T>,
	onResult: (provider: K, result: RequestOutcome<T>) => void,
	signal: AbortSignal,
): Promise<void> {
	await Promise.allSettled(
		providers.map(async (provider) => {
			try {
				const data = await search(provider);
				if (!signal.aborted) onResult(provider, { status: "success", data });
			} catch (error) {
				if (!signal.aborted) onResult(provider, { status: "error", error });
			}
		}),
	);
}
