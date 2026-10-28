import { invoke, isTauri } from "@tauri-apps/api/core";
import { boundedRequest } from "$/modules/online-lyrics/requests";
import type { TTMLMetadata } from "$/types/ttml";

export const APPLE_MUSIC_IMPORT_FIELDS = [
	"musicName",
	"artists",
	"album",
	"appleMusicId",
	"isrc",
	"songwriter",
] as const;

export type AppleMusicMetadataMode = "enhanced" | "basic";

export type AppleMusicMetadataField =
	(typeof APPLE_MUSIC_IMPORT_FIELDS)[number];

export interface AppleMusicSongLink {
	songId: string;
	storefront: string;
}

export interface AppleMusicMetadataPreview extends AppleMusicSongLink {
	metadata: TTMLMetadata[];
	sourceUrl: string;
	artworkUrl?: string;
	releaseDate?: string;
	durationMs?: number;
	retrievalMode?: AppleMusicMetadataMode;
	enhancementUnavailable?: boolean;
}

export type AppleMusicMetadataErrorCode =
	| "invalidLink"
	| "albumLink"
	| "notFound"
	| "invalidResponse"
	| "network"
	| "timeout"
	| "rateLimited"
	| "accessDenied"
	| "serviceUnavailable";

export class AppleMusicMetadataError extends Error {
	constructor(public readonly code: AppleMusicMetadataErrorCode) {
		super(code);
		this.name = "AppleMusicMetadataError";
	}
}

const validId = (value: string) =>
	/^[1-9]\d{0,15}$/.test(value) && Number.isSafeInteger(Number(value));

export function parseAppleMusicSongLink(input: string): AppleMusicSongLink {
	const text = input.trim();
	if (!text || text.length > 4096) {
		throw new AppleMusicMetadataError("invalidLink");
	}
	let url: URL;
	try {
		url = new URL(
			/^(?:music|itunes)\.apple\.com\//i.test(text) ? `https://${text}` : text,
		);
	} catch {
		throw new AppleMusicMetadataError("invalidLink");
	}
	if (
		url.protocol !== "https:" ||
		!["music.apple.com", "itunes.apple.com"].includes(url.hostname) ||
		url.username ||
		url.password ||
		url.port
	) {
		throw new AppleMusicMetadataError("invalidLink");
	}
	const parts = url.pathname.split("/").filter(Boolean);
	const storefront = /^[a-z]{2}$/i.test(parts[0] ?? "")
		? (parts.shift()?.toLowerCase() ?? "us")
		: "us";
	const kind = parts[0];
	const resourceId = parts.at(-1)?.replace(/^id/, "") ?? "";
	if (
		!["song", "album"].includes(kind) ||
		(parts.length !== 2 && parts.length !== 3) ||
		!validId(resourceId)
	) {
		throw new AppleMusicMetadataError("invalidLink");
	}
	const selectedIds = url.searchParams.getAll("i");
	if (selectedIds.length > 1 || (selectedIds[0] && !validId(selectedIds[0]))) {
		throw new AppleMusicMetadataError("invalidLink");
	}
	if (kind === "album" && !selectedIds[0]) {
		throw new AppleMusicMetadataError("albumLink");
	}
	return {
		storefront,
		songId: kind === "album" ? selectedIds[0] : resourceId,
	};
}

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

const nonempty = (value: unknown) =>
	typeof value === "string" ? value.trim() : "";

