import { Button, DropdownMenu } from "@radix-ui/themes";
import { useSetAtom } from "jotai";
import { Toolbar } from "radix-ui";
import type { CSSProperties } from "react";
import { Trans, useTranslation } from "react-i18next";
import { toast } from "react-toastify";
import { fillMissingTranslationsAtom } from "$/modules/ttml-cleanup/editor-state.ts";
import {
	shortSyllableMergeDialogAtom,
	timelineFormatDialogAtom,
	translationRemovalDialogAtom,
	ttmlCleanupDialogAtom,
} from "$/states/dialogs.ts";
import { useTopMenuActions } from "../useTopMenuActions";

type ToolMenuProps = {
	variant: "toolbar" | "submenu";
	triggerStyle?: CSSProperties;
	buttonStyle?: CSSProperties;
};

const ToolMenuItems = () => {
	const { t } = useTranslation();
	const menu = useTopMenuActions();
	const setCleanupOpen = useSetAtom(ttmlCleanupDialogAtom);
	const setTimelineFormatOpen = useSetAtom(timelineFormatDialogAtom);
	const setTranslationRemovalOpen = useSetAtom(translationRemovalDialogAtom);
	const setShortSyllableMergeOpen = useSetAtom(shortSyllableMergeDialogAtom);
	const fillMissingTranslations = useSetAtom(fillMissingTranslationsAtom);

	return (
		<>
			<DropdownMenu.Item onSelect={() => setTimelineFormatOpen(true)}>
				{t("timelineFormat.menu", "格式化时间轴...")}
			</DropdownMenu.Item>
			<DropdownMenu.Item onSelect={() => setTranslationRemovalOpen(true)}>
				{t("translationRemoval.menu", "批量去除翻译...")}
			</DropdownMenu.Item>
			<DropdownMenu.Item onSelect={() => setCleanupOpen(true)}>
				{t("ttmlCleanup.menu", "整理 TTML 歌词...")}
			</DropdownMenu.Item>
			<DropdownMenu.Item
				onSelect={() => {
					const result = fillMissingTranslations();
					if (result.changed) {
						toast.success(
							t(
								"translationFill.applied",
								"已用原文补齐 {count} 行缺失翻译。可用 Ctrl+Z 撤销。",
								{ count: result.filledLines },
							),
						);
					} else {
						toast.info(
							t("translationFill.noChanges", "当前歌词没有缺失的翻译"),
						);
					}
				}}
			>
				{t("translationFill.menu", "用原文补齐缺失翻译")}
			</DropdownMenu.Item>
			<DropdownMenu.Sub>
				<DropdownMenu.SubTrigger>
					{t("topBar.menu.segmentationTools", "分词")}
				</DropdownMenu.SubTrigger>
				<DropdownMenu.SubContent>
					<DropdownMenu.Item onSelect={menu.onAutoSegment}>
						{t("topBar.menu.autoSegment", "自动分词")}
					</DropdownMenu.Item>
					<DropdownMenu.Item onSelect={menu.onRubySegment}>
						{t("topBar.menu.rubySegment", "注音分词")}
					</DropdownMenu.Item>
					<DropdownMenu.Item onSelect={menu.onOpenAdvancedSegmentation}>
						{t("topBar.menu.advancedSegment", "高级分词...")}
					</DropdownMenu.Item>
				</DropdownMenu.SubContent>
			</DropdownMenu.Sub>
			<DropdownMenu.Item onSelect={menu.onOpenSyllableSmoothing}>
				{t("topBar.menu.syllableSmoothing", "平滑时间轴...")}
			</DropdownMenu.Item>
			<DropdownMenu.Item onSelect={() => setShortSyllableMergeOpen(true)}>
				{t("shortSyllableMerge.menu", "合并过短音节...")}
			</DropdownMenu.Item>
			<DropdownMenu.Item onSelect={menu.onSyncLineTimestamps}>
				{t("topBar.menu.syncLineTimestamps", "同步行时间戳")}
			</DropdownMenu.Item>
			<DropdownMenu.Sub>
				<DropdownMenu.SubTrigger>
					{t("topBar.menu.perWordRomanization.index", "逐字音译")}
				</DropdownMenu.SubTrigger>
				<DropdownMenu.SubContent>
					<DropdownMenu.Item onSelect={menu.onOpenDistributeRomanization}>
						{t(
							"topBar.menu.perWordRomanization.distribute",
							"自动分配罗马音...",
						)}
					</DropdownMenu.Item>
					<DropdownMenu.Item onSelect={menu.onCheckRomanizationWarnings}>
						{t("topBar.menu.perWordRomanization.check", "检查")}
					</DropdownMenu.Item>
				</DropdownMenu.SubContent>
			</DropdownMenu.Sub>
			<DropdownMenu.Item onSelect={menu.onAutoRuby}>
				{t("topBar.menu.perWordRomanization.autoRuby", "自动注音")}
			</DropdownMenu.Item>
			<DropdownMenu.Item onSelect={menu.onOpenLatencyTest}>
				{t("settingsDialog.common.latencyTest", "音频/输入延迟测试")}
			</DropdownMenu.Item>
		</>
	);
};

export const ToolMenu = (props: ToolMenuProps) => {
	if (props.variant === "submenu") {
		return (
			<DropdownMenu.Sub>
				<DropdownMenu.SubTrigger>
					<Trans i18nKey="topBar.menu.tool">工具</Trans>
				</DropdownMenu.SubTrigger>
				<DropdownMenu.SubContent>
					<ToolMenuItems />
				</DropdownMenu.SubContent>
			</DropdownMenu.Sub>
		);
	}

	return (
		<DropdownMenu.Root>
			<Toolbar.Button asChild>
				<DropdownMenu.Trigger style={props.triggerStyle}>
					<Button variant="soft" style={props.buttonStyle}>
						<Trans i18nKey="topBar.menu.tool">工具</Trans>
					</Button>
				</DropdownMenu.Trigger>
			</Toolbar.Button>
			<DropdownMenu.Content>
				<ToolMenuItems />
			</DropdownMenu.Content>
		</DropdownMenu.Root>
	);
};
