import { Button, Flex, Text } from "@radix-ui/themes";
import { useAtomValue } from "jotai";
import { useEffect, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { syncPronunciationModeAtom } from "$/modules/settings/states";
import { JapaneseReadingClient } from "./client";

let client: JapaneseReadingClient | undefined;

export function getJapaneseReadingClient() {
	if (!client) {
		client = new JapaneseReadingClient({
			createWorker: () =>
				new Worker(new URL("./pronunciation.worker.ts", import.meta.url), {
					type: "module",
					name: "japanese-pronunciation",
				}),
			// kuromoji's browser path joiner expects a same-origin pathname.
			dictionaryPath: new URL(
				`${import.meta.env.BASE_URL}dictionaries/kuromoji/`,
				document.baseURI,
			).pathname,
		});
	}
	return client;
}

export function useJapaneseReadings(
	words: readonly string[],
	enabled: boolean,
) {
	const readingClient = getJapaneseReadingClient();
	const status = useSyncExternalStore(
		readingClient.subscribe,
		readingClient.getStatus,
	);
	const key = JSON.stringify(words);
	const [result, setResult] = useState<{ key: string; readings: string[] }>();
	// biome-ignore lint/correctness/useExhaustiveDependencies: The retry revision intentionally restarts failed requests.
	useEffect(() => {
		if (!enabled) return;
		const controller = new AbortController();
		const textWords = JSON.parse(key) as string[];
		void readingClient.read(textWords, controller.signal).then(
			(readings) => {
				if (!controller.signal.aborted) setResult({ key, readings });
			},
			() => {
				if (!controller.signal.aborted) setResult({ key, readings: [] });
			},
		);
		return () => controller.abort();
	}, [enabled, key, readingClient, status.revision]);
	return enabled && result?.key === key ? result.readings : [];
}

export function JapanesePronunciationStatus() {
	const mode = useAtomValue(syncPronunciationModeAtom);
	const readingClient = getJapaneseReadingClient();
	const status = useSyncExternalStore(
		readingClient.subscribe,
		readingClient.getStatus,
	);
	const { t } = useTranslation();
	if (mode === "off") return null;
	return (
		<Flex align="center" gap="2" mt="1">
			<Text size="1" color={status.state === "error" ? "red" : "gray"}>
				{status.state === "error"
					? t("ribbonBar.syncMode.pronunciationFailed", "发音生成失败")
					: status.state === "loading"
						? t("ribbonBar.syncMode.pronunciationLoading", "正在生成发音…")
						: t(
								"ribbonBar.syncMode.pronunciationAutomatic",
								"无音译时自动注音",
							)}
			</Text>
			{status.state === "error" && (
				<Button size="1" variant="ghost" onClick={readingClient.retry}>
					{t("ribbonBar.syncMode.pronunciationRetry", "重试")}
				</Button>
			)}
		</Flex>
	);
}
