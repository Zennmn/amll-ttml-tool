import type { JapaneseReadingToken } from "./alignment";

export interface KuromojiToken {
	surface_form: string;
	reading?: string;
	pronunciation?: string;
	pos?: string;
}

export interface JapaneseTokenizer {
	tokenize(text: string): KuromojiToken[];
}

export interface JapaneseTokenizerFactory {
	builder(options: { dicPath: string }): {
		build(
			callback: (error: Error | null, tokenizer: JapaneseTokenizer) => void,
		): void;
	};
}

export interface JapaneseReadingRequest {
	id: number;
	words: string[];
	dictionaryPath: string;
}

export type JapaneseReadingResponse =
	| { type: "ready" }
	| { id: number; readings: string[] }
	| { id: number; error: string };

export type { JapaneseReadingToken };
