// Guards against the version drift reported in issue #13: the addon manifest
// is what Wealthfolio shows in its UI, so if it falls behind package.json the
// published release reports the wrong version with no other visible symptom.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (name) => JSON.parse(readFileSync(root + name, 'utf8'));

const pkg = read('package.json').version;
const addon = read('manifest.json').version;
const released = read('.release-please-manifest.json')['.'];

const mismatches = [];
if (pkg !== addon) {
  mismatches.push(`manifest.json (${addon}) does not match package.json (${pkg})`);
}
if (pkg !== released) {
  mismatches.push(`.release-please-manifest.json (${released}) does not match package.json (${pkg})`);
}

if (mismatches.length > 0) {
  console.error('Version mismatch:');
  for (const line of mismatches) console.error(`  - ${line}`);
  console.error('\nAll three files are bumped together by release-please. If they have');
  console.error('drifted, check that .github/workflows/release-please.yml still reads');
  console.error('release-please-config.json and does not set `release-type`.');
  process.exit(1);
}

console.log(`Versions consistent: ${pkg}`);
