import { InfoRegular } from "@fluentui/react-icons";
import {
	Button,
	Callout,
	Dialog,
	Flex,
	RadioGroup,
	Text,
	TextField,
} from "@radix-ui/themes";
import { useAtom, useSetAtom } from "jotai";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "react-toastify";
import {
	DialogScopeSelector,
	useDialogScope,
} from "$/hooks/useDialogScope.tsx";
import { applyShortSyllableMergeAtom } from "$/modules/segmentation/states/short-syllable-merge.ts";
import { shortSyllableMergeDialogAtom } from "$/states/dialogs.ts";

type MergeDirection = "auto" | "previous" | "next";

const DEFAULT_THRESHOLD_MS = 100;
const MIN_THRESHOLD_MS = 1;
const MAX_THRESHOLD_MS = 1000;

export const ShortSyllableMergeDialog = () => {
	const { t } = useTranslation();
	const [open, setOpen] = useAtom(shortSyllableMergeDialogAtom);
	const scopeState = useDialogScope(open);
	const applyShortSyllableMerge = useSetAtom(applyShortSyllableMergeAtom);
	const [thresholdInput, setThresholdInput] = useState(
		String(DEFAULT_THRESHOLD_MS),
	);
	const [direction, setDirection] = useState<MergeDirection>("auto");

	const thresholdMs = Number(thresholdInput);
	const isThresholdValid =
		Number.isInteger(thresholdMs) &&
		thresholdMs >= MIN_THRESHOLD_MS &&
		thresholdMs <= MAX_THRESHOLD_MS;

	const handleConfirm = () => {
		if (!isThresholdValid) return;

		const result = applyShortSyllableMerge({
			thresholdMs,
			direction,
			targetLineIndices: scopeState.getTargetLineIndices(),
		});

		setOpen(false);

		if (result.changed) {
			toast.success(
				t(
					"shortSyllableMerge.applied",
					"已合并 {mergedUnits} 个过短音节，涉及 {changedLines} 行。可用 Ctrl+Z 撤销。",
					{
						mergedUnits: result.mergedUnits,
						changedLines: result.changedLines,
					},
				),
			);
		} else {
			toast.info(
				t(
					"shortSyllableMerge.noChanges",
					"没有找到符合条件、可合并的过短音节。",
				),
			);
		}
	};

	return (
		<Dialog.Root open={open} onOpenChange={setOpen}>
			<Dialog.Content maxWidth="450px">
				<Dialog.Title>
					{t("shortSyllableMerge.title", "合并过短音节")}
				</Dialog.Title>
				<Dialog.Description size="2" mb="3" color="gray">
					{t(
						"shortSyllableMerge.description",
						"仅合并同一行内相邻、时间有效且自身短于阈值的 CJK 音节；相邻间隔超过阈值、未计时、无效时间或非 CJK 内容会跳过。",
					)}
				</Dialog.Description>

				<Flex direction="column" gap="4">
					<Callout.Root color="gray" size="1">
						<Callout.Icon>
							<InfoRegular />
						</Callout.Icon>
						<Callout.Text>
							{t(
								"shortSyllableMerge.directionHint",
								"自动选择会先选间隔更近的一侧；间隔相同时选较短邻居，再相同时选前一个。指定方向不可用时，会回退到另一侧。",
							)}
						</Callout.Text>
					</Callout.Root>

					<Flex direction="column" gap="2">
						<Text size="2" weight="bold">
							{t("shortSyllableMerge.thresholdLabel", "短音节阈值")}
						</Text>
						<TextField.Root
							aria-label={t("shortSyllableMerge.thresholdLabel", "短音节阈值")}
							style={{ width: "110px" }}
							size="1"
							type="number"
							min={MIN_THRESHOLD_MS}
							max={MAX_THRESHOLD_MS}
							step="1"
							value={thresholdInput}
							onChange={(event) => setThresholdInput(event.target.value)}
							color={isThresholdValid ? undefined : "red"}
						>
							<TextField.Slot />
							<TextField.Slot>
								{t("shortSyllableMerge.thresholdUnit", "毫秒")}
							</TextField.Slot>
						</TextField.Root>
						{!isThresholdValid && (
							<Text size="1" color="red">
								{t(
									"shortSyllableMerge.thresholdInvalid",
									"请输入 1 到 1000 之间的整数毫秒值。",
								)}
							</Text>
						)}
					</Flex>

					<Flex direction="column" gap="2">
						<Text size="2" weight="bold">
							{t("shortSyllableMerge.directionLabel", "合并方向")}
						</Text>
						<RadioGroup.Root
							value={direction}
							onValueChange={(value) => setDirection(value as MergeDirection)}
						>
							<Flex direction="column" gap="2">
								<RadioGroup.Item value="auto">
									{t("shortSyllableMerge.directionAuto", "自动选择")}
								</RadioGroup.Item>
								<RadioGroup.Item value="previous">
									{t("shortSyllableMerge.directionPrevious", "优先向前")}
								</RadioGroup.Item>
								<RadioGroup.Item value="next">
									{t("shortSyllableMerge.directionNext", "优先向后")}
								</RadioGroup.Item>
							</Flex>
						</RadioGroup.Root>
					</Flex>

					<DialogScopeSelector {...scopeState} />
				</Flex>

				<Flex gap="3" mt="5" justify="end">
					<Dialog.Close>
						<Button variant="soft" color="gray">
							{t("common.cancel", "取消")}
						</Button>
					</Dialog.Close>
					<Button disabled={!isThresholdValid} onClick={handleConfirm}>
						{t("common.apply", "应用")}
					</Button>
				</Flex>
			</Dialog.Content>
		</Dialog.Root>
	);
};
