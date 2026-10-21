const TTML_NS = "http://www.w3.org/ns/ttml";
const ITUNES_NS = "http://music.apple.com/lyric-ttml-internal";
const XML_NS = "http://www.w3.org/XML/1998/namespace";
const XMLNS_NS = "http://www.w3.org/2000/xmlns/";

interface ExportFormatOptions {
	lineTiming: boolean;
	language?: string;
}

/** Use the reference lyric clock notation without changing the represented time. */
function formatClock(value: string): string {
	if (!/^\d+(?::\d{1,2}){0,2}(?:\.\d{1,3})?$/.test(value)) return value;
	const parts = value.split(":").map(Number);
	const seconds = parts.pop() ?? 0;
	const minutes = parts.pop() ?? 0;
	const hours = parts.pop() ?? 0;
	const milliseconds = Math.round(
		(hours * 3600 + minutes * 60 + seconds) * 1000,
	);
	if (!Number.isSafeInteger(milliseconds)) return value;
	const wholeMinutes = Math.floor(milliseconds / 60000);
	const wholeSeconds = Math.floor((milliseconds % 60000) / 1000);
	return `${wholeMinutes}:${String(wholeSeconds).padStart(2, "0")}.${String(
		milliseconds % 1000,
	).padStart(3, "0")}`;
}

/** Complete the shared WASM generator's XML declarations and clock formatting. */
export function normalizeTtmlExport(
	source: string,
	options: ExportFormatOptions,
): string {
	const document = new DOMParser().parseFromString(source, "application/xml");
	const root = document.documentElement;
	if (
		root.localName !== "tt" ||
		root.namespaceURI !== TTML_NS ||
		document.getElementsByTagName("parsererror").length > 0
	) {
		throw new Error("Cannot normalize invalid TTML output");
	}
	root.setAttributeNS(XMLNS_NS, "xmlns:itunes", ITUNES_NS);
	root.setAttributeNS(
		ITUNES_NS,
		"itunes:timing",
		options.lineTiming ? "Line" : "Word",
	);
	root.setAttributeNS(
		XML_NS,
		"xml:lang",
		options.language?.trim() ||
			root.getAttributeNS(XML_NS, "lang")?.trim() ||
			"und",
	);

	for (const element of [root, ...Array.from(root.getElementsByTagName("*"))]) {
		if (element.namespaceURI !== TTML_NS && element.namespaceURI !== ITUNES_NS)
			continue;
		for (const attribute of ["begin", "end", "dur"]) {
			const value = element.getAttribute(attribute);
			if (value) element.setAttribute(attribute, formatClock(value));
		}
	}
	for (const metadata of Array.from(
		root.getElementsByTagNameNS(ITUNES_NS, "iTunesMetadata"),
	)) {
		for (const translation of Array.from(
			metadata.getElementsByTagNameNS(ITUNES_NS, "translation"),
		)) {
			if (!translation.hasAttribute("type"))
				translation.setAttribute("type", "subtitle");
		}
	}
	const xml = new XMLSerializer()
		.serializeToString(document)
		.replace(/^<\?xml[^?]*\?>\s*/i, "");
	return `<?xml version="1.0" encoding="utf-8"?>\n${xml}`;
}
