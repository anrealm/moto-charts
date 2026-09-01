/*
 * Checks one built archive against what its own code says it loads, and against
 * the sources it was built from.
 *
 *   node tools/check-archive.mjs dist/moto-charts.xpi firefox [1.0.1]
 *
 * Nothing here is a list of filenames. A hardcoded list next to build.sh's
 * hardcoded `cp` would drift with it and verify nothing: add a file, forget to
 * copy it, and both lists stay silent while the extension installs and throws on
 * load. So the expected set is derived from the artifact — the manifest names the
 * background scripts, the popup and the icons; the popup names its own scripts;
 * the scripts name what they import and what they inject into the page.
 *
 * Presence of a name is not enough either: a zip can carry `content/game.js` as
 * zero bytes, or last week's copy, and still list every expected entry. So every
 * member is also required to be non-empty and byte-identical to the file in the
 * repo it came from — which is the whole claim a release makes about an asset.
 *
 * Prints its own ok/FAIL lines so it reads as part of check-dist.sh's report,
 * and exits 1 if anything failed.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const [archive, browser, expectVersion = ''] = process.argv.slice(2);
if (!archive || !['firefox', 'chrome'].includes(browser)) {
  console.error('usage: check-archive.mjs <archive> <firefox|chrome> [version]');
  process.exit(2);
}

const label = path.basename(archive);
let failed = false;
const ok = (m) => console.log(`  ok    ${label}: ${m}`);
const bad = (m) => { console.log(`  FAIL  ${label}: ${m}`); failed = true; };

// `unzip -l` rather than `-Z1`: the listing carries the uncompressed size, and a
// member being empty is one of the failures worth catching.
const listing = execFileSync('unzip', ['-l', archive], { encoding: 'utf8' });
const members = new Map(); // name -> uncompressed size
for (const line of listing.split('\n')) {
  const m = line.match(/^\s*(\d+)\s+\S+\s+\S+\s+(\S.*)$/);
  if (m && m[2] !== 'Name') members.set(m[2].trim(), Number(m[1]));
}
// Directory entries are listed at size 0 and are not payload.
const files = new Map([...members].filter(([name]) => !name.endsWith('/')));

const readText = (name) => execFileSync('unzip', ['-p', archive, name], { encoding: 'utf8' });
const readBytes = (name) => execFileSync('unzip', ['-p', archive, name], { maxBuffer: 32 * 1024 * 1024 });

// --- the manifest, and the browser it was built for --------------------------
let manifest;
try {
  manifest = JSON.parse(readText('manifest.json'));
} catch (e) {
  bad(`manifest.json is missing or not valid JSON (${e.message.split('\n')[0]})`);
  process.exit(1);
}

if (manifest.manifest_version !== 3) bad(`manifest_version is ${manifest.manifest_version}, expected 3`);

// build.sh copies a different manifest into each tree. Swapping them produces an
// extension that installs and then does nothing, which no other check notices.
if (browser === 'firefox') {
  if (!manifest.background?.scripts?.length) bad('no background.scripts — Firefox MV3 needs them');
  if (manifest.background?.service_worker) bad('has background.service_worker — the Chrome manifest was copied here');
  // Unsigned installs and later updates are keyed on this id; without it
  // Firefox invents a fresh one per install.
  if (!manifest.browser_specific_settings?.gecko?.id) bad('no browser_specific_settings.gecko.id');
} else {
  if (!manifest.background?.service_worker) bad('no background.service_worker — Chrome MV3 needs one');
  if (manifest.background?.scripts) bad('has background.scripts — the Firefox manifest was copied here');
}
if (!failed) ok(`manifest is ${browser} MV3, version ${manifest.version}`);

if (expectVersion && manifest.version !== expectVersion) {
  bad(`manifest version is ${manifest.version}, expected ${expectVersion}`);
} else if (expectVersion) {
  ok(`version matches ${expectVersion}`);
}

// --- what the artifact says it loads ----------------------------------------
// Each reference records where it came from, so a failure names the file that
// asked for the missing path rather than just the path.
const refs = new Map();
const want = (file, source) => {
  if (typeof file === 'string' && file) refs.set(file.replace(/^\.?\//, ''), source);
};

for (const s of manifest.background?.scripts ?? []) want(s, 'manifest background.scripts');
want(manifest.background?.service_worker, 'manifest background.service_worker');
want(manifest.action?.default_popup, 'manifest action.default_popup');
for (const icon of Object.values(manifest.icons ?? {})) want(icon, 'manifest icons');
for (const icon of Object.values(manifest.action?.default_icon ?? {})) want(icon, 'manifest action.default_icon');

// The popup pulls in its own scripts.
const popup = manifest.action?.default_popup;
if (popup && files.has(popup)) {
  const html = readText(popup);
  for (const [, src] of html.matchAll(/<script[^>]+src=["']([^"']+)["']/g)) want(src, popup);
}

// Scripts pull in more scripts two ways: importScripts() in the background
// (Chrome's service worker cannot use <script>), and the file list handed to
// scripting.executeScript() to inject the game into the page. The injected
// files are the ones no manifest mentions, so nothing else would catch them.
for (const js of [...refs.keys()].filter((f) => f.endsWith('.js') && files.has(f))) {
  const code = readText(js);
  for (const [, imported] of code.matchAll(/importScripts\(\s*["']([^"']+)["']/g)) want(imported, js);

  const injected = [...code.matchAll(/=\s*\[\s*((?:["'][^"']+\.js["']\s*,?\s*)+)\]/g)]
    .flatMap(([, body]) => [...body.matchAll(/["']([^"']+\.js)["']/g)].map(([, f]) => f));
  if (js.endsWith('launcher.js')) {
    if (injected.length === 0) {
      // Not a pass: the injected content files are invisible to every other
      // check here, so losing track of them must be loud.
      bad(`${js} declares no list of injected .js files — check-archive.mjs needs updating`);
    }
    for (const f of injected) want(f, `${js} (injected into the page)`);
  }
}

const missing = [...refs].filter(([file]) => !files.has(file));
if (missing.length === 0) {
  ok(`all ${refs.size} referenced files are present`);
} else {
  for (const [file, source] of missing) bad(`${source} references ${file}, which is not in the archive`);
}

// --- nothing in the archive is empty ----------------------------------------
// A zero-byte member lists like any other and passes every name-based check.
// It is what an interrupted copy or a clobbered source leaves behind.
const empty = [...files].filter(([, size]) => size === 0).map(([name]) => name);
if (empty.length === 0) ok(`all ${files.size} members are non-empty`);
else bad(`empty members: ${empty.join(', ')}`);

// --- every member traces back to a file in the repo -------------------------
// build.sh only ever copies: src/ into content/, extension/ into the root and
// icons/, and one of the two manifests into manifest.json. So each member must
// be byte-identical to its source. This is what makes the release's claim about
// an asset checkable — and it catches a stale dist/, a half-finished copy, or a
// tree rebuilt from something other than this checkout.
const sourceFor = (name) => {
  if (name === 'manifest.json') return `extension/manifest.${browser}.json`;
  if (name.startsWith('content/')) return `src/${name.slice('content/'.length)}`;
  if (name.startsWith('icons/')) return `extension/${name}`;
  if (!name.includes('/')) return `extension/${name}`;
  return null;
};

const drifted = [];
const untraceable = [];
for (const name of files.keys()) {
  const source = sourceFor(name);
  if (!source || !fs.existsSync(source)) {
    // Not merely unknown: a member with no source is a byte shipped to users
    // that this checkout cannot account for.
    untraceable.push(name);
    continue;
  }
  if (!readBytes(name).equals(fs.readFileSync(source))) drifted.push(`${name} ≠ ${source}`);
}
if (drifted.length === 0 && untraceable.length === 0) {
  ok(`all ${files.size} members match their sources`);
}
for (const d of drifted) bad(`content differs from the source it was built from: ${d}`);
for (const u of untraceable) {
  bad(`${u} has no corresponding source file — if build.sh started generating it, teach sourceFor() about it`);
}

// --- nothing rode along that should not have --------------------------------
// `zip -X` is about extra fields, not these: __MACOSX and .DS_Store come from
// Finder's Compress or from `ditto`, i.e. from an archive repacked by hand
// rather than built by build.sh — the workflow this pipeline exists to retire.
const junk = [...members.keys()].filter((e) => /__MACOSX|\.DS_Store/.test(e));
if (junk.length === 0) ok('no macOS junk entries');
else bad(`contains ${junk.join(', ')}`);

process.exit(failed ? 1 : 0);