export function parseAppleMusicLookupResponse(
	data: unknown,
	link: AppleMusicSongLink,
): AppleMusicMetadataPreview {
	if (!record(data) || !Array.isArray(data.results)) {
		throw new AppleMusicMetadataError("invalidResponse");
	}
	if (data.resultCount === 0 && data.results.length === 0) {
		throw new AppleMusicMetadataError("notFound");
	}
	const track = data.results.find(
		(item) =>
			record(item) &&
			item.wrapperType === "track" &&
			item.kind === "song" &&
			typeof item.trackId === "number" &&
			Number.isSafeInteger(item.trackId) &&
			String(item.trackId) === link.songId,
	);
	if (!track || !nonempty(track.trackName) || !nonempty(track.artistName)) {
		throw new AppleMusicMetadataError("invalidResponse");
	}
	const metadata: TTMLMetadata[] = [
		{ key: "musicName", value: [nonempty(track.trackName)] },
		// The lookup API supplies an artist display name, not a structured list.
		// Splitting punctuation would corrupt names such as Earth, Wind & Fire.
		{ key: "artists", value: [nonempty(track.artistName)] },
	];
	const album = nonempty(track.collectionName);
	if (album) metadata.push({ key: "album", value: [album] });
	metadata.push({ key: "appleMusicId", value: [link.songId] });
	const artwork = nonempty(track.artworkUrl100);
	const date = nonempty(track.releaseDate);
	return {
		...link,
		metadata,
		sourceUrl: `https://music.apple.com/${link.storefront}/song/${link.songId}`,
		artworkUrl: /^https:\/\/[^/]+\.mzstatic\.com\//i.test(artwork)
			? artwork
			: undefined,
		releaseDate:
			/^\d{4}-\d{2}-\d{2}(?:T|$)/.test(date) && !Number.isNaN(Date.parse(date))
				? date.slice(0, 10)
				: undefined,
		durationMs:
			typeof track.trackTimeMillis === "number" &&
			Number.isFinite(track.trackTimeMillis) &&
			track.trackTimeMillis >= 0
				? track.trackTimeMillis
				: undefined,
	};
}

interface AppleMusicLookupOptions {
	mode?: AppleMusicMetadataMode;
	signal?: AbortSignal;
	fetcher?: typeof fetch;
	timeoutMs?: number;
	nativeLookup?: (
		link: AppleMusicSongLink,
	) => Promise<{ status: number; body: string }>;
	nativeCatalogLookup?: (
		link: AppleMusicSongLink,
	) => Promise<{ status: number; body: string }>;
	enhancementTimeoutMs?: number;
}

function parseLookupResult(
	status: number,
	body: string,
	link: AppleMusicSongLink,
): AppleMusicMetadataPreview {
	if (
		!Number.isInteger(status) ||
		status < 100 ||
		status > 599 ||
		typeof body !== "string"
	) {
		throw new AppleMusicMetadataError("invalidResponse");
	}
	if (status < 200 || status >= 300) {
		throw new AppleMusicMetadataError(
			status === 429
				? "rateLimited"
				: status === 404
					? "notFound"
					: status === 408 || status === 504
						? "timeout"
						: status === 401 || status === 403 || status === 451
							? "accessDenied"
							: "serviceUnavailable",
		);
	}
	let data: unknown;
	try {
		if (body.length > 512 * 1024) throw new Error("Response too large");
		data = JSON.parse(body);
	} catch {
		throw new AppleMusicMetadataError("invalidResponse");
	}
	return parseAppleMusicLookupResponse(data, link);
}

function normalizeNativeError(error: unknown): AppleMusicMetadataError {
	if (error instanceof AppleMusicMetadataError) return error;
	if (
		record(error) &&
		["invalidLink", "network", "timeout", "invalidResponse"].includes(
			String(error.code),
		)
	) {
		return new AppleMusicMetadataError(
			error.code as AppleMusicMetadataErrorCode,
		);
	}
	return new AppleMusicMetadataError("network");
}

function waitForLookupRetry(signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		signal.throwIfAborted();
		const cancel = () => {
			clearTimeout(timer);
			reject(signal.reason);
		};
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", cancel);
			resolve();
		}, 200);
		signal.addEventListener("abort", cancel, { once: true });
	});
}

