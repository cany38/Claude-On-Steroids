// Used by the setup files. Compares the running Node.js with the release list on
// nodejs.org and prints the version that should be installed.
// Exit 0: this Node.js is the newest release of a supported line.
// Exit 1: it is behind on its line, or the line no longer gets security fixes.
// Exit 2: nodejs.org could not be reached, so nothing is known.
const current = `v${process.versions.node}`;
let list;
try {
  const r = await fetch('https://nodejs.org/dist/index.json', { signal: AbortSignal.timeout(15000) });
  list = await r.json();
} catch {
  console.log(current);
  process.exit(2);
}

const majorOf = (v) => Number(v.slice(1).split('.')[0]);
// index.json lists the newest release first. The three newest even lines are the
// ones nodejs.org still patches; odd lines are short lived and are left too.
const lines = [...new Set(list.map((r) => majorOf(r.version)).filter((m) => m % 2 === 0))].sort((a, b) => b - a).slice(0, 3);
const major = majorOf(current);
if (!lines.includes(major)) {
  console.log(list.find((r) => r.lts).version);
  process.exit(1);
}
const newest = list.find((r) => majorOf(r.version) === major).version;
console.log(newest);
process.exit(newest === current ? 0 : 1);
