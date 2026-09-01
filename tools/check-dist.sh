#!/usr/bin/env bash
# Checks what ./build.sh left in dist/. Run it after a build, or let CI run it.
# Every check stands for a way a build breaks while still looking fine in a
# directory listing: a manifest that disagrees with the tag, the wrong manifest
# copied into the wrong tree, a file the code loads that never got copied, a
# macOS resource fork riding along inside the zip, a bookmarklet that no longer
# decodes to the bundle it was built from.
#
#   tools/check-dist.sh            # structural checks only
#   tools/check-dist.sh 1.0.1      # also pin both manifests to that version
#
# Archive contents are checked by tools/check-archive.mjs, which derives what
# should be inside from the artifact's own manifest and code rather than from a
# list kept here — a list here would drift along with build.sh and prove nothing.
set -uo pipefail

cd "$(dirname "$0")/.."

# An empty argument would silently disable the version pin, which is the one
# thing the release job passes an argument for.
if [ "$#" -gt 0 ] && [ -z "$1" ]; then
  echo "usage: check-dist.sh [version] — the version, if given, must not be empty" >&2
  exit 2
fi
EXPECT_VERSION="${1:-}"

XPI=dist/moto-charts.xpi
CRX=dist/moto-charts-chrome.zip
BUNDLE=dist/moto.bundle.js
BOOKMARKLET=dist/bookmarklet.txt

fail=0
ok()  { printf '  ok    %s\n' "$1"; }
bad() { printf '  FAIL  %s\n' "$1"; fail=1; }

# --- the four shippable files exist and are not empty ------------------------
for f in "$XPI" "$CRX" "$BUNDLE" "$BOOKMARKLET"; do
  if [ -s "$f" ]; then ok "$f present ($(( $(wc -c < "$f") / 1024 )) KB)"
  else bad "$f missing or empty"; fi
done
# Nothing below can run against a half-built dist/.
if [ "$fail" -ne 0 ]; then
  printf '\ndist/ is incomplete — run ./build.sh first\n'
  exit 1
fi

# --- both archives are readable zips -----------------------------------------
# An .xpi is a plain zip; if unzip cannot read it, neither can the browser.
for f in "$XPI" "$CRX"; do
  if unzip -tqq "$f" >/dev/null 2>&1; then ok "$f is a valid zip"
  else bad "$f is not a readable zip"; fi
done
if [ "$fail" -ne 0 ]; then
  printf '\ndist/ is NOT shippable — an archive is unreadable\n'
  exit 1
fi

# --- each archive against its own manifest and code --------------------------
node tools/check-archive.mjs "$XPI" firefox "$EXPECT_VERSION" || fail=1
node tools/check-archive.mjs "$CRX" chrome  "$EXPECT_VERSION" || fail=1

