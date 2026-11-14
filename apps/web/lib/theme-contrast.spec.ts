import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * `--input` is the border every shadcn form control draws (`border-input`).
 * It once shipped as white on a white card, so registration's fields and its
 * consent checkbox could not be seen until focused. WCAG 2.1 SC 1.4.11 asks a
 * control's boundary for 3:1 against what surrounds it; forms sit on cards and
 * on the page background. `.dark` mirrors the light values until dark mode
 * gets its own palette, and is held to the same floor.
 */
const CSS = readFileSync(fileURLToPath(new URL("../app/globals.css", import.meta.url)), "utf8");
const BLOCKS = [":root", ".dark"] as const;
const SURFACES = ["card", "background"] as const;

function token(block: string, name: string): string {
  const body = CSS.match(new RegExp(`^${block.replace(".", "\\.")} \\{([^}]*)\\}`, "m"))?.[1];
  const value = body?.match(new RegExp(`--${name}:\\s*(#[0-9A-Fa-f]{6});`))?.[1];
  if (!value) throw new Error(`${block} has no hex --${name}`);
  return value;
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((at) => {
    const channel = parseInt(hex.slice(at, at + 2), 16) / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

describe("form-control border contrast in globals.css", () => {
  it("measures known pairs as WCAG does", () => {
    expect(contrast("#FFFFFF", "#000000")).toBeCloseTo(21, 5);
    expect(contrast("#FFFFFF", "#FFFFFF")).toBe(1);
    expect(contrast("#8E8E93", "#FFFFFF")).toBeCloseTo(3.26, 2);
  });

  it.each(BLOCKS.flatMap((block) => SURFACES.map((surface) => [block, surface] as const)))(
    "%s input/%s is at least 3:1",
    (block, surface) => {
      const ratio = contrast(token(block, "input"), token(block, surface));
      expect(ratio, `${block} input/${surface} = ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(3);
    },
  );
});
