import {
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
import { timelineFormatDialogAtom } from "$/states/dialogs";
import { lyricLinesAtom, projectIdAtom } from "$/states/main";
import { msToTimestamp } from "$/utils/timestamp";
import { formatTimeline } from "./format-timeline";
import { formatTimelineAtom } from "./timeline-format-state";

function TimelineFormatContent({ onClose }: { onClose: () => void }) {
	const { t } = useTranslation();
	const lyric = useAtomValue(lyricLinesAtom);
	const apply = useSetAtom(formatTimelineAtom);
	const [mergeTranslations, setMergeTranslations] = useState(true);
	const [excludedGroups, setExcludedGroups] = useState(new Set<string>());
	const candidates = useMemo(
		() => formatTimeline(lyric, { mergeTranslations: false }),
		[lyric],
	);
	const mergeGroupIds = useMemo(
		() =>
			new Set(
				candidates.translationGroups
					.filter((group) => !excludedGroups.has(group.id))
					.map((group) => group.id),
			),
		[candidates, excludedGroups],
	);
	const preview = useMemo(
		() => formatTimeline(lyric, { mergeTranslations, mergeGroupIds }),
		[lyric, mergeTranslations, mergeGroupIds],
	);
	return (
		<>
			<Dialog.Title>{t("timelineFormat.title", "格式化时间轴")}</Dialog.Title>
			<Dialog.Description size="2" mb="4">
				{t(
					"timelineFormat.description",
					"按歌词开始时间从早到晚排序，相同时间保持原顺序。和声随所属主句移动，原文、逐字时间和音译保留。",
				)}
			</Dialog.Description>
			<Flex direction="column" gap="3">
				<Text as="label" size="2">
					<Flex align="center" gap="2">
						<Checkbox
							checked={mergeTranslations}
							onCheckedChange={(checked) =>
								setMergeTranslations(checked === true)
							}
						/>
						{t("timelineFormat.merge", "合并同时间戳的已有翻译")}
					</Flex>
				</Text>
				<Text size="1" color="gray">
					{t(
						"timelineFormat.mergeHint",
						"同一开始时间、同一声部的翻译按原顺序合并到该组第一条原文的翻译栏，重复译文仅保留一次，其余行只清空翻译。所有原文行保留；主句、和声、对唱分开，未打轴行跳过。可取消不需要合并的组。",
					)}
				</Text>
				<Callout.Root size="1" color={preview.changed ? "green" : "gray"}>
					<Callout.Text>
						{preview.changed
							? t(
									"timelineFormat.preview",
									"将调整 {lines} 行的位置，合并 {groups} 组翻译。可用 Ctrl+Z 撤销。",
									{
										lines: preview.reorderedLines,
										groups: preview.mergedGroups,
									},
								)
							: t("timelineFormat.noChanges", "当前歌词没有需要格式化的内容。")}
					</Callout.Text>
				</Callout.Root>
				{mergeTranslations && candidates.translationGroups.length > 0 && (
					<Box style={{ maxHeight: "38vh", overflowY: "auto" }}>
						<Flex direction="column" gap="3">
							{candidates.translationGroups.map((group) => (
								<Box
									key={group.id}
									p="3"
									style={{
										border: "1px solid var(--gray-a5)",
										borderRadius: "var(--radius-3)",
										overflowWrap: "anywhere",
									}}
								>
									<Text as="label" size="2" weight="bold">
										<Flex align="center" gap="2">
											<Checkbox
												checked={!excludedGroups.has(group.id)}
												onCheckedChange={(checked) =>
													setExcludedGroups((previous) => {
														const next = new Set(previous);
														if (checked === true) next.delete(group.id);
														else next.add(group.id);
														return next;
													})
												}
											/>
											{t("timelineFormat.target", "第 {line} 行 · {time}", {
												line: group.targetLineNumber,
												time: msToTimestamp(group.startTime),
											})}
											{group.isBG && t("timelineFormat.background", "和声")}
											{group.isDuet && t("timelineFormat.duet", "对唱")}
										</Flex>
									</Text>
									<Text
										as="p"
										size="2"
										mt="2"
										style={{ whiteSpace: "pre-wrap" }}
									>
										{group.original ||
											t("timelineFormat.emptyOriginal", "（无原文）")}
									</Text>
									<Text as="div" size="1" color="gray" mt="2">
										{t("timelineFormat.sources", "翻译来源：第 {lines} 行", {
											lines: group.translations
												.map((item) => item.lineNumber)
												.join(", "),
										})}
									</Text>
									<Text
										as="p"
										size="2"
										mt="1"
										style={{ whiteSpace: "pre-wrap" }}
									>
										{group.mergedTranslation}
									</Text>
								</Box>
							))}
						</Flex>
					</Box>
				)}
			</Flex>
			<Flex gap="3" mt="5" justify="end" wrap="wrap">
				<Dialog.Close>
					<Button variant="soft" color="gray">
						{t("common.cancel", "取消")}
					</Button>
				</Dialog.Close>
				<Button
					disabled={!preview.changed}
					onClick={() => {
						const result = apply({ mergeTranslations, mergeGroupIds });
						onClose();
						if (result.changed)
							toast.success(
								t(
									"timelineFormat.applied",
									"已格式化时间轴：调整 {lines} 行的位置，合并 {groups} 组翻译。可用 Ctrl+Z 撤销。",
									{ lines: result.reorderedLines, groups: result.mergedGroups },
								),
							);
					}}
				>
					{t("common.apply", "应用")}
				</Button>
			</Flex>
		</>
	);
}

export function TimelineFormatDialog() {
	const [open, setOpen] = useAtom(timelineFormatDialogAtom);
	const projectId = useAtomValue(projectIdAtom);
	return (
		<Dialog.Root open={open} onOpenChange={setOpen}>
			<Dialog.Content maxWidth="680px">
				{open && (
					<TimelineFormatContent
						key={projectId}
						onClose={() => setOpen(false)}
					/>
				)}
			</Dialog.Content>
		</Dialog.Root>
	);
}
