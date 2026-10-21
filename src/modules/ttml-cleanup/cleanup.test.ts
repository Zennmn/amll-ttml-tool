import assert from "node:assert/strict";
import test from "node:test";
import { DOMParser, XMLSerializer } from "@xmldom/xmldom";
import { cleanupTtml } from "./cleanup";

Object.defineProperty(globalThis, "DOMParser", {
	value: DOMParser,
	configurable: true,
});
Object.defineProperty(globalThis, "XMLSerializer", {
	value: XMLSerializer,
	configurable: true,
});

const TTM_NAMESPACE = "http://www.w3.org/ns/ttml#metadata";
const XML_NAMESPACE = "http://www.w3.org/XML/1998/namespace";
const TTL = `<tt xmlns="http://www.w3.org/ns/ttml" xmlns:ttm="${TTM_NAMESPACE}">`;

function parse(xml: string): Document {
	return new DOMParser().parseFromString(
		xml,
		"application/xml",
	) as unknown as Document;
}

function elements(root: Node, localName: string): Element[] {
	const result: Element[] = [];
	for (let child = root.firstChild; child; child = child.nextSibling) {
		if (child.nodeType !== 1) continue;
		const element = child as Element;
		if (element.localName === localName) result.push(element);
		result.push(...elements(element, localName));
	}
	return result;
}

