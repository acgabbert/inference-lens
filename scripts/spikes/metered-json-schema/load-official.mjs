import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';

export async function loadOfficial() {
  const root = new URL('./official/', import.meta.url);
  const manifest = JSON.parse(await readFile(new URL('manifest.json', root), 'utf8'));
  const tasks = [];
  let excluded = 0;
  const actualGroups = new Map();
  for (const file of (await readdir(new URL('draft7/', root))).filter((file) => file.endsWith('.json'))) {
    const groups = JSON.parse(await readFile(new URL(`draft7/${file}`, root), 'utf8'));
    for (const group of groups) {
      const key = `${file}: ${group.description}`;
      assert.ok(!actualGroups.has(key), `Duplicate group: ${key}`);
      actualGroups.set(key, group);
    }
  }
  assert.equal(manifest.groups.length, actualGroups.size, 'Manifest must cover every vendored group');
  for (const entry of manifest.groups) {
    const key = `${entry.file}: ${entry.description}`;
    const group = actualGroups.get(key);
    assert.ok(group, `Missing or duplicated manifest group: ${key}`);
    actualGroups.delete(key);
    assert.equal(group.tests.length, entry.tests);
    if (entry.exclude) { excluded += group.tests.length; continue; }
    for (const test of group.tests) tasks.push({ name: `${key}: ${test.description}`, schema: group.schema, data: test.data, expected: test.valid ? 'valid' : 'invalid' });
  }
  return { tasks, excluded, revision: manifest.revision };
}
