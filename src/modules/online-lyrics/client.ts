import { invoke, isTauri } from "@tauri-apps/api/core";
import { boundedRequest } from "./requests";
import {
	type LyricCandidate,
	type LyricChannel,
	ONLINE_PROVIDERS,
	type OnlineLyrics,
	type OnlineProviderId,
	type OnlineSearchPage,
	type OnlineTrack,
} from "./types";

const MAX_CONTENT_LENGTH = 2 * 1024 * 1024;
const CACHE_TTL = 4 * 60 * 60 * 1000;
const lyricCache = new Map<string, { expires: number; data: OnlineLyrics }>();
const LOCAL_API = "/api/online-lyrics";
let localProviders = new Set<OnlineProviderId>();
let discoveryGeneration = 0;

export function supportsProvider(provider: OnlineProviderId): boolean {
	return provider === "lrclib" || isTauri() || localProviders.has(provider);
}

/** A verified same-origin service enables the native sources in a local browser. */
export async function discoverAvailableProviders(
	signal?: AbortSignal,
): Promise<OnlineProviderId[]> {
	if (isTauri()) return [...ONLINE_PROVIDERS];
	const generation = ++discoveryGeneration;
	let providers: OnlineProviderId[] = [];
	try {
		providers = await boundedRequest(
			async (requestSignal) => {
				const response = await fetch(`${LOCAL_API}/health`, {
					signal: requestSignal,
					cache: "no-store",
				});
				if (!response.ok) return [];
				const content = await response.text();
				if (content.length > 4096) return [];
				const health = record(JSON.parse(content));
				if (
					health.service !== "amll-lyrics-service" ||
					health.protocolVersion !== 1 ||
					!Array.isArray(health.providers)
				)
					return [];
				return ONLINE_PROVIDERS.filter((provider) =>
					(health.providers as unknown[]).includes(provider),
				);
			},
			signal,
			2500,
		);
	} catch (error) {
		if (signal?.aborted) throw error;
		// A static website can still use the existing direct LRCLIB transport.
	}
	if (signal?.aborted) throw signal.reason;
	if (generation === discoveryGeneration) localProviders = new Set(providers);
	return ONLINE_PROVIDERS.filter(supportsProvider);
}

function usesLocalService(provider: OnlineProviderId): boolean {
	return !isTauri() && localProviders.has(provider);
}

