import test from 'node:test';
import assert from 'node:assert/strict';
import { receiptCompatibility, sameMerchant } from '../src/merchant.mjs';
import { importReceipt } from '../src/core.mjs';

const itemized = (merchant, amount = 10000) => ({
  kind: 'itemized', merchant, date: '', currency: 'CAD',
  items: [{ name: 'Pizza', quantity: 1, amountCents: amount, discountCents: 0, taxCategory: 'food' }],
  taxes: [], orderDiscountCents: 0, preTipTotalCents: amount, tipCents: null, finalTotalCents: amount,
  notes: [], uncertain: []
});
const payment = (merchant) => ({
  kind: 'payment', merchant, date: '', currency: 'CAD', items: [], taxes: [],
  orderDiscountCents: 0, preTipTotalCents: 10000, tipCents: 2000, finalTotalCents: 12000,
  notes: [], uncertain: []
});
const session = () => ({
  items: [], receipts: [], taxes: [], orderDiscountCents: 0,
  tipCents: 0, tipVerified: false, itemizedTotalCents: null, verifiedTotalCents: null
});

test('common merchant variants match but different restaurants do not', () => {
  assert.ok(sameMerchant('BierCraft UniverCity', 'BierCraft'));
  assert.ok(sameMerchant('Gobong88', 'Gobong (Burnaby)'));
  assert.ok(sameMerchant('Busan Daeji Gukbap Restaurant', 'Busan Daeji Gukbap'));
  assert.equal(sameMerchant('Red Lobster', 'Red Robin'), false);
  assert.equal(sameMerchant('Gobong88', 'Busan Daeji Gukbap'), false);
});

test('the same restaurant accepts itemized plus payment receipt', () => {
  const s = session();
  assert.equal(importReceipt(s, itemized('Gobong88')), null);
  assert.equal(receiptCompatibility(s, payment('Gobong (Burnaby)')).status, 'ready');
  assert.equal(importReceipt(s, payment('Gobong (Burnaby)')), null);
  assert.equal(s.receipts.length, 2);
  assert.equal(s.items.length, 1);
  assert.equal(s.verifiedTotalCents, 12000);
  assert.equal(s.tipCents, 2000);
});

test('another restaurant is blocked before any amounts are modified', () => {
  const s = session();
  importReceipt(s, itemized('Gobong88'));
  const snapshot = JSON.stringify(s);
  const otherRestaurant = payment('Busan Daeji Gukbap');
  assert.equal(receiptCompatibility(s, otherRestaurant).status, 'blocked');
  assert.throws(() => importReceipt(s, otherRestaurant), e => e.status === 409 && /Different restaurant/.test(e.message));
  assert.equal(JSON.stringify(s), snapshot);
  assert.throws(() => importReceipt(s, itemized('BierCraft')), e => e.status === 409);
  assert.equal(JSON.stringify(s), snapshot);
});

test('missing merchant requires explicit host confirmation when the session already has a receipt', () => {
  const s = session();
  importReceipt(s, itemized('Gobong88'));
  const noMerchant = payment('');
  assert.equal(receiptCompatibility(s, noMerchant).status, 'review');
  assert.throws(() => importReceipt(s, noMerchant), e => e.status === 409);
  assert.equal(s.receipts.length, 1);
  importReceipt(s, noMerchant, null, true);
  assert.equal(s.receipts.length, 2);
});

test('itemized photos from the same restaurant are accepted as separate lines', () => {
  const s = session();
  importReceipt(s, itemized('BierCraft'));
  importReceipt(s, itemized('BierCraft UniverCity', 500));
  assert.equal(s.receipts.length, 2);
  assert.equal(s.items.length, 2);
});
