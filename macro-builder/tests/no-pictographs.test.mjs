// Интерфейс расширения не должен содержать эмодзи и символов-пиктограмм (галочки, значки предупреждения,
// треугольники «пуск» и т. п.): на разных системах они рисуются цветными картинками и портят строгий вид.
// Запуск: node --test macro-builder/tests/no-pictographs.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SKIP_DIRS = new Set(["vendor", "icons", "node_modules"]);
const RE = /[\p{Extended_Pictographic}\u{FE0F}]/u;

function files(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...files(p));
    else if (/\.(js|mjs|cjs|html|css|md|json)$/.test(e.name)) out.push(p);
  }
  return out;
}

test("в исходниках расширения нет эмодзи и символов-пиктограмм", () => {
  const bad = [];
  for (const f of files(ROOT)) {
    fs.readFileSync(f, "utf8").split("\n").forEach((line, i) => {
      if (RE.test(line)) bad.push(`${path.relative(ROOT, f)}:${i + 1}: ${line.trim().slice(0, 80)}`);
    });
  }
  assert.deepEqual(bad, []);
});

test("тёмной темы нет: в стилях нет prefers-color-scheme: dark", () => {
  const css = fs.readFileSync(path.join(ROOT, "styles.css"), "utf8");
  assert.doesNotMatch(css, /prefers-color-scheme\s*:\s*dark/);
  assert.match(css, /color-scheme:\s*light/);
});
