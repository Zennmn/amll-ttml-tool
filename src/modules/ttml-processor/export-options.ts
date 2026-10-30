export type TtmlTimingMode = "auto" | "word" | "line";

/** An empty value follows the imported document's original language. */
export function normalizeTtmlLanguage(value: string): string | undefined {
	const trimmed = value.trim();
	if (!trimmed || trimmed.toLowerCase() === "auto") return undefined;
	try {
		return Intl.getCanonicalLocales(trimmed)[0];
	} catch {
		return undefined;
	}
}
