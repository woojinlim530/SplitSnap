import { calculate, expectedTotal, itemAssignedUnits } from './engine.mjs';
import { normalize } from './gemini.mjs';
import { uid } from './session.mjs';
import { receiptCompatibility, sameMerchant } from './merchant.mjs';

function error(code, message) {
  const e = new Error(message);
  e.status = code;
  throw e;
}

function integer(value, min = 0, max = 1_000_000_000) {
  if (!Number.isSafeInteger(value) || value < min || value > max) error(400, 'Invalid monetary amount or quantity');
  return value;
}

function text(value, max = 100) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) error(400, 'Invalid text field');
  return value.trim();
}


function clientSession(session, actor = null) {
  const isHost = actor?.role === 'host';
  const summary = calculate(session);
  if (!isHost) {
    summary.payments = summary.payments.filter(payment => payment.participantId === actor?.id);
    delete summary.outstandingCents;
  }
  return {
    id: session.id,
    title: session.title,
    currency: session.currency,
    status: session.status,
    revision: session.revision,
    hostId: session.hostId,
    participants: session.participants.map(({ id, name, role }) => ({ id, name, role })),
    items: session.items,
    taxes: session.taxes,
    orderDiscountCents: session.orderDiscountCents,
    tipCents: session.tipCents,
    tipVerified: session.tipVerified,
    verifiedTotalCents: session.verifiedTotalCents,
    itemizedTotalCents: session.itemizedTotalCents,
    receipts: session.receipts.map(({ id, kind, merchant, createdAt, summary }) => ({ id, kind, merchant, createdAt, summary })),
    expiresAt: session.expiresAt,
    payments: isHost ? session.payments : session.payments.filter(payment => payment.participantId === actor?.id),
    summary
  };
}

function active(session) {
  if (session.status !== 'active') error(409, 'The bill is finalized. Host must reopen it before editing');
}

function editItem(item, data) {
  const next = { ...item };
  if ('name' in data) next.name = text(data.name, 130);
  if ('quantity' in data) {
    const quantity = integer(data.quantity, 1, 999);
    if (itemAssignedUnits(item) > quantity) error(409, 'Remove existing allocations before decreasing the quantity');
    next.quantity = quantity;
  }
  if ('amountCents' in data) next.amountCents = integer(data.amountCents);
  if ('discountCents' in data) next.discountCents = integer(data.discountCents);
  if (next.discountCents > next.amountCents) error(400, 'Discount cannot exceed item price');
  if ('taxCategory' in data) {
    if (!['food', 'alcohol', 'beverage', 'other', 'unknown'].includes(data.taxCategory)) error(400, 'Invalid tax category');
    next.taxCategory = data.taxCategory;
  }
  Object.assign(item, next);
}

function normalizeReceiptForImport(parsed) {
  if (!parsed || !['itemized', 'payment', 'unknown'].includes(parsed.kind)) error(400, 'Invalid receipt');
  return normalize(parsed);
}

