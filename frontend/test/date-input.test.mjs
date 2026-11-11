import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("shared date input", () => {
  it("formats date-only values in English with UTC calendar semantics", () => {
    const source = fs.readFileSync(path.join(root, "components/ui/date-input.tsx"), "utf8");
    assert.match(source, /new Intl\.DateTimeFormat\("en-GB", \{ day: "numeric", month: "short", year: "numeric", timeZone: "UTC" \}\)/);
    assert.match(source, /function parseDate\(value: string\)/);
    assert.match(source, /Date\.UTC\(Number\(year\), Number\(month\) - 1, Number\(day\)\)/);
  });

  it("keeps ISO values in form submissions and applies min/max to selectable dates", () => {
    const source = fs.readFileSync(path.join(root, "components/ui/date-input.tsx"), "utf8");
    assert.match(source, /<input type="hidden" name=\{name\} value=\{draft === formatDateInput\(currentValue\) \? currentValue : ""\} \/>/);
    assert.match(source, /\(min && date < min\) \|\| \(max && date > max\)/);
  });

  it("resynchronizes and clamps the visible month when the selected value or bounds change", () => {
    const source = fs.readFileSync(path.join(root, "components/ui/date-input.tsx"), "utf8");
    assert.match(source, /const visibleRangeKey = `\$\{currentValue\}\\u0000\$\{min \?\? ""\}\\u0000\$\{max \?\? ""\}`/);
    assert.match(source, /if \(synchronizedRangeKey !== visibleRangeKey\)/);
    assert.match(source, /monthWithinBounds\(currentValue \|\| min \|\| todayInApplicationZone\(\), min, max\)/);
  });

  it("uses a shared placeholder and equal-height date and calendar controls", () => {
    const source = fs.readFileSync(path.join(root, "components/ui/date-input.tsx"), "utf8");
    assert.match(source, /placeholder = "Select date"/);
    assert.match(source, /type="text"[^\n]*placeholder=\{placeholder\}/);
    assert.match(source, /className="h-11 min-w-0 flex-1/);
    assert.match(source, /className="inline-flex h-11 shrink-0/);
  });


});
