/** Browser port of the user-supplied ttml_cleanup.py cleanup rules. */
const TT_NS = "http://www.w3.org/ns/ttml";
const TTM_NS = "http://www.w3.org/ns/ttml#metadata";
const MAX_SOURCE_LENGTH = 16 * 1024 * 1024;
const BRACKETS = new Map([
	["(", ")"],
	["（", "）"],
]);
const CLOSING = new Map(Array.from(BRACKETS, ([open, close]) => [close, open]));

export interface CleanupOptions {
	harmony: boolean;
	punctuation: boolean;
}

export interface CleanupResult {
	xml: string;
	harmonyGroups: number;
	punctuationMerged: number;
}

function isElement(node: Node): node is Element {
	return node.nodeType === 1;
}

function children(element: Element): Element[] {
	return Array.from(element.childNodes).filter(isElement);
}

function isSpan(element: Element): boolean {
	return (
		element.localName === "span" &&
		(element.namespaceURI === TT_NS || !element.namespaceURI)
	);
}

function roles(element: Element): string[] {
	return (element.getAttributeNS(TTM_NS, "role") || "")
		.split(/\s+/)
		.filter(Boolean);
}

function isAuxiliary(element: Element): boolean {
	return roles(element).some(
		(role) =>
			role === "x-translation" ||
			role.startsWith("x-roman") ||
			role === "x-transliteration",
	);
}

function isLeaf(element: Element): boolean {
	// Keep comments, ruby and other structured content intact.
	return (
		isSpan(element) &&
		Array.from(element.childNodes).every(
			(node) => node.nodeType === 3 || node.nodeType === 4,
		)
	);
}

function isWhitespace(node: Node): boolean {
	return (
		(node.nodeType === 3 || node.nodeType === 4) && !node.nodeValue?.trim()
	);
}

interface Piece {
	node: Node;
	selected?: boolean;
}

function processBracketRun(
	parent: Element,
	run: Element[],
	inBackground: boolean,
): number {
	const chars: string[] = [];
	const offsets = new Map<Element, number>();
	for (const span of run) {
		offsets.set(span, chars.length);
		for (const char of span.textContent || "") chars.push(char);
	}
	const matched = new Set<number>();
	const stack: { char: string; position: number }[] = [];
	const depthDelta = new Int32Array(chars.length + 1);
	chars.forEach((char, position) => {
		if (BRACKETS.has(char)) {
			stack.push({ char, position });
		} else if (CLOSING.has(char)) {
			const top = stack[stack.length - 1];
			if (top?.char === CLOSING.get(char)) {
				stack.pop();
				matched.add(top.position);
				matched.add(position);
				depthDelta[top.position + 1] += 1;
				depthDelta[position] -= 1;
			}
		}
	});
	if (matched.size === 0) return 0;
	const enclosed = new Uint8Array(chars.length);
	let depth = 0;
	for (let index = 0; index < chars.length; index++) {
		depth += depthDelta[index];
		enclosed[index] = depth > 0 ? 1 : 0;
	}

	const after = run[run.length - 1].nextSibling;
	const sourceNodes: Node[] = [];
	for (
		let node: Node | null = run[0];
		node && node !== after;
		node = node.nextSibling
	) {
		sourceNodes.push(node);
	}
	const pieces: Piece[] = [];
	for (const node of sourceNodes) {
		if (!isElement(node)) {
			pieces.push({ node });
			continue;
		}
		const offset = offsets.get(node);
		if (offset === undefined) continue;
		const textPieces: { text: string; selected: boolean }[] = [];
		Array.from(node.textContent || "").forEach((char, index) => {
			const position = offset + index;
			if (matched.has(position)) return;
			const selected = enclosed[position] === 1;
			const previous = textPieces[textPieces.length - 1];
			if (previous && previous.selected === selected) previous.text += char;
			else textPieces.push({ text: char, selected });
		});
		for (const piece of textPieces) {
			const span =
				textPieces.length === 1 ? node : (node.cloneNode(false) as Element);
			span.textContent = piece.text;
			pieces.push({ node: span, selected: piece.selected });
			// All text fragments keep the exact attributes of the original timed word.
		}
	}
	for (const node of sourceNodes) parent.removeChild(node);
	const document = parent.ownerDocument;
	const replacement: Node[] = [];
	let groups = 0;
	for (let index = 0; index < pieces.length; ) {
		const piece = pieces[index];
		if (!piece.selected || inBackground) {
			replacement.push(piece.node);
			index += 1;
			continue;
		}
		let end = index;
		let cursor = index + 1;
		while (cursor < pieces.length) {
			if (pieces[cursor].selected === undefined) {
				cursor += 1;
				continue;
			}
			if (!pieces[cursor].selected) break;
			end = cursor++;
		}
		const wrapper = document.createElementNS(
			run[0].namespaceURI,
			run[0].tagName,
		);
		wrapper.setAttributeNS(
			TTM_NS,
			`${parent.lookupPrefix(TTM_NS) || "ttm"}:role`,
			"x-bg",
		);
		for (let child = index; child <= end; child++)
			wrapper.appendChild(pieces[child].node);
		const previous = replacement[replacement.length - 1];
		if (
			previous &&
			!(previous.nodeType === 3 && /[ \t\n\r]$/.test(previous.nodeValue || ""))
		) {
			replacement.push(document.createTextNode(" "));
		}
		replacement.push(wrapper);
		groups += 1;
		index = end + 1;
	}
	for (const node of replacement) parent.insertBefore(node, after);
	return groups;
}

