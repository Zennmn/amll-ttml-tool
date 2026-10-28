import {
	Button,
	Callout,
	Dialog,
	Flex,
	Text,
	TextField,
} from "@radix-ui/themes";
import { useAtom, useStore } from "jotai";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { audioEngine } from "$/modules/audio/audio-engine";
import { loadedAudioAtom } from "$/modules/audio/states";
import { appleMusicAudioDialogAtom } from "$/states/dialogs";
import { projectIdAtom } from "$/states/main";
import {
	type AppleMusicAuth,
	type AudioErrorCode,
	type AudioJob,
	acquireAppleMusicAudio,
	audioErrorCode,
	canonicalAudioLink,
	createAppleMusicAudioClient,
	isAppleMusicAudioDesktop,
} from "./client";

export function AppleMusicAudioDialog() {
	const [open, setOpen] = useAtom(appleMusicAudioDialogAtom);
	const [url, setUrl] = useState("");
	const [auth, setAuth] = useState<AppleMusicAuth | null>(null);
	const [job, setJob] = useState<AudioJob | null>(null);
	const [error, setError] = useState<AudioErrorCode | null>(null);
	const [busy, setBusy] = useState(false);
	const [authBusy, setAuthBusy] = useState(false);
	const [applying, setApplying] = useState(false);
	const controller = useRef<AbortController | null>(null);
	const version = useRef(0);
	const store = useStore();
	const { t } = useTranslation();
	const desktop = isAppleMusicAudioDesktop();
	const client = useMemo(() => createAppleMusicAudioClient(), []);
	useEffect(() => {
		if (!open || !desktop || authBusy) return;
		let cancelled = false;
		const revision = version.current;
		let timer: ReturnType<typeof setTimeout>;
		const update = async () => {
			try {
				const next = await client.status();
				if (!cancelled && revision === version.current) setAuth(next);
			} catch (e) {
				if (!cancelled && revision === version.current)
					setError(audioErrorCode(e));
			}
			if (!cancelled) timer = setTimeout(update, 750);
		};
		void update();
		return () => {
			cancelled = true;
			clearTimeout(timer);
		};
	}, [open, desktop, client, authBusy]);
	useEffect(
		() => () => {
			version.current++;
			controller.current?.abort();
		},
		[],
	);
	const close = (next: boolean) => {
		if (applying) return;
		if (!next) {
			version.current++;
			controller.current?.abort();
			setError(null);
		}
		setOpen(next);
	};
	const authenticate = async (logout: boolean) => {
		const revision = ++version.current;
		setAuthBusy(true);
		setError(null);
		try {
			const next = await (logout ? client.logout() : client.login());
			if (revision === version.current) setAuth(next);
		} catch (e) {
			if (revision === version.current) setError(audioErrorCode(e));
		} finally {
			setAuthBusy(false);
		}
	};
	const start = async () => {
		try {
			canonicalAudioLink(url);
		} catch (e) {
			setError(audioErrorCode(e));
			return;
		}
		const revision = ++version.current;
		const abort = new AbortController();
		controller.current = abort;
		const project = store.get(projectIdAtom);
		const previousAudio = store.get(loadedAudioAtom);
		const current = () =>
			revision === version.current &&
			store.get(projectIdAtom) === project &&
			store.get(loadedAudioAtom) === previousAudio;
		setBusy(true);
		setError(null);
		setJob(null);
		try {
			const file = await acquireAppleMusicAudio(client, url, {
				signal: abort.signal,
				isCurrent: current,
				onProgress: (next) => {
					if (current()) setJob(next);
				},
			});
			if (!current() || abort.signal.aborted) return;
			setApplying(true);
			await audioEngine.loadMusic(file);
			setOpen(false);
		} catch (e) {
			if (revision === version.current && audioErrorCode(e) !== "cancelled")
				setError(audioErrorCode(e));
		} finally {
			controller.current = null;
			setBusy(false);
			setApplying(false);
			setJob(null);
		}
	};
	const progress = job?.progress == null ? undefined : job.progress * 100;
	return (
		<Dialog.Root open={open} onOpenChange={close}>
			<Dialog.Content
				maxWidth="640px"
				onEscapeKeyDown={(e) => {
					if (applying) e.preventDefault();
				}}
			>
				<Dialog.Title>{t("appleMusicAudio.title")}</Dialog.Title>
				<Dialog.Description mb="4">
					{t("appleMusicAudio.description")}
				</Dialog.Description>
				<Flex direction="column" gap="4">
					{!desktop ? (
						<Callout.Root>
							<Callout.Text>{t("appleMusicAudio.desktopOnly")}</Callout.Text>
						</Callout.Root>
					) : (
						<>
							<Flex align="center" justify="between" gap="3" wrap="wrap">
								<Text size="2" color={auth?.authenticated ? "green" : "gray"}>
									{t(
										auth?.authenticated
											? "appleMusicAudio.signedIn"
											: auth?.loginOpen
												? "appleMusicAudio.waitingLogin"
												: "appleMusicAudio.signedOut",
									)}
								</Text>
								<Flex gap="2">
									<Button
										type="button"
										variant="soft"
										loading={authBusy}
										disabled={busy}
										onClick={() => void authenticate(false)}
									>
										{t("appleMusicAudio.webLogin")}
									</Button>
									{auth?.authenticated && (
										<Button
											type="button"
											variant="ghost"
											color="gray"
											disabled={busy || authBusy}
											onClick={() => void authenticate(true)}
										>
											{t("appleMusicAudio.logout")}
										</Button>
									)}
								</Flex>
							</Flex>
							<Text as="label" size="2" htmlFor="apple-music-audio-url">
								{t("appleMusicAudio.linkLabel")}
							</Text>
							<TextField.Root
								id="apple-music-audio-url"
								placeholder="https://music.apple.com/…"
								value={url}
								disabled={busy}
								onChange={(event) => {
									setUrl(event.target.value);
									setError(null);
								}}
							/>
							<Text size="1" color="gray">
								{t("appleMusicAudio.cacheHint")}
							</Text>
							{auth && !auth.runtimeReady && (
								<Callout.Root color="amber">
									<Callout.Text>
										{t("appleMusicAudio.errors.runtimeMissing")}
									</Callout.Text>
								</Callout.Root>
							)}
						</>
					)}
					{busy && (
						<Flex direction="column" gap="2" role="status" aria-live="polite">
							<Text size="2">
								{t(
									applying
										? "appleMusicAudio.loadingAudio"
										: `appleMusicAudio.stages.${job?.state ?? "queued"}`,
								)}
							</Text>
							<progress
								aria-label={t("appleMusicAudio.progress")}
								max={100}
								value={progress}
								style={{ width: "100%", accentColor: "var(--accent-9)" }}
							/>
							{job?.bytesReceived != null && (
								<Text size="1" color="gray">
									{(job.bytesReceived / 1024 / 1024).toFixed(1)} MB
								</Text>
							)}
						</Flex>
					)}
					{error && (
						<Callout.Root color="red" role="alert">
							<Callout.Text>
								{t(`appleMusicAudio.errors.${error}`)}
							</Callout.Text>
						</Callout.Root>
					)}
					<Flex gap="3" justify="end" wrap="wrap">
						<Button
							type="button"
							variant="soft"
							color="gray"
							disabled={applying}
							onClick={() => close(false)}
						>
							{t("appleMusicAudio.close")}
						</Button>
						{busy ? (
							<Button
								type="button"
								variant="soft"
								color="red"
								disabled={applying}
								onClick={() => controller.current?.abort()}
							>
								{t("appleMusicAudio.cancel")}
							</Button>
						) : (
							<Button
								type="button"
								disabled={
									!desktop ||
									!auth?.authenticated ||
									!auth?.runtimeReady ||
									authBusy ||
									!url.trim()
								}
								onClick={() => void start()}
							>
								{t("appleMusicAudio.download")}
							</Button>
						)}
					</Flex>
				</Flex>
			</Dialog.Content>
		</Dialog.Root>
	);
}
