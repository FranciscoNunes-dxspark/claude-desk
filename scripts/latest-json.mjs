// Writes latest.json, the file the app's updater reads (Tauri's format): the
// version and, per platform, the file to install from release v<version> and its
// signature. Bundles are the release job's downloaded artifacts, one folder per
// build (claude-desk-<platform>):
//   node scripts/latest-json.mjs <version> <bundles folder> > latest.json
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";

const [version, folder] = process.argv.slice(2);
if (!version || !folder) throw new Error("usage: latest-json.mjs <version> <folder>");
const repo = process.env.GITHUB_REPOSITORY || "FranciscoNunes-dxspark/claude-desk";

const filesIn = (dir) =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesIn(path) : [path];
  });

// Which artifact and file each platform updates from: the bundles the updater can
// install by itself (AppImage, NSIS setup, macOS app archive).
const PLATFORMS = {
  "linux-x86_64": ["claude-desk-linux-x64", (f) => f.endsWith(".AppImage")],
  "windows-x86_64": ["claude-desk-windows-x64", (f) => /-setup\.exe$/.test(f)],
  "darwin-aarch64": ["claude-desk-macos-arm64", (f) => f.endsWith(".app.tar.gz")],
  "darwin-x86_64": ["claude-desk-macos-x64", (f) => f.endsWith(".app.tar.gz")],
};

const platforms = {};
for (const [platform, [artifact, matches]] of Object.entries(PLATFORMS)) {
  let files;
  try {
    files = filesIn(join(folder, artifact));
  } catch {
    continue; // that build failed or didn't run
  }
  const file = files.find((f) => matches(f) && files.includes(`${f}.sig`));
  if (!file) continue;
  platforms[platform] = {
    signature: readFileSync(`${file}.sig`, "utf8").trim(),
    url: `https://github.com/${repo}/releases/download/v${version}/${basename(file)}`,
  };
}
if (!Object.keys(platforms).length) throw new Error(`No signed bundles under ${folder}.`);

console.log(
  JSON.stringify({ version, notes: `Claude Desk ${version}`, pub_date: new Date().toISOString(), platforms }, null, 2),
);
