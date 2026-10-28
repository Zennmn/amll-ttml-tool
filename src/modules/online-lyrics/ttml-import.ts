// SPDX-License-Identifier: GPL-3.0-only

import { uid } from "uid";
import type { AmllLyricResult } from "$/modules/ttml-processor/types";
import type { TTMLLyric, TTMLMetadata } from "$/types/ttml";
import { convertOnlineLyrics, OnlineLyricsConversionError } from "./adapter";
import type { OnlineLyrics, OnlinePlatformId, OnlineTrack } from "./types";

const MAX_TTML_CONTENT_BYTES = 2 * 1024 * 1024;
const XML_DECLARATION_OR_ENTITY = /<!DOCTYPE\b|<!ENTITY\b/i;
const TTML_ROOT = /^<(?:[A-Za-z_][\w.-]*:)?tt(?:\s|>)/;
const PLATFORM_METADATA_KEYS = [
	"appleMusicId",
	"ncmMusicId",
	"qqMusicId",
	"spotifyId",
] as const satisfies readonly OnlinePlatformId[];

type TtmlToAmll = typeof import("$/modules/ttml-processor")["ttmlToAmll"];

function parserMessage(value: unknown): string {
	if (typeof value === "object" && value !== null && "message" in value) {
		const message = value.message;
		if (typeof message === "string") {
			return message.replace(/\s+/g, " ").trim().slice(0, 512);
		}
	}
	return value instanceof Error ? value.message.slice(0, 512) : "";
}

function ttmlParserError(cause: unknown): OnlineLyricsConversionError {
	const detail = parserMessage(cause);
	return new OnlineLyricsConversionError(
		detail ? `Invalid TTML lyrics: ${detail}` : "Invalid TTML lyrics",
		{ cause },
	);
}

function skipXmlProlog(content: string): string {
	let rest = content.replace(/^\uFEFF/, "").trimStart();
	for (;;) {
		if (rest.startsWith("<?")) {
			const end = rest.indexOf("?>");
			if (end < 0) return rest;
			rest = rest.slice(end + 2).trimStart();
			continue;
		}
		if (rest.startsWith("<!--")) {
			const end = rest.indexOf("-->");
			if (end < 0) return rest;
			rest = rest.slice(end + 3).trimStart();
			continue;
		}
		return rest;
	}
}

function validateTtmlContent(content: unknown): asserts content is string {
	if (typeof content !== "string" || content.trim().length === 0) {
		throw new OnlineLyricsConversionError("TTML lyrics are empty");
	}
	const byteLength =
		content.length > MAX_TTML_CONTENT_BYTES
			? Number.POSITIVE_INFINITY
			: new TextEncoder().encode(content).byteLength;
	if (byteLength > MAX_TTML_CONTENT_BYTES) {
		throw new OnlineLyricsConversionError(
			"TTML lyrics exceed the supported size limit",
		);
	}
	if (XML_DECLARATION_OR_ENTITY.test(content)) {
		throw new OnlineLyricsConversionError(
			"TTML lyrics must not contain document type or entity declarations",
		);
	}
	if (!TTML_ROOT.test(skipXmlProlog(content))) {
		throw new OnlineLyricsConversionError("Lyrics are not a TTML document");
	}
}

function normalizeAmllLyricResult(amllResult: AmllLyricResult): TTMLLyric {
	return {
		metadata: amllResult.metadata.map((meta) => ({
			...meta,
			value: [...meta.value],
		})),
		lyricLines: amllResult.lyricLines.map((line) => ({
			...line,
			words: line.words.map((word) => ({
				...word,
				id: uid(),
				obscene: word.obscene ?? false,
				emptyBeat: word.emptyBeat ?? 0,
			})),
			ignoreSync: false,
			id: uid(),
		})),
	};
}

function normalizedValues(values: readonly unknown[] | undefined): string[] {
	if (!Array.isArray(values)) return [];
	return [
		...new Set(
			values
				.filter((value): value is string => typeof value === "string")
				.map((value) => value.trim())
				.filter(Boolean),
		),
	];
}

function hasMetadataValue(metadata: TTMLMetadata[], key: string): boolean {
	return metadata.some(
		(meta) =>
			meta.key === key &&
			meta.value.some((value) => typeof value === "string" && value.trim()),
	);
}

function addIndexMetadataIfMissing(
	metadata: TTMLMetadata[],
	key: string,
	values: readonly unknown[] | undefined,
): void {
	if (hasMetadataValue(metadata, key)) return;
	const normalized = normalizedValues(values);
	if (normalized.length > 0) metadata.push({ key, value: normalized });
}

function mergeTrackMetadata(
	track: OnlineTrack,
	metadata: TTMLMetadata[],
): TTMLMetadata[] {
	addIndexMetadataIfMissing(metadata, "musicName", [track.title]);
	addIndexMetadataIfMissing(metadata, "artists", track.artists);
	addIndexMetadataIfMissing(metadata, "album", [track.album]);

	for (const key of PLATFORM_METADATA_KEYS) {
		addIndexMetadataIfMissing(metadata, key, track.platformIds?.[key]);
	}
	return metadata;
}

function hasLyricContent(result: AmllLyricResult): boolean {
	return result.lyricLines.some(
		(line) =>
			line.words.some(
				(word) => typeof word.word === "string" && word.word.trim().length > 0,
			) ||
			line.translatedLyric.trim().length > 0 ||
			line.romanLyric.trim().length > 0,
	);
}

/**
 * Converts an online result for the editor preview. TTML stays on the TTML
 * parser path so its line and word timing, annotations, and roles are retained.
 * `durationMs` applies only to provider formats handled by the LRC adapter.
 *
 * The fourth argument is a test seam for loading the bundled parser directly in
 * Node. Production callers omit it and use the application's lazy parser import.
 */
export async function convertOnlineLyricsForPreview(
	track: OnlineTrack,
	bundle: OnlineLyrics,
	durationMs?: number,
	ttmlToAmllOverride?: TtmlToAmll,
): Promise<TTMLLyric> {
	const original = (bundle as OnlineLyrics | null | undefined)?.original;
	if (original?.format !== "ttml") {
		return convertOnlineLyrics(track, bundle, durationMs);
	}

	try {
		validateTtmlContent(original.content);
		const ttmlToAmll =
			ttmlToAmllOverride ??
			(await import("$/modules/ttml-processor")).ttmlToAmll;
		const parsed = ttmlToAmll(original.content);
		if (!parsed.success) throw ttmlParserError(parsed.error);
		if (
			!Array.isArray(parsed.data.lyricLines) ||
			!Array.isArray(parsed.data.metadata)
		) {
			throw new OnlineLyricsConversionError(
				"TTML lyrics have an invalid parser result",
			);
		}
		if (!hasLyricContent(parsed.data)) {
			throw new OnlineLyricsConversionError(
				"TTML lyrics contain no lyric text",
			);
		}

		const normalized = normalizeAmllLyricResult(parsed.data);
		normalized.metadata = mergeTrackMetadata(track, normalized.metadata);
		return normalized;
	} catch (cause) {
		if (cause instanceof OnlineLyricsConversionError) throw cause;
		throw new OnlineLyricsConversionError(
			"Unable to convert online TTML lyrics",
			{
				cause,
			},
		);
	}
}