async function fetchBasicAppleMusicMetadata(
	input: string,
	options: AppleMusicLookupOptions = {},
): Promise<AppleMusicMetadataPreview> {
	const link = parseAppleMusicSongLink(input);
	options.signal?.throwIfAborted();
	const nativeLookup =
		options.nativeLookup ??
		(typeof window !== "undefined" && isTauri()
			? (song: AppleMusicSongLink) =>
					invoke<{ status: number; body: string }>(
						"apple_music_metadata_lookup",
						{ songId: song.songId, storefront: song.storefront },
					)
			: undefined);
	try {
		return await boundedRequest(
			async (signal) => {
				let nativeFailure: AppleMusicMetadataError | undefined;
				if (nativeLookup) {
					try {
						const result = await nativeLookup(link);
						signal.throwIfAborted();
						if (!record(result))
							throw new AppleMusicMetadataError("invalidResponse");
						return parseLookupResult(result.status, result.body, link);
					} catch (error) {
						signal.throwIfAborted();
						nativeFailure = normalizeNativeError(error);
						if (
							![
								"network",
								"timeout",
								"serviceUnavailable",
								"accessDenied",
							].includes(nativeFailure.code)
						) {
							throw nativeFailure;
						}
					}
				}
				const url = new URL("https://itunes.apple.com/lookup");
				url.searchParams.set("id", link.songId);
				url.searchParams.set("country", link.storefront);
				for (let attempt = 0; attempt < 2; attempt++) {
					signal.throwIfAborted();
					try {
						const response = await (options.fetcher ?? fetch)(url.toString(), {
							signal,
							credentials: "omit",
							cache: "no-store",
							referrerPolicy: "no-referrer",
							headers: { Accept: "application/json" },
						});
						const text = await response.text();
						signal.throwIfAborted();
						return parseLookupResult(response.status, text, link);
					} catch (error) {
						signal.throwIfAborted();
						const failure =
							error instanceof AppleMusicMetadataError
								? error
								: (nativeFailure ?? new AppleMusicMetadataError("network"));
						if (
							attempt > 0 ||
							!["network", "serviceUnavailable"].includes(failure.code)
						) {
							throw failure;
						}
						await waitForLookupRetry(signal);
					}
				}
				throw new AppleMusicMetadataError("network");
			},
			options.signal,
			options.timeoutMs ?? 25000,
		);
	} catch (error) {
		options.signal?.throwIfAborted();
		if (error instanceof Error && error.name === "TimeoutError") {
			throw new AppleMusicMetadataError("timeout");
		}
		if (error instanceof AppleMusicMetadataError) throw error;
		throw new AppleMusicMetadataError("network");
	}
}

/** Parse catalog attributes only for the exact song selected in the shared link. */
export function parseAppleMusicCatalogResponse(
	data: unknown,
	link: AppleMusicSongLink,
): AppleMusicMetadataPreview {
	if (!record(data) || !Array.isArray(data.data)) {
		throw new AppleMusicMetadataError("invalidResponse");
	}
	if (data.data.length === 0) throw new AppleMusicMetadataError("notFound");
	const song = data.data.find(
		(item) => record(item) && item.type === "songs" && item.id === link.songId,
	);
	const attributes =
		record(song) && record(song.attributes) ? song.attributes : null;
	if (
		!attributes ||
		!nonempty(attributes.name) ||
		!nonempty(attributes.artistName)
	) {
		throw new AppleMusicMetadataError("invalidResponse");
	}
	const metadata: TTMLMetadata[] = [
		{ key: "musicName", value: [nonempty(attributes.name)] },
		{ key: "artists", value: [nonempty(attributes.artistName)] },
	];
	const album = nonempty(attributes.albumName);
	if (album) metadata.push({ key: "album", value: [album] });
	metadata.push({ key: "appleMusicId", value: [link.songId] });
	const isrc = nonempty(attributes.isrc).replace(/-/g, "").toUpperCase();
	if (/^[A-Z]{2}[A-Z0-9]{3}\d{7}$/.test(isrc))
		metadata.push({ key: "isrc", value: [isrc] });
	// Keep Apple's composer display string intact; this is not a complete lyricist list.
	const composer = nonempty(attributes.composerName);
	if (composer && composer.length <= 4096)
		metadata.push({ key: "songwriter", value: [composer] });
	const artwork = record(attributes.artwork)
		? nonempty(attributes.artwork.url)
		: "";
	const date = nonempty(attributes.releaseDate);
	return {
		...link,
		metadata,
		sourceUrl: `https://music.apple.com/${link.storefront}/song/${link.songId}`,
		retrievalMode: "enhanced",
		artworkUrl: /^https:\/\/[^/]+\.mzstatic\.com\//i.test(artwork)
			? artwork.replaceAll("{w}", "300").replaceAll("{h}", "300")
			: undefined,
		releaseDate:
			/^\d{4}-\d{2}-\d{2}(?:T|$)/.test(date) && !Number.isNaN(Date.parse(date))
				? date.slice(0, 10)
				: undefined,
		durationMs:
			typeof attributes.durationInMillis === "number" &&
			Number.isFinite(attributes.durationInMillis) &&
			attributes.durationInMillis >= 0
				? attributes.durationInMillis
				: undefined,
	};
}

