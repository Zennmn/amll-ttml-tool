import { Button, Dialog, Flex, Text, TextField } from "@radix-ui/themes";
import { useAtom } from "jotai";
import { type FormEvent, useState } from "react";
import { useTranslation } from "react-i18next";
import { ttmlLanguageAtom } from "$/modules/settings/states";
import { normalizeTtmlLanguage } from "$/modules/ttml-processor/export-options";
import { ttmlLanguageDialogAtom } from "$/states/dialogs";

const descriptionId = "ttml-language-dialog-description";
const errorId = "ttml-language-dialog-error";

const TtmlLanguageDialogContent = ({ onClose }: { onClose: () => void }) => {
	const { t } = useTranslation();
	const [language, setLanguage] = useAtom(ttmlLanguageAtom);
	const [draft, setDraft] = useState(language === "auto" ? "" : language);
	const normalized = normalizeTtmlLanguage(draft);
	const invalid = draft.trim() !== "" && !normalized;

	const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		if (invalid) return;
		setLanguage(normalized ?? "auto");
		onClose();
	};

	return (
		<Dialog.Root open onOpenChange={(open) => !open && onClose()}>
			<Dialog.Content maxWidth="460px">
				<form onSubmit={handleSubmit}>
					<Flex direction="column" gap="4">
						<Flex direction="column" gap="1">
							<Dialog.Title>
								{t("settings.common.ttmlLanguage", "原文语言")}
							</Dialog.Title>
							<Dialog.Description id={descriptionId} size="2" color="gray">
								{t(
									"ttmlExportMenu.customLanguageDescription",
									"设置当前工程的原文语言代码，例如 pt-BR。留空恢复自动检测，不改变翻译语言。",
								)}
							</Dialog.Description>
						</Flex>

						<Flex direction="column" gap="2">
							<Text size="2" weight="bold">
								{t("settings.common.ttmlLanguageCustom", "自定义语言代码")}
							</Text>
							<TextField.Root
								aria-describedby={invalid ? errorId : descriptionId}
								aria-invalid={invalid || undefined}
								aria-label={t(
									"settings.common.ttmlLanguageCustom",
									"自定义语言代码",
								)}
								autoCapitalize="off"
								autoCorrect="off"
								autoFocus
								placeholder="pt-BR"
								spellCheck={false}
								value={draft}
								onChange={(event) => setDraft(event.currentTarget.value)}
							/>
							{invalid && (
								<Text id={errorId} size="1" color="red" role="alert">
									{t(
										"ttmlExportMenu.invalidLanguage",
										"请输入有效的语言代码，例如 pt-BR，或留空恢复自动检测。",
									)}
								</Text>
							)}
						</Flex>

						<Flex gap="3" justify="end">
							<Button
								type="button"
								variant="soft"
								color="gray"
								onClick={onClose}
							>
								{t("common.cancel", "取消")}
							</Button>
							<Button type="submit" disabled={invalid}>
								{t("common.apply", "应用")}
							</Button>
						</Flex>
					</Flex>
				</form>
			</Dialog.Content>
		</Dialog.Root>
	);
};

export const TtmlLanguageDialog = () => {
	const [open, setOpen] = useAtom(ttmlLanguageDialogAtom);
	if (!open) return null;
	return <TtmlLanguageDialogContent onClose={() => setOpen(false)} />;
};
