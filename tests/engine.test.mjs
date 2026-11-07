import test from 'node:test';
import assert from 'node:assert/strict';
import { allocateWeighted, calculate, expectedTotal } from '../src/engine.mjs';

const id = x => x;
const person = name => ({ id: name, name });
const item = (id, quantity, amountCents, taxCategory = 'food', groups = [], discountCents = 0) => ({ id, name: id, quantity, amountCents, taxCategory, groups, discountCents });
const group = (id, quantity, members) => ({ id, quantity, members });
const make = (items, taxes = [], tipCents = 0, orderDiscountCents = 0, verifiedTotalCents = null) => ({ items, taxes, tipCents, orderDiscountCents, verifiedTotalCents, tipVerified: true, status: 'active', participants: [person('alex'), person('jamie'), person('chris')], payments: [], hostId: 'alex' });

test('weighted rounding allocates exact cents', () => {
  assert.deepEqual(allocateWeighted(2500, [{id:'alex',weight:1},{id:'jamie',weight:1},{id:'chris',weight:1}]), {alex:834, jamie:833, chris:833});
});

test('thirty beers remain a single item with quantity claims', () => {
  const session = make([item('beer', 30, 24000, 'alcohol', [group('a',12,['alex']),group('b',10,['jamie']),group('c',8,['chris'])])]);
  const r = calculate(session);
  assert.equal(r.canFinalize, true);
  assert.deepEqual(r.people.map(x => x.totalCents), [9600,8000,6400]);
  assert.equal(r.totalCents, 24000);
});

test('different beers are separated, identical beers can be shared', () => {
  const session = make([
    item('asahi', 2, 1500, 'alcohol', [group('a',1,['alex']),group('b',1,['jamie','chris'])]),
    item('sapporo', 1, 800, 'alcohol', [group('c',1,['alex','jamie'])])
  ]);
  const r = calculate(session);
  assert.equal(r.canFinalize, true);
  assert.deepEqual(r.people.map(x=>x.foodCents), [1150,775,375]);
});

test('discount, category taxes and tip allocate exactly', () => {
  const session = make([
    item('burger',2,2400,'food',[group('a',1,['alex']),group('b',1,['jamie'])]),
    item('beer',2,2000,'alcohol',[group('c',1,['jamie']),group('d',1,['chris'])],200)
  ],[{id:'foodtax',label:'GST',amountCents:120,category:'food'},{id:'liquortax',label:'Liquor',amountCents:270,category:'alcohol'}],630,300);
  const r = calculate(session);
  assert.equal(r.canFinalize, true);
  assert.equal(r.people.reduce((s,p)=>s+p.totalCents,0), 4920);
  assert.equal(r.people[0].taxCents,60);
  assert.equal(r.people[2].taxCents,135);
  assert.equal(r.totalCents,expectedTotal(session));
});

test('unassigned items prevent finalization', () => {
  const session = make([item('beer',3,2400,'alcohol',[group('a',1,['alex'])])]);
  const r = calculate(session);
  assert.equal(r.canFinalize,false);
  assert.equal(r.unassignedCents,1600);
  assert.match(r.errors[0],/2 unassigned/);
});

test('payment receipt mismatch prevents finalization', () => {
  const session = make([item('pizza',1,1800,'food',[group('a',1,['alex','jamie'])])],[],0,0,1900);
  assert.equal(calculate(session).canFinalize,false);
});

test('unknown tax category prevents finalization', () => {
  const session=make([item('pizza',1,2000,'food',[group('a',1,['alex'])])],[{id:'unknown-tax',label:'Other tax',category:'unknown',amountCents:50}]);
  assert.equal(calculate(session).canFinalize,false);
});

test('one-cent tip with 3 people is exactly assigned', () => {
  const session=make([item('pizza',1,300,'food',[group('a',1,['alex','jamie','chris'])])],[],1);
  const r=calculate(session);
  assert.equal(r.totalCents,301);
  assert.equal(r.people.reduce((s,p)=>s+p.totalCents,0),301);
});

test('printed itemized total mismatch prevents finalization even without payment receipt', () => {
  const session=make([item('pizza',1,1800,'food',[group('a',1,['alex'])])]);
  session.itemizedTotalCents=1850;
  assert.equal(calculate(session).canFinalize,false);
  assert.match(calculate(session).errors.join(' '),/Itemized receipt/);
});
