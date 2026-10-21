export const ONLINE_PROVIDERS = ["netease", "qq", "kugou", "lrclib"] as const;
export type OnlineProviderId = (typeof ONLINE_PROVIDERS)[number];

/** Provider identifiers are retained until the full lyric has been fetched. */
export interface OnlineTrack {
	provider: OnlineProviderId;
	id: string;
	title: string;
	artists: string[];
	album: string;
	durationMs: number;
	mid?: string;
	hash?: string;
}

export interface OnlineSearchPage {
	tracks: OnlineTrack[];
	page: number;
	hasMore: boolean;
}

export interface LyricCandidate {
	id: string;
	accessKey: string;
	label: string;
	durationMs?: number;
}

export type LyricFormat = "lrc" | "qrc" | "yrc" | "krc" | "plain";
export interface LyricChannel {
	format: LyricFormat;
	content: string;
}

/** Channels remain separate so equal timestamps do not imply translation. */
export interface OnlineLyrics {
	original: LyricChannel;
	translation?: LyricChannel;
	romanization?: LyricChannel;
	originalLrc?: string;
	candidates?: LyricCandidate[];
	selectedCandidateId?: string;
}

export interface AudioSearchContext {
	query: string;
	title: string;
	artists: string[];
	album: string;
	durationMs: number;
}
