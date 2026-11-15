#!/usr/bin/env node
// Renders the installer's images (scripts/make-dmg.mjs) into assets/dmg:
//   background.svg        → background.png, background@2x.png   (a release: ScreenFry + options)
//   background-single.svg → background-single.png, @2x          (a beta: one app)
//   the Uninstall ScreenFry icon → uninstall.png (1024 px; make-dmg turns it into an .icns)
// Run after editing the SVGs or the logo.
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Resvg } from "@resvg/resvg-js";

const root = resolve(import.meta.dirname, "..");
const dir = join(root, "assets/dmg");
const render = (svg, width) =>
  new Resvg(svg, {
    fitTo: { mode: "width", value: width },
    font: { loadSystemFonts: true, defaultFontFamily: "Helvetica Neue" },
  })
    .render()
    .asPng();

for (const name of ["background", "background-single"]) {
  const svg = readFileSync(join(dir, `${name}.svg`), "utf8");
  const width = Number(/width="(\d+)"/.exec(svg)[1]);
  for (const [suffix, scale] of [["", 1], ["@2x", 2]]) {
    writeFileSync(join(dir, `${name}${suffix}.png`), render(svg, width * scale));
    console.log(`Wrote assets/dmg/${name}${suffix}.png`);
  }
}

// Uninstall ScreenFry: the greyed ScreenFry Developer logo with a red "remove" badge.
const logo = readFileSync(join(root, "assets/branding/screenfry-developer.png")).toString("base64");
const uninstall = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 1024 1024">
  <image width="1024" height="1024" opacity="0.85" xlink:href="data:image/png;base64,${logo}"/>
  <circle cx="760" cy="760" r="210" fill="#d63a2f" stroke="#fff" stroke-width="36"/>
  <rect x="640" y="736" width="240" height="48" rx="24" fill="#fff"/>
</svg>`;
writeFileSync(join(dir, "uninstall.png"), render(uninstall, 1024));
console.log("Wrote assets/dmg/uninstall.png");