/** Basic stays available independently; the desktop UI opts into enhancement. */
export async function fetchAppleMusicMetadata(
	input: string,
	options: AppleMusicLookupOptions = {},
): Promise<AppleMusicMetadataPreview> {
	const link = parseAppleMusicSongLink(input);
	options.signal?.throwIfAborted();
	if (options.mode !== "enhanced") {
		return fetchBasicAppleMusicMetadata(input, options);
	}
	const catalogLookup =
		options.nativeCatalogLookup ??
		(typeof window !== "undefined" && isTauri()
			? (song: AppleMusicSongLink) =>
					invoke<{ status: number; body: string }>(
						"apple_music_catalog_lookup",
						{
							songId: song.songId,
							storefront: song.storefront,
						},
					)
			: undefined);
	try {
		return await boundedRequest(
			async (signal) => {
				if (catalogLookup) {
					try {
						return await boundedRequest(
							async (catalogSignal) => {
								const response = await catalogLookup(link);
								catalogSignal.throwIfAborted();
								if (
									!record(response) ||
									response.status !== 200 ||
									typeof response.body !== "string" ||
									response.body.length > 512 * 1024
								) {
									throw new AppleMusicMetadataError("invalidResponse");
								}
								let data: unknown;
								try {
									data = JSON.parse(response.body);
								} catch {
									throw new AppleMusicMetadataError("invalidResponse");
								}
								return parseAppleMusicCatalogResponse(data, link);
							},
							signal,
							options.enhancementTimeoutMs ?? 13000,
						);
					} catch {
						signal.throwIfAborted();
						// A failed/older enhancement command must not prevent a basic preview.
					}
				}
				const basic = await fetchBasicAppleMusicMetadata(input, {
					...options,
					signal,
				});
				return {
					...basic,
					retrievalMode: "basic",
					enhancementUnavailable: true,
				};
			},
			options.signal,
			options.timeoutMs ?? 30000,
		);
	} catch (error) {
		options.signal?.throwIfAborted();
		if (error instanceof Error && error.name === "TimeoutError") {
			throw new AppleMusicMetadataError("timeout");
		}
		if (error instanceof AppleMusicMetadataError) throw error;
		throw new AppleMusicMetadataError("network");
	}
}

export function getDefaultAppleMusicFields(
	current: TTMLMetadata[],
	preview: AppleMusicMetadataPreview,
): AppleMusicMetadataField[] {
	return APPLE_MUSIC_IMPORT_FIELDS.filter(
		(key) =>
			preview.metadata.some(
				(item) => item.key === key && item.value.some((value) => value.trim()),
			) &&
			!current.some(
				(item) => item.key === key && item.value.some((value) => value.trim()),
			),
	);
}

export function getAvailableAppleMusicFields(
	preview: AppleMusicMetadataPreview,
): AppleMusicMetadataField[] {
	return APPLE_MUSIC_IMPORT_FIELDS.filter((key) =>
		preview.metadata.some(
			(item) => item.key === key && item.value.some((value) => value.trim()),
		),
	);
}

export function mergeAppleMusicMetadata(
	current: TTMLMetadata[],
	preview: AppleMusicMetadataPreview,
	fields: readonly AppleMusicMetadataField[],
): TTMLMetadata[] {
	let result = current;
	for (const key of APPLE_MUSIC_IMPORT_FIELDS) {
		if (!fields.includes(key)) continue;
		const source = preview.metadata.find((item) => item.key === key);
		const values = [
			...new Set(source?.value.map((value) => value.trim()).filter(Boolean)),
		];
		if (!values.length) continue;
		const matches = result.filter((item) => item.key === key);
		if (
			matches.length === 1 &&
			!matches[0].error &&
			matches[0].value.length === values.length &&
			matches[0].value.every((value, index) => value === values[index])
		) {
			continue;
		}
		let replaced = false;
		result = result.flatMap((item) => {
			if (item.key !== key) return [item];
			if (replaced) return [];
			replaced = true;
			return [{ key, value: values }];
		});
		if (!replaced) result.push({ key, value: values });
	}
	return result;
}
