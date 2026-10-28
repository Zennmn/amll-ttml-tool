import { boundedRequest } from "./requests";
import type {
	OnlineLyrics,
	OnlinePlatformId,
	OnlineProviderId,
	OnlineSearchPage,
	OnlineTrack,
} from "./types";

export type RepositoryProvider = "amll-ttml-db" | "am-lyrics";

interface RepositoryEntry {
	track: OnlineTrack;
	path: string;
	sha256?: string;
	sizeBytes?: number;
	searchText: string;
}

const INDEX_TTL = 15 * 60 * 1000;
const MAX_TTML_BYTES = 2 * 1024 * 1024;
const MAX_INDEX_BYTES = 32 * 1024 * 1024;
const PAGE_SIZE = 20;
const MAX_ENTRIES = 100_000;
const REPOSITORY_ROOTS: Record<RepositoryProvider, readonly string[]> = {
	"am-lyrics": [
		"https://raw.githubusercontent.com/Zennmn/am-lyrics/main/",
		"https://cdn.jsdelivr.net/gh/Zennmn/am-lyrics@main/",
	],
	"amll-ttml-db": [
		"https://raw.githubusercontent.com/amll-dev/amll-ttml-db/main/",
		"https://cdn.jsdelivr.net/gh/amll-dev/amll-ttml-db@main/",
	],
};
const PLATFORM_IDS: OnlinePlatformId[] = [
	"ncmMusicId",
	"qqMusicId",
	"appleMusicId",
	"spotifyId",
];

