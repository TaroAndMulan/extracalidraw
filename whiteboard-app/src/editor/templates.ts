/**
 * Page templates (lined / grid / dotted paper). Each is a small SVG used as a
 * locked background image, so everyone sees the same paper and it shows up in
 * thumbnails, exports and print. The SVG is the same for every page using a
 * template, so it's stored only once per paper.
 */

export type PageTemplate = "lined" | "grid" | "dots";

export const TEMPLATE_LABELS: Record<PageTemplate, string> = {
  lined: "Lined",
  grid: "Grid",
  dots: "Dotted",
};

/** 16:10, like most screens */
export const TEMPLATE_WIDTH = 1600;
export const TEMPLATE_HEIGHT = 1000;

const GAP = 40;

const range = (from: number, to: number, step: number) => {
  const values: number[] = [];
  for (let value = from; value <= to; value += step) {
    values.push(value);
  }
  return values;
};

export const renderTemplateSVG = (template: PageTemplate) => {
  const w = TEMPLATE_WIDTH;
  const h = TEMPLATE_HEIGHT;
  let pattern = "";

  if (template === "lined") {
    pattern = `${range(GAP * 2, h - GAP, GAP)
      .map(
        (y) =>
          `<line x1="0" y1="${y}" x2="${w}" y2="${y}" stroke="#74c0fc" stroke-opacity="0.55" stroke-width="1.5"/>`,
      )
      .join("")}<line x1="${GAP * 3}" y1="0" x2="${
      GAP * 3
    }" y2="${h}" stroke="#ff8787" stroke-opacity="0.6" stroke-width="1.5"/>`;
  } else if (template === "grid") {
    const lines = (major: boolean) =>
      [
        ...range(GAP, w - GAP, GAP)
          .filter((x) => (x % (GAP * 5) === 0) === major)
          .map((x) => `<line x1="${x}" y1="0" x2="${x}" y2="${h}"/>`),
        ...range(GAP, h - GAP, GAP)
          .filter((y) => (y % (GAP * 5) === 0) === major)
          .map((y) => `<line x1="0" y1="${y}" x2="${w}" y2="${y}"/>`),
      ].join("");
    pattern =
      `<g stroke="#adb5bd" stroke-opacity="0.45" stroke-width="1">${lines(
        false,
      )}</g>` +
      `<g stroke="#868e96" stroke-opacity="0.6" stroke-width="1.5">${lines(
        true,
      )}</g>`;
  } else {
    pattern = `<g fill="#868e96" fill-opacity="0.6">${range(GAP, w - GAP, GAP)
      .flatMap((x) =>
        range(GAP, h - GAP, GAP).map(
          (y) => `<circle cx="${x}" cy="${y}" r="2.2"/>`,
        ),
      )
      .join("")}</g>`;
  }

  // transparent sheet, so it works in light and dark mode
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${pattern}<rect x="1" y="1" width="${
    w - 2
  }" height="${
    h - 2
  }" rx="10" fill="none" stroke="#868e96" stroke-opacity="0.5" stroke-width="2"/></svg>`;
};
