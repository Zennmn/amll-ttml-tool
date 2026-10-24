import type { TTMLMetadata } from "$/types/ttml";

export const APPLE_MUSIC_IMPORT_FIELDS = [
	"musicName",
	"artists",
	"album",
	"appleMusicId",
] as const;

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
}

export type AppleMusicMetadataErrorCode =
	| "invalidLink"
	| "albumLink"
	| "notFound"
	| "invalidResponse"
	| "network"
	| "timeout"
	| "rateLimited";

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
	signal?: AbortSignal;
	fetcher?: typeof fetch;
	timeoutMs?: number;
}

export async function fetchAppleMusicMetadata(
	input: string,
	options: AppleMusicLookupOptions = {},
): Promise<AppleMusicMetadataPreview> {
	const link = parseAppleMusicSongLink(input);
	options.signal?.throwIfAborted();
	const controller = new AbortController();
	const cancel = () => controller.abort(options.signal?.reason);
	options.signal?.addEventListener("abort", cancel, { once: true });
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, options.timeoutMs ?? 15000);
	try {
		const url = new URL("https://itunes.apple.com/lookup");
		url.searchParams.set("id", link.songId);
		url.searchParams.set("country", link.storefront);
		const response = await (options.fetcher ?? fetch)(url.toString(), {
			signal: controller.signal,
			credentials: "omit",
			referrerPolicy: "no-referrer",
			headers: { Accept: "application/json" },
		});
		controller.signal.throwIfAborted();
		if (!response.ok) {
			throw new AppleMusicMetadataError(
				response.status === 429
					? "rateLimited"
					: response.status === 404
						? "notFound"
						: "network",
			);
		}
		const text = await response.text();
		controller.signal.throwIfAborted();
		let data: unknown;
		try {
			if (text.length > 512 * 1024) {
				throw new Error("Response too large");
			}
			data = JSON.parse(text);
		} catch {
			throw new AppleMusicMetadataError("invalidResponse");
		}
		return parseAppleMusicLookupResponse(data, link);
	} catch (error) {
		options.signal?.throwIfAborted();
		if (timedOut) throw new AppleMusicMetadataError("timeout");
		if (error instanceof AppleMusicMetadataError) throw error;
		throw new AppleMusicMetadataError("network");
	} finally {
		clearTimeout(timer);
		options.signal?.removeEventListener("abort", cancel);
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
