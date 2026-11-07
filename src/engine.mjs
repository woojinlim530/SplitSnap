export const money = cents => `$${(cents / 100).toFixed(2)}`;

export function allocateWeighted(total, entries) {
  if (!Number.isSafeInteger(total) || total < 0) throw new Error('Invalid amount');
  const result = Object.fromEntries(entries.map(x => [x.id, 0]));
  const eligible = entries.filter(x => Number.isFinite(x.weight) && x.weight > 0);
  const totalWeight = eligible.reduce((sum, x) => sum + x.weight, 0);
  if (!eligible.length || totalWeight <= 0) {
    if (total === 0) return result;
    throw new Error('Cannot allocate charge without an eligible item');
  }
  const parts = eligible.map(x => {
    const exact = total * x.weight / totalWeight;
    return { id: x.id, whole: Math.floor(exact), fraction: exact - Math.floor(exact) };
  });
  let remainder = total - parts.reduce((sum, x) => sum + x.whole, 0);
  parts.sort((a, b) => b.fraction - a.fraction || a.id.localeCompare(b.id));
  for (const part of parts) {
    result[part.id] += part.whole + (remainder > 0 ? 1 : 0);
    if (remainder > 0) remainder--;
  }
  return result;
}

export function itemAssignedUnits(item) {
  return (item.groups || []).reduce((sum, group) => sum + group.quantity, 0);
}

export function expectedTotal(session) {
  return session.items.reduce((n, item) => n + item.amountCents - item.discountCents, 0) - session.orderDiscountCents + session.taxes.reduce((n, tax) => n + tax.amountCents, 0) + session.tipCents;
}

