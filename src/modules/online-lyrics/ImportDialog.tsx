import { Search16Regular } from "@fluentui/react-icons";
import {
	Badge,
	Box,
	Button,
	Card,
	Checkbox,
	Dialog,
	Flex,
	ScrollArea,
	Select,
	Spinner,
	Text,
	TextArea,
	TextField,
} from "@radix-ui/themes";
import { useAtom, useAtomValue, useStore } from "jotai";
import { atomWithStorage } from "jotai/utils";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "react-toastify";
import { audioEngine } from "$/modules/audio/audio-engine";
import { audioEngineStateAtom, loadedAudioAtom } from "$/modules/audio/states";
import { extractParenthesesToBg } from "$/modules/lrclib/utils/extractParenthesesToBg";
import { segmentLyricLines } from "$/modules/segmentation/utils/segmentation";
import { useSegmentationConfig } from "$/modules/segmentation/utils/useSegmentationConfig";
import { importFromLRCLIBDialogAtom } from "$/states/dialogs";
import { lyricLinesAtom } from "$/states/main";
import type { TTMLLyric } from "$/types/ttml";
import { createLogger } from "$/utils/logger";
import { createAudioSearchContext, rankTracks } from "./audio-context";
import {
	discoverAvailableProviders,
	fetchProviderLyrics,
	searchProvider,
	supportsProvider,
} from "./client";
import styles from "./ImportDialog.module.css";
import { isRepositoryProvider } from "./repository-sources";
import { searchIndependently } from "./requests";
import { convertOnlineLyricsForPreview } from "./ttml-import";
import {
	type AudioSearchContext,
	type LyricCandidate,
	ONLINE_PROVIDERS,
	type OnlineLyrics,
	type OnlineProviderId,
	type OnlineTrack,
} from "./types";
import { useImportLyrics } from "./useImportLyrics";

const logger = createLogger("OnlineLyrics");
const enabledProvidersAtom = atomWithStorage<OnlineProviderId[]>(
	"onlineLyricSources",
	[...ONLINE_PROVIDERS],
);
interface ProviderResult {
	status: "loading" | "success" | "error";
	tracks: OnlineTrack[];
	page: number;
	hasMore: boolean;
	error?: string;
}
const emptyResult: ProviderResult = {
	status: "loading",
	tracks: [],
	page: 1,
	hasMore: false,
};
const formatDuration = (ms: number) =>
	`${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}`;

