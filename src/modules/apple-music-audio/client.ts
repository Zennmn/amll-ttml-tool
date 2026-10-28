import { isTauri } from "@tauri-apps/api/core";

export const AUDIO_ERROR_CODES = [
	"desktopOnly",
	"notAuthenticated",
	"runtimeMissing",
	"invalidLink",
	"busy",
	"network",
	"timeout",
	"unavailable",
	"subscriptionRequired",
	"invalidAudio",
	"cancelled",
	"stale",
	"failed",
] as const;
export type AudioErrorCode = (typeof AUDIO_ERROR_CODES)[number];
export class AppleMusicAudioError extends Error {
	constructor(public readonly code: AudioErrorCode) {
		super(code);
	}
}
export interface AppleMusicAuth {
	authenticated: boolean;
	loginOpen: boolean;
	runtimeReady: boolean;
}
export type JobState =
	| "queued"
	| "authenticating"
	| "downloading"
	| "processing"
	| "ready"
	| "cancelled"
	| "error";
export interface AudioJob {
	id: string;
	state: JobState;
	progress: number | null;
	bytesReceived: number | null;
	totalBytes: number | null;
	fileName: string | null;
	errorCode: AudioErrorCode | null;
}
type Invoke = <T>(
	command: string,
	args?: Record<string, unknown>,
) => Promise<T>;
export interface AppleMusicAudioClient {
	status(): Promise<AppleMusicAuth>;
	login(): Promise<AppleMusicAuth>;
	logout(): Promise<AppleMusicAuth>;
	start(url: string): Promise<AudioJob>;
	job(jobId: string): Promise<AudioJob>;
	cancel(jobId: string): Promise<void>;
	release(jobId: string): Promise<void>;
	read(jobId: string): Promise<ArrayBuffer>;
}
const MAX_AUDIO = 64 * 1024 * 1024;
export const isAppleMusicAudioDesktop = () =>
	typeof window !== "undefined" && isTauri();
export function audioErrorCode(error: unknown): AudioErrorCode {
	if (error instanceof AppleMusicAudioError) return error.code;
	return typeof error === "string" &&
		(AUDIO_ERROR_CODES as readonly string[]).includes(error)
		? (error as AudioErrorCode)
		: "failed";
}

export function canonicalAudioLink(raw: string): string {
	try {
		if (raw.length > 2048) throw new Error();
		const url = new URL(raw.trim());
		const parts = url.pathname.replace(/^\/+|\/+$/g, "").split("/");
		if (
			url.protocol !== "https:" ||
			url.hostname !== "music.apple.com" ||
			url.port ||
			url.username ||
			url.password ||
			url.hash ||
			parts.length < 3 ||
			parts.length > 4 ||
			!/^[a-z]{2}$/i.test(parts[0])
		)
			throw new Error();
		const ids =
			parts[1] === "song"
				? [parts.at(-1) ?? ""]
				: parts[1] === "album"
					? url.searchParams.getAll("i")
					: [];
		if (
			ids.length !== 1 ||
			!/^[1-9]\d{0,15}$/.test(ids[0]) ||
			!Number.isSafeInteger(Number(ids[0]))
		)
			throw new Error();
		return `https://music.apple.com/${parts[0].toLowerCase()}/song/${ids[0]}`;
	} catch {
		throw new AppleMusicAudioError("invalidLink");
	}
}