async function localRequest(
	command: "search" | "fetch",
	args: Record<string, unknown>,
	signal: AbortSignal,
): Promise<unknown> {
	const response = await fetch(`${LOCAL_API}/${command}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(args),
		credentials: "omit",
		signal,
	});
	const content = await response.text();
	if (content.length > MAX_CONTENT_LENGTH * 4)
		throw new Error("Lyric response is too large");
	let data: unknown;
	try {
		data = JSON.parse(content);
	} catch {
		throw new Error(`Local lyric service: HTTP ${response.status}`);
	}
	if (!response.ok) {
		const message = record(data).error;
		throw new Error(
			typeof message === "string"
				? message.slice(0, 1024)
				: `Local lyric service: HTTP ${response.status}`,
		);
	}
	return data;
}

function record(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Invalid lyric service response");
	}
	return value as Record<string, unknown>;
}

function text(value: unknown, max = 1024): string {
	if (typeof value !== "string" || value.length > max) {
		throw new Error("Invalid lyric service text");
	}
	return value;
}

function duration(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0
		? Math.round(value)
		: 0;
}

function validateTrack(
	value: unknown,
	provider: OnlineProviderId,
): OnlineTrack {
	const item = record(value);
	if (item.provider !== provider || !Array.isArray(item.artists)) {
		throw new Error("Invalid lyric service track");
	}
	return {
		provider,
		id: text(item.id),
		title: text(item.title),
		artists: item.artists.slice(0, 30).map((artist) => text(artist)),
		album: text(item.album),
		durationMs: duration(item.durationMs),
		mid: typeof item.mid === "string" ? text(item.mid) : undefined,
		hash: typeof item.hash === "string" ? text(item.hash) : undefined,
	};
}

function validateChannel(value: unknown): LyricChannel {
	const channel = record(value);
	if (!["lrc", "qrc", "yrc", "krc", "plain"].includes(String(channel.format))) {
		throw new Error("Unsupported lyric service format");
	}
	return {
		format: channel.format as LyricChannel["format"],
		content: text(channel.content, MAX_CONTENT_LENGTH),
	};
}

function validateLyrics(value: unknown): OnlineLyrics {
	const item = record(value);
	const candidates = item.candidates == null ? undefined : item.candidates;
	if (candidates !== undefined && !Array.isArray(candidates)) {
		throw new Error("Invalid lyric candidates");
	}
	return {
		original: validateChannel(item.original),
		translation: item.translation
			? validateChannel(item.translation)
			: undefined,
		romanization: item.romanization
			? validateChannel(item.romanization)
			: undefined,
		originalLrc: item.originalLrc
			? text(item.originalLrc, MAX_CONTENT_LENGTH)
			: undefined,
		selectedCandidateId: item.selectedCandidateId
			? text(item.selectedCandidateId)
			: undefined,
		candidates: candidates?.slice(0, 50).map((value: unknown) => {
			const candidate = record(value);
			return {
				id: text(candidate.id),
				accessKey: text(candidate.accessKey),
				label: text(candidate.label),
				durationMs: duration(candidate.durationMs),
			};
		}),
	};
}

async function lrcLibJson(path: string, signal: AbortSignal): Promise<unknown> {
	const response = await fetch(`https://lrclib.net/api/${path}`, { signal });
	if (!response.ok) throw new Error(`LRCLIB: HTTP ${response.status}`);
	const content = await response.text();
	if (content.length > MAX_CONTENT_LENGTH * 4)
		throw new Error("Lyric response is too large");
	return JSON.parse(content) as unknown;
}

export async function searchProvider(
	provider: OnlineProviderId,
	query: string,
	page = 1,
	signal?: AbortSignal,
): Promise<OnlineSearchPage> {
	const keyword = query.trim();
	if (!keyword) return { tracks: [], page, hasMore: false };
	if (Array.from(keyword).length > 200)
		throw new Error("Search query is too long");
	if (!supportsProvider(provider))
		throw new Error(
			"This source requires the local lyric service or desktop app",
		);
	return boundedRequest(async (requestSignal) => {
		if (provider === "lrclib" && !isTauri() && !usesLocalService(provider)) {
			const values = await lrcLibJson(
				`search?q=${encodeURIComponent(keyword)}`,
				requestSignal,
			);
			if (!Array.isArray(values))
				throw new Error("Invalid LRCLIB search response");
			const start = (page - 1) * 20;
			return {
				page,
				hasMore: start + 20 < values.length,
				tracks: values.slice(start, start + 20).map((value: unknown) => {
					const item = record(value);
					if (!Number.isSafeInteger(item.id) || Number(item.id) < 0)
						throw new Error("Invalid LRCLIB id");
					return {
						provider,
						id: String(item.id),
						title: text(item.trackName ?? item.name),
						artists: [text(item.artistName)],
						album: text(item.albumName ?? ""),
						durationMs: duration(Number(item.duration) * 1000),
					};
				}),
			};
		}
		const args = { provider, query: keyword, page };
		const data = record(
			usesLocalService(provider)
				? await localRequest("search", args, requestSignal)
				: await invoke<unknown>("online_lyrics_search", args),
		);
		if (!Array.isArray(data.tracks))
			throw new Error("Invalid lyric search response");
		return {
			page,
			hasMore: data.hasMore === true,
			tracks: data.tracks
				.slice(0, 100)
				.map((track) => validateTrack(track, provider)),
		};
	}, signal);
}

export async function fetchProviderLyrics(
	track: OnlineTrack,
	candidate?: LyricCandidate,
	signal?: AbortSignal,
): Promise<OnlineLyrics> {
	if (!supportsProvider(track.provider))
		throw new Error(
			"This source requires the local lyric service or desktop app",
		);
	const cacheKey = `${track.provider}:${track.id}:${candidate?.id ?? "default"}`;
	const cached = lyricCache.get(cacheKey);
	if (cached && cached.expires > Date.now())
		return structuredClone(cached.data);
	const lyrics = await boundedRequest(
		async (requestSignal) => {
			if (
				track.provider === "lrclib" &&
				!isTauri() &&
				!usesLocalService(track.provider)
			) {
				if (!/^\d+$/.test(track.id)) throw new Error("Invalid LRCLIB id");
				const item = record(await lrcLibJson(`get/${track.id}`, requestSignal));
				const synced =
					typeof item.syncedLyrics === "string" ? item.syncedLyrics : "";
				const plain =
					typeof item.plainLyrics === "string" ? item.plainLyrics : "";
				return validateLyrics({
					original: {
						format: synced ? "lrc" : "plain",
						content: synced || plain,
					},
				});
			}
			const args = { track, candidate: candidate ?? null };
			return validateLyrics(
				usesLocalService(track.provider)
					? await localRequest("fetch", args, requestSignal)
					: await invoke<unknown>("online_lyrics_fetch", args),
			);
		},
		signal,
		35_000,
	);
	if (!lyrics.original.content.trim())
		throw new Error("This track has no lyrics");
	if (lyricCache.size >= 100)
		lyricCache.delete(lyricCache.keys().next().value ?? "");
	lyricCache.set(cacheKey, {
		expires: Date.now() + CACHE_TTL,
		data: structuredClone(lyrics),
	});
	return lyrics;
}
