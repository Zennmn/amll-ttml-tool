import { useSetAtom } from "jotai";
import { useCallback, useEffect, useRef, useState } from "react";
import { pcmDataErrorAtom } from "$/modules/audio/states";
import { LRUCache } from "$/modules/spectrogram/utils/lru-cache";
import type {
	SpectrogramWorker,
	TileGenerationParams,
	WorkerResponse,
} from "$/modules/spectrogram/workers/types";
import { spectrogramLogger } from "../logger";

const MAX_CACHED_TILES = 70;

export type TileEntry = {
	bitmap: ImageBitmap;
	width: number;
	height: number;
	gain: number;
	paletteId: string;
};

class SpectrogramWorkerClient {
	private worker: SpectrogramWorker;
	private reqIdCounter = 0;
	private closed = false;
	private pendingRequests = new Map<
		number,
		{
			resolve: (bmp: ImageBitmap) => void;
			reject: (err: Error) => void;
		}
	>();
	private onInitCompleteCallback?: () => void;
	private onErrorCallback?: (message: string) => void;

	constructor(
		onInitComplete?: () => void,
		onError?: (message: string) => void,
	) {
		this.onInitCompleteCallback = onInitComplete;
		this.onErrorCallback = onError;
		this.worker = new Worker(
			new URL("../workers/spectrogram.worker.ts", import.meta.url),
			{ type: "module" },
		);
		this.worker.onmessage = this.handleMessage.bind(this);
		this.worker.onerror = (event) => {
			this.handleError(event.message || "Spectrogram worker failed");
		};
		this.worker.onmessageerror = () => {
			this.handleError("Invalid spectrogram worker response");
		};
	}

	private rejectPending(error: Error) {
		for (const request of this.pendingRequests.values()) {
			request.reject(error);
		}
		this.pendingRequests.clear();
	}

	private handleError(message: string) {
		this.rejectPending(new Error(message));
		this.onErrorCallback?.(message);
	}

	private handleMessage(event: MessageEvent<WorkerResponse>) {
		if (this.closed) return;
		const msg = event.data;
		if (msg.type === "INIT_COMPLETE") {
			this.onInitCompleteCallback?.();
		} else if (msg.type === "TILE_READY") {
			const request = this.pendingRequests.get(msg.reqId);
			if (request) {
				request.resolve(msg.imageBitmap);
				this.pendingRequests.delete(msg.reqId);
			} else {
				msg.imageBitmap.close();
			}
		} else if (msg.type === "ERROR") {
			if (msg.reqId === -1) {
				this.handleError(msg.message);
				return;
			}
			const request = this.pendingRequests.get(msg.reqId);
			if (request) {
				spectrogramLogger.warn(`Worker Error req ${msg.reqId}:`, msg.message);
				request.reject(new Error(msg.message));
				this.pendingRequests.delete(msg.reqId);
			}
		}
	}

	public getTile(params: TileGenerationParams): Promise<ImageBitmap> {
		const reqId = this.reqIdCounter++;
		return new Promise((resolve, reject) => {
			this.pendingRequests.set(reqId, { resolve, reject });
			this.worker.postMessage({
				type: "GET_TILE",
				reqId,
				params,
			});
		});
	}

	public initAudio(sampleRate: number, duration: number) {
		this.worker.postMessage({ type: "INIT", sampleRate, duration });
	}

	public releaseAudio() {
		this.worker.postMessage({ type: "RELEASE" });
	}

	public setPalette(palette: Uint8Array) {
		this.worker.postMessage({ type: "SET_PALETTE", palette });
	}

	public terminate() {
		if (this.closed) return;
		this.closed = true;
		this.worker.onmessage = null;
		this.worker.onerror = null;
		this.worker.onmessageerror = null;
		this.worker.terminate();
		this.rejectPending(new Error("Spectrogram worker terminated"));
		this.onInitCompleteCallback = undefined;
		this.onErrorCallback = undefined;
	}
}