function importReceipt(session, raw, fingerprint = null, merchantConfirmed = false) {
  const parsed = normalizeReceiptForImport(raw);
  if (fingerprint && session.receipts.some(r => r.fingerprint === fingerprint)) error(409, 'This image has already been imported');
  if (parsed.kind === 'unknown') error(400, 'Choose itemized or payment receipt before importing');
  const compatibility = receiptCompatibility(session, parsed);
  if (compatibility.status === 'blocked') error(409, compatibility.message);
  if (compatibility.status === 'review' && !merchantConfirmed) error(409, compatibility.message);
  if (parsed.items.some(item => item.discountCents > item.amountCents)) error(400, 'One or more discounts exceed item prices');
  const isPayment = parsed.kind === 'payment';
  if (!isPayment) {
    if (!parsed.items.length) error(400, 'No menu items were detected. Use Add Item instead');
    for (const item of parsed.items) {
      if (item.discountCents > item.amountCents) error(400, `Discount exceeds the price of ${item.name}`);
      session.items.push({ id: uid(), name: item.name, nameOriginal: item.name, quantity: item.quantity, amountCents: item.amountCents, discountCents: item.discountCents, taxCategory: item.taxCategory, groups: [] });
    }
    for (const tax of parsed.taxes) session.taxes.push({ id: uid(), ...tax });
    session.orderDiscountCents += parsed.orderDiscountCents;
    if (parsed.preTipTotalCents !== null) session.itemizedTotalCents = (session.itemizedTotalCents || 0) + parsed.preTipTotalCents;
    if (parsed.tipCents !== null) {
      session.tipCents = parsed.tipCents;
      session.tipVerified = true;
    }
    if (parsed.finalTotalCents !== null && parsed.tipCents !== null) session.verifiedTotalCents = parsed.finalTotalCents;
  } else {
    if (parsed.tipCents !== null) {
      session.tipCents = parsed.tipCents;
      session.tipVerified = true;
    }
    if (parsed.finalTotalCents !== null) session.verifiedTotalCents = parsed.finalTotalCents;
  }
  const result = expectedTotal(session);
  const warnings = [];
  if (parsed.kind === 'payment' && parsed.preTipTotalCents !== null && parsed.preTipTotalCents !== result - session.tipCents) warnings.push(`Payment before tip ${parsed.preTipTotalCents}¢ differs from current bill before tip ${result - session.tipCents}¢.`);
  if (parsed.kind === 'itemized' && parsed.preTipTotalCents !== null && parsed.items.length && parsed.preTipTotalCents !== parsed.items.reduce((n, item) => n + item.amountCents - item.discountCents, 0) - parsed.orderDiscountCents + parsed.taxes.reduce((n, tax) => n + tax.amountCents, 0)) warnings.push('Scanned itemized lines do not match the printed receipt total. Correct the item and charge values before finalizing.');
  if (parsed.kind === 'payment') {
    const merchant = parsed.merchant;
    const itemizedMerchants = session.receipts.filter(r => r.kind === 'itemized' && r.merchant).map(r => r.merchant);
    if (merchant && itemizedMerchants.length && !itemizedMerchants.some(m => sameMerchant(m, merchant))) warnings.push('Payment merchant differs from the itemized receipt merchant. Confirm both receipts belong to this bill.');
  }
  const warning = warnings.length ? warnings.join(' ') : null;
  session.receipts.push({ id: uid(), kind: parsed.kind, merchant: parsed.merchant, createdAt: new Date().toISOString(), summary: `${parsed.merchant || 'Receipt'} · ${parsed.kind}`, fingerprint });
  return warning;
}

function modifyClaim(session, actor, data) {
  const item = session.items.find(x => x.id === data.itemId);
  if (!item) error(404, 'Item not found');
  const targetId = data.targetId || actor.id;
  if (actor.role !== 'host' && targetId !== actor.id) error(403, 'You can only edit your own selections');
  if (!session.participants.some(p => p.id === targetId)) error(404, 'Participant not found');
  const op = data.op;
  const available = item.quantity - itemAssignedUnits(item);
  const solo = item.groups.find(g => g.members.length === 1 && g.members[0] === targetId);
  if (op === 'toggle' && item.quantity === 1) {
    let group = item.groups[0];
    if (!group) {
      item.groups.push({ id: uid(), quantity: 1, members: [targetId], shared: true });
    } else if (group.members.includes(targetId)) {
      group.members = group.members.filter(id => id !== targetId);
      if (!group.members.length) item.groups = [];
    } else {
      group.members.push(targetId);
    }
  } else if (op === 'plus' && item.quantity > 1) {
    if (available <= 0) error(409, 'Every unit is assigned. Remove an allocation before adding another');
    if (solo) solo.quantity++;
    else item.groups.push({ id: uid(), quantity: 1, members: [targetId], shared: false });
  } else if (op === 'minus' && item.quantity > 1) {
    if (!solo) error(409, 'You have no individual units to remove');
    solo.quantity--;
    if (solo.quantity === 0) item.groups = item.groups.filter(g => g.id !== solo.id);
  } else if (op === 'share' && item.quantity > 1) {
    if (solo) {
      solo.quantity--;
      if (solo.quantity === 0) item.groups = item.groups.filter(g => g.id !== solo.id);
    } else if (available <= 0) {
      error(409, 'No free unit to share. Release one individual unit first');
    }
    item.groups.push({ id: uid(), quantity: 1, members: [targetId], shared: true });
  } else if (['join', 'leave'].includes(op) && item.quantity > 1) {
    const group = item.groups.find(g => g.id === data.groupId);
    if (!group || !group.shared || group.quantity !== 1) error(404, 'Shared portion not found');
    if (op === 'join') {
      if (!group.members.includes(targetId)) group.members.push(targetId);
    } else {
      if (!group.members.includes(targetId)) error(409, 'Not a member of this portion');
      group.members = group.members.filter(id => id !== targetId);
      if (!group.members.length) item.groups = item.groups.filter(g => g.id !== group.id);
    }
  } else {
    error(400, 'Unsupported allocation operation');
  }
  if (itemAssignedUnits(item) > item.quantity) error(409, 'Quantity exceeds item count');
}


export { error, integer, text, clientSession, active, editItem, importReceipt, modifyClaim };
