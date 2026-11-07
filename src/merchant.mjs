const legalAndLocationWords = new Set(['restaurant', 'restaurants', 'resto', 'cafe', 'café', 'inc', 'ltd', 'limited', 'corp', 'corporation', 'company', 'co', 'bc', 'canada', 'burnaby', 'vancouver', 'surrey', 'richmond', 'univercity', 'university', 'the']);

export function merchantKey(value) {
  const words = String(value || '').normalize('NFKD').toLowerCase().replace(/\p{M}/gu, '').replace(/[0-9]+/g, ' ').match(/[\p{L}]+/gu) || [];
  const filtered = words.filter(x => !legalAndLocationWords.has(x));
  return (filtered.length ? filtered : words).join('');
}

export function sameMerchant(a, b) {
  const x = merchantKey(a);
  const y = merchantKey(b);
  return Boolean(x && y && (x === y || (Math.min(x.length, y.length) >= 5 && (x.startsWith(y) || y.startsWith(x)))));
}

export function receiptCompatibility(session, parsed) {
  const current = (session.receipts || []).map(r => String(r.merchant || '').trim()).filter(Boolean);
  const proposed = String(parsed?.merchant || '').trim();
  if (!current.length && !(session.receipts || []).length) return { status: 'ready', message: '', currentMerchant: null };
  if (!current.length || !proposed) return {
    status: 'review',
    message: 'The restaurant name is missing from one of these receipts. Confirm that both receipts belong to the same restaurant before importing.',
    currentMerchant: current[0] || null
  };
  if (current.every(existing => sameMerchant(existing, proposed))) return { status: 'ready', message: '', currentMerchant: current[0] };
  return {
    status: 'blocked',
    message: `Different restaurant detected. This split already contains ${current[0]}; the new receipt shows ${proposed}. Create a separate split for the new restaurant.`,
    currentMerchant: current[0]
  };
}
