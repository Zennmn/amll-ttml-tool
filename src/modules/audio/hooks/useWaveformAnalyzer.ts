import { useSetAtom } from "jotai";
import { useEffect, useRef } from "react";
import {
	bpmStateAtom,
	pcmDataErrorAtom,
	pcmDataReadyAtom,
} from "$/modules/audio/states";
import AnalyzerWorker from "$/modules/ffmpeg/worker/analyzer.worker.ts?worker";
import RendererWorker from "$/modules/ffmpeg/worker/renderer.worker.ts?worker";
import ffmpegWasmUrl from "$/modules/ffmpeg/worker/wasm/ffmpeg/ffmpeg_wasm.wasm?url";

const BPM_ANALYSIS_TIMEOUT_MS = 60_000;

interface UseWaveformAnalyzerProps {
	audioFile: Blob | null;
	wsContainerRef: React.RefObject<HTMLDivElement | null>;
	canvasRef: React.RefObject<HTMLCanvasElement | null>;
	sliderWidthPx: number;
	engineState: string;
}

export const useWaveformAnalyzer = ({
	audioFile,
	wsContainerRef,
	canvasRef,
	sliderWidthPx,
	engineState,
}: UseWaveformAnalyzerProps) => {
	const setPcmDataReady = useSetAtom(pcmDataReadyAtom);
	const setPcmDataError = useSetAtom(pcmDataErrorAtom);
	const setBpmState = useSetAtom(bpmStateAtom);

	const analyzerWorkerRef = useRef<Worker | null>(null);
	const rendererWorkerRef = useRef<Worker | null>(null);
	const offscreenTransferred = useRef(false);

	useEffect(() => {
		let renderer: Worker;
		try {
			renderer = new RendererWorker();
			rendererWorkerRef.current = renderer;
		} catch {
			return;
		}
		return () => {
			renderer.terminate();
			if (rendererWorkerRef.current === renderer) {
				rendererWorkerRef.current = null;
			}
		};
	}, []);

	useEffect(() => {
		setPcmDataReady(false);
		setPcmDataError(null);
		if (!audioFile || audioFile.size === 0) {
			setBpmState({ status: "idle" });
			rendererWorkerRef.current?.postMessage({ type: "CLEAR" });
			return;
		}

		if (!rendererWorkerRef.current) {
			const error = "Could not start waveform renderer";
			setPcmDataError(error);
			setBpmState({ status: "error", error });
			return;
		}
		if (!canvasRef.current || !wsContainerRef.current) return;

		if (analyzerWorkerRef.current) {
			analyzerWorkerRef.current.terminate();
			analyzerWorkerRef.current = null;
		}

		setBpmState({ status: "analyzing" });

		try {
			if (!offscreenTransferred.current) {
				const offscreen = canvasRef.current.transferControlToOffscreen();
				const styles = getComputedStyle(wsContainerRef.current);
				const waveColor =
					styles.getPropertyValue("--accent-a4").trim() || "#00ffa21e";

				rendererWorkerRef.current.postMessage(
					{
						type: "INIT_CANVAS",
						payload: {
							canvas: offscreen,
							width: wsContainerRef.current.clientWidth,
							height: wsContainerRef.current.clientHeight,
							dpr: window.devicePixelRatio || 1,
							color: waveColor,
						},
					},
					[offscreen],
				);
				offscreenTransferred.current = true;
			}

			rendererWorkerRef.current.postMessage({ type: "CLEAR" });

			const mc = new MessageChannel();
			rendererWorkerRef.current.postMessage(
				{ type: "NEW_PORT", payload: { port: mc.port2 } },
				[mc.port2],
			);

			const worker = new AnalyzerWorker();
			analyzerWorkerRef.current = worker;
			let pcmReady = false;
			let bpmTimeout: ReturnType<typeof setTimeout> | undefined;
			const stopWorker = () => {
				clearTimeout(bpmTimeout);
				worker.onmessage = null;
				worker.onerror = null;
				worker.onmessageerror = null;
				worker.terminate();
				if (analyzerWorkerRef.current === worker) {
					analyzerWorkerRef.current = null;
				}
			};
			const failAnalysis = (error: string) => {
				setBpmState({ status: "error", error });
				// A failed BPM calculation does not invalidate decoded PCM.
				if (!pcmReady) setPcmDataError(error);
				stopWorker();
			};
			worker.onmessage = (e) => {
				if (e.data.type === "PCM_READY") {
					pcmReady = true;
					setPcmDataReady(true);
					bpmTimeout = setTimeout(
						() => failAnalysis("BPM analysis timed out"),
						BPM_ANALYSIS_TIMEOUT_MS,
					);
				} else if (e.data.type === "ANALYZE_DONE") {
					setPcmDataReady(true);
					if (e.data.payload?.bpmResult) {
						setBpmState({
							status: "completed",
							result: e.data.payload.bpmResult,
							calculationTime: e.data.payload.calculationTime,
						});
					} else if (e.data.payload?.error) {
						setBpmState({ status: "error", error: e.data.payload.error });
					}

					// 分析完销毁以便腾出内存
					stopWorker();
				} else if (e.data.type === "ANALYZE_ERROR") {
					failAnalysis(e.data.payload?.error || "Unknown analysis error");
				}
			};
			worker.onerror = (e) =>
				failAnalysis(e.message || "Audio analysis worker failed");
			worker.onmessageerror = () =>
				failAnalysis("Invalid audio analysis response");

			worker.postMessage(
				{
					type: "INIT",
					payload: {
						file: audioFile,
						ffmpegWasmUrl,
						port: mc.port1,
					},
				},
				[mc.port1],
			);
			return stopWorker;
		} catch (error) {
			analyzerWorkerRef.current?.terminate();
			analyzerWorkerRef.current = null;
			const message = error instanceof Error ? error.message : String(error);
			setPcmDataError(message);
			setBpmState({ status: "error", error: message });
		}
	}, [
		audioFile,
		setPcmDataReady,
		setPcmDataError,
		setBpmState,
		canvasRef,
		wsContainerRef,
	]);

	// 处理窗口大小变化并触发防抖重绘
	useEffect(() => {
		if (
			sliderWidthPx > 0 &&
			rendererWorkerRef.current &&
			wsContainerRef.current
		) {
			const timeoutId = setTimeout(() => {
				if (!wsContainerRef.current || !rendererWorkerRef.current) return;
				const styles = getComputedStyle(wsContainerRef.current);
				const waveColor =
					styles.getPropertyValue("--accent-a4").trim() || "#00ffa21e";

				rendererWorkerRef.current.postMessage({
					type: "RESIZE",
					payload: {
						width: sliderWidthPx,
						height: wsContainerRef.current.clientHeight,
						dpr: window.devicePixelRatio || 1,
						color: waveColor,
					},
				});
			}, 1000);
			return () => clearTimeout(timeoutId);
		}
	}, [sliderWidthPx, wsContainerRef]);

	// 如果音频引擎销毁了，或者音频引擎出错了，清空掉波形图
	useEffect(() => {
		if (engineState === "idle" && rendererWorkerRef.current) {
			rendererWorkerRef.current.postMessage({ type: "CLEAR" });
		}
	}, [engineState]);
};
