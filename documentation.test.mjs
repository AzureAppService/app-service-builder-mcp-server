import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('README documentation links use the canonical docs host', async () => {
  const readme = await readFile(new URL('./README.md', import.meta.url), 'utf8');
  assert.match(readme, /https:\/\/builder\.appservice\.azure\.com\/docs\//);
  assert.doesNotMatch(readme, /https:\/\/builderapps\.azure\.com\/docs(?:\/|\b)/);
});