function record(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new AppleMusicAudioError("failed");
	return value as Record<string, unknown>;
}
function parseAuth(raw: unknown): AppleMusicAuth {
	const value = record(raw);
	if (
		[value.authenticated, value.loginOpen, value.runtimeReady].some(
			(v) => typeof v !== "boolean",
		)
	)
		throw new AppleMusicAudioError("failed");
	return {
		authenticated: value.authenticated as boolean,
		loginOpen: value.loginOpen as boolean,
		runtimeReady: value.runtimeReady as boolean,
	};
}
function parseJob(raw: unknown): AudioJob {
	const value = record(raw);
	if (
		typeof value.id !== "string" ||
		!/^[a-f0-9-]{1,100}$/.test(value.id) ||
		![
			"queued",
			"authenticating",
			"downloading",
			"processing",
			"ready",
			"cancelled",
			"error",
		].includes(String(value.state))
	)
		throw new AppleMusicAudioError("failed");
	if (value.state === "ready" && value.fileName !== "audio.m4a")
		throw new AppleMusicAudioError("invalidAudio");
	const bytes = (v: unknown) =>
		typeof v === "number" &&
		Number.isSafeInteger(v) &&
		v >= 0 &&
		v <= MAX_AUDIO * 3
			? v
			: null;
	return {
		id: value.id,
		state: value.state as JobState,
		progress:
			typeof value.progress === "number" &&
			Number.isFinite(value.progress) &&
			value.progress >= 0 &&
			value.progress <= 1
				? value.progress
				: null,
		bytesReceived: bytes(value.bytesReceived),
		totalBytes: bytes(value.totalBytes),
		fileName: value.fileName === "audio.m4a" ? "audio.m4a" : null,
		errorCode: value.errorCode == null ? null : audioErrorCode(value.errorCode),
	};
}
export function audioBytes(raw: unknown): ArrayBuffer {
	let data: Uint8Array;
	if (raw instanceof ArrayBuffer) data = new Uint8Array(raw);
	else if (raw instanceof Uint8Array) data = raw;
	else if (
		Array.isArray(raw) &&
		raw.length <= MAX_AUDIO &&
		raw.every((v) => Number.isInteger(v) && v >= 0 && v <= 255)
	)
		data = new Uint8Array(raw);
	else throw new AppleMusicAudioError("invalidAudio");
	if (
		data.byteLength < 32 ||
		data.byteLength > MAX_AUDIO ||
		data[4] !== 102 ||
		data[5] !== 116 ||
		data[6] !== 121 ||
		data[7] !== 112
	)
		throw new AppleMusicAudioError("invalidAudio");
	return Uint8Array.from(data).buffer;
}
export function createAppleMusicAudioClient(
	injected?: Invoke,
	desktop = isAppleMusicAudioDesktop(),
): AppleMusicAudioClient {
	const request = async <T>(
		name: string,
		args?: Record<string, unknown>,
	): Promise<T> => {
		if (!desktop) throw new AppleMusicAudioError("desktopOnly");
		try {
			const invoke = injected ?? (await import("@tauri-apps/api/core")).invoke;
			return await invoke<T>(`apple_music_audio_${name}`, args);
		} catch (error) {
			throw new AppleMusicAudioError(audioErrorCode(error));
		}
	};
	return {
		status: async () => parseAuth(await request("status")),
		login: async () => parseAuth(await request("login")),
		logout: async () => parseAuth(await request("logout")),
		start: async (url) =>
			parseJob(await request("start", { url: canonicalAudioLink(url) })),
		job: async (jobId) => parseJob(await request("job", { jobId })),
		cancel: async (jobId) => {
			await request("cancel", { jobId });
		},
		release: async (jobId) => {
			await request("release", { jobId });
		},
		read: async (jobId) => audioBytes(await request("read", { jobId })),
	};
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal.aborted) {
			reject(new AppleMusicAudioError("cancelled"));
			return;
		}
		const abort = () => {
			clearTimeout(timer);
			reject(new AppleMusicAudioError("cancelled"));
		};
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", abort);
			resolve();
		}, ms);
		signal.addEventListener("abort", abort, { once: true });
	});
}
export async function acquireAppleMusicAudio(
	client: AppleMusicAudioClient,
	url: string,
	options: {
		signal: AbortSignal;
		isCurrent(): boolean;
		onProgress(job: AudioJob): void;
		pollMs?: number;
	},
): Promise<File> {
	const check = () => {
		if (options.signal.aborted) throw new AppleMusicAudioError("cancelled");
		if (!options.isCurrent()) throw new AppleMusicAudioError("stale");
	};
	check();
	let job: AudioJob | undefined;
	try {
		job = await client.start(url);
		const deadline = Date.now() + 610_000;
		while (true) {
			check();
			options.onProgress(job);
			if (job.state === "cancelled")
				throw new AppleMusicAudioError("cancelled");
			if (job.state === "error")
				throw new AppleMusicAudioError(job.errorCode ?? "failed");
			if (job.state === "ready") break;
			if (Date.now() > deadline) throw new AppleMusicAudioError("timeout");
			await wait(options.pollMs ?? 500, options.signal);
			check();
			const next = await client.job(job.id);
			if (next.id !== job.id) throw new AppleMusicAudioError("failed");
			job = next;
		}
		const bytes = await client.read(job.id);
		check();
		return new File([bytes], "Apple Music.m4a", { type: "audio/mp4" });
	} finally {
		if (job) {
			await client.cancel(job.id).catch(() => {});
			await client.release(job.id).catch(() => {});
		}
	}
}
