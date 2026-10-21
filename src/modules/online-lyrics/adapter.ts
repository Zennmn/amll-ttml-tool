// SPDX-FileCopyrightText: Copyright (C) 2024-2025 沉默の金 <cmzj@cmzj.org>
// SPDX-License-Identifier: GPL-3.0-only
// KRC and provider-channel rules adapted from LDDC for the AMLL editor model.

import {
	type LyricLine as ParsedAmllLine,
	parseEslrc,
	parseQrc,
	parseYrc,
} from "@applemusic-like-lyrics/lyric";
import {
	type LyricLine,
	newLyricLine,
	newLyricWord,
	type TTMLLyric,
	type TTMLMetadata,
} from "$/types/ttml";
import type {
	LyricChannel,
	LyricFormat,
	OnlineLyrics,
	OnlineProviderId,
	OnlineTrack,
} from "./types";

const MAX_CONTENT_LENGTH = 16 * 1024 * 1024;
const MAX_LYRIC_LINES = 5_000;
const MAX_OFFSET_MS = 24 * 60 * 60 * 1_000;
const TIME_MATCH_TOLERANCE_MS = 300;
const ORIGINAL_LRC_MATCH_TOLERANCE_MS = 2_000;
const DEFAULT_LAST_LINE_DURATION_MS = 10_000;
/** AMLL's LRC parser uses this as an open-ended final line placeholder. */
const AMLL_LRC_MAX_TIMESTAMP_MS = 59_999_999;

const PROVIDERS = new Set<OnlineProviderId>([
	"netease",
	"qq",
	"kugou",
	"lrclib",
]);
const FORMATS = new Set<LyricFormat>(["lrc", "qrc", "yrc", "krc", "plain"]);

type NullableTime = number | null;

interface InternalWord {
	text: string;
	startTime: NullableTime;
	endTime: NullableTime;
	romanWord: string;
}

interface InternalLine {
	/** The line position in the provider channel, before empty lines are removed. */
	sourceIndex: number;
	startTime: NullableTime;
	endTime: NullableTime;
	text: string;
	words: InternalWord[];
	translatedLyric: string;
	romanLyric: string;
	isBG: boolean;
	isDuet: boolean;
}

interface ParsedChannel {
	format: LyricFormat;
	lines: InternalLine[];
}

export class OnlineLyricsConversionError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "OnlineLyricsConversionError";
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cleanText(value: string): string {
	return value.replace(/\r\n?/g, "\n").trim();
}

function finitePositive(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) && value > 0
		? Math.round(value)
		: null;
}

function applyOffset(time: NullableTime, offsetMs: number): NullableTime {
	if (time === null) return null;
	return Math.max(0, Math.round(time + offsetMs));
}

function validateLineBudget(length: number, context: string): void {
	if (length > MAX_LYRIC_LINES) {
		throw new OnlineLyricsConversionError(
			`${context} contains too many lyric lines`,
		);
	}
}

