// Runs after `npm install` (package.json "postinstall"). Patches xterm's canvas renderer so
// block elements (▐ ▛ ▜ ▌ ▀ ▄ …, which Claude Code's logo is drawn with) are filled on whole
// device pixels. Unpatched, a half block in a cell an odd number of pixels wide ends mid-pixel
// and is blended, leaving a visible seam where it meets the next block. Rounding each piece's
// edges makes neighbouring pieces tile exactly at any font size and display scaling, without
// changing the cell size. Fails loudly if xterm's code changes shape, rather than silently
// dropping the fix.
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
let file;
try {
  file = require.resolve("@xterm/addon-canvas/lib/addon-canvas.js");
} catch {
  process.exit(0); // not installed (e.g. a partial install); nothing to patch
}

const FROM = "e.fillRect(i+a.x*h,s+a.y*l,a.w*h,a.h*l)";
const TO =
  "{const X=Math.round(i+a.x*h),Y=Math.round(s+a.y*l);" +
  "e.fillRect(X,Y,Math.round(i+(a.x+a.w)*h)-X,Math.round(s+(a.y+a.h)*l)-Y)}";

const code = readFileSync(file, "utf8");
if (code.includes(TO)) {
  console.log("patch-xterm: block elements already snapped to whole pixels");
} else if (code.split(FROM).length === 2) {
  writeFileSync(file, code.replace(FROM, TO));
  console.log("patch-xterm: block elements now snap to whole pixels");
} else {
  console.error(`patch-xterm: couldn't find the block-element drawing code in ${file}.`);
  console.error("xterm's canvas renderer changed: update scripts/patch-xterm.mjs.");
  process.exit(1);
}
