import { LocalLanguage24Regular, Timer24Regular } from "@fluentui/react-icons";
import { Flex, Select, Text, TextField } from "@radix-ui/themes";
import { useAtom, useAtomValue } from "jotai";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
	ttmlLanguageAtom,
	ttmlTimingModeAtom,
} from "$/modules/settings/states";
import {
	normalizeTtmlLanguage,
	type TtmlTimingMode,
} from "$/modules/ttml-processor/export-options";
import { resolvedTtmlLanguageAtom } from "$/modules/ttml-processor/language-state";
import { SettingsRow } from "./SettingsGroup";

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

export const TtmlExportOptions = () => {
	const { t } = useTranslation();
	const [timing, setTiming] = useAtom(ttmlTimingModeAtom);
	const [language, setLanguage] = useAtom(ttmlLanguageAtom);
	const resolvedLanguage = useAtomValue(resolvedTtmlLanguageAtom);
	const [custom, setCustom] = useState(!commonLanguages.has(language));
	const [draft, setDraft] = useState(language === "auto" ? "" : language);
	const invalid =
		custom && draft.trim() !== "" && !normalizeTtmlLanguage(draft);
	const timingTitle = t("settings.common.ttmlTiming", "TTML 计时模式");
	const languageTitle = t("settings.common.ttmlLanguage", "原文语言");

	return (
		<>
			<SettingsRow
				icon={<Timer24Regular />}
				title={timingTitle}
				description={t(
					"settings.common.ttmlTimingDesc",
					"自动按歌词判断。逐行只导出行时间，编辑器里的逐词时间仍保留。",
				)}
				action={
					<Select.Root
						value={timing}
						onValueChange={(value) => setTiming(value as TtmlTimingMode)}
					>
						<Select.Trigger aria-label={timingTitle} />
						<Select.Content>
							<Select.Item value="auto">
								{t("settings.common.ttmlTimingAuto", "自动")}
							</Select.Item>
							<Select.Item value="word">
								{t("settings.common.ttmlTimingWord", "逐词（Word）")}
							</Select.Item>
							<Select.Item value="line">
								{t("settings.common.ttmlTimingLine", "逐行（Line）")}
							</Select.Item>
						</Select.Content>
					</Select.Root>
				}
			/>
			<SettingsRow
				icon={<LocalLanguage24Regular />}
				title={languageTitle}
				description={t(
					"settings.common.ttmlLanguageDesc",
					"默认在本地检测当前歌词原文。手动选择仅作用于当前工程，不改变翻译语言。",
				)}
				action={
					<Flex
						direction="column"
						gap="2"
						style={{ width: "min(220px, 100%)" }}
					>
						<Select.Root
							value={custom ? "custom" : language || "source"}
							onValueChange={(value) => {
								if (value === "custom") {
									setDraft(language === "auto" ? "" : language);
									setCustom(true);
								} else {
									setCustom(false);
									setLanguage(value === "source" ? "" : value);
								}
							}}
						>
							<Select.Trigger aria-label={languageTitle} />
							<Select.Content>
								<Select.Item value="auto">
									{t("settings.common.ttmlLanguageAuto", "自动检测（默认）")}
								</Select.Item>
								<Select.Item value="source">
									{t("settings.common.ttmlLanguageSource", "跟随原文件")}
								</Select.Item>
								<Select.Item value="en">
									{t("settings.common.ttmlLanguageEn", "英语（en）")}
								</Select.Item>
								<Select.Item value="zh-Hans">
									{t(
										"settings.common.ttmlLanguageZhHans",
										"简体中文（zh-Hans）",
									)}
								</Select.Item>
								<Select.Item value="zh-Hant">
									{t(
										"settings.common.ttmlLanguageZhHant",
										"繁体中文（zh-Hant）",
									)}
								</Select.Item>
								<Select.Item value="ja">
									{t("settings.common.ttmlLanguageJa", "日语（ja）")}
								</Select.Item>
								<Select.Item value="ko">
									{t("settings.common.ttmlLanguageKo", "韩语（ko）")}
								</Select.Item>
								<Select.Item value="und">
									{t("settings.common.ttmlLanguageUnd", "未知（und）")}
								</Select.Item>
								<Select.Item value="custom">
									{t("settings.common.ttmlLanguageCustom", "自定义语言代码")}
								</Select.Item>
							</Select.Content>
						</Select.Root>
						{language === "auto" && (
							<Text size="1" color="gray">
								{t(
									"settings.common.ttmlLanguageAutoResult",
									"自动（{language}）",
									{
										language: resolvedLanguage,
									},
								)}
							</Text>
						)}
						{custom && (
							<>
								<TextField.Root
									aria-label={t(
										"settings.common.ttmlLanguageCustom",
										"自定义语言代码",
									)}
									aria-invalid={invalid ? true : undefined}
									placeholder="pt-BR"
									value={draft}
									onChange={(event) => {
										const value = event.currentTarget.value;
										setDraft(value);
										const normalized = normalizeTtmlLanguage(value);
										if (!value.trim() || normalized)
											setLanguage(normalized || "auto");
									}}
								/>
								{invalid && (
									<Text size="1" color="red" role="alert">
										{t(
											"settings.common.ttmlLanguageInvalid",
											"语言代码无效，已保留上一次有效选择。例：pt-BR。",
										)}
									</Text>
								)}
							</>
						)}
					</Flex>
				}
			/>
		</>
	);
};