# Same source, same release: the two manifests must never drift apart. Checked
# here rather than per-archive, because neither archive can see the other.
# stderr is dropped: unzip writes "caution: filename not matched" straight into
# the CI log for a manifest that isn't there, and the missing version is
# reported below anyway.
read_version() { unzip -p "$1" manifest.json 2>/dev/null | node -e '
  let s = "";
  process.stdin.on("data", (d) => s += d)
    .on("end", () => {
      try { console.log(JSON.parse(s).version ?? "unreadable"); } catch { console.log("unreadable"); }
    });
'; }
v_ff=$(read_version "$XPI")
v_cr=$(read_version "$CRX")
if [ -z "$v_ff" ] || [ "$v_ff" = unreadable ] || [ -z "$v_cr" ] || [ "$v_cr" = unreadable ]; then
  # Without this, two manifests that yield nothing usable compare equal to each
  # other — an ok line reading "both manifests agree on version".
  bad "could not read a version out of both manifests (xpi '$v_ff', chrome zip '$v_cr')"
elif [ "$v_ff" = "$v_cr" ]; then
  ok "both manifests agree on version $v_ff"
else
  bad "version mismatch: xpi $v_ff vs chrome zip $v_cr"
fi

# --- the console bundle actually starts the game -----------------------------
# `root.MotoPhysics = api;` is in physics.js and nowhere else. Grepping for the
# bare name would not do: game.js reads `global.MotoPhysics`, so a bundle built
# from game.js alone — physics.js truncated to nothing, `cat` of an empty file
# succeeding — would match and ship a bundle that dies on the first frame.
if grep -qF 'root.MotoPhysics = api;' "$BUNDLE"; then ok "$BUNDLE contains src/physics.js"
else bad "$BUNDLE does not contain src/physics.js"; fi

# Likewise `global.MotoCharts = API;` is game.js publishing itself, as opposed to
# the many places that merely read the name.
if grep -qF 'global.MotoCharts = API;' "$BUNDLE"; then ok "$BUNDLE contains src/game.js"
else bad "$BUNDLE does not contain src/game.js"; fi

# The call has to be last: the bundle is pasted into a console and the
# bookmarklet wraps it, so anything after the start call never runs the game.
if [ "$(grep -vE '^[[:space:]]*$' "$BUNDLE" | tail -n 1)" = 'MotoCharts.start();' ]; then
  ok "$BUNDLE ends with the start call"
else
  bad "$BUNDLE does not end with MotoCharts.start()"
fi

# --- the version the code reports about itself -------------------------------
# src/game.js carries a third version string, shipped inside all four artifacts
# as MotoCharts.version. The manifests are pinned above; without this, a release
# can go out reporting the previous version to anyone who asks the API.
v_code=$(grep -oE "version: '[^']*'" "$BUNDLE" | head -n 1 | sed "s/version: '//; s/'$//")
if [ -z "$v_code" ]; then
  bad "$BUNDLE carries no version string — check-dist.sh needs updating"
elif [ "$v_code" != "$v_ff" ]; then
  bad "the code reports version $v_code, the manifests say $v_ff"
elif [ -n "$EXPECT_VERSION" ] && [ "$v_code" != "$EXPECT_VERSION" ]; then
  bad "the code reports version $v_code, expected $EXPECT_VERSION"
else
  ok "the code reports version $v_code, matching the manifests"
fi

# --- the bookmarklet is one pasteable line that decodes back to the bundle ---
# Counting newline characters, not `wc -l`: a correct one-line file that lost its
# trailing newline counts as 0 lines, and a real two-line file without one counts
# as 1. Either way `wc -l` gives the wrong verdict on a healthy or broken build.
newlines=$(tr -cd '\n' < "$BOOKMARKLET" | wc -c | tr -d ' ')
if [ "$newlines" -le 1 ]; then
  ok "$BOOKMARKLET is a single line"
else
  # A trailing newline does not open a line, so it does not count towards the
  # total the message reports.
  if [ -n "$(tail -c 1 "$BOOKMARKLET")" ]; then spans=$((newlines + 1)); else spans="$newlines"; fi
  bad "$BOOKMARKLET spans $spans lines — a bookmarklet must be one"
fi

# `catch` keeps a thrown stack trace out of the report: the last line of a node
# trace is its version banner, which says nothing about what broke.
# The verdict comes from node's exit status; stderr is captured only to explain
# a failure. Judging by "was anything written to stderr" would turn a future
# runtime warning — an ExperimentalWarning, an inherited NODE_OPTIONS — into a
# FAIL on a perfectly good bookmarklet.
if bookmarklet_error=$(node -e '
  try {
    const fs = require("fs");
    const line = fs.readFileSync("dist/bookmarklet.txt", "utf8").trim();
    if (!line.startsWith("javascript:")) throw new Error("does not start with javascript:");
    const decoded = decodeURIComponent(line.slice("javascript:".length));
    const bundle = fs.readFileSync("dist/moto.bundle.js", "utf8");
    if (decoded !== "(function(){" + bundle + "})();") {
      throw new Error("decoded body does not match dist/moto.bundle.js");
    }
  } catch (e) { console.error(e.message); process.exit(1); }
' 2>&1 >/dev/null); then
  ok "$BOOKMARKLET decodes to the built bundle"
else
  bad "$BOOKMARKLET: ${bookmarklet_error:-node exited non-zero without a message}"
fi

if [ "$fail" -eq 0 ]; then
  printf '\ndist/ looks shippable%s\n' "${EXPECT_VERSION:+ as $EXPECT_VERSION}"
else
  printf '\ndist/ is NOT shippable — see FAIL above\n'
fi
exit "$fail"
