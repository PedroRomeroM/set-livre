import { describe, expect, it } from "vitest";

import { srgbColorChannels, srgbContrastRatio } from "../helpers/srgb-contrast";

describe("sRGB contrast helper", () => {
  it.each([
    ["#fff", [255, 255, 255]],
    ["#000", [0, 0, 0]],
    ["#65736c", [101, 115, 108]],
    ["#AeBdB5", [174, 189, 181]],
  ] as const)("parses the closed hexadecimal format %s", (color, expected) => {
    expect(srgbColorChannels(color)).toEqual(expected);
  });

  it.each(["#ffff", "#ffffffff", "rgb(255 255 255)", "transparent", " #fff"])(
    "rejects an unobserved color representation: %s",
    (color) => {
      expect(() => srgbColorChannels(color)).toThrow("hexadecimal sRGB esperado");
    },
  );

  it("computes contrast consistently for short and long white", () => {
    expect(srgbContrastRatio("#000", "#fff")).toBe(21);
    expect(srgbContrastRatio("#000000", "#ffffff")).toBe(21);
  });
});
