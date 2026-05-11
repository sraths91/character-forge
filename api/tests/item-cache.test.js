import { test } from 'node:test';
import assert from 'node:assert';

// Force in-memory DB before importing database.js
process.env.CF_DB_PATH = ':memory:';

const { putItemSprite, getItemSprite, ITEM_GENERATOR_VERSION } = await import('../db/database.js');

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

test('round-trips a sprite', () => {
  putItemSprite({ hash: 'a'.repeat(40), pngBase64: PNG, itemName: 'Test', baseAsset: '/x' });
  const got = getItemSprite('a'.repeat(40));
  assert.ok(got);
  assert.strictEqual(got.png, PNG);
  assert.strictEqual(got.name, 'Test');
  assert.strictEqual(got.baseAsset, '/x');
  assert.strictEqual(got.version, ITEM_GENERATOR_VERSION);
});

test('returns null for unknown hash', () => {
  assert.strictEqual(getItemSprite('b'.repeat(40)), null);
});

test('upsert replaces an existing row', () => {
  const hash = 'd'.repeat(40);
  putItemSprite({ hash, pngBase64: PNG, itemName: 'first', baseAsset: '/a' });
  putItemSprite({ hash, pngBase64: PNG, itemName: 'second', baseAsset: '/b' });
  const got = getItemSprite(hash);
  assert.strictEqual(got.name, 'second');
  assert.strictEqual(got.baseAsset, '/b');
});

test('getItemSprite increments hits without throwing', () => {
  const hash = 'c'.repeat(40);
  putItemSprite({ hash, pngBase64: PNG, itemName: 'X', baseAsset: '/x' });
  assert.ok(getItemSprite(hash));
  assert.ok(getItemSprite(hash));
  assert.ok(getItemSprite(hash));
  // Implicit assertion: no error on the UPDATE statement after multiple reads.
});

test('ITEM_GENERATOR_VERSION is a positive integer', () => {
  assert.ok(Number.isInteger(ITEM_GENERATOR_VERSION));
  assert.ok(ITEM_GENERATOR_VERSION >= 1);
});
