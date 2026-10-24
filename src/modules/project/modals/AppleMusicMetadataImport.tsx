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
	type AppleMusicMetadataPreview,
	fetchAppleMusicMetadata,
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
		fallback: "网络连接失败，请检查网络后重试。",
	},
	timeout: {
		key: "metadataDialog.appleMusic.errors.timeout",
		fallback: "请求超时，请稍后重试。",
	},
	rateLimited: {
		key: "metadataDialog.appleMusic.errors.rateLimited",
		fallback: "请求过于频繁，请稍后重试。",
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

	const handleUrlChange = useCallback(
		(value: string) => {
			inputValueRef.current = value;
			abortCurrentRequest();
			setUrl(value);
			setPreview(null);
			setSelectedFields(new Set());
			setErrorCode(null);
			setIsLoading(false);
			setIsApplying(false);
			applyStartedRef.current = false;
		},
		[abortCurrentRequest],
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
			inputValueRef.current = url;
			const requestVersion = abortCurrentRequest();

			setPreview(null);
			setSelectedFields(new Set());
			setErrorCode(null);
			setIsApplying(false);
			applyStartedRef.current = false;

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
		[abortCurrentRequest, url],
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
	};

	const errorMessage = errorCode
		? t(ERROR_MESSAGES[errorCode].key, ERROR_MESSAGES[errorCode].fallback)
		: "";
	const duration = formatDuration(preview?.durationMs);

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
						"粘贴 Apple Music 歌曲链接，获取歌名、歌手、专辑和 Apple Music ID。空字段默认勾选；勾选已有值的字段会替换该值。ISRC 和词曲作者需另行填写。",
					)}
				</Callout.Text>
			</Callout.Root>

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
						<Heading as="h3" size="2" id={previewTitleId}>
							{t("metadataDialog.appleMusic.previewTitle", "导入预览")}
						</Heading>
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
									? t(
											"metadataDialog.appleMusic.duration",
											"时长：{duration}",
											{ duration },
										)
									: null}
							</Text>
						)}
					</div>

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
