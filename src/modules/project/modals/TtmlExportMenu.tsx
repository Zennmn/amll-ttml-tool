import { DropdownMenu, Flex, Text } from "@radix-ui/themes";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { useTranslation } from "react-i18next";
import {
	ttmlLanguageAtom,
	ttmlTimingModeAtom,
} from "$/modules/settings/states";
import type { TtmlTimingMode } from "$/modules/ttml-processor/export-options";
import { resolvedTtmlLanguageAtom } from "$/modules/ttml-processor/language-state";
import { ttmlLanguageDialogAtom } from "$/states/dialogs";

const commonLanguages = new Set([
	"auto",
	"",
	"en",
	"zh-Hans",
	"zh-Hant",
	"ja",
	"ko",
	"und",
]);

const SubmenuLabel = ({
	children,
	value,
}: {
	children: React.ReactNode;
	value: string;
}) => (
	<Flex align="center" gap="3" justify="between" width="100%">
		<span>{children}</span>
		<Text as="span" color="gray" size="1">
			{value}
		</Text>
	</Flex>
);

export const TtmlExportMenu = () => {
	const { t } = useTranslation();
	const [timing, setTiming] = useAtom(ttmlTimingModeAtom);
	const [language, setLanguage] = useAtom(ttmlLanguageAtom);
	const resolvedLanguage = useAtomValue(resolvedTtmlLanguageAtom);
	const setLanguageDialogOpen = useSetAtom(ttmlLanguageDialogAtom);

	const timingLabels: Record<TtmlTimingMode, string> = {
		auto: t("settings.common.ttmlTimingAuto", "自动"),
		word: t("settings.common.ttmlTimingWord", "逐词（Word）"),
		line: t("settings.common.ttmlTimingLine", "逐行（Line）"),
	};
	const conciseTimingLabels: Record<TtmlTimingMode, string> = {
		auto: timingLabels.auto,
		word: timingLabels.word.replace(/\s*[（(].*$/u, ""),
		line: timingLabels.line.replace(/\s*[（(].*$/u, ""),
	};
	const isCustomLanguage = !commonLanguages.has(language);
	const currentLanguage = isCustomLanguage ? "custom" : language || "source";

	return (
		<>
			<DropdownMenu.Sub>
				<DropdownMenu.SubTrigger>
					<SubmenuLabel value={conciseTimingLabels[timing]}>
						{t("settings.common.ttmlTiming", "TTML 计时模式")}
					</SubmenuLabel>
				</DropdownMenu.SubTrigger>
				<DropdownMenu.SubContent>
					<DropdownMenu.RadioGroup
						value={timing}
						onValueChange={(value) => setTiming(value as TtmlTimingMode)}
					>
						<DropdownMenu.RadioItem value="auto">
							{timingLabels.auto}
						</DropdownMenu.RadioItem>
						<DropdownMenu.RadioItem value="word">
							{timingLabels.word}
						</DropdownMenu.RadioItem>
						<DropdownMenu.RadioItem value="line">
							{timingLabels.line}
						</DropdownMenu.RadioItem>
					</DropdownMenu.RadioGroup>
				</DropdownMenu.SubContent>
			</DropdownMenu.Sub>

			<DropdownMenu.Sub>
				<DropdownMenu.SubTrigger>
					<SubmenuLabel
						value={
							language === "auto"
								? t(
										"settings.common.ttmlLanguageAutoResult",
										"自动（{language}）",
										{
											language: resolvedLanguage,
										},
									)
								: language ||
									t("settings.common.ttmlLanguageSource", "跟随原文件")
						}
					>
						{t("settings.common.ttmlLanguage", "原文语言")}
					</SubmenuLabel>
				</DropdownMenu.SubTrigger>
				<DropdownMenu.SubContent>
					<DropdownMenu.RadioGroup
						value={currentLanguage}
						onValueChange={(value) => {
							if (value === "custom") return;
							setLanguage(value === "source" ? "" : value);
						}}
					>
						<DropdownMenu.RadioItem value="auto">
							{t("settings.common.ttmlLanguageAuto", "自动检测（默认）")}
						</DropdownMenu.RadioItem>
						<DropdownMenu.RadioItem value="source">
							{t("settings.common.ttmlLanguageSource", "跟随原文件")}
						</DropdownMenu.RadioItem>
						<DropdownMenu.RadioItem value="en">
							{t("settings.common.ttmlLanguageEn", "英语（en）")}
						</DropdownMenu.RadioItem>
						<DropdownMenu.RadioItem value="zh-Hans">
							{t("settings.common.ttmlLanguageZhHans", "简体中文（zh-Hans）")}
						</DropdownMenu.RadioItem>
						<DropdownMenu.RadioItem value="zh-Hant">
							{t("settings.common.ttmlLanguageZhHant", "繁体中文（zh-Hant）")}
						</DropdownMenu.RadioItem>
						<DropdownMenu.RadioItem value="ja">
							{t("settings.common.ttmlLanguageJa", "日语（ja）")}
						</DropdownMenu.RadioItem>
						<DropdownMenu.RadioItem value="ko">
							{t("settings.common.ttmlLanguageKo", "韩语（ko）")}
						</DropdownMenu.RadioItem>
						<DropdownMenu.RadioItem value="und">
							{t("settings.common.ttmlLanguageUnd", "未知（und）")}
						</DropdownMenu.RadioItem>
						<DropdownMenu.RadioItem
							value="custom"
							onSelect={() => setLanguageDialogOpen(true)}
						>
							{t("settings.common.ttmlLanguageCustom", "自定义语言代码")}…
						</DropdownMenu.RadioItem>
					</DropdownMenu.RadioGroup>
				</DropdownMenu.SubContent>
			</DropdownMenu.Sub>
		</>
	);
};
