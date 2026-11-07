export const uid = () => crypto.randomUUID();
export const makeToken = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
};
export async function hashToken(token) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
export function authenticateHashed(session, tokenDigest) {
  if (!session || typeof tokenDigest !== 'string' || tokenDigest.length !== 64) return null;
  return session.participants.find(person => person.tokenHash === tokenDigest) || null;
}
export function touchExpiry(session) {
  const hasSettlements = session.status === 'finalized' && session.settlements?.length;
  const outstanding = hasSettlements ? session.settlements.some(x => x.participantId !== session.hostId && (session.payments || []).filter(p => p.participantId === x.participantId).reduce((s, p) => s + p.amountCents, 0) < x.amountCents) : true;
  const duration = outstanding ? 90 : 30;
  session.expiresAt = new Date(Date.now() + duration * 86400000).toISOString();
}


export async function createSession({ title, hostName, demo = false, providedId }) {
  const id = providedId || uid();
  const hostId = uid();
  const token = makeToken();
  const host = { id: hostId, name: hostName.slice(0, 40), role: 'host', tokenHash: await hashToken(token), createdAt: new Date().toISOString() };
  const session = {
    id,
    title: title.slice(0, 80),
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 90 * 86400000).toISOString(),
    revision: 0,
    currency: 'CAD',
    status: 'active',
    hostId,
    participants: [host],
    items: [],
    taxes: [],
    orderDiscountCents: 0,
    tipCents: 0,
    tipVerified: false,
    verifiedTotalCents: null,
    itemizedTotalCents: null,
    receipts: [],
    settlements: [],
    payments: []
  };
  if (demo) {
    const products = [
      ['HH Manna Burger', 2, 2400, 'food'],
      ['12oz Superflux', 1, 425, 'alcohol'],
      ['BC Beer', 1, 425, 'alcohol'],
      ['HH Onion Rings', 1, 825, 'food'],
      ['Modelo HH', 1, 750, 'alcohol'],
      ['HH Pretzel Bites', 1, 900, 'food'],
      ['12oz Dino Sour', 2, 850, 'alcohol']
    ];
    session.title = 'BierCraft Dinner';
    session.items = products.map(([name, quantity, amountCents, taxCategory]) => ({ id: uid(), name, nameOriginal: name, quantity, amountCents, discountCents: 0, taxCategory, groups: [] }));
    session.taxes = [{ id: uid(), label: 'Food Tax (GST)', amountCents: 206, category: 'food' }, { id: uid(), label: 'Liquor Tax', amountCents: 368, category: 'alcohol' }];
    session.tipCents = 1287;
    session.tipVerified = true;
    session.verifiedTotalCents = 8436;
    session.itemizedTotalCents = 7149;
    session.receipts = [{ id: uid(), kind: 'demo', merchant: 'BierCraft UniverCity', createdAt: new Date().toISOString(), summary: 'Demo receipt · $84.36', fingerprint: null }];
  }
  return { session, token };
}
