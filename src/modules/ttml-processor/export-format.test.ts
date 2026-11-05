import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { DOMParser, XMLSerializer } from "@xmldom/xmldom";
import { normalizeTtmlExport } from "./export-format";
import type { AmllLyricResult } from "./types";

Object.assign(globalThis, { DOMParser, XMLSerializer });

const TT = "http://www.w3.org/ns/ttml";
const ITUNES = "http://music.apple.com/lyric-ttml-internal";
const XML = "http://www.w3.org/XML/1998/namespace";
const TTM = "http://www.w3.org/ns/ttml#metadata";

type WasmResult<T> = { success: true; data: T } | { success: false };

async function loadWasm() {
	const bindings = await import("./wasm/ttml_processor_wasm_bg.js" as string);
	const bytes = await readFile(
		new URL("./wasm/ttml_processor_wasm_bg.wasm", import.meta.url),
	);
	const { instance } = await WebAssembly.instantiate(bytes, {
		"./ttml_processor_wasm_bg.js": bindings,
	});
	bindings.__wbg_set_wasm(instance.exports);
	(instance.exports.__wbindgen_start as () => void)();
	return bindings;
}

function fixture(body = "", attributes = "", metadata = ""): string {
	return `<tt xmlns="${TT}" xmlns:itunes="${ITUNES}" xmlns:ttm="${TTM}" ${attributes}><head><metadata>${metadata}</metadata></head><body>${body}</body></tt>`;
}

function rootOf(xml: string) {
	const root = new DOMParser().parseFromString(
		xml,
		"application/xml",
	).documentElement;
	assert.ok(root);
	return root;
}

test("word exports include a namespaced Word declaration and UTF-8 XML header", () => {
	const xml = normalizeTtmlExport(fixture(), { lineTiming: false });
	assert.match(xml, /^<\?xml version="1.0" encoding="utf-8"\?>\n<tt/);
	const root = rootOf(xml);
	assert.equal(root.getAttributeNS(ITUNES, "timing"), "Word");
	assert.equal(root.getAttribute("xmlns:itunes"), ITUNES);
	assert.equal(root.getAttributeNS(XML, "lang"), "und");
});

test("line mode replaces an existing timing declaration without duplicates", () => {
	const source = fixture("", 'itunes:timing="Word"');
	const line = normalizeTtmlExport(source, { lineTiming: true });
	const root = rootOf(line);
	assert.equal(root.getAttributeNS(ITUNES, "timing"), "Line");
	assert.equal(
		Array.from(root.attributes).filter(
			(attribute) =>
				attribute.namespaceURI === ITUNES && attribute.localName === "timing",
		).length,
		1,
	);
	assert.equal(
		rootOf(normalizeTtmlExport(line, { lineTiming: false })).getAttributeNS(
			ITUNES,
			"timing",
		),
		"Word",
	);
});

test("source languages survive; an explicit language wins and blanks use und", () => {
	for (const language of ["en", "zh-Hans", "ja"]) {
		const root = rootOf(
			normalizeTtmlExport(fixture("", `xml:lang="${language}"`), {
				lineTiming: false,
			}),
		);
		assert.equal(root.getAttributeNS(XML, "lang"), language);
	}
	assert.equal(
		rootOf(
			normalizeTtmlExport(fixture("", 'xml:lang="en"'), {
				lineTiming: false,
				language: " ja ",
			}),
		).getAttributeNS(XML, "lang"),
		"ja",
	);
	assert.equal(
		rootOf(
			normalizeTtmlExport(fixture("", 'xml:lang=" "'), {
				lineTiming: false,
			}),
		).getAttributeNS(XML, "lang"),
		"und",
	);
});

test("seconds, minute and hour clocks retain millisecond precision", () => {
	const source = fixture(
		'<div begin="0.000" end="1:02:03.004" dur="3723.004"><p begin="3.416" end="1:02.003"><span begin="59.999" end="60.001">word</span></p></div>',
	);
	const root = rootOf(normalizeTtmlExport(source, { lineTiming: false }));
	const div = root.getElementsByTagNameNS(TT, "div").item(0);
	const p = root.getElementsByTagNameNS(TT, "p").item(0);
	const span = root.getElementsByTagNameNS(TT, "span").item(0);
	assert.equal(div?.getAttribute("begin"), "0:00.000");
	assert.equal(div?.getAttribute("end"), "62:03.004");
	assert.equal(div?.getAttribute("dur"), "62:03.004");
	assert.equal(p?.getAttribute("begin"), "0:03.416");
	assert.equal(p?.getAttribute("end"), "1:02.003");
	assert.equal(span?.getAttribute("begin"), "0:59.999");
	assert.equal(span?.getAttribute("end"), "1:00.001");
});

test("Apple translations are typed subtitles and retain language, type and line links", () => {
	const metadata = `<iTunesMetadata xmlns="${ITUNES}"><translations><translation xml:lang="zh-Hans"><text for="L1">你好<span ttm:role="x-bg">哦</span></text></translation><translation type="custom" xml:lang="ja"><text for="L1">こんにちは</text></translation></translations><transliterations><transliteration><text for="L1"><span begin="1.234" end="2.345">ni hao</span></text></transliteration></transliterations></iTunesMetadata>`;
	const root = rootOf(
		normalizeTtmlExport(fixture("", "", metadata), { lineTiming: false }),
	);
	const translations = root.getElementsByTagNameNS(ITUNES, "translation");
	assert.equal(translations.item(0)?.getAttribute("type"), "subtitle");
	assert.equal(translations.item(1)?.getAttribute("type"), "custom");
	assert.equal(translations.item(0)?.getAttributeNS(XML, "lang"), "zh-Hans");
	assert.equal(
		root.getElementsByTagNameNS(ITUNES, "text").item(0)?.getAttribute("for"),
		"L1",
	);
	assert.equal(
		root.getElementsByTagNameNS(ITUNES, "span").item(1)?.getAttribute("begin"),
		"0:01.234",
	);
});

