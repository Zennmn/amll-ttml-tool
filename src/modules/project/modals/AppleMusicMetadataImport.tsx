import {
	Button,
	Callout,
	Checkbox,
	Flex,
	Heading,
	Spinner,
	Text,
	TextField,
} from "@radix-ui/themes";
import { isTauri } from "@tauri-apps/api/core";
import {
	type FormEvent,
	useCallback,
	useEffect,
	useId,
	useMemo,
	useRef,
	useState,
} from "react";
import { useTranslation } from "react-i18next";
import type { TTMLMetadata } from "$/types/ttml";
import {
	APPLE_MUSIC_IMPORT_FIELDS,
	AppleMusicMetadataError,
	type AppleMusicMetadataField,
	type AppleMusicMetadataMode,
	type AppleMusicMetadataPreview,
	fetchAppleMusicMetadata,
	getAvailableAppleMusicFields,
	getDefaultAppleMusicFields,
} from "../logic/apple-music-metadata";
import styles from "./AppleMusicMetadataImport.module.css";
import { AppleMusicIcon } from "./PlatformIcons";

export interface AppleMusicMetadataImportProps {
	metadata: TTMLMetadata[];
	onApply: (
		preview: AppleMusicMetadataPreview,
		fields: AppleMusicMetadataField[],
	) => void;
	onCancel: () => void;
}

type ImportErrorCode = AppleMusicMetadataError["code"] | "unknown";

const ERROR_MESSAGES: Record<
	ImportErrorCode,
	{ key: string; fallback: string }
> = {
	invalidLink: {
		key: "metadataDialog.appleMusic.errors.invalidLink",
		fallback: "链接格式不正确，请输入 Apple Music 歌曲链接。",
	},
	albumLink: {
		key: "metadataDialog.appleMusic.errors.albumLink",
		fallback: "请在专辑中选择具体歌曲，再复制歌曲的分享链接。",
	},
	notFound: {
		key: "metadataDialog.appleMusic.errors.notFound",
		fallback: "在链接对应的 Apple Music 地区找不到这首歌，可能已下架或不可用。",
	},
	invalidResponse: {
		key: "metadataDialog.appleMusic.errors.invalidResponse",
		fallback: "Apple Music 返回了无法读取的信息，请稍后重试。",
	},
	network: {
		key: "metadataDialog.appleMusic.errors.network",
		fallback:
			"未能连接到 Apple Music 查询服务，可能是接口或代理连接暂时异常，请重试。",
	},
	timeout: {
		key: "metadataDialog.appleMusic.errors.timeout",
		fallback: "请求超时，请稍后重试。",
	},
	rateLimited: {
		key: "metadataDialog.appleMusic.errors.rateLimited",
		fallback: "请求过于频繁，请稍后重试。",
	},
	accessDenied: {
		key: "metadataDialog.appleMusic.errors.accessDenied",
		fallback: "Apple Music 查询服务拒绝了请求，请稍后重试。",
	},
	serviceUnavailable: {
		key: "metadataDialog.appleMusic.errors.serviceUnavailable",
		fallback: "Apple Music 查询服务暂时不可用，请稍后重试。",
	},
	unknown: {
		key: "metadataDialog.appleMusic.errors.unknown",
		fallback: "获取歌曲信息失败，请稍后重试。",
	},
};

const getMetadataValues = (
	metadata: TTMLMetadata[],
	field: AppleMusicMetadataField,
) => [
	...new Set(
		metadata
			.filter((item) => item.key === field)
			.flatMap((item) => item.value)
			.map((value) => value.trim())
			.filter(Boolean),
	),
];

const getImportErrorCode = (error: unknown): ImportErrorCode => {
	if (!(error instanceof AppleMusicMetadataError)) return "unknown";
	return Object.hasOwn(ERROR_MESSAGES, error.code) ? error.code : "unknown";
};

const formatDuration = (durationMs: number | undefined) => {
	if (
		durationMs === undefined ||
		!Number.isFinite(durationMs) ||
		durationMs < 0
	) {
		return "";
	}
	const totalSeconds = Math.round(durationMs / 1000);
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = String(totalSeconds % 60).padStart(2, "0");
	return `${minutes}:${seconds}`;
};

