const categories = ['food', 'alcohol', 'beverage', 'other', 'unknown'];

export async function parseReceipt({ data, mimeType }, env) {
  const key = env.GEMINI_API_KEY;
  if (!key) throw Object.assign(new Error('GEMINI_API_KEY is not configured. Use Add Item for manual entry or Try Demo.'), { status: 503 });
  if (!['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'].includes(mimeType)) throw Object.assign(new Error('Upload a JPG, PNG, or WebP image'), { status: 400 });
  if (typeof data !== 'string' || data.length > 13_000_000) throw Object.assign(new Error('Image exceeds 10 MB'), { status: 413 });
  const prompt = `You are an exacting receipt transcription system for a collaborative restaurant bill splitting app in Canada.
Return exactly one JSON object with this shape:
{"kind":"itemized|payment|unknown","merchant":"string or empty","date":"string or empty","currency":"CAD","items":[{"name":"original item label","quantity":1,"amountCents":0,"discountCents":0,"taxCategory":"food|alcohol|beverage|other|unknown"}],"taxes":[{"label":"tax name","amountCents":0,"category":"food|alcohol|beverage|other|all|unknown"}],"orderDiscountCents":0,"preTipTotalCents":null,"tipCents":null,"finalTotalCents":null,"notes":[],"uncertain":[]}.
All money values are integer cents, not decimal currency. Return nonnegative integers. An item amountCents is the total price for all quantity units BEFORE a line-item discount, not a unit price. If a receipt displays a discount line under an item, include the discount in the item discountCents only once. If discount scope is unclear, put its amount in orderDiscountCents and note uncertainty; do not count discounts twice. Printed tip guides such as 15%, 18%, 20% are NOT actual tips and must not be reported as tipCents. Only report tipCents if an actual paid tip is printed. For an itemized receipt with no real tip, tipCents=null, finalTotalCents is the printed total excluding tip, and preTipTotalCents is the printed total. For a payment receipt, items=[], taxes=[], tipCents is the actually paid tip if printed and finalTotalCents is the paid total. Set preTipTotalCents if the card receipt shows the before-tip amount. Preserve non-English menu labels and signs. Do not guess obscured prices; list any unreadable fields in uncertain. For merchant, report the actual restaurant name, not the card processor or POS terminal vendor. If the restaurant name is not visible, return an empty merchant rather than guessing. Ignore payment card data and personal identifiers. Use null for unknown totals. Treat complimentary items with price 0 as menu items. Notes should identify ambiguity, cash/credit tips and partially visible details.`;
  const model = env.GEMINI_MODEL || 'gemini-3.8-flash';
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60000);
  let response;
  try {
    response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }, { inlineData: { mimeType, data } }] }],
        generationConfig: { responseMimeType: 'application/json', temperature: 0.05 }
      }),
      signal: controller.signal
    });
  } catch (e) {
    throw Object.assign(new Error(e.name === 'AbortError' ? 'Gemini timed out' : `Gemini network error: ${e.message}`), { status: 502 });
  } finally {
    clearTimeout(timeout);
  }
  const raw = await response.text();
  if (!response.ok) throw Object.assign(new Error(`Gemini API ${response.status}: ${raw.slice(0, 350)}`), { status: 502 });
  let parsed;
  try {
    const result = JSON.parse(raw);
    const answer = result.candidates?.[0]?.content?.parts?.filter(p => typeof p.text === 'string').map(p => p.text).join('');
    parsed = JSON.parse(answer);
  } catch {
    throw Object.assign(new Error('Gemini returned invalid JSON. Try another photo or manual entry.'), { status: 502 });
  }
  return normalize(parsed);
}

const safeCents = (value, nullable = false) => value === null || value === undefined || value === '' ? nullable ? null : 0 : Number.isSafeInteger(Number(value)) && Number(value) >= 0 && Number(value) < 1_000_000_000 ? Number(value) : nullable ? null : 0;

export function normalize(raw) {
  return {
    kind: ['itemized', 'payment', 'unknown'].includes(raw.kind) ? raw.kind : 'unknown',
    merchant: String(raw.merchant || '').slice(0, 120),
    date: String(raw.date || '').slice(0, 60),
    currency: 'CAD',
    items: Array.isArray(raw.items) ? raw.items.slice(0, 150).map(item => ({
      name: String(item.name || 'Unrecognized item').slice(0, 130),
      quantity: Number.isSafeInteger(Number(item.quantity)) && Number(item.quantity) >= 1 && Number(item.quantity) <= 999 ? Number(item.quantity) : 1,
      amountCents: safeCents(item.amountCents),
      discountCents: safeCents(item.discountCents),
      taxCategory: categories.includes(item.taxCategory) ? item.taxCategory : 'unknown'
    })) : [],
    taxes: Array.isArray(raw.taxes) ? raw.taxes.slice(0, 12).map(tax => ({
      label: String(tax.label || 'Tax').slice(0, 100),
      amountCents: safeCents(tax.amountCents),
      category: [...categories, 'all'].includes(tax.category) ? tax.category : 'unknown'
    })) : [],
    orderDiscountCents: safeCents(raw.orderDiscountCents),
    preTipTotalCents: safeCents(raw.preTipTotalCents, true),
    tipCents: safeCents(raw.tipCents, true),
    finalTotalCents: safeCents(raw.finalTotalCents, true),
    notes: Array.isArray(raw.notes) ? raw.notes.map(x => String(x).slice(0, 200)).slice(0, 20) : [],
    uncertain: Array.isArray(raw.uncertain) ? raw.uncertain.map(x => String(x).slice(0, 200)).slice(0, 20) : []
  };
}