test("AMLL inline languages, text spacing, vocal roles and custom attributes survive", () => {
	const source = fixture(
		'<div><p begin="1.000" end="3.000" itunes:key="L1" ttm:agent="v7" data-test="keep"><span begin="1.000" end="2.000">Hello &amp; &lt;world&gt;</span>  <span ttm:role="x-bg" begin="1.500" end="2.500"><span begin="1.500" end="2.500">(echo)</span></span><span ttm:role="x-translation" xml:lang="zh-Hans">你好</span><span ttm:role="x-roman">ni hao</span></p></div>',
	);
	const before = rootOf(source).getElementsByTagNameNS(TT, "p").item(0);
	const root = rootOf(normalizeTtmlExport(source, { lineTiming: false }));
	const after = root.getElementsByTagNameNS(TT, "p").item(0);
	assert.equal(after?.textContent, before?.textContent);
	assert.equal(after?.getAttributeNS(ITUNES, "key"), "L1");
	assert.equal(after?.getAttributeNS(TTM, "agent"), "v7");
	assert.equal(after?.getAttribute("data-test"), "keep");
	assert.deepEqual(
		Array.from(root.getElementsByTagNameNS(TT, "span"))
			.map((span) => span.getAttributeNS(TTM, "role"))
			.filter(Boolean),
		["x-bg", "x-translation", "x-roman"],
	);
	assert.equal(root.getElementsByTagNameNS(ITUNES, "translations").length, 0);
});

test("normalizing existing output is idempotent with one XML declaration", () => {
	const source = `<?xml version='1.0' encoding='utf-8'?>${fixture('<div begin="0:00.000" end="0:01.000"/>', 'xml:lang="en"')}`;
	const first = normalizeTtmlExport(source, { lineTiming: false });
	assert.equal(normalizeTtmlExport(first, { lineTiming: false }), first);
	assert.equal(first.match(/<\?xml\b/g)?.length, 1);
});

test("non-clock expressions and extension namespace attributes are preserved", () => {
	const root = rootOf(
		normalizeTtmlExport(
			fixture(
				'<div begin="100ms" end="indefinite"><extra xmlns="urn:custom" begin="1.000"/></div>',
			),
			{ lineTiming: false },
		),
	);
	assert.equal(
		root.getElementsByTagNameNS(TT, "div").item(0)?.getAttribute("begin"),
		"100ms",
	);
	assert.equal(
		root.getElementsByTagNameNS(TT, "div").item(0)?.getAttribute("end"),
		"indefinite",
	);
	assert.equal(
		root
			.getElementsByTagNameNS("urn:custom", "extra")
			.item(0)
			?.getAttribute("begin"),
		"1.000",
	);
});

test("AMLL duet exports keep vocal roles through the vendored generator and parser", async () => {
	const wasm = await loadWasm();
	for (const order of [
		[true, false],
		[false, true],
	]) {
		const expected = order.map((isDuet) => ({
			text: isDuet ? "Answer" : "Lead",
			isDuet,
		}));
		const amll: AmllLyricResult = {
			lyricLines: expected.map(({ text, isDuet }, i) => {
				const startTime = i * 1_000;
				const endTime = startTime + 1_000;
				return {
					words: [{ word: text, startTime, endTime }],
					translatedLyric: "",
					romanLyric: "",
					isBG: false,
					isDuet,
					startTime,
					endTime,
				};
			}),
			metadata: [],
		};
		const generated = wasm.amllToTtml(amll, undefined, {
			lineTiming: false,
			useAppleFormatRules: false,
		}) as WasmResult<string>;
		assert.ok(generated.success);
		const amllExport = normalizeTtmlExport(generated.data, {
			lineTiming: false,
			amllDuetAgent: true,
		});
		const agents = rootOf(amllExport).getElementsByTagNameNS(TTM, "agent");
		assert.equal(agents.item(0)?.getAttribute("type"), "person");
		assert.equal(agents.item(1)?.getAttribute("type"), "other");
		const reimported = wasm.ttmlToAmll(
			amllExport,
			undefined,
		) as WasmResult<AmllLyricResult>;
		assert.ok(reimported.success);
		assert.deepEqual(
			reimported.data.lyricLines.map((parsed) => ({
				text: parsed.words.map((word) => word.word).join(""),
				isDuet: parsed.isDuet,
			})),
			expected,
		);
	}
});

test("external TTML exports leave non-AMLL vocal agents unchanged", () => {
	const source = fixture(
		'<div><p begin="0.000" end="1.000" itunes:key="L1" ttm:agent="v1"><span begin="0.000" end="1.000">Lead</span></p><p begin="1.000" end="2.000" itunes:key="L2" ttm:agent="v2"><span begin="1.000" end="2.000">Answer</span></p></div>',
		"",
		'<ttm:agent type="person" xml:id="v1"/><ttm:agent type="person" xml:id="v2"/>',
	);
	const exported = normalizeTtmlExport(source, { lineTiming: false });
	assert.deepEqual(
		Array.from(rootOf(exported).getElementsByTagNameNS(TTM, "agent")).map(
			(agent) => agent.getAttribute("type"),
		),
		["person", "person"],
	);
});
