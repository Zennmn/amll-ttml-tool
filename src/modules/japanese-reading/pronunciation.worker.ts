import kuromoji from "kuromoji/build/kuromoji.js";
import { generateJapaneseReadings } from "./engine";
import type {
	JapaneseReadingRequest,
	JapaneseReadingResponse,
	JapaneseTokenizer,
} from "./types";

const scope = self as unknown as DedicatedWorkerGlobalScope;
let tokenizerPromise: Promise<JapaneseTokenizer> | undefined;

function loadTokenizer(dictionaryPath: string): Promise<JapaneseTokenizer> {
	if (!tokenizerPromise) {
		tokenizerPromise = new Promise<JapaneseTokenizer>((resolve, reject) => {
			kuromoji
				.builder({ dicPath: dictionaryPath })
				.build((error, tokenizer) => {
					if (error) reject(error);
					else resolve(tokenizer);
				});
		}).then((tokenizer) => {
			scope.postMessage({ type: "ready" } satisfies JapaneseReadingResponse);
			return tokenizer;
		});
	}
	return tokenizerPromise;
}

scope.onmessage = async (event: MessageEvent<JapaneseReadingRequest>) => {
	const { id, words, dictionaryPath } = event.data;
	try {
		if (
			!Number.isSafeInteger(id) ||
			!Array.isArray(words) ||
			words.some((word) => typeof word !== "string") ||
			typeof dictionaryPath !== "string"
		) {
			throw new Error("Invalid reading request");
		}
		const tokenizer = await loadTokenizer(dictionaryPath);
		const readings = generateJapaneseReadings(tokenizer, words);
		scope.postMessage({ id, readings } satisfies JapaneseReadingResponse);
	} catch {
		scope.postMessage({
			id,
			error: "generationFailed",
		} satisfies JapaneseReadingResponse);
	}
};