export const useSpectrogramWorker = (
	pcmDataReady: boolean,
	durationInMs: number,
	paletteData: Uint8Array,
) => {
	const setPcmDataError = useSetAtom(pcmDataErrorAtom);
	const clientRef = useRef<SpectrogramWorkerClient | null>(null);
	const [isWorkerReady, setIsWorkerReady] = useState(false);
	const tileCache = useRef<LRUCache<string, TileEntry>>(
		new LRUCache(MAX_CACHED_TILES, (_key, entry) => {
			entry.bitmap.close();
		}),
	);
	const activeRequests = useRef<Set<string>>(new Set());
	const [lastTileTimestamp, setLastTileTimestamp] = useState(0);

	const paletteDataRef = useRef(paletteData);
	useEffect(() => {
		paletteDataRef.current = paletteData;
		if (clientRef.current) {
			clientRef.current.setPalette(paletteData);
		}
	}, [paletteData]);

	useEffect(() => {
		setIsWorkerReady(false);
		if (!pcmDataReady || durationInMs <= 0) return;

		let cancelled = false;
		let client: SpectrogramWorkerClient | null = null;
		const isCurrentClient = () =>
			!cancelled && client !== null && clientRef.current === client;
		const reportError = (error: unknown) => {
			if (cancelled) return;
			setIsWorkerReady(false);
			setPcmDataError(
				error instanceof Error ? error.message : String(error),
			);
		};

		tileCache.current.clear();
		activeRequests.current.clear();

		try {
			client = new SpectrogramWorkerClient(
				() => {
					if (!isCurrentClient()) return;
					setIsWorkerReady(true);
					setLastTileTimestamp(Date.now());
				},
				(message) => {
					if (!isCurrentClient()) return;
					setIsWorkerReady(false);
					setPcmDataError(message);
				},
			);
			clientRef.current = client;
			client.initAudio(44100, durationInMs / 1000);

			if (paletteDataRef.current) {
				client.setPalette(paletteDataRef.current);
			}
		} catch (error) {
			reportError(error);
			if (client) {
				if (clientRef.current === client) {
					clientRef.current = null;
				}
				client.terminate();
			}
		}

		return () => {
			cancelled = true;
			if (clientRef.current === client) {
				clientRef.current = null;
			}
			client?.terminate();
		};
	}, [pcmDataReady, durationInMs, setPcmDataError]);

	const requestTileIfNeeded = useCallback(
		async (params: TileGenerationParams) => {
			const client = clientRef.current;
			if (!client || !isWorkerReady) return;

			const cacheKey = `tile-${params.tileIndex}`;
			const requestFingerprint = `${params.tileIndex}-w${params.tileWidthPx}-h${params.height}-g${params.gain}-p${params.paletteId}`;

			const cacheEntry = tileCache.current.get(cacheKey);

			const isStale =
				!cacheEntry ||
				cacheEntry.width < params.tileWidthPx ||
				cacheEntry.height !== params.height ||
				cacheEntry.gain !== params.gain ||
				cacheEntry.paletteId !== params.paletteId;

			if (isStale && !activeRequests.current.has(requestFingerprint)) {
				activeRequests.current.add(requestFingerprint);

				try {
					const bitmap = await client.getTile(params);
					if (clientRef.current !== client) {
						bitmap.close();
						return;
					}

					tileCache.current.set(cacheKey, {
						bitmap,
						width: params.tileWidthPx,
						height: params.height,
						gain: params.gain,
						paletteId: params.paletteId,
					});

					setLastTileTimestamp(Date.now());
				} catch (err) {
					if (clientRef.current === client) {
						spectrogramLogger.error("生成频谱图瓦片失败", err);
					}
				} finally {
					if (clientRef.current === client) {
						activeRequests.current.delete(requestFingerprint);
					}
				}
			}
		},
		[isWorkerReady],
	);

	return { tileCache, requestTileIfNeeded, lastTileTimestamp, isWorkerReady };
};