export const AppleMusicMetadataImport = ({
	metadata,
	onApply,
	onCancel,
}: AppleMusicMetadataImportProps) => {
	const { t } = useTranslation();
	const [isDesktop] = useState(
		() => typeof window !== "undefined" && isTauri(),
	);
	const [mode, setMode] = useState<AppleMusicMetadataMode>(() =>
		isDesktop ? "enhanced" : "basic",
	);
	const [url, setUrl] = useState("");
	const [preview, setPreview] = useState<AppleMusicMetadataPreview | null>(
		null,
	);
	const [selectedFields, setSelectedFields] = useState<
		Set<AppleMusicMetadataField>
	>(() => new Set());
	const [errorCode, setErrorCode] = useState<ImportErrorCode | null>(null);
	const [isLoading, setIsLoading] = useState(false);
	const [isApplying, setIsApplying] = useState(false);

	const titleId = useId();
	const previewTitleId = useId();
	const urlInputId = useId();
	const modeGroupName = useId();
	const requestVersionRef = useRef(0);
	const abortControllerRef = useRef<AbortController | null>(null);
	const inputValueRef = useRef("");
	const metadataRef = useRef(metadata);
	const applyStartedRef = useRef(false);

	useEffect(() => {
		metadataRef.current = metadata;
	}, [metadata]);

	useEffect(() => {
		return () => {
			requestVersionRef.current += 1;
			abortControllerRef.current?.abort();
			abortControllerRef.current = null;
		};
	}, []);

	const abortCurrentRequest = useCallback(() => {
		requestVersionRef.current += 1;
		abortControllerRef.current?.abort();
		abortControllerRef.current = null;
		return requestVersionRef.current;
	}, []);

	const resetLookupState = useCallback(() => {
		setPreview(null);
		setSelectedFields(new Set());
		setErrorCode(null);
		setIsLoading(false);
		setIsApplying(false);
		applyStartedRef.current = false;
	}, []);

	const handleUrlChange = useCallback(
		(value: string) => {
			inputValueRef.current = value;
			abortCurrentRequest();
			setUrl(value);
			resetLookupState();
		},
		[abortCurrentRequest, resetLookupState],
	);

	const handleModeChange = useCallback(
		(nextMode: AppleMusicMetadataMode) => {
			if (
				nextMode === mode ||
				isApplying ||
				(!isDesktop && nextMode !== "basic")
			) {
				return;
			}
			abortCurrentRequest();
			setMode(nextMode);
			resetLookupState();
		},
		[abortCurrentRequest, isApplying, isDesktop, mode, resetLookupState],
	);

	const handleCancel = useCallback(() => {
		abortCurrentRequest();
		setIsLoading(false);
		onCancel();
	}, [abortCurrentRequest, onCancel]);

	const handleSubmit = useCallback(
		async (event: FormEvent<HTMLFormElement>) => {
			event.preventDefault();
			const input = url.trim();
			const requestedMode: AppleMusicMetadataMode = isDesktop ? mode : "basic";
			inputValueRef.current = url;
			const requestVersion = abortCurrentRequest();

			resetLookupState();

			if (!input) {
				setIsLoading(false);
				setErrorCode("invalidLink");
				return;
			}

			const controller = new AbortController();
			abortControllerRef.current = controller;
			setIsLoading(true);

			try {
				const nextPreview = await fetchAppleMusicMetadata(input, {
					signal: controller.signal,
					mode: requestedMode,
				});
				if (
					requestVersion !== requestVersionRef.current ||
					controller.signal.aborted ||
					inputValueRef.current.trim() !== input
				) {
					return;
				}

				setPreview(nextPreview);
				setSelectedFields(
					new Set(getDefaultAppleMusicFields(metadataRef.current, nextPreview)),
				);
			} catch (error) {
				if (
					requestVersion !== requestVersionRef.current ||
					controller.signal.aborted
				) {
					return;
				}
				setPreview(null);
				setSelectedFields(new Set());
				setErrorCode(getImportErrorCode(error));
			} finally {
				if (requestVersion === requestVersionRef.current) {
					setIsLoading(false);
					if (abortControllerRef.current === controller) {
						abortControllerRef.current = null;
					}
				}
			}
		},
		[abortCurrentRequest, isDesktop, mode, resetLookupState, url],
	);

	const handleToggleField = useCallback(
		(field: AppleMusicMetadataField, checked: boolean) => {
			if (!preview || getMetadataValues(preview.metadata, field).length === 0) {
				return;
			}
			setSelectedFields((current) => {
				const next = new Set(current);
				if (checked) next.add(field);
				else next.delete(field);
				return next;
			});
		},
		[preview],
	);

	const presentSelectedFields = useMemo(
		() =>
			preview
				? APPLE_MUSIC_IMPORT_FIELDS.filter(
						(field) =>
							selectedFields.has(field) &&
							getMetadataValues(preview.metadata, field).length > 0,
					)
				: [],
		[preview, selectedFields],
	);

	const availableFields = useMemo(
		() => (preview ? getAvailableAppleMusicFields(preview) : []),
		[preview],
	);
	const allAvailableFieldsSelected =
		availableFields.length > 0 &&
		availableFields.every((field) => selectedFields.has(field));
	const hasSelectedAvailableField = availableFields.some((field) =>
		selectedFields.has(field),
	);

	const handleSelectAllFields = useCallback(() => {
		if (!preview) return;
		setSelectedFields(new Set(getAvailableAppleMusicFields(preview)));
	}, [preview]);

	const handleClearFields = useCallback(() => {
		setSelectedFields(new Set());
	}, []);

	const handleApply = useCallback(() => {
		if (!preview || presentSelectedFields.length === 0) return;
		if (applyStartedRef.current) return;
		applyStartedRef.current = true;
		setIsApplying(true);
		onApply(preview, [...presentSelectedFields]);
	}, [onApply, presentSelectedFields, preview]);

	const fieldLabels: Record<AppleMusicMetadataField, string> = {
		musicName: t("metadataDialog.builtinOptions.musicName", "歌曲名称"),
		artists: t("metadataDialog.builtinOptions.artists", "歌曲的艺术家"),
		album: t("metadataDialog.builtinOptions.album", "歌曲的专辑名"),
		appleMusicId: t(
			"metadataDialog.builtinOptions.appleMusicId",
			"Apple Music 音乐 ID",
		),
		isrc: t("metadataDialog.builtinOptions.isrc", "歌曲的 ISRC 号码"),
		songwriter: t(
			"metadataDialog.appleMusic.composerLabel",
			"作曲者（写入词曲作者）",
		),
	};

	const errorMessage = errorCode
		? t(ERROR_MESSAGES[errorCode].key, ERROR_MESSAGES[errorCode].fallback)
		: "";
	const duration = formatDuration(preview?.durationMs);
	const hasComposer =
		preview !== null &&
		getMetadataValues(preview.metadata, "songwriter").length > 0;

	return (
		<section className={styles.panel} aria-labelledby={titleId}>
			<div className={styles.header}>
				<div className={styles.titleRow}>
					<AppleMusicIcon className={styles.appleIcon} aria-hidden />
					<Heading as="h2" size="3" id={titleId}>
						{t("metadataDialog.appleMusic.title", "从 Apple Music 导入")}
					</Heading>
				</div>
				<Button
					className={styles.backButton}
					type="button"
					variant="soft"
					color="gray"
					onClick={handleCancel}
				>
					{t("metadataDialog.appleMusic.back", "返回")}
				</Button>
			</div>

			<Callout.Root className={styles.description} color="blue" size="1">
				<Callout.Text>
					{t(
						"metadataDialog.appleMusic.description",
						"粘贴 Apple Music 歌曲链接以获取元数据。桌面版可选择增强获取，额外获取 ISRC 和可用的作曲者信息；网页版使用基础获取。空字段默认勾选；勾选已有值的字段会替换该值。",
					)}
				</Callout.Text>
			</Callout.Root>

			<fieldset className={styles.modeFieldset} disabled={isApplying}>
				<legend className={styles.modeLegend}>
					{t("metadataDialog.appleMusic.modeLabel", "获取方式")}
				</legend>
				<div className={styles.modeOptions}>
					{isDesktop && (
						<label
							className={styles.modeOption}
							data-selected={mode === "enhanced" ? "true" : "false"}
						>
							<input
								className={styles.modeRadio}
								type="radio"
								name={modeGroupName}
								value="enhanced"
								checked={mode === "enhanced"}
								onChange={() => handleModeChange("enhanced")}
							/>
							<span className={styles.modeCopy}>
								<Text as="span" size="2" weight="medium">
									{t("metadataDialog.appleMusic.modeEnhanced", "增强获取")}
								</Text>
								<Text as="span" size="1" color="gray">
									{t(
										"metadataDialog.appleMusic.modeEnhancedHelp",
										"额外获取 ISRC 与可用的作曲者信息，无需登录。",
									)}
								</Text>
							</span>
						</label>
					)}
					<label
						className={styles.modeOption}
						data-selected={mode === "basic" ? "true" : "false"}
					>
						<input
							className={styles.modeRadio}
							type="radio"
							name={modeGroupName}
							value="basic"
							checked={mode === "basic"}
							onChange={() => handleModeChange("basic")}
						/>
						<span className={styles.modeCopy}>
							<Text as="span" size="2" weight="medium">
								{t("metadataDialog.appleMusic.modeBasic", "基础获取")}
							</Text>
							<Text as="span" size="1" color="gray">
								{t(
									"metadataDialog.appleMusic.modeBasicHelp",
									"获取歌名、歌手、专辑和 Apple Music ID 四项基础信息。",
								)}
							</Text>
						</span>
					</label>
				</div>
				{!isDesktop && (
					<Text className={styles.modeNote} as="p" size="1" color="gray">
						{t(
							"metadataDialog.appleMusic.modeWebHint",
							"浏览器版使用基础获取。",
						)}
					</Text>
				)}
			</fieldset>

			<form className={styles.urlForm} onSubmit={handleSubmit} noValidate>
				<div className={styles.urlField}>
					<Text as="label" htmlFor={urlInputId} size="2" weight="medium">
						{t("metadataDialog.appleMusic.urlLabel", "Apple Music 歌曲链接")}
					</Text>
					<TextField.Root
						id={urlInputId}
						className={styles.urlInput}
						type="text"
						inputMode="url"
						autoComplete="off"
						spellCheck={false}
						value={url}
						onChange={(event) => handleUrlChange(event.currentTarget.value)}
						placeholder={t(
							"metadataDialog.appleMusic.urlPlaceholder",
							"https://music.apple.com/…",
						)}
						aria-label={t(
							"metadataDialog.appleMusic.urlLabel",
							"Apple Music 歌曲链接",
						)}
						aria-invalid={errorCode !== null}
					/>
				</div>
				<Button
					className={styles.fetchButton}
					type="submit"
					disabled={!url.trim() || isApplying}
				>
					{isLoading && <Spinner size="1" />}
					{isLoading
						? t("metadataDialog.appleMusic.loading", "正在获取…")
						: errorCode
							? t("metadataDialog.appleMusic.retry", "重新获取")
							: t("metadataDialog.appleMusic.fetch", "获取歌曲信息")}
				</Button>
			</form>

			{isLoading && (
				<Flex
					className={styles.statusRow}
					align="center"
					gap="2"
					role="status"
					aria-live="polite"
				>
					<Spinner size="1" />
					<Text size="2" color="gray">
						{t("metadataDialog.appleMusic.loading", "正在获取…")}
					</Text>
				</Flex>
			)}

			{errorCode && (
				<Callout.Root className={styles.errorCallout} color="red" role="alert">
					<Callout.Text>{errorMessage}</Callout.Text>
				</Callout.Root>
			)}

			{preview && !isLoading && (
				<section className={styles.preview} aria-labelledby={previewTitleId}>
					<div className={styles.previewHeader}>
						<div className={styles.previewTitleRow}>
							<Heading as="h3" size="2" id={previewTitleId}>
								{t("metadataDialog.appleMusic.previewTitle", "导入预览")}
							</Heading>
							<Text
								className={styles.retrievalStatus}
								size="1"
								color={preview.retrievalMode === "enhanced" ? "green" : "gray"}
							>
								{preview.retrievalMode === "enhanced"
									? t("metadataDialog.appleMusic.enhancedResult", "增强获取")
									: t("metadataDialog.appleMusic.basicResult", "基础获取")}
							</Text>
						</div>
						<div className={styles.previewActions}>
							<Button
								type="button"
								size="1"
								variant="soft"
								color="gray"
								onClick={handleSelectAllFields}
								disabled={isApplying || allAvailableFieldsSelected}
							>
								{t("metadataDialog.appleMusic.selectAll", "全选可用字段")}
							</Button>
							<Button
								type="button"
								size="1"
								variant="soft"
								color="gray"
								onClick={handleClearFields}
								disabled={isApplying || !hasSelectedAvailableField}
							>
								{t("metadataDialog.appleMusic.clearSelection", "取消全选")}
							</Button>
						</div>
					</div>
					{(preview.releaseDate || duration) && (
						<Text className={styles.context} size="1" color="gray">
							{preview.releaseDate
								? t(
										"metadataDialog.appleMusic.releaseDate",
										"发行日期：{date}",
										{ date: preview.releaseDate },
									)
								: null}
							{preview.releaseDate && duration ? " · " : null}
							{duration
								? t("metadataDialog.appleMusic.duration", "时长：{duration}", {
										duration,
									})
								: null}
						</Text>
					)}

					{preview.enhancementUnavailable && (
						<Callout.Root
							className={styles.fallbackCallout}
							color="amber"
							size="1"
						>
							<Callout.Text>
								{t(
									"metadataDialog.appleMusic.enhancementUnavailable",
									"增强获取暂不可用，已获取基础信息。ISRC 和作曲者可稍后重试。",
								)}
							</Callout.Text>
						</Callout.Root>
					)}

					{hasComposer && (
						<Text className={styles.composerHint} size="1" color="gray">
							{t(
								"metadataDialog.appleMusic.composerHint",
								"Apple Music 提供的作曲者信息可能不含完整作词者名单；导入时会写入当前“词曲作者”字段。",
							)}
						</Text>
					)}

					<div className={styles.previewTable}>
						<div className={styles.columnHeader} aria-hidden="true">
							<span />
							<span>{t("metadataDialog.appleMusic.fieldHeader", "字段")}</span>
							<span>Apple Music</span>
							<span>
								{t("metadataDialog.appleMusic.existingHeader", "当前值")}
							</span>
						</div>

						{APPLE_MUSIC_IMPORT_FIELDS.map((field) => {
							const incomingValues = getMetadataValues(preview.metadata, field);
							const existingValues = getMetadataValues(metadata, field);
							const hasIncoming = incomingValues.length > 0;
							const isSelected = hasIncoming && selectedFields.has(field);
							const label = fieldLabels[field];

							return (
								<div
									key={field}
									className={styles.fieldRow}
									data-selected={isSelected ? "true" : "false"}
									data-unavailable={hasIncoming ? "false" : "true"}
								>
									<div className={styles.fieldCheck}>
										<Checkbox
											checked={isSelected}
											disabled={!hasIncoming || isApplying}
											onCheckedChange={(checked) =>
												handleToggleField(field, checked === true)
											}
											aria-label={label}
										/>
									</div>
									<div className={styles.fieldIdentity}>
										<Text size="2" weight="medium">
											{label}
										</Text>
									</div>
									<div className={styles.incomingCell}>
										<span className={styles.mobileLabel}>Apple Music</span>
										{hasIncoming ? (
											<Flex direction="column" gap="1">
												{incomingValues.map((value) => (
													<Text
														className={styles.valueText}
														key={value}
														size="2"
													>
														{value}
													</Text>
												))}
											</Flex>
										) : (
											<Text size="1" color="gray">
												{t("metadataDialog.appleMusic.noIncoming", "未提供")}
											</Text>
										)}
									</div>
									<div className={styles.existingCell}>
										<span className={styles.mobileLabel}>
											{t("metadataDialog.appleMusic.existingHeader", "当前值")}
										</span>
										{existingValues.length > 0 ? (
											<Flex direction="column" gap="1">
												{existingValues.map((value) => (
													<Text
														className={styles.valueText}
														key={value}
														size="2"
													>
														{value}
													</Text>
												))}
											</Flex>
										) : (
											<Text size="1" color="gray">
												{t("metadataDialog.appleMusic.noExisting", "未设置")}
											</Text>
										)}
									</div>
								</div>
							);
						})}
					</div>

					<div className={styles.footer}>
						<Button
							className={styles.applyButton}
							type="button"
							onClick={handleApply}
							disabled={presentSelectedFields.length === 0 || isApplying}
						>
							{t("metadataDialog.appleMusic.apply", "导入所选字段")}
						</Button>
					</div>
				</section>
			)}
		</section>
	);
};
