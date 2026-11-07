export const ACCESS_PREFIX = 'splitsnap.access.';
export const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,200}$/;

export function listSavedAccess(storage) {
  const saved = [];
  if (!storage) return saved;
  try {
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (!key?.startsWith(ACCESS_PREFIX)) continue;
      const id = key.slice(ACCESS_PREFIX.length);
      const token = storage.getItem(key);
      if (SESSION_ID_PATTERN.test(id) && TOKEN_PATTERN.test(token || '')) saved.push({ id: id.toLowerCase(), token });
    }
  } catch {
    return saved;
  }
  return saved;
}

export function createRecoveryLink(origin, id, token) {
  if (!SESSION_ID_PATTERN.test(id) || !TOKEN_PATTERN.test(token)) throw new Error('Invalid Host recovery details');
  return `${origin.replace(/\/$/, '')}/s/${id.toLowerCase()}#access=${encodeURIComponent(token)}`;
}

export function parseRecoveryLink(input, origin) {
  let url;
  try { url = new URL(input.trim()); }
  catch { throw new Error('Paste a complete SplitSnap recovery link'); }
  if (url.origin !== origin) throw new Error('The recovery link must belong to this SplitSnap website');
  const match = url.pathname.match(/^\/s\/([0-9a-f-]{36})\/?$/i);
  if (!match || !SESSION_ID_PATTERN.test(match[1])) throw new Error('The recovery link has an invalid session address');
  const token = new URLSearchParams(url.hash.slice(1)).get('access');
  if (!TOKEN_PATTERN.test(token || '')) throw new Error('This link does not contain a valid recovery key');
  return { id: match[1].toLowerCase(), token };
}