function convertHarmony(element: Element, inBackground = false): number {
	if (isAuxiliary(element)) return 0;
	const background = inBackground || roles(element).includes("x-bg");
	let groups = 0;
	for (const child of children(element))
		groups += convertHarmony(child, background);
	if (element.localName !== "p" && !isSpan(element)) return groups;
	let run: Element[] = [];
	const flush = () => {
		if (run.length > 0) groups += processBracketRun(element, run, background);
		run = [];
	};
	for (const node of Array.from(element.childNodes)) {
		if (isElement(node) && isLeaf(node) && roles(node).length === 0)
			run.push(node);
		else if (!isWhitespace(node)) flush();
	}
	flush();
	return groups;
}

function lastLeaf(element: Element): Element | null {
	if (!isSpan(element) || isAuxiliary(element)) return null;
	if (isLeaf(element)) return element;
	for (const node of Array.from(element.childNodes).reverse()) {
		if (isElement(node)) return lastLeaf(node);
		if (!isWhitespace(node) && node.nodeType !== 8) return null;
	}
	return null;
}

function mergePunctuation(element: Element): number {
	if (isAuxiliary(element)) return 0;
	let merged = 0;
	for (const child of children(element)) merged += mergePunctuation(child);
	for (const child of children(element)) {
		if (!isLeaf(child) || roles(child).length > 0) continue;
		const punctuation = (child.textContent || "").trim();
		if (
			!punctuation ||
			/[*＊]/u.test(punctuation) ||
			!/^\p{P}+$/u.test(punctuation)
		)
			continue;
		let previous: Node | null = child.previousSibling;
		while (previous && isWhitespace(previous))
			previous = previous.previousSibling;
		if (!previous || !isElement(previous) || !isSpan(previous)) continue;
		const target = lastLeaf(previous);
		if (!target || /[*＊]/u.test(target.textContent || "")) continue;
		target.textContent = (target.textContent || "") + punctuation;
		element.removeChild(child);
		merged += 1;
	}
	return merged;
}

/** Clean a TTML copy without changing editor data or recomputing word timestamps. */
export function cleanupTtml(
	source: string,
	options: CleanupOptions,
): CleanupResult {
	if (source.length > MAX_SOURCE_LENGTH)
		throw new Error("TTML 文件超过 16 MB，无法整理");
	if (/<!DOCTYPE[\s>]/i.test(source))
		throw new Error("不支持含有 DOCTYPE 的 TTML 文件");
	let document: Document;
	try {
		document = new DOMParser().parseFromString(source, "application/xml");
	} catch {
		throw new Error("TTML XML 格式无效，请检查文件内容");
	}
	const root = document.documentElement;
	if (
		!root ||
		root.localName === "parsererror" ||
		document.getElementsByTagName("parsererror").length > 0
	) {
		throw new Error("TTML XML 格式无效，请检查文件内容");
	}
	if (
		root.localName !== "tt" ||
		(root.namespaceURI && root.namespaceURI !== TT_NS)
	) {
		throw new Error("这不是受支持的 TTML 歌词文件");
	}
	const bodies = Array.from(
		root.getElementsByTagNameNS(root.namespaceURI || "", "body"),
	);
	let harmonyGroups = 0;
	let punctuationMerged = 0;
	for (const body of bodies) {
		if (options.harmony) harmonyGroups += convertHarmony(body);
		if (options.punctuation) punctuationMerged += mergePunctuation(body);
	}
	const xml = new XMLSerializer()
		.serializeToString(document)
		.replace(/^<\?xml[^?]*\?>\s*/i, "");
	return {
		xml: `<?xml version="1.0" encoding="utf-8"?>\n${xml}`,
		harmonyGroups,
		punctuationMerged,
	};
}
