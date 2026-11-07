import test from 'node:test';
import assert from 'node:assert/strict';
import { listSavedAccess, parseRecoveryLink, createRecoveryLink } from '../public/saved-access.mjs';

const sessionId = '12345678-1234-4234-8234-123456789abc';
const token = 'a'.repeat(43);
const origin = 'https://splitsnap.splitsnap.workers.dev';

test('Existing v1.4 stored Host access is discovered without migration', () => {
  const data = new Map([
    [`splitsnap.access.${sessionId}`, token],
    ['other.website.data', 'not relevant'],
    ['splitsnap.access.invalid', token],
    [`splitsnap.access.87654321-4321-4432-8432-abcdefabcdef`, 'bad']
  ]);
  const storage = { get length() { return data.size; }, key(i) { return [...data.keys()][i]; }, getItem(k) { return data.get(k); } };
  assert.deepEqual(listSavedAccess(storage), [{ id: sessionId, token }]);
});

test('Recovery link is scoped to this hostname and includes Host access fragment', () => {
  const url = createRecoveryLink(origin, sessionId, token);
  assert.equal(url, `${origin}/s/${sessionId}#access=${token}`);
  assert.deepEqual(parseRecoveryLink(url, origin), { id: sessionId, token });
  assert.throws(() => parseRecoveryLink(`${origin}/s/${sessionId}`, origin), /valid recovery key/);
  assert.throws(() => parseRecoveryLink(`https://attacker.example/s/${sessionId}#access=${token}`, origin), /must belong/);
  assert.throws(() => parseRecoveryLink(`${origin}/s/not-valid#access=${token}`, origin), /invalid session address/);
  assert.throws(() => createRecoveryLink(origin, sessionId, 'bad'), /Invalid Host/);
});

test('Browser storage failures return an empty list without deleting sessions', () => {
  assert.deepEqual(listSavedAccess({ get length() { throw new Error('blocked'); } }), []);
});