export function calculate(session) {
  const errors = [];
  const people = session.participants.map(x => x.id);
  const unknown = '__unassigned__';
  const ids = [...people, unknown];
  const ledgers = Object.fromEntries(ids.map(id => [id, { id, foodCents: 0, discountCents: 0, taxCents: 0, tipCents: 0, totalCents: 0, taxByCategory: {} }]));
  const rows = [];
  const discountedItems = session.items.map(item => {
    const gross = item.amountCents;
    const discount = item.discountCents;
    if (!Number.isInteger(item.quantity) || item.quantity < 1 || !Number.isInteger(gross) || gross < 0 || !Number.isInteger(discount) || discount < 0 || discount > gross) {
      errors.push(`Invalid amount or quantity for ${item.name}`);
    }
    const assigned = itemAssignedUnits(item);
    if (assigned > item.quantity) errors.push(`${item.name}: assigned quantity exceeds order`);
    if (assigned < item.quantity) errors.push(`${item.name}: ${item.quantity - assigned} unassigned`);
    return { item, net: Math.max(0, gross - discount), assigned };
  });
  const itemsSubtotal = discountedItems.reduce((sum, x) => sum + x.net, 0);
  const globalDiscount = session.orderDiscountCents || 0;
  if (globalDiscount < 0 || globalDiscount > itemsSubtotal) errors.push('Order discount exceeds subtotal');
  let perItemDiscount;
  try {
    perItemDiscount = allocateWeighted(Math.min(globalDiscount, itemsSubtotal), discountedItems.map(x => ({ id: x.item.id, weight: x.net })));
  } catch (e) {
    errors.push(e.message);
    perItemDiscount = {};
  }
  const allocationsByItem = [];
  for (const entry of discountedItems) {
    const { item, net, assigned } = entry;
    const itemFinal = Math.max(0, net - (perItemDiscount[item.id] || 0));
    const groups = (item.groups || []).map(g => ({ id: g.id, weight: g.quantity, members: g.members }));
    if (assigned < item.quantity) groups.push({ id: unknown, weight: item.quantity - assigned, members: [unknown] });
    const itemDistribution = allocateWeighted(itemFinal, groups);
    const personAmounts = Object.fromEntries(ids.map(id => [id, 0]));
    for (const group of groups) {
      const groupValue = itemDistribution[group.id] || 0;
      if (group.members.length === 0) {
        errors.push(`${item.name}: a shared portion has no members`);
        continue;
      }
      const shareValues = allocateWeighted(groupValue, group.members.map(id => ({ id, weight: 1 })));
      for (const [id, value] of Object.entries(shareValues)) {
        if (!ledgers[id]) {
          errors.push(`${item.name}: invalid participant`);
          continue;
        }
        ledgers[id].foodCents += value;
        personAmounts[id] += value;
        ledgers[id].taxByCategory[item.taxCategory] = (ledgers[id].taxByCategory[item.taxCategory] || 0) + value;
      }
    }
    allocationsByItem.push({ id: item.id, name: item.name, assigned, quantity: item.quantity, amounts: personAmounts, valueCents: itemFinal });
  }
  for (const tax of session.taxes) {
    if (!Number.isInteger(tax.amountCents) || tax.amountCents < 0) {
      errors.push(`Invalid tax amount: ${tax.label}`);
      continue;
    }
    if (tax.category === 'unknown' && tax.amountCents > 0) {
      errors.push(`Tax category needs review: ${tax.label}`);
      continue;
    }
    const weights = ids.map(id => ({ id, weight: tax.category === 'all' ? ledgers[id].foodCents : ledgers[id].taxByCategory[tax.category] || 0 }));
    try {
      const distribution = allocateWeighted(tax.amountCents, weights);
      for (const id of ids) ledgers[id].taxCents += distribution[id] || 0;
    } catch (e) {
      errors.push(`${tax.label}: ${e.message}`);
    }
  }
  try {
    const tipDistribution = allocateWeighted(session.tipCents, ids.map(id => ({ id, weight: ledgers[id].foodCents })));
    for (const id of ids) ledgers[id].tipCents = tipDistribution[id] || 0;
  } catch (e) {
    errors.push(`Tip: ${e.message}`);
  }
  for (const id of ids) {
    const p = ledgers[id];
    p.totalCents = p.foodCents + p.taxCents + p.tipCents;
  }
  const total = expectedTotal(session);
  if (session.itemizedTotalCents !== null && session.itemizedTotalCents !== undefined && total - session.tipCents !== session.itemizedTotalCents) {
    errors.push(`Itemized receipt ${money(session.itemizedTotalCents)} does not match calculated pre-tip amount ${money(total - session.tipCents)}`);
  }
  if (session.verifiedTotalCents !== null && session.verifiedTotalCents !== undefined && session.verifiedTotalCents !== total) {
    errors.push(`Payment receipt ${money(session.verifiedTotalCents)} does not match calculated ${money(total)}`);
  }
  if (total < 0) errors.push('Negative bill total');
  const allocatedTotal = ids.reduce((sum, id) => sum + ledgers[id].totalCents, 0);
  if (allocatedTotal !== total) errors.push(`Totals do not match (${money(allocatedTotal)} vs ${money(total)})`);
  if (!session.items.length) errors.push('Add at least one menu item');
  const settled = session.status === 'finalized' && session.settlements?.length ? session.settlements : people.map(id => ({ participantId: id, amountCents: ledgers[id].totalCents }));
  const payments = settled.map(entry => {
    const paidCents = (session.payments || []).filter(p => p.participantId === entry.participantId).reduce((sum, p) => sum + p.amountCents, 0);
    return { ...entry, paidCents, outstandingCents: entry.participantId === session.hostId ? 0 : Math.max(0, entry.amountCents - paidCents) };
  });
  return {
    errors,
    canFinalize: errors.length === 0,
    totalCents: total,
    verifiedTotalCents: session.verifiedTotalCents,
    unassignedCents: ledgers[unknown].totalCents,
    itemRows: allocationsByItem,
    people: people.map(id => ({ ...ledgers[id], name: session.participants.find(p => p.id === id)?.name || 'Unknown' })),
    payments,
    outstandingCents: payments.reduce((sum, p) => sum + p.outstandingCents, 0),
    tipVerified: Boolean(session.tipVerified)
  };
}
