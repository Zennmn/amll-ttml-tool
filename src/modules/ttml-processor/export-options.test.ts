import assert from "node:assert/strict";
import test from "node:test";
import { normalizeTtmlLanguage } from "./export-options";

test("an empty language selection follows the source document", () => {
	assert.equal(normalizeTtmlLanguage(""), undefined);
	assert.equal(normalizeTtmlLanguage("  "), undefined);
});

test("language selections accept common languages and unknown language", () => {
	for (const language of ["en", "zh-Hans", "zh-Hant", "ja", "ko", "und"]) {
		assert.equal(normalizeTtmlLanguage(language), language);
	}
});

test("custom language selections are trimmed and canonicalized", () => {
	assert.equal(normalizeTtmlLanguage(" pt-br "), "pt-BR");
	assert.equal(normalizeTtmlLanguage("zh-hans-cn"), "zh-Hans-CN");
});

test("invalid language codes cannot become exported root language", () => {
	for (const value of ["en_US", "English please", "中文", '<lang="en">']) {
		assert.equal(normalizeTtmlLanguage(value), undefined);
	}
});