export function isRepositoryProvider(
	provider: OnlineProviderId,
): provider is RepositoryProvider {
	return provider === "amll-ttml-db" || provider === "am-lyrics";
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function label(value: unknown): string {
	return typeof value === "string" && value.length <= 2048 ? value.trim() : "";
}

function catalogId(value: unknown): string {
	const id =
		typeof value === "number" && Number.isSafeInteger(value) && value > 0
			? String(value)
			: label(value);
	return /^[1-9]\d{0,19}$/.test(id) ? id : "";
}

function normalize(value: string): string {
	return value
		.normalize("NFKC")
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.trim();
}

/** Only repository-relative TTML paths are accepted; encode each component once. */
function safePath(value: unknown, directory: string): string | undefined {
	if (typeof value !== "string" || value.length > 4096) return;
	const parts = value.split("/");
	if (
		parts[0] !== directory ||
		parts.length < 2 ||
		!value.endsWith(".ttml") ||
		value.includes("\\") ||
		Array.from(value).some((character) => {
			const code = character.charCodeAt(0);
			return code < 32 || code === 127;
		}) ||
		parts.some((part) => !part || part === "." || part === "..")
	)
		return;
	return value;
}

function entry(
	track: OnlineTrack,
	path: string,
	extra: Pick<RepositoryEntry, "sha256" | "sizeBytes"> = {},
): RepositoryEntry {
	return {
		track,
		path,
		...extra,
		searchText: normalize(
			`${track.title} ${track.artists.join(" ")} ${track.album}`,
		),
	};
}

function parseAmLyricsIndex(value: unknown): RepositoryEntry[] {
	const index = record(value);
	if (index?.version !== 1 || !Array.isArray(index.entries))
		throw new Error("Invalid am-lyrics index");
	if (index.entries.length > MAX_ENTRIES) throw new Error("Index is too large");
	const entries: RepositoryEntry[] = [];
	for (const value of index.entries) {
		const item = record(value);
		if (!item || item.enabled === false) continue;
		const id = catalogId(item.appleMusicId);
		const path = safePath(item.path, "am-lyrics");
		const title = label(item.title);
		const artist = label(item.artist);
		if (!id || !path || !title || !artist) continue;
		const alternateIds = Array.isArray(item.alternateIds)
			? item.alternateIds.slice(0, 100).map(catalogId).filter(Boolean)
			: [];
		const sha256 =
			typeof item.sha256 === "string" && /^[\da-f]{64}$/i.test(item.sha256)
				? item.sha256.toLowerCase()
				: undefined;
		const sizeBytes =
			typeof item.sizeBytes === "number" &&
			Number.isSafeInteger(item.sizeBytes) &&
			item.sizeBytes > 0
				? item.sizeBytes
				: undefined;
		if (sizeBytes !== undefined && sizeBytes > MAX_TTML_BYTES) continue;
		entries.push(
			entry(
				{
					provider: "am-lyrics",
					id,
					title,
					artists: [artist],
					album: label(item.album),
					durationMs: 0,
					platformIds: { appleMusicId: [...new Set([id, ...alternateIds])] },
				},
				path,
				{ sha256, sizeBytes },
			),
		);
	}
	return entries;
}

function parseAmllIndex(content: string): RepositoryEntry[] {
	const rows = content.split(/\r?\n/).filter((row) => row.trim());
	if (rows.length > MAX_ENTRIES) throw new Error("Index is too large");
	const entries: RepositoryEntry[] = [];
	const claimed = new Set<string>();
	// The official index is historical, oldest first. Match current platform
	// mappings by letting the newest valid revision claim each catalog ID.
	for (let index = rows.length - 1; index >= 0; index--) {
		let item: Record<string, unknown> | undefined;
		try {
			item = record(JSON.parse(rows[index]));
		} catch {
			continue;
		}
		if (!item || !Array.isArray(item.metadata)) continue;
		const filename = item.rawLyricFile;
		if (
			typeof filename !== "string" ||
			!/^[\da-z][\da-z,._-]{0,1023}\.ttml$/i.test(filename)
		)
			continue;
		const metadata = new Map<string, string[]>();
		for (const pair of item.metadata.slice(0, 500)) {
			if (
				!Array.isArray(pair) ||
				typeof pair[0] !== "string" ||
				!Array.isArray(pair[1])
			)
				continue;
			const values = pair[1].slice(0, 100).map(label).filter(Boolean);
			metadata.set(pair[0], [...(metadata.get(pair[0]) ?? []), ...values]);
		}
		const titles = metadata.get("musicName") ?? metadata.get("title") ?? [];
		const artists = metadata.get("artists") ?? metadata.get("artist") ?? [];
		const platformIds: OnlineTrack["platformIds"] = {};
		for (const platform of PLATFORM_IDS) {
			const values = (metadata.get(platform) ?? []).filter((value) =>
				platform === "qqMusicId" || platform === "spotifyId"
					? /^[\da-z]{1,64}$/i.test(value)
					: !!catalogId(value),
			);
			const current = values.filter((id) => !claimed.has(`${platform}:${id}`));
			for (const id of values) claimed.add(`${platform}:${id}`);
			if (current.length) platformIds[platform] = [...new Set(current)];
		}
		if (!Object.keys(platformIds).length) continue;
		const result = entry(
			{
				provider: "amll-ttml-db",
				id: filename,
				title: titles[0] ?? filename.replace(/\.ttml$/i, ""),
				artists,
				album: metadata.get("album")?.[0] ?? "",
				durationMs: 0,
				platformIds,
			},
			`raw-lyrics/${filename}`,
		);
		result.searchText = normalize(
			`${titles.join(" ")} ${artists.join(" ")} ${(metadata.get("album") ?? []).join(" ")}`,
		);
		entries.push(result);
	}
	if (!entries.length) throw new Error("Invalid AMLL TTML DB index");
	return entries;
}

/** Enforce the byte cap while streaming, rather than after allocating a huge body. */
async function readBytes(
	response: Response,
	maximum: number,
): Promise<Uint8Array<ArrayBuffer>> {
	const declared = Number(response.headers.get("content-length"));
	if (declared > maximum) {
		await response.body?.cancel();
		throw new Error("Repository response is too large");
	}
	if (!response.body) return new Uint8Array();
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let length = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			length += value.byteLength;
			if (length > maximum) {
				await reader.cancel();
				throw new Error("Repository response is too large");
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	const bytes = new Uint8Array(length);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return bytes;
}

export class RepositorySources {
	private readonly indexes = new Map<
		RepositoryProvider,
		{ expires: number; entries: RepositoryEntry[]; root: string }
	>();

	constructor(
		private readonly request: typeof fetch = (...args) => fetch(...args),
		private readonly now: () => number = () => Date.now(),
	) {}

	private async download(
		url: string,
		maximum: number,
		signal: AbortSignal,
	): Promise<Uint8Array<ArrayBuffer>> {
		signal.throwIfAborted();
		const response = await this.request(url, {
			signal,
			credentials: "omit",
			cache: "no-cache",
			referrerPolicy: "no-referrer",
		});
		if (!response.ok)
			throw new Error(`TTML repository: HTTP ${response.status}`);
		const bytes = await readBytes(response, maximum);
		signal.throwIfAborted();
		return bytes;
	}

	private async getIndex(
		provider: RepositoryProvider,
		signal: AbortSignal,
	): Promise<RepositoryEntry[]> {
		signal.throwIfAborted();
		const cached = this.indexes.get(provider);
		if (cached && cached.expires > this.now()) return cached.entries;
		let parsed: RepositoryEntry[] = [];
		const { root } = await this.downloadFrom(
			REPOSITORY_ROOTS[provider],
			provider === "am-lyrics"
				? "index.json"
				: "metadata/raw-lyrics-index.jsonl",
			MAX_INDEX_BYTES,
			signal,
			(bytes) => {
				const content = new TextDecoder().decode(bytes);
				parsed =
					provider === "am-lyrics"
						? parseAmLyricsIndex(JSON.parse(content))
						: parseAmllIndex(content);
			},
		);
		const entries = [
			...new Map(parsed.map((item) => [item.track.id, item])).values(),
		];
		signal.throwIfAborted();
		this.indexes.set(provider, {
			expires: this.now() + INDEX_TTL,
			entries,
			root,
		});
		return entries;
	}

	private async downloadFrom(
		roots: readonly string[],
		path: string,
		maximum: number,
		signal: AbortSignal,
		validate?: (bytes: Uint8Array<ArrayBuffer>) => void,
	): Promise<{ bytes: Uint8Array<ArrayBuffer>; root: string }> {
		let lastError: unknown;
		for (const root of roots) {
			try {
				const bytes = await boundedRequest(
					(requestSignal) =>
						this.download(`${root}${path}`, maximum, requestSignal),
					signal,
					10_000,
				);
				validate?.(bytes);
				return { bytes, root };
			} catch (error) {
				signal.throwIfAborted();
				lastError = error;
			}
		}
		throw lastError;
	}

	async search(
		provider: RepositoryProvider,
		query: string,
		page: number,
		signal: AbortSignal,
	): Promise<OnlineSearchPage> {
		if (!Number.isSafeInteger(page) || page < 1)
			throw new Error("Invalid page");
		const keyword = normalize(query);
		if (!keyword) return { tracks: [], page, hasMore: false };
		const entries = await this.getIndex(provider, signal);
		const tokens = keyword.split(" ");
		const idQuery = /^\d+$/.test(keyword);
		const matches = entries.filter(({ track, searchText }) => {
			const idMatch = Object.values(track.platformIds ?? {}).some((ids) =>
				ids.includes(idQuery ? keyword : query.trim()),
			);
			return (
				idMatch ||
				(idQuery
					? normalize(track.title) === keyword
					: tokens.every((token) => searchText.includes(token)))
			);
		});
		const offset = (page - 1) * PAGE_SIZE;
		return {
			page,
			hasMore: offset + PAGE_SIZE < matches.length,
			tracks: matches
				.slice(offset, offset + PAGE_SIZE)
				.map(({ track }) => structuredClone(track)),
		};
	}

	async fetchLyrics(
		track: OnlineTrack,
		signal: AbortSignal,
	): Promise<OnlineLyrics> {
		if (!isRepositoryProvider(track.provider))
			throw new Error("Invalid TTML source");
		const entries = await this.getIndex(track.provider, signal);
		const item = entries.find((item) => item.track.id === track.id);
		if (!item) throw new Error("Track no longer exists in the TTML repository");
		const path = item.path.split("/").map(encodeURIComponent).join("/");
		const configuredRoots = REPOSITORY_ROOTS[track.provider];
		const preferredRoot =
			this.indexes.get(track.provider)?.root ?? configuredRoots[0];
		const roots = [...new Set([preferredRoot, ...configuredRoots])];
		const { bytes } = await this.downloadFrom(
			roots,
			path,
			MAX_TTML_BYTES,
			signal,
		);
		if (item.sizeBytes !== undefined && bytes.byteLength !== item.sizeBytes) {
			this.indexes.delete(track.provider);
			throw new Error(
				"TTML file size does not match its index; retry after the repository updates",
			);
		}
		if (item.sha256) {
			const digest = await crypto.subtle.digest("SHA-256", bytes);
			const actual = Array.from(new Uint8Array(digest), (byte) =>
				byte.toString(16).padStart(2, "0"),
			).join("");
			if (actual !== item.sha256) {
				this.indexes.delete(track.provider);
				throw new Error("TTML file checksum does not match its index");
			}
		}
		signal.throwIfAborted();
		return {
			original: {
				format: "ttml",
				content: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
			},
		};
	}
}

const repositorySources = new RepositorySources();

export const searchRepository = (
	provider: RepositoryProvider,
	query: string,
	page: number,
	signal: AbortSignal,
) => repositorySources.search(provider, query, page, signal);

export const fetchRepositoryLyrics = (
	track: OnlineTrack,
	signal: AbortSignal,
) => repositorySources.fetchLyrics(track, signal);