function decodeXmlEntities(value: string): string {
	return value.replace(
		/&(?:#(\d+)|#x([\da-f]+)|amp|lt|gt|quot|apos);/gi,
		(entity, decimal: string | undefined, hex: string | undefined) => {
			if (decimal) return String.fromCodePoint(Number(decimal));
			if (hex) return String.fromCodePoint(Number.parseInt(hex, 16));
			switch (entity.toLowerCase()) {
				case "&amp;":
					return "&";
				case "&lt;":
					return "<";
				case "&gt;":
					return ">";
				case "&quot;":
					return '"';
				case "&apos;":
					return "'";
				default:
					return entity;
			}
		},
	);
}

function normalizeChannelContent(
	rawContent: string,
	format: LyricFormat,
): string {
	if (rawContent.length > MAX_CONTENT_LENGTH) {
		throw new OnlineLyricsConversionError(
			"Lyric content exceeds the supported size limit",
		);
	}

	let value = rawContent.replace(/^\uFEFF/, "").trim();
	if (!value) return "";
	if (format === "krc" && value.startsWith("krc18")) {
		value = value.slice(5).trimStart();
	}

	const lyricContentAttribute = value.match(
		/\bLyricContent\s*=\s*(["'])([\s\S]*?)\1/i,
	);
	if (lyricContentAttribute?.[2]) {
		value = lyricContentAttribute[2];
	} else {
		const cdata = value.match(/<!\[CDATA\[([\s\S]*?)\]\]>/i);
		if (cdata?.[1]) value = cdata[1];
	}

	return decodeXmlEntities(value)
		.replace(/\\r\\n/g, "\n")
		.replace(/\\n/g, "\n")
		.replace(/\\t/g, "\t")
		.replace(/\r\n?/g, "\n");
}

function extractOffset(content: string): number {
	const pattern = /\[\s*offset\s*:\s*([+-]?\d+)\s*\]/gi;
	let offset = 0;
	for (const match of content.matchAll(pattern)) {
		const parsed = Number(match[1]);
		if (!Number.isSafeInteger(parsed) || Math.abs(parsed) > MAX_OFFSET_MS) {
			throw new OnlineLyricsConversionError("Invalid LRC offset tag");
		}
		offset = parsed;
	}
	return offset;
}

function isMetadataLine(value: string): boolean {
	return /^\[[^[\]:]+:[^\]]*\]$/.test(value);
}

function parsePlainLines(content: string): InternalLine[] {
	const lines: InternalLine[] = [];
	for (const rawLine of content.split("\n")) {
		const text = cleanText(rawLine);
		if (!text) continue;
		lines.push({
			sourceIndex: lines.length,
			startTime: null,
			endTime: null,
			text,
			words: [{ text, startTime: null, endTime: null, romanWord: "" }],
			translatedLyric: "",
			romanLyric: "",
			isBG: false,
			isDuet: false,
		});
	}
	validateLineBudget(lines.length, "Plain lyric channel");
	return lines;
}

function parseLrcTimestamp(
	minutesText: string,
	secondsText: string,
	fractionText: string | undefined,
): number {
	const minutes = Number.parseInt(minutesText, 10);
	const seconds = Number.parseInt(secondsText, 10);
	const fraction = fractionText ? Number(`0.${fractionText}`) : 0;
	return Math.round((minutes * 60 + seconds + fraction) * 1_000);
}

function parsedLineToInternal(
	line: ParsedAmllLine,
	sourceIndex: number,
	offset: number,
	treatMaxTimestampAsMissing = false,
): InternalLine {
	const words = line.words
		.map((word) => ({
			text: word.word ?? "",
			startTime:
				typeof word.startTime === "number" && Number.isFinite(word.startTime)
					? applyOffset(word.startTime, offset)
					: null,
			endTime:
				typeof word.endTime === "number" &&
				Number.isFinite(word.endTime) &&
				!(
					treatMaxTimestampAsMissing &&
					word.endTime === AMLL_LRC_MAX_TIMESTAMP_MS
				)
					? applyOffset(word.endTime, offset)
					: null,
			romanWord: word.romanWord ?? "",
		}))
		.filter((word) => word.text.length > 0 || word.startTime !== null);
	const startTime =
		typeof line.startTime === "number" && Number.isFinite(line.startTime)
			? applyOffset(line.startTime, offset)
			: null;
	const endTime =
		typeof line.endTime === "number" &&
		Number.isFinite(line.endTime) &&
		!(treatMaxTimestampAsMissing && line.endTime === AMLL_LRC_MAX_TIMESTAMP_MS)
			? applyOffset(line.endTime, offset)
			: null;
	return {
		sourceIndex,
		startTime,
		endTime,
		text: words.map((word) => word.text).join(""),
		words,
		translatedLyric: line.translatedLyric ?? "",
		romanLyric: line.romanLyric ?? "",
		isBG: Boolean(line.isBG),
		isDuet: Boolean(line.isDuet),
	};
}

function parseEnhancedLrc(
	content: string,
	offset: number,
): InternalLine[] | null {
	if (!/<\d+:\d+(?:[.:]\d+)?>/.test(content)) return null;
	try {
		const parsed = parseEslrc(content);
		if (parsed.length === 0) return null;
		validateLineBudget(parsed.length, "Enhanced LRC channel");
		return parsed.map((line, index) =>
			parsedLineToInternal(line, index, offset, true),
		);
	} catch (cause) {
		throw new OnlineLyricsConversionError(
			"Unable to parse enhanced LRC content",
			{ cause },
		);
	}
}

function parseLrcLines(content: string, offset: number): InternalLine[] {
	const enhanced = parseEnhancedLrc(content, offset);
	if (enhanced) return enhanced;

	const lines: InternalLine[] = [];
	let sourceIndex = 0;
	for (const rawLine of content.split("\n")) {
		const line = rawLine.trim();
		if (!line) continue;

		const timestamps = Array.from(
			line.matchAll(/\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g),
		);
		if (timestamps.length === 0) {
			if (isMetadataLine(line)) continue;
			const text = cleanText(line);
			if (!text) continue;
			lines.push({
				sourceIndex: sourceIndex++,
				startTime: null,
				endTime: null,
				text,
				words: [{ text, startTime: null, endTime: null, romanWord: "" }],
				translatedLyric: "",
				romanLyric: "",
				isBG: false,
				isDuet: false,
			});
			continue;
		}

		const text = line
			.replace(/\[\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?\]/g, "")
			.trim();
		for (const timestamp of timestamps) {
			const startTime = applyOffset(
				parseLrcTimestamp(timestamp[1], timestamp[2], timestamp[3]),
				offset,
			);
			lines.push({
				sourceIndex: sourceIndex++,
				startTime,
				endTime: null,
				text,
				words: text
					? [
							{
								text,
								startTime,
								endTime: null,
								romanWord: "",
							},
						]
					: [],
				translatedLyric: "",
				romanLyric: "",
				isBG: false,
				isDuet: false,
			});
		}
	}
	validateLineBudget(lines.length, "LRC channel");
	return lines;
}

function parsedAmllToInternal(
	parsed: ParsedAmllLine[],
	offset: number,
): InternalLine[] {
	validateLineBudget(parsed.length, "Timed lyric channel");
	return parsed.map((line, index) => parsedLineToInternal(line, index, offset));
}

function parseQrcLines(content: string, offset: number): InternalLine[] {
	try {
		const parsed = parseQrc(content);
		if (parsed.length > 0) return parsedAmllToInternal(parsed, offset);
	} catch (cause) {
		throw new OnlineLyricsConversionError("Unable to parse QRC content", {
			cause,
		});
	}
	if (/\[\d+:\d+(?:[.:]\d+)?\]/.test(content)) {
		return parseLrcLines(content, offset);
	}
	return parsePlainLines(content);
}

function parseYrcLines(content: string, offset: number): InternalLine[] {
	try {
		const parsed = parseYrc(content);
		if (parsed.length > 0) return parsedAmllToInternal(parsed, offset);
	} catch (cause) {
		throw new OnlineLyricsConversionError("Unable to parse YRC content", {
			cause,
		});
	}
	if (/\[\d+:\d+(?:[.:]\d+)?\]/.test(content)) {
		return parseLrcLines(content, offset);
	}
	return parsePlainLines(content);
}

function parseKrcWords(
	lineContent: string,
	lineStart: number,
	lineEnd: number,
): InternalWord[] {
	const markers = Array.from(lineContent.matchAll(/<(\d+),(\d+),\d+>/g));
	if (markers.length === 0) {
		const text = lineContent.replace(/^\[\d+,\d+\]/, "").trim();
		return text
			? [{ text, startTime: lineStart, endTime: lineEnd, romanWord: "" }]
			: [];
	}

	const words: InternalWord[] = [];
	for (let index = 0; index < markers.length; index++) {
		const marker = markers[index];
		const next = markers[index + 1];
		const startOffset = Number(marker[1]);
		const duration = Number(marker[2]);
		if (!Number.isFinite(startOffset) || !Number.isFinite(duration)) continue;
		const text = lineContent
			.slice(
				(marker.index ?? 0) + marker[0].length,
				next?.index ?? lineContent.length,
			)
			.replace(/^\[\d+,\d+\]/, "");
		words.push({
			text,
			startTime: lineStart + startOffset,
			endTime: lineStart + startOffset + duration,
			romanWord: "",
		});
	}
	return words;
}

function decodeBase64Utf8(encodedValue: string): string {
	const compact = encodedValue.trim().replace(/\s+/g, "");
	if (!compact || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(compact)) {
		throw new OnlineLyricsConversionError("Invalid KRC language base64 data");
	}
	const normalized = compact.replace(/-/g, "+").replace(/_/g, "/");
	const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
	try {
		const binary = globalThis.atob(padded);
		const bytes = Uint8Array.from(binary, (character) =>
			character.charCodeAt(0),
		);
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch (cause) {
		throw new OnlineLyricsConversionError("Invalid KRC language base64 data", {
			cause,
		});
	}
}

function normalizeKrcRows(value: unknown): string[][] | null {
	if (!Array.isArray(value)) return null;
	return value.map((row) => {
		if (typeof row === "string") return [row];
		if (!Array.isArray(row)) return [];
		return row.map((part) => (typeof part === "string" ? part : ""));
	});
}

function krcRowText(row: string[] | undefined): string {
	return row?.join("") ?? "";
}

function applyKrcLanguage(
	lines: InternalLine[],
	encoded: string | undefined,
): void {
	if (!encoded?.trim()) return;
	let payload: unknown;
	try {
		payload = JSON.parse(decodeBase64Utf8(encoded));
	} catch (cause) {
		if (cause instanceof OnlineLyricsConversionError) throw cause;
		throw new OnlineLyricsConversionError(
			"KRC language metadata is not valid JSON",
			{ cause },
		);
	}
	if (!isRecord(payload) || !Array.isArray(payload.content)) {
		throw new OnlineLyricsConversionError(
			"KRC language metadata has an invalid structure",
		);
	}

	const nonEmptyLines = lines.filter((line) => line.text.length > 0);
	const compactOrdinals = new Map<InternalLine, number>();
	nonEmptyLines.forEach((line, index) => {
		compactOrdinals.set(line, index);
	});

	for (const entry of payload.content) {
		if (!isRecord(entry)) continue;
		const rows = normalizeKrcRows(entry.lyricContent);
		if (!rows || rows.length === 0) continue;
		const directAlignment = rows.length === lines.length;
		const compactAlignment = rows.length === nonEmptyLines.length;

		for (const line of lines) {
			const compactIndex = compactOrdinals.get(line);
			let row: string[] | undefined;
			if (directAlignment) {
				row = rows[line.sourceIndex];
			} else if (compactAlignment && compactIndex !== undefined) {
				row = rows[compactIndex];
			} else if (
				compactIndex !== undefined &&
				rows.length < nonEmptyLines.length
			) {
				// Short language arrays are missing tail entries. Mapping the
				// available prefix keeps a missing row from shifting later lines.
				row = rows[compactIndex];
			}
			if (!row) continue;

			if (entry.type === 0) {
				if (line.words.length === row.length) {
					for (let index = 0; index < row.length; index++) {
						line.words[index].romanWord = row[index];
					}
				} else {
					const romanText = row.join("").trim();
					if (romanText && !line.romanLyric) line.romanLyric = romanText;
				}
			} else if (entry.type === 1) {
				const translation = krcRowText(row).trim();
				if (translation && !line.translatedLyric) {
					line.translatedLyric = translation;
				}
			}
		}
	}
}

function parseKrcLines(content: string, offset: number): InternalLine[] {
	const lines: InternalLine[] = [];
	const tags = new Map<string, string>();
	let sourceIndex = 0;

	for (const rawLine of content.split("\n")) {
		const line = rawLine.trim();
		if (!line.startsWith("[")) continue;

		const tag = line.match(/^\[([A-Za-z_][\w.-]*):([\s\S]*)\]$/);
		if (tag) {
			tags.set(tag[1].toLowerCase(), tag[2]);
			continue;
		}

		const timing = line.match(/^\[(\d+),(\d+)\](.*)$/);
		if (!timing) continue;
		const rawStart = Number(timing[1]);
		const rawDuration = Number(timing[2]);
		if (!Number.isFinite(rawStart) || !Number.isFinite(rawDuration)) {
			throw new OnlineLyricsConversionError("Invalid KRC line timing");
		}

		const startTime = applyOffset(rawStart, offset);
		const endTime = applyOffset(rawStart + rawDuration, offset);
		const words = parseKrcWords(
			timing[3],
			startTime ?? 0,
			endTime ?? startTime ?? 0,
		);
		lines.push({
			sourceIndex: sourceIndex++,
			startTime,
			endTime,
			text: words.map((word) => word.text).join(""),
			words,
			translatedLyric: "",
			romanLyric: "",
			isBG: false,
			isDuet: false,
		});
	}

	validateLineBudget(lines.length, "KRC channel");
	applyKrcLanguage(lines, tags.get("language"));
	return lines;
}

function parseChannel(channel: LyricChannel): ParsedChannel {
	if (!isRecord(channel) || typeof channel.content !== "string") {
		throw new OnlineLyricsConversionError("Invalid lyric channel");
	}
	if (!FORMATS.has(channel.format)) {
		throw new OnlineLyricsConversionError(
			`Unsupported online lyric format: ${String(channel.format)}`,
		);
	}
	const content = normalizeChannelContent(channel.content, channel.format);
	if (!content) return { format: channel.format, lines: [] };
	const offset = extractOffset(content);
	switch (channel.format) {
		case "lrc":
			return { format: channel.format, lines: parseLrcLines(content, offset) };
		case "qrc":
			return { format: channel.format, lines: parseQrcLines(content, offset) };
		case "yrc":
			return { format: channel.format, lines: parseYrcLines(content, offset) };
		case "krc":
			return { format: channel.format, lines: parseKrcLines(content, offset) };
		case "plain":
			return { format: channel.format, lines: parsePlainLines(content) };
		default:
			throw new OnlineLyricsConversionError("Unsupported lyric format");
	}
}

function isOrdinaryLrcChannel(channel: ParsedChannel): boolean {
	return (
		channel.format === "lrc" &&
		channel.lines.every(
			(line) => line.words.filter((word) => word.text.trim()).length <= 1,
		)
	);
}

/** Restore LRCLIB's historical same-timestamp translation/romanization rows. */
function groupLrcLibTimestampRows(lines: InternalLine[]): InternalLine[] {
	const timed = lines
		.filter((line) => line.startTime !== null)
		.sort(
			(left, right) =>
				(left.startTime ?? 0) - (right.startTime ?? 0) ||
				left.sourceIndex - right.sourceIndex,
		);
	const untimed = lines.filter((line) => line.startTime === null);
	const grouped: InternalLine[] = [];

	for (let index = 0; index < timed.length; ) {
		const startTime = timed[index].startTime;
		let nextIndex = index + 1;
		while (
			nextIndex < timed.length &&
			timed[nextIndex].startTime === startTime
		) {
			nextIndex++;
		}
		const rows = timed
			.slice(index, nextIndex)
			.filter((line) => line.text.trim().length > 0);
		index = nextIndex;
		if (rows.length === 0) continue;

		const [main, translation, romanization, ...extras] = rows;
		if (!main.translatedLyric && translation) {
			main.translatedLyric = translation.text.trim();
		}
		if (!main.romanLyric && romanization) {
			main.romanLyric = romanization.text.trim();
		}
		grouped.push(main, ...extras);
	}

	return [...grouped, ...untimed];
}

function applyLrcLibTimestampCompatibility(
	track: OnlineTrack,
	bundle: OnlineLyrics,
	original: ParsedChannel,
): void {
	if (
		track.provider !== "lrclib" ||
		bundle.translation != null ||
		bundle.romanization != null ||
		!isOrdinaryLrcChannel(original)
	) {
		return;
	}
	original.lines = groupLrcLibTimestampRows(original.lines);
}

function comparableText(value: string): string {
	return value.replace(/[(（][^）)]*[）)]|\s+/g, "");
}

function alignTimedLines(
	anchors: InternalLine[],
	targets: InternalLine[],
	toleranceMs: number,
): Map<InternalLine, InternalLine> {
	const timedAnchors = anchors
		.filter((line) => line.startTime !== null && line.text.trim().length > 0)
		.sort(
			(left, right) =>
				(left.startTime ?? 0) - (right.startTime ?? 0) ||
				left.sourceIndex - right.sourceIndex,
		);
	const timedTargets = targets
		.filter((line) => line.startTime !== null && line.text.trim().length > 0)
		.sort(
			(left, right) =>
				(left.startTime ?? 0) - (right.startTime ?? 0) ||
				left.sourceIndex - right.sourceIndex,
		);
	const usedTargets = new Set<InternalLine>();
	const matched = new Map<InternalLine, InternalLine>();

	for (const anchor of timedAnchors) {
		const anchorTime = anchor.startTime;
		if (anchorTime === null) continue;
		let best: InternalLine | null = null;
		let bestDifference = Number.POSITIVE_INFINITY;
		for (const target of timedTargets) {
			const targetTime = target.startTime;
			if (targetTime === null || usedTargets.has(target)) continue;
			if (targetTime < anchorTime - toleranceMs) continue;
			if (targetTime > anchorTime + toleranceMs) break;
			const difference = Math.abs(targetTime - anchorTime);
			if (
				difference < bestDifference ||
				(difference === bestDifference &&
					best !== null &&
					target.sourceIndex < best.sourceIndex)
			) {
				best = target;
				bestDifference = difference;
			}
		}
		if (best) {
			usedTargets.add(best);
			matched.set(anchor, best);
		}
	}
	return matched;
}

function alignUntimedOrSequential(
	anchors: InternalLine[],
	targets: InternalLine[],
	matched: Map<InternalLine, InternalLine>,
	allowSequential: boolean,
): void {
	const remainingAnchors = anchors.filter(
		(line) => !matched.has(line) && line.text.trim().length > 0,
	);
	const usedTargets = new Set(matched.values());
	const remainingTargets = targets.filter(
		(line) => !usedTargets.has(line) && line.text.trim().length > 0,
	);
	if (remainingAnchors.length !== remainingTargets.length) return;
	const targetsAreUntimed = remainingTargets.every(
		(line) => line.startTime === null,
	);
	if (!targetsAreUntimed && !allowSequential) return;

	const sortedAnchors = [...remainingAnchors].sort(
		(left, right) => left.sourceIndex - right.sourceIndex,
	);
	const sortedTargets = [...remainingTargets].sort(
		(left, right) => left.sourceIndex - right.sourceIndex,
	);
	for (let index = 0; index < sortedAnchors.length; index++) {
		matched.set(sortedAnchors[index], sortedTargets[index]);
	}
}

function mapByMatchingText(
	lines: InternalLine[],
	anchors: InternalLine[],
): Map<InternalLine, InternalLine> {
	const used = new Set<InternalLine>();
	const matched = new Map<InternalLine, InternalLine>();
	for (const line of lines) {
		if (line.startTime === null || !line.text.trim()) continue;
		const wantedText = comparableText(line.text);
		if (!wantedText) continue;
		let best: InternalLine | null = null;
		let bestDifference = Number.POSITIVE_INFINITY;
		for (const anchor of anchors) {
			if (used.has(anchor) || comparableText(anchor.text) !== wantedText) {
				continue;
			}
			const difference =
				anchor.startTime === null
					? Number.POSITIVE_INFINITY
					: Math.abs(anchor.startTime - line.startTime);
			if (difference > ORIGINAL_LRC_MATCH_TOLERANCE_MS) continue;
			if (difference < bestDifference) {
				best = anchor;
				bestDifference = difference;
			}
		}
		if (best) {
			used.add(best);
			matched.set(line, best);
		}
	}
	return matched;
}

function attachTranslation(
	line: InternalLine,
	translation: InternalLine | undefined,
): void {
	const text = translation?.text.trim();
	if (text && !line.translatedLyric) line.translatedLyric = text;
}

function attachRomanization(
	line: InternalLine,
	romanization: InternalLine | undefined,
	wordLevel: boolean,
): void {
	if (!romanization) return;
	if (
		wordLevel &&
		romanization.words.length > 1 &&
		line.words.length === romanization.words.length
	) {
		for (let index = 0; index < line.words.length; index++) {
			const romanWord = romanization.words[index].text;
			if (romanWord) line.words[index].romanWord = romanWord;
		}
		return;
	}
	const text = romanization.text.trim();
	if (text && !line.romanLyric) line.romanLyric = text;
}

function applyAuxiliaryChannels(
	original: ParsedChannel,
	translation: ParsedChannel | undefined,
	romanization: ParsedChannel | undefined,
	originalLrc: ParsedChannel | undefined,
	provider: OnlineProviderId,
): void {
	const originalLines = original.lines;
	const translationLines = translation?.lines ?? [];
	const romanizationLines = romanization?.lines ?? [];
	const allowSequential = provider === "qq" || provider === "kugou";

	if (
		provider === "netease" &&
		original.format === "yrc" &&
		originalLrc &&
		originalLrc.lines.length > 0
	) {
		const anchorTranslationMatch = alignTimedLines(
			originalLrc.lines,
			translationLines,
			TIME_MATCH_TOLERANCE_MS,
		);
		const anchorRomanizationMatch = alignTimedLines(
			originalLrc.lines,
			romanizationLines,
			TIME_MATCH_TOLERANCE_MS,
		);
		const originalToAnchor = mapByMatchingText(
			originalLines,
			originalLrc.lines,
		);
		for (const [line, anchor] of originalToAnchor) {
			attachTranslation(line, anchorTranslationMatch.get(anchor));
			attachRomanization(line, anchorRomanizationMatch.get(anchor), true);
		}

		const linesNeedingTranslation = originalLines.filter(
			(line) => !line.translatedLyric && line.text.trim(),
		);
		const usedTranslations = new Set(anchorTranslationMatch.values());
		const remainingTranslations = translationLines.filter(
			(line) => !usedTranslations.has(line),
		);
		const directTranslationMatch = alignTimedLines(
			linesNeedingTranslation,
			remainingTranslations,
			TIME_MATCH_TOLERANCE_MS,
		);
		for (const [line, matched] of directTranslationMatch) {
			attachTranslation(line, matched);
		}

		const linesNeedingRomanization = originalLines.filter(
			(line) =>
				!line.romanLyric &&
				line.words.every((word) => !word.romanWord) &&
				line.text.trim(),
		);
		const usedRomanizations = new Set(anchorRomanizationMatch.values());
		const remainingRomanizations = romanizationLines.filter(
			(line) => !usedRomanizations.has(line),
		);
		const directRomanizationMatch = alignTimedLines(
			linesNeedingRomanization,
			remainingRomanizations,
			TIME_MATCH_TOLERANCE_MS,
		);
		for (const [line, matched] of directRomanizationMatch) {
			attachRomanization(line, matched, true);
		}
		return;
	}

	const translationMatch = alignTimedLines(
		originalLines,
		translationLines,
		TIME_MATCH_TOLERANCE_MS,
	);
	alignUntimedOrSequential(
		originalLines,
		translationLines,
		translationMatch,
		allowSequential,
	);
	for (const [line, matched] of translationMatch) {
		attachTranslation(line, matched);
	}

	const romanizationMatch = alignTimedLines(
		originalLines,
		romanizationLines,
		TIME_MATCH_TOLERANCE_MS,
	);
	alignUntimedOrSequential(
		originalLines,
		romanizationLines,
		romanizationMatch,
		allowSequential,
	);
	for (const [line, matched] of romanizationMatch) {
		attachRomanization(line, matched, true);
	}
}

function resolveDuration(
	track: OnlineTrack,
	bundle: OnlineLyrics,
	override: number | undefined,
): number | null {
	const direct = finitePositive(override);
	if (direct !== null) return direct;
	if (Array.isArray(bundle.candidates)) {
		const selected = bundle.candidates.find(
			(candidate) =>
				candidate.id === bundle.selectedCandidateId &&
				finitePositive(candidate.durationMs) !== null,
		);
		const selectedDuration = finitePositive(selected?.durationMs);
		if (selectedDuration !== null) return selectedDuration;
	}
	return finitePositive(track.durationMs);
}

function finalizeLines(
	lines: InternalLine[],
	durationMs: number | null,
): LyricLine[] {
	const visible = lines.filter(
		(line) =>
			line.text.trim().length > 0 || line.words.some((word) => word.text),
	);
	const timed = visible
		.filter((line) => line.startTime !== null)
		.sort(
			(left, right) =>
				(left.startTime ?? 0) - (right.startTime ?? 0) ||
				left.sourceIndex - right.sourceIndex,
		);
	const untimed = visible
		.filter((line) => line.startTime === null)
		.sort((left, right) => left.sourceIndex - right.sourceIndex);
	const ordered = [...timed, ...untimed];
	const distinctStarts = Array.from(
		new Set(timed.map((line) => line.startTime as number)),
	).sort((left, right) => left - right);
	const maximumStart = distinctStarts.at(-1) ?? null;

	return ordered.map((line) => {
		const startTime = line.startTime;
		if (startTime === null) {
			const output = newLyricLine();
			const word = newLyricWord();
			word.word = line.text;
			output.words = [word];
			output.translatedLyric = line.translatedLyric;
			output.romanLyric = line.romanLyric;
			return output;
		}

		const nextStart =
			distinctStarts.find((candidate) => candidate > startTime) ?? null;
		const explicitEnd =
			line.endTime !== null && line.endTime >= startTime ? line.endTime : null;
		const fallbackEnd =
			startTime === maximumStart && durationMs !== null
				? Math.max(startTime + 1, durationMs)
				: (nextStart ?? startTime + DEFAULT_LAST_LINE_DURATION_MS);
		let endTime = explicitEnd ?? fallbackEnd;
		if (endTime < startTime) endTime = startTime;

		const output = newLyricLine();
		output.startTime = startTime;
		output.endTime = endTime;
		output.translatedLyric = line.translatedLyric;
		output.romanLyric = line.romanLyric;
		output.isBG = line.isBG;
		output.isDuet = line.isDuet;
		output.words = line.words
			.filter((word) => word.text.length > 0 || word.startTime !== null)
			.map((word) => {
				const outputWord = newLyricWord();
				const wordStart = word.startTime ?? startTime;
				const rawWordEnd = word.endTime ?? endTime;
				outputWord.word = word.text;
				outputWord.startTime = Math.max(0, wordStart);
				outputWord.endTime = Math.max(outputWord.startTime, rawWordEnd);
				outputWord.romanWord = word.romanWord;
				return outputWord;
			});
		if (output.words.length === 0) {
			const outputWord = newLyricWord();
			outputWord.word = line.text;
			outputWord.startTime = startTime;
			outputWord.endTime = endTime;
			output.words = [outputWord];
		}
		return output;
	});
}

function addMetadataValue(
	metadata: TTMLMetadata[],
	key: string,
	values: string[],
): void {
	const normalized = Array.from(
		new Set(values.map((value) => value.trim()).filter(Boolean)),
	);
	if (normalized.length > 0) metadata.push({ key, value: normalized });
}

function buildMetadata(track: OnlineTrack): TTMLMetadata[] {
	const metadata: TTMLMetadata[] = [];
	addMetadataValue(metadata, "musicName", [track.title]);
	addMetadataValue(metadata, "artists", track.artists);
	addMetadataValue(metadata, "album", [track.album]);

	switch (track.provider) {
		case "netease":
			addMetadataValue(metadata, "ncmMusicId", [track.id]);
			break;
		case "qq":
			addMetadataValue(metadata, "qqMusicId", [track.mid ?? track.id]);
			break;
		case "kugou":
			addMetadataValue(metadata, "kugouMusicId", [track.id]);
			break;
		case "lrclib":
			addMetadataValue(metadata, "lrclibId", [track.id]);
			break;
	}
	return metadata;
}

function validateTrack(track: OnlineTrack): void {
	if (!isRecord(track)) {
		throw new OnlineLyricsConversionError("Invalid online track");
	}
	if (!PROVIDERS.has(track.provider)) {
		throw new OnlineLyricsConversionError("Invalid online track provider");
	}
	if (
		typeof track.id !== "string" ||
		typeof track.title !== "string" ||
		!Array.isArray(track.artists) ||
		track.artists.some((artist) => typeof artist !== "string") ||
		typeof track.album !== "string"
	) {
		throw new OnlineLyricsConversionError("Invalid online track metadata");
	}
}

function convertOnlineLyricsUnchecked(
	track: OnlineTrack,
	bundle: OnlineLyrics,
	durationOverride: number | undefined,
): TTMLLyric {
	validateTrack(track);
	if (!isRecord(bundle) || !isRecord(bundle.original)) {
		throw new OnlineLyricsConversionError("Invalid online lyric bundle");
	}

	const original = parseChannel(bundle.original);
	applyLrcLibTimestampCompatibility(track, bundle, original);
	const translation = bundle.translation
		? parseChannel(bundle.translation)
		: undefined;
	const romanization = bundle.romanization
		? parseChannel(bundle.romanization)
		: undefined;
	const originalLrc =
		typeof bundle.originalLrc === "string" && bundle.originalLrc.trim()
			? parseChannel({ format: "lrc", content: bundle.originalLrc })
			: undefined;

	applyAuxiliaryChannels(
		original,
		translation,
		romanization,
		originalLrc,
		track.provider,
	);

	let lines = original.lines;
	if (lines.length === 0 && translation?.lines.length) {
		// Some providers can return only a translated track. Keep usable text
		// instead of producing an empty import.
		lines = translation.lines;
	}
	return {
		metadata: buildMetadata(track),
		lyricLines: finalizeLines(
			lines,
			resolveDuration(track, bundle, durationOverride),
		),
	};
}

/**
 * Converts decrypted provider lyric tracks into the editor's TTML model.
 *
 * Each source channel is parsed independently. Timestamp based translation
 * matching is bounded; a missing translation remains missing instead of being
 * copied from an arbitrarily distant line. Language line indices are retained
 * internally so empty source rows cannot shift later translations.
 */
export function convertOnlineLyrics(
	track: OnlineTrack,
	bundle: OnlineLyrics,
	durationMs?: number,
): TTMLLyric {
	try {
		return convertOnlineLyricsUnchecked(track, bundle, durationMs);
	} catch (cause) {
		if (cause instanceof OnlineLyricsConversionError) throw cause;
		throw new OnlineLyricsConversionError("Unable to convert online lyrics", {
			cause,
		});
	}
}
