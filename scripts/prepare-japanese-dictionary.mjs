import { copyFile, mkdir, readdir, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const packageRoot = dirname(require.resolve("kuromoji/package.json"));
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const destination = join(projectRoot, "public", "dictionaries", "kuromoji");
await mkdir(destination, { recursive: true });
const dictionaryFiles = (await readdir(join(packageRoot, "dict"))).filter(
	(file) => file.endsWith(".dat.gz"),
);
if (dictionaryFiles.length !== 12)
	throw new Error("Incomplete Japanese dictionary");
const sources = [
	...dictionaryFiles.map((file) => [join(packageRoot, "dict", file), file]),
	[join(packageRoot, "LICENSE-2.0.txt"), "LICENSE-2.0.txt"],
	[join(packageRoot, "NOTICE.md"), "NOTICE.md"],
];
let copied = 0;
for (const [source, filename] of sources) {
	const target = join(destination, filename);
	const sourceStat = await stat(source);
	const targetStat = await stat(target).catch(() => undefined);
	if (
		targetStat?.size === sourceStat.size &&
		targetStat.mtimeMs >= sourceStat.mtimeMs
	)
		continue;
	await copyFile(source, target);
	copied++;
}
console.log(
	`Japanese dictionary ready (${dictionaryFiles.length} local files, ${copied} copied).`,
);
