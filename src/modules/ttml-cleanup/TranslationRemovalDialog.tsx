import {
	Badge,
	Box,
	Button,
	Callout,
	Checkbox,
	Dialog,
	Flex,
	Text,
} from "@radix-ui/themes";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "react-toastify";
import { translationRemovalDialogAtom } from "$/states/dialogs";
import {
	lyricLinesAtom,
	projectIdAtom,
	selectedLinesAtom,
} from "$/states/main";
import type { LyricLine } from "$/types/ttml";
import { msToTimestamp } from "$/utils/timestamp";
import { removeTranslationsAtom } from "./translation-removal-state";

interface TranslationRow {
	line: LyricLine;
	lineIndex: number;
}

function TranslationRemovalDialogContent({ onClose }: { onClose: () => void }) {
	const { t } = useTranslation();
	const lyric = useAtomValue(lyricLinesAtom);
	const editorSelectedLineIds = useAtomValue(selectedLinesAtom);
	const applyRemoval = useSetAtom(removeTranslationsAtom);

	const translatedRows = useMemo<TranslationRow[]>(
		() =>
			lyric.lyricLines.flatMap((line, lineIndex) =>
				line.translatedLyric.trim().length > 0 ? [{ line, lineIndex }] : [],
			),
		[lyric.lyricLines],
	);
	const availableLineIds = useMemo(
		() => new Set(translatedRows.map(({ line }) => line.id)),
		[translatedRows],
	);
	const [selectedLineIds, setSelectedLineIds] = useState<Set<string>>(() => {
		return new Set(
			[...editorSelectedLineIds].filter((id) => availableLineIds.has(id)),
		);
	});
	const selectedIds = useMemo(
		() =>
			new Set([...selectedLineIds].filter((id) => availableLineIds.has(id))),
		[availableLineIds, selectedLineIds],
	);
	const selectedCount = selectedIds.size;
	const allSelected =
		translatedRows.length > 0 && selectedCount === translatedRows.length;

	const toggleLine = (lineId: string, checked: boolean) => {
		setSelectedLineIds((previous) => {
			const next = new Set(previous);
			if (checked) next.add(lineId);
			else next.delete(lineId);
			return next;
		});
	};

	const handleApply = () => {
		if (selectedCount === 0) return;
		const result = applyRemoval(new Set(selectedIds));
		onClose();
		if (result.changed) {
			toast.success(
				t(
					"translationRemoval.applied",
					"已移除 {count} 行翻译，可用 Ctrl+Z 撤销。",
					{ count: result.removedLines },
				),
			);
		} else {
			toast.info(
				t("translationRemoval.noChanges", "所选歌词没有可移除的翻译。"),
			);
		}
	};

	return (
		<Dialog.Root open onOpenChange={(open) => !open && onClose()}>
			<Dialog.Content maxWidth="720px">
				<Dialog.Title>
					{t("translationRemoval.title", "批量去除翻译")}
				</Dialog.Title>
				<Dialog.Description size="2" color="gray" mb="4">
					{t(
						"translationRemoval.description",
						"选择要移除翻译的歌词行。打开时会勾选编辑器中已有翻译的选中行；应用后可用 Ctrl+Z 撤销。",
					)}
				</Dialog.Description>

				<Flex align="center" justify="between" gap="3" mb="2" wrap="wrap">
					<Text size="2" weight="bold">
						{t("translationRemoval.available", "有翻译的歌词（{count}）", {
							count: translatedRows.length,
						})}
					</Text>
					<Flex gap="2">
						<Button
							size="1"
							variant="soft"
							disabled={translatedRows.length === 0 || allSelected}
							onClick={() =>
								setSelectedLineIds(
									new Set(translatedRows.map(({ line }) => line.id)),
								)
							}
						>
							{t("translationRemoval.selectAll", "全选")}
						</Button>
						<Button
							size="1"
							variant="ghost"
							color="gray"
							disabled={selectedCount === 0}
							onClick={() => setSelectedLineIds(new Set())}
						>
							{t("translationRemoval.clearSelection", "取消选择")}
						</Button>
					</Flex>
				</Flex>

				{translatedRows.length === 0 ? (
					<Callout.Root size="1" color="gray">
						<Callout.Text>
							{t("translationRemoval.empty", "当前歌词没有可移除的翻译。")}
						</Callout.Text>
					</Callout.Root>
				) : (
					<Box
						role="group"
						aria-label={t("translationRemoval.listLabel", "包含翻译的歌词行")}
						style={{
							maxHeight: "min(52vh, 420px)",
							overflowY: "auto",
							border: "1px solid var(--gray-5)",
							borderRadius: "var(--radius-3)",
						}}
					>
						{translatedRows.map(({ line, lineIndex }) => {
							const checkboxId = `translation-removal-${line.id}`;
							const checked = selectedIds.has(line.id);
							const original = line.words.map((word) => word.word).join("");
							const hasOriginal = original.trim().length > 0;
							return (
								<Box
									key={line.id}
									px="3"
									py="2"
									style={{
										borderBottom: "1px solid var(--gray-4)",
										backgroundColor: checked ? "var(--accent-2)" : undefined,
									}}
								>
									<Flex align="start" gap="3">
										<Checkbox
											id={checkboxId}
											checked={checked}
											aria-label={t(
												"translationRemoval.selectLine",
												"选择第 {line} 行翻译",
												{ line: lineIndex + 1 },
											)}
											onCheckedChange={(value) =>
												toggleLine(line.id, value === true)
											}
											style={{ marginTop: 3 }}
										/>
										<Box style={{ flex: 1, minWidth: 0 }}>
											<Flex align="center" gap="2" wrap="wrap">
												<Text
													as="label"
													htmlFor={checkboxId}
													size="1"
													color="gray"
												>
													#{lineIndex + 1} · {msToTimestamp(line.startTime)}
												</Text>
												{line.isBG && (
													<Badge size="1" variant="soft" color="green">
														{t(
															"translationRemoval.lineTag.background",
															"背景和声",
														)}
													</Badge>
												)}
												{line.isDuet && (
													<Badge size="1" variant="soft" color="blue">
														{t("translationRemoval.lineTag.duet", "对唱")}
													</Badge>
												)}
												{!hasOriginal && (
													<Badge size="1" variant="soft" color="amber">
														{t(
															"translationRemoval.lineTag.translationOnly",
															"仅翻译",
														)}
													</Badge>
												)}
											</Flex>
											<Text
												as="p"
												size="2"
												weight="medium"
												style={{
													margin: "4px 0 0",
													whiteSpace: "pre-wrap",
													wordBreak: "break-word",
												}}
											>
												{hasOriginal
													? original
													: t("translationRemoval.noOriginal", "（无原文）")}
											</Text>
											<Text
												as="p"
												size="2"
												color="gray"
												style={{
													margin: "2px 0 0",
													whiteSpace: "pre-wrap",
													wordBreak: "break-word",
												}}
											>
												{line.translatedLyric}
											</Text>
										</Box>
									</Flex>
								</Box>
							);
						})}
					</Box>
				)}

				<Flex gap="3" mt="4" justify="end">
					<Dialog.Close>
						<Button variant="soft" color="gray">
							{t("translationRemoval.cancel", "取消")}
						</Button>
					</Dialog.Close>
					<Button
						color="red"
						disabled={selectedCount === 0}
						onClick={handleApply}
					>
						{t("translationRemoval.removeSelected", "移除所选翻译（{count}）", {
							count: selectedCount,
						})}
					</Button>
				</Flex>
			</Dialog.Content>
		</Dialog.Root>
	);
}

export function TranslationRemovalDialog() {
	const [open, setOpen] = useAtom(translationRemovalDialogAtom);
	const projectId = useAtomValue(projectIdAtom);
	if (!open) return null;
	return (
		<TranslationRemovalDialogContent
			key={projectId}
			onClose={() => setOpen(false)}
		/>
	);
}
