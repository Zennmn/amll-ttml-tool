import {
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
import { ttmlCleanupDialogAtom } from "$/states/dialogs.ts";
import { lyricLinesAtom } from "$/states/main.ts";
import { cleanupEditorLyrics } from "./editor-cleanup.ts";
import { applyTtmlCleanupAtom } from "./editor-state.ts";

export function TtmlCleanupDialog() {
	const { t } = useTranslation();
	const [open, setOpen] = useAtom(ttmlCleanupDialogAtom);
	const lyric = useAtomValue(lyricLinesAtom);
	const applyCleanup = useSetAtom(applyTtmlCleanupAtom);
	const [harmony, setHarmony] = useState(true);
	const [punctuation, setPunctuation] = useState(true);

	const preview = useMemo(
		() => (open ? cleanupEditorLyrics(lyric, { harmony, punctuation }) : null),
		[open, lyric, harmony, punctuation],
	);
	const hasLyrics = useMemo(
		() =>
			open &&
			lyric.lyricLines.some((line) =>
				line.words.some((word) => word.word.trim().length > 0),
			),
		[open, lyric],
	);
	const canApply =
		hasLyrics && (harmony || punctuation) && Boolean(preview?.changed);

	const onApply = () => {
		const result = applyCleanup({ harmony, punctuation });
		setOpen(false);
		if (result.changed) {
			toast.success(
				t(
					"ttmlCleanup.applied",
					"已整理当前歌词：背景和声 {harmony} 组，合并标点 {punctuation} 处。可用 Ctrl+Z 撤销。",
					{
						harmony: result.harmonyGroups,
						punctuation: result.punctuationMerged,
					},
				),
			);
		} else {
			toast.info(t("ttmlCleanup.noChanges", "当前歌词没有需要整理的内容"));
		}
	};

	return (
		<Dialog.Root open={open} onOpenChange={setOpen}>
			<Dialog.Content maxWidth="460px">
				<Dialog.Title>{t("ttmlCleanup.title", "整理当前歌词")}</Dialog.Title>
				<Dialog.Description size="2" mb="4">
					{t(
						"ttmlCleanup.description",
						"直接整理当前编辑器中的歌词。应用后可使用 Ctrl+Z 撤销。",
					)}
				</Dialog.Description>
				<Flex direction="column" gap="4">
					<Flex direction="column" gap="3">
						<Text as="label" size="2">
							<Flex gap="2" align="center">
								<Checkbox
									checked={punctuation}
									onCheckedChange={(checked) =>
										setPunctuation(checked === true)
									}
								/>
								{t("ttmlCleanup.punctuation", "合并独立标点")}
							</Flex>
						</Text>
						<Text as="label" size="2">
							<Flex gap="2" align="center">
								<Checkbox
									checked={harmony}
									onCheckedChange={(checked) => setHarmony(checked === true)}
								/>
								{t(
									"ttmlCleanup.harmony",
									"圆括号内歌词转为背景和声，并去掉圆括号",
								)}
							</Flex>
						</Text>
						<Text size="1" color="gray">
							{t(
								"ttmlCleanup.hint",
								"仅识别 () 和（）；其他括号、不成对的圆括号和遮蔽星号保留，原词时间轴不变。",
							)}
						</Text>
					</Flex>
					{!hasLyrics ? (
						<Callout.Root size="1" color="gray">
							<Callout.Text>
								{t("ttmlCleanup.empty", "当前没有歌词，请先导入或添加歌词。")}
							</Callout.Text>
						</Callout.Root>
					) : !harmony && !punctuation ? (
						<Callout.Root size="1" color="gray">
							<Callout.Text>
								{t("ttmlCleanup.chooseOption", "请至少选择一种整理方式。")}
							</Callout.Text>
						</Callout.Root>
					) : preview && !preview.changed ? (
						<Callout.Root size="1" color="gray">
							<Callout.Text>
								{t("ttmlCleanup.noChanges", "当前歌词没有需要整理的内容。")}
							</Callout.Text>
						</Callout.Root>
					) : (
						<Callout.Root size="1" color="green">
							<Callout.Text>
								{t(
									"ttmlCleanup.preview",
									"将整理背景和声 {harmony} 组、合并标点 {punctuation} 处。",
									{
										harmony: preview?.harmonyGroups ?? 0,
										punctuation: preview?.punctuationMerged ?? 0,
									},
								)}
							</Callout.Text>
						</Callout.Root>
					)}
				</Flex>
				<Flex gap="3" mt="5" justify="end">
					<Dialog.Close>
						<Button variant="soft" color="gray">
							{t("common.close", "关闭")}
						</Button>
					</Dialog.Close>
					<Button disabled={!canApply} onClick={onApply}>
						{t("ttmlCleanup.apply", "应用到当前歌词")}
					</Button>
				</Flex>
			</Dialog.Content>
		</Dialog.Root>
	);
}
