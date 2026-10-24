import type { JapaneseReadingRequest, JapaneseReadingResponse } from "./types";

export interface JapaneseReadingStatus {
	state: "idle" | "loading" | "ready" | "error";
	revision: number;
}

interface PendingRequest {
	key: string;
	count: number;
	resolve: (value: string[]) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

export class JapaneseReadingClient {
	private worker?: Worker;
	private sequence = 0;
	private pending = new Map<number, PendingRequest>();
	private inflight = new Map<string, Promise<string[]>>();
	private cache = new Map<string, string[]>();
	private listeners = new Set<() => void>();
	private status: JapaneseReadingStatus = { state: "idle", revision: 0 };

	constructor(
		private readonly options: {
			createWorker: () => Worker;
			dictionaryPath: string;
			timeoutMs?: number;
		},
	) {}

	getStatus = () => this.status;
	subscribe = (listener: () => void) => {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	};

	private setState(state: JapaneseReadingStatus["state"], retry = false) {
		if (this.status.state === state && !retry) return;
		this.status = { state, revision: this.status.revision + (retry ? 1 : 0) };
		for (const listener of this.listeners) listener();
	}

	private stopWorker(error: Error) {
		this.worker?.terminate();
		this.worker = undefined;
		for (const request of this.pending.values()) {
			clearTimeout(request.timer);
			request.reject(error);
		}
		this.pending.clear();
		this.inflight.clear();
	}

	retry = () => {
		this.stopWorker(new Error("Japanese pronunciation restarted"));
		this.setState("idle", true);
	};

	dispose() {
		this.stopWorker(new Error("Japanese pronunciation stopped"));
		this.setState("idle");
	}

	private getWorker() {
		if (this.worker) return this.worker;
		const worker = this.options.createWorker();
		this.worker = worker;
		this.setState("loading");
		worker.onmessage = (event: MessageEvent<JapaneseReadingResponse>) => {
			if (this.worker !== worker) return;
			const response = event.data;
			if (!response || typeof response !== "object") {
				this.stopWorker(new Error("Invalid Japanese pronunciation response"));
				this.setState("error");
				return;
			}
			if ("type" in response && response.type === "ready") {
				this.setState("ready");
				return;
			}
			if (!("id" in response)) return;
			const request = this.pending.get(response.id);
			if (!request) return;
			clearTimeout(request.timer);
			this.pending.delete(response.id);
			if (
				!("readings" in response) ||
				!Array.isArray(response.readings) ||
				response.readings.length !== request.count ||
				response.readings.some((value) => typeof value !== "string")
			) {
				this.setState("error");
				request.reject(new Error("Japanese pronunciation generation failed"));
				return;
			}
			const readings = [...response.readings];
			this.cache.set(request.key, readings);
			if (this.cache.size > 256) {
				const oldest = this.cache.keys().next().value;
				if (oldest !== undefined) this.cache.delete(oldest);
			}
			this.setState("ready");
			request.resolve(readings);
		};
		worker.onerror = () => {
			if (this.worker !== worker) return;
			this.stopWorker(new Error("Japanese pronunciation worker failed"));
			this.setState("error");
		};
		return worker;
	}

	async read(
		words: readonly string[],
		signal?: AbortSignal,
	): Promise<string[]> {
		signal?.throwIfAborted();
		if (
			!/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(
				words.join(""),
			)
		) {
			return words.map(() => "");
		}
		const key = JSON.stringify(words);
		const cached = this.cache.get(key);
		if (cached) return [...cached];
		let shared = this.inflight.get(key);
		if (!shared) {
			try {
				const worker = this.getWorker();
				const id = ++this.sequence;
				shared = new Promise<string[]>((resolve, reject) => {
					const timer = setTimeout(() => {
						this.stopWorker(new Error("Japanese pronunciation timed out"));
						this.setState("error");
					}, this.options.timeoutMs ?? 60000);
					this.pending.set(id, {
						key,
						count: words.length,
						resolve,
						reject,
						timer,
					});
					try {
						worker.postMessage({
							id,
							words: [...words],
							dictionaryPath: this.options.dictionaryPath,
						} satisfies JapaneseReadingRequest);
					} catch (error) {
						clearTimeout(timer);
						this.pending.delete(id);
						this.setState("error");
						reject(error);
					}
				});
				this.inflight.set(key, shared);
				const clear = () => {
					if (this.inflight.get(key) === shared) this.inflight.delete(key);
				};
				void shared.then(clear, clear);
			} catch {
				this.setState("error");
				throw new Error("Japanese pronunciation is unavailable");
			}
		}
		if (!signal) return [...(await shared)];
		return new Promise<string[]>((resolve, reject) => {
			const abort = () => reject(signal.reason);
			signal.addEventListener("abort", abort, { once: true });
			shared.then(
				(readings) => {
					signal.removeEventListener("abort", abort);
					resolve([...readings]);
				},
				(error) => {
					signal.removeEventListener("abort", abort);
					reject(error);
				},
			);
		});
	}
}
