const srgbHexColorPattern = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/iu;

export function srgbColorChannels(color: string): readonly [number, number, number] {
  if (!srgbHexColorPattern.test(color)) {
    throw new Error("A cor computada do contrato visual não usa hexadecimal sRGB esperado.");
  }

  const expanded =
    color.length === 4
      ? `${color[1]}${color[1]}${color[2]}${color[2]}${color[3]}${color[3]}`
      : color.slice(1);
  const red = Number.parseInt(expanded.slice(0, 2), 16);
  const green = Number.parseInt(expanded.slice(2, 4), 16);
  const blue = Number.parseInt(expanded.slice(4, 6), 16);
  return [red, green, blue];
}

function relativeLuminance(color: string) {
  const [red, green, blue] = srgbColorChannels(color).map((channel) => {
    const normalized = channel / 255;
    return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  if (red === undefined || green === undefined || blue === undefined) {
    throw new Error("A cor computada do contrato visual está incompleta.");
  }
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

export function srgbContrastRatio(firstColor: string, secondColor: string) {
  const first = relativeLuminance(firstColor);
  const second = relativeLuminance(secondColor);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}