test("groups round-parenthesized words across spans and retains their timing attributes", () => {
	const source = `${TTL}<body><p><span begin="0.000s" end="0.200s">(</span><span begin="0.200s" end="0.700s" xml:lang="ja">夜に</span><span begin="0.700s" end="1.100s">駆ける</span><span begin="1.100s" end="1.300s">)</span><span begin="1.300s" end="1.800s">unclosed[</span></p></body></tt>`;

	const result = cleanupTtml(source, { harmony: true, punctuation: false });
	assert.equal(result.harmonyGroups, 1);
	assert.equal(result.punctuationMerged, 0);

	const document = parse(result.xml);
	const backgrounds = elements(document, "span").filter(
		(element) => element.getAttributeNS(TTM_NAMESPACE, "role") === "x-bg",
	);
	assert.equal(backgrounds.length, 1);
	assert.equal(backgrounds[0].textContent, "夜に駆ける");
	const words = elements(backgrounds[0], "span");
	assert.equal(words.length, 2);
	assert.equal(words[0].getAttribute("begin"), "0.200s");
	assert.equal(words[0].getAttributeNS(XML_NAMESPACE, "lang"), "ja");
	assert.equal(words[1].getAttribute("end"), "1.100s");
	assert.match(result.xml, /unclosed\[/);
});

test("splits bracketed text inside timed spans without changing either timing", () => {
	const source = `${TTL}<body><p><span begin="0s" end="0.4s">foo(bar</span><span begin="0.4s" end="0.8s">baz)qux</span></p></body></tt>`;

	const result = cleanupTtml(source, { harmony: true, punctuation: false });
	assert.equal(result.harmonyGroups, 1);
	const document = parse(result.xml);
	const paragraph = elements(document, "p")[0];
	assert.equal(paragraph.textContent?.replace(/\s+/gu, ""), "foobarbazqux");
	const words = elements(document, "span").filter(
		(element) => element.getAttributeNS(TTM_NAMESPACE, "role") !== "x-bg",
	);
	assert.deepEqual(
		words.map((word) => word.textContent),
		["foo", "bar", "baz", "qux"],
	);
	assert.deepEqual(
		words.map((word) => [word.getAttribute("begin"), word.getAttribute("end")]),
		[
			["0s", "0.4s"],
			["0s", "0.4s"],
			["0.4s", "0.8s"],
			["0.4s", "0.8s"],
		],
	);
});

test("turns nested and adjacent bracket ranges into one contiguous background group", () => {
	const source = `${TTL}<body><p><span begin="0s" end="0.2s">before</span><span begin="0.2s" end="0.3s">(</span><span begin="0.3s" end="0.5s">a</span><span begin="0.5s" end="0.6s">(</span><span begin="0.6s" end="0.8s">b</span><span begin="0.8s" end="0.9s">)</span><span begin="0.9s" end="1.1s">c</span><span begin="1.1s" end="1.2s">)</span><span begin="1.2s" end="1.5s">after[</span></p></body></tt>`;

	const result = cleanupTtml(source, { harmony: true, punctuation: false });
	assert.equal(result.harmonyGroups, 1);
	const document = parse(result.xml);
	const paragraph = elements(document, "p")[0];
	assert.equal(paragraph.textContent?.replace(/\s+/gu, ""), "beforeabcafter[");
	const backgrounds = elements(document, "span").filter(
		(element) => element.getAttributeNS(TTM_NAMESPACE, "role") === "x-bg",
	);
	assert.equal(backgrounds.length, 1);
	assert.equal(backgrounds[0].textContent, "abc");
	assert.match(result.xml, /after\[/);
});

test("leaves every non-round bracket pair literal without creating background groups", () => {
	const pairs = [
		["[", "]"],
		["【", "】"],
		["{", "}"],
		["〔", "〕"],
		["「", "」"],
		["『", "』"],
	] as const;
	const spans = pairs
		.map(([opening, closing], index) => {
			const start = index * 0.3;
			const afterOpening = start + 0.1;
			const afterContent = start + 0.2;
			return `<span begin="${start.toFixed(3)}s" end="${afterOpening.toFixed(3)}s">${opening}</span><span begin="${afterOpening.toFixed(3)}s" end="${afterContent.toFixed(3)}s">inside</span><span begin="${afterContent.toFixed(3)}s" end="${(start + 0.3).toFixed(3)}s">${closing}</span>`;
		})
		.join("");
	const source = `${TTL}<body><p>${spans}</p></body></tt>`;

	const result = cleanupTtml(source, { harmony: true, punctuation: false });
	assert.equal(result.harmonyGroups, 0);
	assert.equal(result.punctuationMerged, 0);
	const document = parse(result.xml);
	assert.equal(
		elements(document, "span").filter(
			(element) => element.getAttributeNS(TTM_NAMESPACE, "role") === "x-bg",
		).length,
		0,
	);
	assert.equal(
		elements(document, "p")[0].textContent,
		pairs.map(([opening, closing]) => `${opening}inside${closing}`).join(""),
	);
});

test("groups ASCII and fullwidth parentheses split across timed spans", () => {
	const source = `${TTL}<body><p><span begin="0.000s" end="0.100s">(</span><span begin="0.100s" end="0.500s">ascii</span><span begin="0.500s" end="0.600s">)</span>middle<span begin="0.600s" end="0.700s">（</span><span begin="0.700s" end="1.100s">和声</span><span begin="1.100s" end="1.200s">）</span></p></body></tt>`;

	const result = cleanupTtml(source, { harmony: true, punctuation: false });
	assert.equal(result.harmonyGroups, 2);
	assert.equal(result.punctuationMerged, 0);
	const document = parse(result.xml);
	const backgrounds = elements(document, "span").filter(
		(element) => element.getAttributeNS(TTM_NAMESPACE, "role") === "x-bg",
	);
	assert.deepEqual(
		backgrounds.map((background) => background.textContent),
		["ascii", "和声"],
	);
	assert.deepEqual(
		backgrounds.map((background) => {
			const child = elements(background, "span")[0];
			return [
				child.textContent,
				child.getAttribute("begin"),
				child.getAttribute("end"),
			];
		}),
		[
			["ascii", "0.100s", "0.500s"],
			["和声", "0.700s", "1.100s"],
		],
	);
});

test("preserves mixed non-round and nested literal text with exact timings", () => {
	const source = `${TTL}<body><p><span begin="0.000s" end="0.200s">pre</span><span begin="0.200s" end="0.300s">(</span><span begin="0.300s" end="0.500s">echo</span><span begin="0.500s" end="0.600s">[keep]</span><span begin="0.600s" end="0.700s">（</span><span begin="0.700s" end="0.900s">inner</span><span begin="0.900s" end="1.000s">）</span><span begin="1.000s" end="1.100s">{literal}</span><span begin="1.100s" end="1.200s">)</span><span begin="1.200s" end="1.500s">post</span></p></body></tt>`;

	const result = cleanupTtml(source, { harmony: true, punctuation: false });
	assert.equal(result.harmonyGroups, 1);
	const document = parse(result.xml);
	const paragraph = elements(document, "p")[0];
	assert.equal(
		paragraph.textContent?.replace(/\s+/gu, ""),
		"preecho[keep]inner{literal}post",
	);
	const backgrounds = elements(document, "span").filter(
		(element) => element.getAttributeNS(TTM_NAMESPACE, "role") === "x-bg",
	);
	assert.equal(backgrounds.length, 1);
	assert.deepEqual(
		elements(backgrounds[0], "span").map((element) => [
			element.textContent,
			element.getAttribute("begin"),
			element.getAttribute("end"),
		]),
		[
			["echo", "0.300s", "0.500s"],
			["[keep]", "0.500s", "0.600s"],
			["inner", "0.700s", "0.900s"],
			["{literal}", "1.000s", "1.100s"],
		],
	);
});

test("merges standalone Unicode punctuation without extending the target timing", () => {
	const source = `${TTL}<body><p>
		<span begin="1.000s" end="1.250s">Hello</span>
		<span begin="1.250s" end="1.400s">！？</span>
		<span begin="2.000s" end="2.200s">censored＊</span>
		<span begin="2.200s" end="2.300s">。</span>
	</p></body></tt>`;

	const result = cleanupTtml(source, { harmony: false, punctuation: true });
	assert.equal(result.punctuationMerged, 1);
	const document = parse(result.xml);
	const spans = elements(document, "span");
	assert.equal(spans.length, 3);
	assert.equal(spans[0].textContent, "Hello！？");
	assert.equal(spans[0].getAttribute("begin"), "1.000s");
	assert.equal(spans[0].getAttribute("end"), "1.250s");
	assert.equal(spans[1].textContent, "censored＊");
	assert.equal(spans[2].textContent, "。");
});

test("mixed text and comments break adjacency while remaining in the output", () => {
	const source = `${TTL}<body><p>
		<span begin="0s" end="1s">(</span>tail<span begin="1s" end="2s">)</span>
		<!-- reviewer note -->
		<span begin="2s" end="3s">(bg</span><span begin="3s" end="4s">)</span>
	</p></body></tt>`;

	const result = cleanupTtml(source, { harmony: true, punctuation: false });
	assert.equal(result.harmonyGroups, 1);
	assert.match(result.xml, /tail/);
	assert.match(result.xml, /reviewer note/);
	const document = parse(result.xml);
	const backgrounds = elements(document, "span").filter(
		(element) => element.getAttributeNS(TTM_NAMESPACE, "role") === "x-bg",
	);
	assert.equal(backgrounds.length, 1);
	assert.equal(backgrounds[0].textContent, "bg");
});

test("normalizes existing background children without nesting and is idempotent", () => {
	const source = `${TTL}<body><p>
		<span ttm:role="x-bg"><span begin="0s" end="1s">(already)</span></span>
		<span ttm:role="x-translation" xml:lang="zh"><span begin="1s" end="2s">(译文)</span></span>
		<span begin="2s" end="3s">主歌</span><span begin="3s" end="4s">(和声)</span>
	</p></body></tt>`;

	const first = cleanupTtml(source, { harmony: true, punctuation: false });
	assert.equal(first.harmonyGroups, 1);
	const firstDocument = parse(first.xml);
	assert.equal(
		elements(firstDocument, "span").filter(
			(element) => element.getAttributeNS(TTM_NAMESPACE, "role") === "x-bg",
		).length,
		2,
	);
	assert.match(first.xml, />already</);
	assert.doesNotMatch(first.xml, /\(already\)/);
	assert.match(first.xml, /\(译文\)/);
	for (const background of elements(firstDocument, "span").filter(
		(element) => element.getAttributeNS(TTM_NAMESPACE, "role") === "x-bg",
	)) {
		assert.equal(
			elements(background, "span").filter(
				(element) => element.getAttributeNS(TTM_NAMESPACE, "role") === "x-bg",
			).length,
			0,
		);
	}

	const second = cleanupTtml(first.xml, { harmony: true, punctuation: false });
	assert.equal(second.harmonyGroups, 0);
	const secondDocument = parse(second.xml);
	assert.equal(
		elements(secondDocument, "span").filter(
			(element) => element.getAttributeNS(TTM_NAMESPACE, "role") === "x-bg",
		).length,
		2,
	);
});

test("rejects malformed XML and non-TTML documents with user-facing errors", () => {
	assert.throws(
		() => cleanupTtml("<tt><body>", { harmony: true, punctuation: true }),
		/XML/,
	);
	assert.throws(
		() =>
			cleanupTtml('<svg xmlns="http://www.w3.org/2000/svg"/>', {
				harmony: true,
				punctuation: true,
			}),
		/TTML/,
	);
});