export function ImportFromOnlineLyrics() {
	const { t } = useTranslation();
	const store = useStore();
	const [isOpen, setIsOpen] = useAtom(importFromLRCLIBDialogAtom);
	const [storedProviders, setStoredProviders] = useAtom(enabledProvidersAtom);
	const [availableProviders, setAvailableProviders] = useState(() =>
		ONLINE_PROVIDERS.filter(supportsProvider),
	);
	const [transportReady, setTransportReady] = useState(false);
	const loadedAudio = useAtomValue(loadedAudioAtom);
	const audioLoading = useAtomValue(audioEngineStateAtom) === "loading";
	const [metadataVersion, setMetadataVersion] = useState(0);
	const [query, setQuery] = useState("");
	const [filter, setFilter] = useState("all");
	const [results, setResults] = useState<
		Partial<Record<OnlineProviderId, ProviderResult>>
	>({});
	const [hasSearched, setHasSearched] = useState(false);
	const [context, setContext] = useState<AudioSearchContext | null>(null);
	const [previewTrack, setPreviewTrack] = useState<OnlineTrack | null>(null);
	const [previewBundle, setPreviewBundle] = useState<OnlineLyrics | null>(null);
	const [previewData, setPreviewData] = useState<TTMLLyric | null>(null);
	const [previewLoading, setPreviewLoading] = useState(false);
	const [previewError, setPreviewError] = useState("");
	const [includeTranslation, setIncludeTranslation] = useState(true);
	const [includeRomanization, setIncludeRomanization] = useState(true);
	const [autoSegment, setAutoSegment] = useState(false);
	const [extractBg, setExtractBg] = useState(false);
	const { config: segmentationConfig } = useSegmentationConfig();
	const importLyrics = useImportLyrics();
	const searchController = useRef<AbortController | null>(null);
	const previewController = useRef<AbortController | null>(null);
	const searchGeneration = useRef(0);
	const previewGeneration = useRef(0);
	const activeQuery = useRef("");
	const contextRef = useRef<AudioSearchContext | null>(null);
	const enabledRef = useRef<OnlineProviderId[]>([]);
	const enabledProviders = ONLINE_PROVIDERS.filter(
		(provider) =>
			availableProviders.includes(provider) &&
			Array.isArray(storedProviders) &&
			storedProviders.includes(provider),
	);
	enabledRef.current = enabledProviders;
	const providerName = (provider: OnlineProviderId) => {
		switch (provider) {
			case "netease":
				return t("onlineLyrics.providers.netease", "网易云音乐");
			case "qq":
				return t("onlineLyrics.providers.qq", "QQ 音乐");
			case "kugou":
				return t("onlineLyrics.providers.kugou", "酷狗音乐");
			case "lrclib":
				return "LRCLIB";
			case "amll-ttml-db":
				return "AMLL TTML DB";
			case "am-lyrics":
				return "am-lyrics";
		}
	};
	const errorMessage = useCallback(
		(error: unknown) =>
			error instanceof Error && error.name === "TimeoutError"
				? t("onlineLyrics.timeout", "请求超时，请重试或切换来源")
				: t("onlineLyrics.sourceError", "暂时无法获取，请重试或切换来源"),
		[t],
	);
	const closePreview = useCallback(() => {
		previewController.current?.abort();
		previewGeneration.current++;
		setPreviewTrack(null);
		setPreviewBundle(null);
		setPreviewData(null);
		setPreviewError("");
		setPreviewLoading(false);
	}, []);
	const cancelSearch = useCallback(() => {
		searchController.current?.abort();
		searchGeneration.current++;
		setResults((previous) =>
			Object.fromEntries(
				Object.entries(previous).map(([provider, result]) => [
					provider,
					{
						...result,
						status: result.status === "loading" ? "success" : result.status,
					},
				]),
			),
		);
	}, []);
	const runSearch = useCallback(
		async (keyword: string, providers: OnlineProviderId[]) => {
			if (!keyword.trim() || !providers.length) return;
			searchController.current?.abort();
			const controller = new AbortController();
			searchController.current = controller;
			const generation = ++searchGeneration.current;
			activeQuery.current = keyword.trim();
			setHasSearched(true);
			setResults(
				Object.fromEntries(
					providers.map((provider) => [provider, { ...emptyResult }]),
				),
			);
			await searchIndependently(
				providers,
				(provider) => searchProvider(provider, keyword, 1, controller.signal),
				(provider, outcome) => {
					if (generation !== searchGeneration.current) return;
					if (outcome.status === "error")
						logger.warn(`Search failed for ${provider}`, outcome.error);
					setResults((previous) => ({
						...previous,
						[provider]:
							outcome.status === "success"
								? { status: "success", ...outcome.data }
								: {
										...emptyResult,
										status: "error",
										error: errorMessage(outcome.error),
									},
					}));
				},
				controller.signal,
			);
		},
		[errorMessage],
	);
	useEffect(() => {
		const controller = new AbortController();
		void discoverAvailableProviders(controller.signal)
			.then((providers) => {
				if (controller.signal.aborted) return;
				setAvailableProviders(providers);
				setTransportReady(true);
			})
			.catch(() => {
				if (!controller.signal.aborted) setTransportReady(true);
			});
		return () => controller.abort();
	}, []);
	useEffect(() => {
		const update = () => setMetadataVersion((value) => value + 1);
		audioEngine.addEventListener("track-metadata-change", update);
		return () =>
			audioEngine.removeEventListener("track-metadata-change", update);
	}, []);
	// biome-ignore lint/correctness/useExhaustiveDependencies: A new audio file or completed metadata event must reset the search session.
	useEffect(() => {
		if (!isOpen || !transportReady) return;
		closePreview();
		searchController.current?.abort();
		searchGeneration.current++;
		setResults({});
		setHasSearched(false);
		setFilter("all");
		const snapshot =
			!audioLoading && audioEngine.musicLoaded
				? createAudioSearchContext(
						audioEngine.audioTrackMetadata,
						audioEngine.musicDuration * 1000,
					)
				: null;
		contextRef.current = snapshot;
		setContext(snapshot);
		if (snapshot?.query) {
			setQuery(snapshot.query);
			void runSearch(snapshot.query, enabledRef.current);
		} else if (audioLoading) {
			setQuery("");
		} else {
			const metadata = store.get(lyricLinesAtom).metadata;
			setQuery(
				[
					metadata.find((entry) => entry.key === "musicName")?.value[0],
					metadata.find((entry) => entry.key === "artists")?.value.join(" "),
				]
					.filter(Boolean)
					.join(" "),
			);
		}
		return () => {
			searchController.current?.abort();
			previewController.current?.abort();
			searchGeneration.current++;
			previewGeneration.current++;
		};
	}, [
		isOpen,
		transportReady,
		loadedAudio,
		metadataVersion,
		audioLoading,
		store,
		runSearch,
		closePreview,
	]);
	const startSearch = () => {
		if (!transportReady) return;
		closePreview();
		void runSearch(query, enabledProviders);
	};
	const toggleProvider = (provider: OnlineProviderId, enabled: boolean) => {
		const next = enabled
			? [...new Set([...enabledProviders, provider])]
			: enabledProviders.filter((value) => value !== provider);
		setStoredProviders(next);
		cancelSearch();
		closePreview();
		setResults({});
		setHasSearched(false);
		if (query.trim() && next.length) void runSearch(query, next);
	};
	const loadPage = async (provider: OnlineProviderId, page: number) => {
		const previous = results[provider] ?? emptyResult;
		if (previous.status === "loading") return;
		let controller = searchController.current;
		if (!controller || controller.signal.aborted) {
			controller = new AbortController();
			searchController.current = controller;
		}
		const generation = searchGeneration.current;
		setResults((values) => ({
			...values,
			[provider]: { ...previous, status: "loading", error: undefined },
		}));
		try {
			const result = await searchProvider(
				provider,
				activeQuery.current,
				page,
				controller.signal,
			);
			if (generation !== searchGeneration.current || controller.signal.aborted)
				return;
			const combined = new Map(
				(page > 1 ? previous.tracks : []).map((track) => [track.id, track]),
			);
			for (const track of result.tracks) combined.set(track.id, track);
			setResults((values) => ({
				...values,
				[provider]: {
					...result,
					tracks: [...combined.values()],
					status: "success",
				},
			}));
		} catch (error) {
			if (generation !== searchGeneration.current || controller.signal.aborted)
				return;
			logger.warn(`Search page failed for ${provider}`, error);
			setResults((values) => ({
				...values,
				[provider]: {
					...previous,
					status: "error",
					error: errorMessage(error),
				},
			}));
		}
	};
	const openPreview = async (
		track: OnlineTrack,
		candidate?: LyricCandidate,
	) => {
		previewController.current?.abort();
		const controller = new AbortController();
		previewController.current = controller;
		const generation = ++previewGeneration.current;
		setPreviewTrack(track);
		setPreviewLoading(true);
		setPreviewError("");
		setPreviewData(null);
		setPreviewBundle(null);
		try {
			const bundle = await fetchProviderLyrics(
				track,
				candidate,
				controller.signal,
			);
			if (generation !== previewGeneration.current || controller.signal.aborted)
				return;
			const data = await convertOnlineLyricsForPreview(
				track,
				bundle,
				contextRef.current?.durationMs,
			);
			if (generation !== previewGeneration.current || controller.signal.aborted)
				return;
			if (!data.lyricLines.length) throw new Error("No importable lyrics");
			setPreviewBundle(bundle);
			setPreviewData(data);
		} catch (error) {
			if (generation !== previewGeneration.current || controller.signal.aborted)
				return;
			logger.warn(`Fetch or parse failed for ${track.provider}`, error);
			setPreviewError(errorMessage(error));
		} finally {
			if (generation === previewGeneration.current) setPreviewLoading(false);
		}
	};
	const tracks = useMemo(
		() =>
			rankTracks(
				ONLINE_PROVIDERS.flatMap((provider) =>
					filter === "all" || filter === provider
						? (results[provider]?.tracks ?? [])
						: [],
				),
				context,
			),
		[results, filter, context],
	);
	const loading = Object.values(results).some(
		(result) => result.status === "loading",
	);
	const wordTimed =
		!!previewBundle &&
		(["qrc", "yrc", "krc"].includes(previewBundle.original.format) ||
			!!previewData?.lyricLines.some(
				(line) => line.words.filter((word) => word.word.trim()).length > 1,
			));
	const hasTranslation = !!previewData?.lyricLines.some(
		(line) => line.translatedLyric,
	);
	const canEstimateTiming =
		!wordTimed && previewBundle?.original.format !== "ttml";
	const hasRomanization = !!previewData?.lyricLines.some(
		(line) => line.romanLyric || line.words.some((word) => word.romanWord),
	);
	const previewText =
		previewData?.lyricLines
			.map((line) =>
				[
					line.words.map((word) => word.word).join(""),
					includeTranslation ? line.translatedLyric : "",
					includeRomanization
						? line.romanLyric ||
							line.words
								.map((word) => word.romanWord ?? "")
								.filter(Boolean)
								.join(" ")
						: "",
				]
					.filter(Boolean)
					.join("\n"),
			)
			.join("\n\n") ?? "";
	const triggerImport = () => {
		if (!previewData || previewLoading) return;
		try {
			let data = structuredClone(previewData);
			for (const line of data.lyricLines) {
				if (!includeTranslation) line.translatedLyric = "";
				if (!includeRomanization) {
					line.romanLyric = "";
					for (const word of line.words) word.romanWord = "";
				}
			}
			if (extractBg && canEstimateTiming)
				data = {
					...data,
					lyricLines: data.lyricLines.flatMap(extractParenthesesToBg),
				};
			if (autoSegment && canEstimateTiming)
				data = {
					...data,
					lyricLines: segmentLyricLines(data.lyricLines, segmentationConfig),
				};
			importLyrics(data, () => {
				closePreview();
				setIsOpen(false);
			});
		} catch (error) {
			logger.error("Import preparation failed", error);
			toast.error(t("onlineLyrics.importError", "导入失败，当前歌词保持不变"));
		}
	};
	return (
		<>
			<Dialog.Root open={isOpen} onOpenChange={setIsOpen}>
				<Dialog.Content className={styles.dialogContent}>
					<Dialog.Title>
						{t("onlineLyrics.title", "从在线歌词源导入")}
					</Dialog.Title>
					<Dialog.Description size="2" mb="3">
						{t("onlineLyrics.description", "搜索歌曲，预览歌词后导入编辑器")}
					</Dialog.Description>
					<Flex gap="3" wrap="wrap" mb="3">
						{ONLINE_PROVIDERS.map((provider) => (
							<Text as="label" size="2" key={provider}>
								<Flex gap="2" align="center">
									<Checkbox
										checked={enabledProviders.includes(provider)}
										disabled={
											!transportReady || !availableProviders.includes(provider)
										}
										onCheckedChange={(checked) =>
											toggleProvider(provider, checked === true)
										}
									/>
									{providerName(provider)}
								</Flex>
							</Text>
						))}
					</Flex>
					{!transportReady && (
						<Text size="1" color="gray" mb="3">
							{t("onlineLyrics.connecting", "正在连接歌词服务…")}
						</Text>
					)}
					{transportReady && !availableProviders.includes("qq") && (
						<Text size="1" color="gray" mb="3">
							{t(
								"onlineLyrics.localRequired",
								"网易、QQ 和酷狗需要本地版；当前可使用 LRCLIB、AMLL TTML DB 和 am-lyrics",
							)}
						</Text>
					)}
					<Flex gap="2" mb="3">
						<TextField.Root
							className={styles.searchBar}
							value={query}
							maxLength={200}
							placeholder={t(
								"onlineLyrics.placeholder",
								"歌名、歌手或歌曲 ID…",
							)}
							onChange={(event) => {
								setQuery(event.target.value);
								cancelSearch();
							}}
							onKeyDown={(event) => {
								if (event.key === "Enter") startSearch();
							}}
						>
							<TextField.Slot>
								<Search16Regular />
							</TextField.Slot>
						</TextField.Root>
						<Button
							onClick={startSearch}
							disabled={
								!transportReady || !query.trim() || !enabledProviders.length
							}
						>
							{t("common.search", "搜索")}
						</Button>
						{loading && (
							<Button variant="soft" color="gray" onClick={cancelSearch}>
								{t("onlineLyrics.stop", "停止")}
							</Button>
						)}
					</Flex>
					{context?.query && (
						<Text color="gray" size="1" mb="2">
							{t("onlineLyrics.audioQuery", "已读取当前音频：{query}", {
								query: context.query,
							})}
						</Text>
					)}
					<Flex gap="2" wrap="wrap" mb="3" align="center">
						<Select.Root value={filter} onValueChange={setFilter}>
							<Select.Trigger
								aria-label={t("onlineLyrics.filter", "筛选来源")}
							/>
							<Select.Content>
								<Select.Item value="all">
									{t("onlineLyrics.allSources", "全部来源")}
								</Select.Item>
								{ONLINE_PROVIDERS.map((provider) => (
									<Select.Item key={provider} value={provider}>
										{providerName(provider)}
									</Select.Item>
								))}
							</Select.Content>
						</Select.Root>
						{ONLINE_PROVIDERS.map((provider) => {
							const result = results[provider];
							return result ? (
								<Badge key={provider} color={result.error ? "red" : "gray"}>
									{result.status === "loading" && <Spinner size="1" />}
									{providerName(provider)} ·{" "}
									{result.error ?? result.tracks.length}
								</Badge>
							) : null;
						})}
					</Flex>
					<ScrollArea className={styles.scrollArea}>
						<Flex direction="column" gap="2" className={styles.resultList}>
							{tracks.map((track) => (
								<Card
									key={`${track.provider}:${track.id}`}
									className={styles.resultCard}
									asChild
								>
									<button type="button" onClick={() => void openPreview(track)}>
										<Flex justify="between" gap="3" align="center">
											<Box className={styles.trackInfo}>
												<Text as="div" weight="bold" truncate>
													{track.title}
												</Text>
												<Text as="div" size="2" color="gray" truncate>
													{track.artists.join(" / ")} · {track.album}
												</Text>
											</Box>
											<Flex gap="2" align="center" wrap="wrap" justify="end">
												<Badge>{providerName(track.provider)}</Badge>
												{isRepositoryProvider(track.provider) && (
													<Badge>TTML</Badge>
												)}
												{track.durationMs > 0 && (
													<Text size="1" color="gray">
														{formatDuration(track.durationMs)}
													</Text>
												)}
												{context &&
													context.durationMs > 0 &&
													track.durationMs > 0 &&
													Math.abs(track.durationMs - context.durationMs) >=
														4000 && (
														<Badge color="orange">
															{t(
																"onlineLyrics.durationDifference",
																"时长差 {seconds} 秒",
																{
																	seconds: Math.round(
																		(track.durationMs - context.durationMs) /
																			1000,
																	),
																},
															)}
														</Badge>
													)}
											</Flex>
										</Flex>
									</button>
								</Card>
							))}
							{!tracks.length && (
								<Flex className={styles.emptyState} gap="2">
									{loading && <Spinner />}
									<Text>
										{loading
											? t(
													"onlineLyrics.searching",
													"正在搜索，各来源结果会陆续显示…",
												)
											: hasSearched
												? t(
														"onlineLyrics.noResults",
														"没有找到结果，请更换关键词或来源",
													)
												: t(
														"onlineLyrics.startHint",
														"输入歌名、歌手或歌曲 ID 开始搜索",
													)}
									</Text>
								</Flex>
							)}
							{ONLINE_PROVIDERS.map((provider) => {
								const result = results[provider];
								if (!result || (filter !== "all" && filter !== provider))
									return null;
								return (
									<Flex key={provider} gap="2" align="center" wrap="wrap">
										{result.error && (
											<>
												<Text size="2" color="red">
													{providerName(provider)}：{result.error}
												</Text>
												<Button
													size="1"
													variant="soft"
													onClick={() =>
														void loadPage(
															provider,
															result.tracks.length ? result.page + 1 : 1,
														)
													}
												>
													{t("onlineLyrics.retry", "重试")}
												</Button>
											</>
										)}
										{result.hasMore && (
											<Button
												size="1"
												variant="soft"
												disabled={result.status === "loading"}
												onClick={() => void loadPage(provider, result.page + 1)}
											>
												{result.status === "loading" ? (
													<Spinner size="1" />
												) : (
													t("onlineLyrics.loadMore", "加载更多 · {source}", {
														source: providerName(provider),
													})
												)}
											</Button>
										)}
									</Flex>
								);
							})}
						</Flex>
					</ScrollArea>
					<Flex justify="end" mt="3">
						<Dialog.Close>
							<Button variant="soft" color="gray">
								{t("common.close", "关闭")}
							</Button>
						</Dialog.Close>
					</Flex>
				</Dialog.Content>
			</Dialog.Root>
			<Dialog.Root
				open={!!previewTrack && isOpen}
				onOpenChange={(open) => {
					if (!open) closePreview();
				}}
			>
				<Dialog.Content className={styles.previewDialogContent}>
					<Dialog.Title>
						{previewTrack?.title || t("onlineLyrics.preview", "歌词预览")}
					</Dialog.Title>
					<Dialog.Description size="2" mb="3">
						{previewTrack &&
							`${providerName(previewTrack.provider)} · ${previewTrack.artists.join(" / ")} · ${previewTrack.album}`}
					</Dialog.Description>
					{previewLoading && (
						<Flex justify="center" py="6" gap="2">
							<Spinner />
							<Text>{t("onlineLyrics.fetching", "正在获取歌词…")}</Text>
						</Flex>
					)}
					{previewError && (
						<Flex direction="column" gap="3" py="4">
							<Text color="red">{previewError}</Text>
							<Button
								onClick={() => {
									if (previewTrack) void openPreview(previewTrack);
								}}
							>
								{t("onlineLyrics.retry", "重试")}
							</Button>
						</Flex>
					)}
					{!!previewBundle?.candidates?.length && (
						<Select.Root
							value={
								previewBundle.selectedCandidateId ??
								previewBundle.candidates[0].id
							}
							onValueChange={(id) => {
								const candidate = previewBundle.candidates?.find(
									(value) => value.id === id,
								);
								if (previewTrack && candidate)
									void openPreview(previewTrack, candidate);
							}}
						>
							<Select.Trigger
								className={styles.candidateSelect}
								aria-label={t("onlineLyrics.candidate", "歌词版本")}
							/>
							<Select.Content>
								{previewBundle.candidates.map((candidate) => (
									<Select.Item key={candidate.id} value={candidate.id}>
										{candidate.label}
									</Select.Item>
								))}
							</Select.Content>
						</Select.Root>
					)}
					{previewData && (
						<>
							<Flex gap="2" mb="2">
								<Badge color={wordTimed ? "green" : "gray"}>
									{wordTimed
										? t("onlineLyrics.wordTimed", "逐字歌词")
										: previewData.lyricLines.some((line) => line.endTime > 0)
											? t("onlineLyrics.lineTimed", "逐行歌词")
											: t("onlineLyrics.plain", "纯文本歌词")}
								</Badge>
							</Flex>
							<TextArea
								readOnly
								value={previewText}
								className={styles.previewTextArea}
								aria-label={t("onlineLyrics.preview", "歌词预览")}
							/>
							<Flex gap="3" wrap="wrap" mt="3">
								{hasTranslation && (
									<Text as="label" size="2">
										<Flex gap="2" align="center">
											<Checkbox
												checked={includeTranslation}
												onCheckedChange={(value) =>
													setIncludeTranslation(value === true)
												}
											/>
											{t("onlineLyrics.translation", "导入翻译")}
										</Flex>
									</Text>
								)}
								{hasRomanization && (
									<Text as="label" size="2">
										<Flex gap="2" align="center">
											<Checkbox
												checked={includeRomanization}
												onCheckedChange={(value) =>
													setIncludeRomanization(value === true)
												}
											/>
											{t("onlineLyrics.romanization", "导入音译")}
										</Flex>
									</Text>
								)}
								{canEstimateTiming && (
									<>
										<Text as="label" size="2">
											<Flex gap="2" align="center">
												<Checkbox
													checked={autoSegment}
													onCheckedChange={(value) =>
														setAutoSegment(value === true)
													}
												/>
												{t("onlineLyrics.segment", "自动分词（估算时间）")}
											</Flex>
										</Text>
										<Text as="label" size="2">
											<Flex gap="2" align="center">
												<Checkbox
													checked={extractBg}
													onCheckedChange={(value) =>
														setExtractBg(value === true)
													}
												/>
												{t("onlineLyrics.extractBg", "提取括号内容为背景人声")}
											</Flex>
										</Text>
									</>
								)}
							</Flex>
						</>
					)}
					<Flex justify="end" gap="3" mt="4">
						<Dialog.Close>
							<Button color="gray" variant="soft">
								{t("common.cancel", "取消")}
							</Button>
						</Dialog.Close>
						<Button
							disabled={!previewData || previewLoading}
							onClick={triggerImport}
						>
							{t("onlineLyrics.import", "导入歌词")}
						</Button>
					</Flex>
				</Dialog.Content>
			</Dialog.Root>
		</>
	);
}
