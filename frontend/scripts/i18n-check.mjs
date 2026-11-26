// Fails if any translation file is missing keys or has extra keys compared to en.json.
// Plural variants (_zero/_one/_two/_few/_many/_other) of a plural key in en.json are allowed
// to differ per language, but `<base>_other` is always required.
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "../src/translations");
const PLURAL = /_(zero|one|two|few|many|other)$/;
const load = (f) => JSON.parse(readFileSync(path.join(dir, f), "utf8"));
const placeholders = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(",");

const ref = load("en.json");
const refKeys = new Set(Object.keys(ref));
const pluralBases = new Set([...refKeys].filter((k) => PLURAL.test(k)).map((k) => k.replace(PLURAL, "")));

let failed = false;
for (const file of readdirSync(dir).filter((f) => f.endsWith(".json") && f !== "en.json")) {
  const dict = load(file);
  const keys = new Set(Object.keys(dict));
  const errors = [];
  for (const k of refKeys) {
    const base = k.replace(PLURAL, "");
    if (PLURAL.test(k) && pluralBases.has(base) && !k.endsWith("_other")) continue;
    if (!keys.has(k)) errors.push(`missing key: ${k}`);
  }
  for (const k of keys) {
    const base = k.replace(PLURAL, "");
    if (refKeys.has(k)) continue;
    if (PLURAL.test(k) && pluralBases.has(base)) continue;
    errors.push(`extra key: ${k}`);
  }
  for (const k of keys) {
    const refKey = refKeys.has(k) ? k : `${k.replace(PLURAL, "")}_other`;
    if (refKeys.has(refKey) && typeof dict[k] === "string") {
      const a = placeholders(ref[refKey]).split(",").filter((p) => p !== "count").join(",");
      const b = placeholders(dict[k]).split(",").filter((p) => p !== "count").join(",");
      if (a !== b) errors.push(`placeholder mismatch in ${k}: en {${a}} vs {${b}}`);
    }
    if (typeof dict[k] !== "string" || !dict[k].trim()) errors.push(`empty value: ${k}`);
  }
  if (errors.length) {
    failed = true;
    console.error(`${file}:\n  ${errors.join("\n  ")}`);
  } else {
    console.log(`${file}: OK (${keys.size} keys)`);
  }
}
if (failed) process.exit(1);
