import { AppleMusicAudioDialog } from "$/modules/apple-music-audio/AppleMusicAudioDialog";
import { LatencyTestDialog } from "$/modules/audio/modals/LatencyTest.tsx";
import { ImportFromLRCLIB } from "$/modules/lrclib/modals/ImportDialog.tsx";
import { ReplaceWordDialog } from "$/modules/lyric-editor/tools/ReplaceWordDialog.tsx";
import { ShortSyllableMergeDialog } from "$/modules/lyric-editor/tools/ShortSyllableMergeDialog.tsx";
import { SyllableSmoothingDialog } from "$/modules/lyric-editor/tools/SyllableSmoothingDialog.tsx";
import { TimeShiftDialog } from "$/modules/lyric-editor/tools/TimeShift.tsx";
import { DistributeRomanizationDialog } from "$/modules/project/modals/DistributeRomanization.tsx";
import { HistoryRestoreDialog } from "$/modules/project/modals/HistoryRestore.tsx";
import { ImportFromText } from "$/modules/project/modals/ImportFromText.tsx";
import { MetadataEditor } from "$/modules/project/modals/MetadataEditor.tsx";
import { SubmitToAMLLDBDialog } from "$/modules/project/modals/SubmitToAmll.tsx";
import { TtmlLanguageDialog } from "$/modules/project/modals/TtmlLanguageDialog.tsx";
import { AdvancedSegmentationDialog } from "$/modules/segmentation/components/AdvancedSegmentation.tsx";
import { SplitWordDialog } from "$/modules/segmentation/components/split-word.tsx";
import { SettingsDialog } from "$/modules/settings/modals/index.tsx";
import { TimelineFormatDialog } from "$/modules/ttml-cleanup/TimelineFormatDialog.tsx";
import { TranslationRemovalDialog } from "$/modules/ttml-cleanup/TranslationRemovalDialog.tsx";
import { TtmlCleanupDialog } from "$/modules/ttml-cleanup/TtmlCleanupDialog.tsx";
import { ConfirmationDialog } from "./confirmation.tsx";
import { TtmlErrorDialog } from "./TtmlErrorDialog.tsx";

export const Dialogs = () => {
	return (
		<>
			<AppleMusicAudioDialog />
			<ImportFromText />
			<ImportFromLRCLIB />
			<MetadataEditor />
			<TtmlLanguageDialog />
			<SettingsDialog />
			<SplitWordDialog />
			<ReplaceWordDialog />
			<SubmitToAMLLDBDialog />
			<LatencyTestDialog />
			<ConfirmationDialog />
			<HistoryRestoreDialog />
			<AdvancedSegmentationDialog />
			<TimeShiftDialog />
			<SyllableSmoothingDialog />
			<ShortSyllableMergeDialog />
			<TtmlCleanupDialog />
			<TimelineFormatDialog />
			<TranslationRemovalDialog />
			<DistributeRomanizationDialog />
			<TtmlErrorDialog />
		</>
	);
};

export default Dialogs;
