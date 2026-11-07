import { listSavedAccess, createRecoveryLink, parseRecoveryLink } from './saved-access.mjs';
const $ = selector => document.querySelector(selector);
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const usd = value => '$' + (Number(value || 0) / 100).toFixed(2);
const dollars = value => (Number(value || 0) / 100).toFixed(2);
const cents = value => Math.round(Number(value || 0) * 100);
const colors = ['av0', 'av1', 'av2', 'av3', 'av4'];
const state = { session: null, actorId: null, role: null, token: '', tab: 'split', modal: null, gemini: false, draft: null, pendingFiles: [], uploadBusy: false, paymentTarget: null, editId: null, newTaxRows: null, connection: null, parseFingerprint: null, previewUrl: null, showReceiptPreview: true, importNotice: null, scanStage: 'preparing', scanFileName: '', scanTotal: 0, importError: '', receiptCompatibility: null, merchantConfirmed: false, savedSplits: [], dashboardLoading: false, dashboardNotice: '', installPrompt: null, installAvailable: false };
const root = $('#app');

function avatar(person, idx = 0) {
  return `<span class="avatar ${colors[idx % colors.length]}" title="${escape(person.name)}">${escape(person.name?.slice(0, 1).toUpperCase() || '?')}</span>`;
}

function icon(name) {
  const icons = { arrow: '↗', plus: '+', minus: '−', close: '×', check: '✓', copy: '▢', camera: '▣', sparkle: '✦', lock: '♢', receipt: '▤', people: '◉', share: '↗', dots: '•••', edit: '✎', clock: '◷', back: '←' };
  return icons[name] || name;
}

function brand() {
  return `<a class="brand" href="/" data-action="home"><span class="brand-mark">≋</span><span>SplitSnap<span style="color:var(--coral)">.</span></span></a>`;
}

function nav() {
  return `<div class="shell"><header class="navbar">${brand()}<div class="nav-right"><button type="button" class="nav-splits" data-action="home">My Splits</button><span class="top-note">Better bills, together.</span></div></header></div>`;
}

function footer() {
  return `<div class="shell"><footer class="footer"><span>SplitSnap © 2026 · Built for the messy middle of dinner.</span><span>No login. No payment processing. Just the right numbers.</span></footer></div>`;
}

function notify(message, type = 'info') {
  const el = document.createElement('div');
  el.className = `toast ${type === 'error' ? 'error' : ''}`;
  el.textContent = message;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), 4500);
}

async function api(method, endpoint, data = undefined, auth = true) {
  const response = await fetch(endpoint, {
    method,
    headers: { ...(data !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(auth && state.token ? { Authorization: `Bearer ${state.token}` } : {}) },
    body: data === undefined ? undefined : JSON.stringify(data),
    cache: 'no-store'
  });
  let payload;
  try { payload = await response.json(); } catch { throw new Error(`Server response ${response.status}`); }
  if (!response.ok) throw new Error(payload.error || `Request failed (${response.status})`);
  return payload;
}

function safeRun(fn) {
  Promise.resolve().then(fn).catch(e => notify(e.message || 'Something went wrong', 'error'));
}

function storageKey(id) { return `splitsnap.access.${id}`; }

function savedCredentials() {
  try { return listSavedAccess(window.localStorage); }
  catch { return []; }
}

function safeStoreToken(id, token) {
  try { localStorage.setItem(storageKey(id), token); }
  catch { notify('Browser storage is unavailable. Save your recovery link before closing.', 'error'); }
}

function safeRemoveToken(id) {
  try { localStorage.removeItem(storageKey(id)); } catch {}
}

function dashboardSplitCard(entry) {
  const s = entry.session;
  if (!s) return `<article class="saved-card"><div><strong>Unavailable split</strong><p>${escape(entry.message || 'Unable to reach this session')}</p></div><button type="button" class="btn secondary small" data-action="open-saved" data-id="${entry.id}">Retry</button></article>`;
  const host = entry.role === 'host';
  const due = host && s.status === 'finalized' ? s.summary.outstandingCents : null;
  const title = s.title || 'Dinner Split';
  const status = s.status === 'finalized' ? due === 0 && host ? 'Fully settled' : host && due > 0 ? 'Unpaid' : 'Finalized' : 'In progress';
  const tag = s.status === 'finalized' && due === 0 && host ? 'good' : host && due > 0 ? 'orange' : '';
  return `<article class="saved-card"><div class="saved-card-body"><div class="saved-card-title"><strong>${escape(title)}</strong><span class="tag ${tag}">${escape(status)}</span></div><div class="saved-card-meta">${s.participants.length} people · ${s.status === 'finalized' ? 'Finalized bill' : 'Live split'} · ${usd(s.summary.totalCents)} total</div>${host && due !== null ? `<div class="saved-due">${usd(due)} outstanding</div>` : ''}<div class="saved-expires">Available until ${new Date(s.expiresAt).toLocaleDateString()}</div></div><div class="saved-card-actions"><button type="button" class="btn primary small" data-action="open-saved" data-id="${entry.id}">Open split ${icon('arrow')}</button>${host ? `<button type="button" class="btn secondary small" data-action="saved-recovery" data-id="${entry.id}">Recovery link</button>` : ''}</div></article>`;
}

function recoveryPanel() {
  return `<section class="recovery-panel"><div><h2>Restore a split</h2><p>Changed phones or opened SplitSnap from your Home Screen? Paste the private Host recovery link to restore access.</p></div><form id="restore-form" class="restore-form"><label for="restore-link">Recovery link</label><input id="restore-link" name="link" type="url" inputmode="url" autocomplete="off" spellcheck="false" placeholder="https://…/s/…#access=…" required><button class="btn secondary" type="submit">Restore split</button></form><p class="recovery-warning">Keep this link private. Anyone with it can act as the Host.</p></section>`;
}

function dashboardView() {
  const entries = state.savedSplits;
  const hosted = entries.filter(x => x.role === 'host');
  const joined = entries.filter(x => x.role !== 'host');
  return `<div class="shell dashboard"><div class="dashboard-top"><div><div class="eyebrow">WELCOME BACK</div><h1>My Splits</h1><p>Continue a bill, check what is still owed, or start a new dinner.</p></div><button type="button" class="btn coral" data-action="new">＋ New split</button></div>${state.dashboardLoading ? `<div class="saved-loading" role="status">Loading your saved splits…</div>` : state.dashboardNotice ? `<div class="alert">${escape(state.dashboardNotice)}</div>` : ''}<div class="dashboard-sections"><section><div class="dashboard-section-heading"><h2>Your hosted splits</h2><span class="tag">${hosted.length}</span></div>${hosted.length ? `<div class="saved-grid">${hosted.map(dashboardSplitCard).join('')}</div>` : `<div class="empty-splits">${state.dashboardLoading ? 'Checking your saved sessions…' : 'No hosted splits found on this device.'}</div>`}</section>${joined.length ? `<section><div class="dashboard-section-heading"><h2>Joined splits</h2><span class="tag">${joined.length}</span></div><div class="saved-grid">${joined.map(dashboardSplitCard).join('')}</div></section>` : ''}</div>${recoveryPanel()}<section class="install-panel"><div><strong>Keep SplitSnap on your Home Screen</strong><p>Open it like an app. You can still access your splits in Safari, and recover access on another device with your Host link.</p></div><button class="btn secondary" data-action="install-pwa">How to install</button></section></div>`;
}

async function loadDashboard() {
  const credentials = savedCredentials().slice(0, 60);
  if (!credentials.length) { state.savedSplits = []; state.dashboardLoading = false; render(); return; }
  state.dashboardLoading = true;
  state.dashboardNotice = '';
  render();
  const results = [];
  let hadNetworkError = false;
  const queue = [...credentials];
  const worker = async () => {
    while (queue.length) {
      const item = queue.shift();
      try {
        const response = await fetch(`/api/sessions/${item.id}`, { headers: { Authorization: `Bearer ${item.token}` }, cache: 'no-store' });
        if (response.status === 401 || response.status === 404) { safeRemoveToken(item.id); continue; }
        if (!response.ok) throw new Error(`Server returned ${response.status}`);
        const data = await response.json();
        results.push({ id: item.id, token: item.token, session: data.session, role: data.role });
      } catch (error) {
        hadNetworkError = true;
        results.push({ id: item.id, token: item.token, role: 'host', message: 'Connection unavailable. Your saved access is still on this device.' });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, queue.length) }, worker));
  state.savedSplits = results.sort((a, b) => ((b.session?.expiresAt || '') > (a.session?.expiresAt || '') ? 1 : -1));
  state.dashboardLoading = false;
  if (hadNetworkError) state.dashboardNotice = 'Some sessions could not be loaded. Connect to the internet and try again.';
  if (location.pathname === '/' && !state.session) render();
}

function goHome() {
  if (state.connection) state.connection.abort();
  state.connection = null;
  state.session = null;
  state.token = '';
  state.modal = null;
  state.publicInfo = null;
  history.pushState(null, '', '/');
  safeRun(loadDashboard);
}

function goNew() {
  if (state.connection) state.connection.abort();
  state.connection = null;
  state.session = null;
  state.token = '';
  state.modal = null;
  history.pushState(null, '', '/new');
  render();
}

function homeView() {
  return `<div class="shell"><section class="hero"><div><div class="eyebrow">Dinner is better without the math</div><h1>Good food.<br>Fair <em>splits.</em><br>Zero fuss.</h1><p>Snap your receipt, invite your people, and claim what you ate together. Every tax, shared dish and tip adds up beautifully.</p><div class="hero-ctas"><button class="btn coral" data-action="new">Start splitting ${icon('arrow')}</button><button class="btn secondary" data-action="demo">Try with a real receipt ${icon('arrow')}</button></div><div class="hero-sub"><span>No account needed</span><span>Works on any phone</span><span>Live collaboration</span></div></div><div class="illustration"><div class="demo-receipt"><div class="r-title">DINNER TOGETHER</div><div class="r-muted">YOUR TABLE · 4 FRIENDS</div><div class="r-line"><span>2 × Smash Burger</span><span>$32.00</span></div><div class="r-line"><span>1 × Loaded Fries</span><span>$13.00</span></div><div class="r-line"><span>3 × Draft Beer</span><span>$24.00</span></div><div class="r-line"><span>1 × Chocolate Cake</span><span>$11.00</span></div><div class="r-rule"></div><div class="r-line"><span>Taxes & tip</span><span>$18.72</span></div><div class="r-rule"></div><div class="r-bottom"><span>TOTAL</span><span>$98.72</span></div><div style="text-align:center;font-size:11px;color:#9baa9c;margin-top:25px;letter-spacing:.13em">✦ SPLIT FAIRLY ✦</div></div><div class="floating float-a">✦ AI read your receipt</div><div class="floating float-b"><div class="avatars">${[0, 1, 2].map(i => `<span class="avatar ${colors[i]}">${'AJC'[i]}</span>`).join('')}</div><span>Everyone's in!</span></div></div></section><section class="feature-grid"><div class="feature"><div class="eyebrow">01</div><strong>One receipt. All your friends.</strong><p>Even if your payment receipt and itemized bill are separate.</p></div><div class="feature"><div class="eyebrow">02</div><strong>Every drink is accounted for.</strong><p>30 beers? One tidy row. Different beers? Separate rows.</p></div><div class="feature"><div class="eyebrow">03</div><strong>Pay later? No problem.</strong><p>Finalize the split now, track who's paid as money arrives.</p></div></section><div class="home-install">${recoveryPanel()}<section class="install-panel"><div><strong>Install SplitSnap</strong><p>Save SplitSnap to your Home Screen for quick access to future dinners.</p></div><button type="button" class="btn secondary" data-action="install-pwa">How to install</button></section></div></div>`;
}

function createView() {
  return `<div class="shell"><section class="create"><div class="eyebrow">SET UP YOUR TABLE</div><h1>Let's split something good.</h1><p>Give your session a name. You'll be the Host, which means you control the receipt and finalize the bill.</p><div class="panel pad"><form id="create-form"><div class="field"><label for="title">What's the occasion?</label><input id="title" name="title" maxlength="80" placeholder="Friday dinner" value="Friday Dinner" required></div><div class="field"><label for="hostName">Your nickname</label><input id="hostName" name="hostName" maxlength="40" placeholder="Alex" required autocomplete="nickname"></div><button class="btn coral" style="width:100%" type="submit">Create my split ${icon('arrow')}</button></form></div><p style="font-size:12px;text-align:center;margin-top:17px">Just testing? <a href="#" data-action="demo" style="color:var(--coral);font-weight:800">Open the BierCraft demo</a></p></section></div>`;
}

function joinView(publicInfo) {
  const name = publicInfo?.title || 'Dinner Split';
  return `<div class="shell"><section class="create"><div class="eyebrow">YOU'RE INVITED</div><h1>Grab a seat.</h1><p>Someone invited you to <strong>${escape(name)}</strong>. Choose a nickname, then tap what you ate to split the bill with your friends.</p><div class="panel pad"><form id="join-form"><div class="field"><label for="nickname">Your nickname</label><input id="nickname" name="nickname" maxlength="40" placeholder="Your name" required autocomplete="nickname" autofocus></div><button class="btn coral" style="width:100%" type="submit">Join this split ${icon('arrow')}</button></form></div><p style="font-size:12px;text-align:center;margin-top:17px">Same device as before? Your access is saved automatically in this browser.</p></section></div>`;
}

function statusTag(s) {
  return s.status === 'finalized' ? '<span class="tag good">✓ Finalized</span>' : '<span class="tag"><span class="dot"></span> Live split</span>';
}

function participantPills(s) {
  return `<div class="participants">${s.participants.map((p, i) => `<div class="participant-pill">${avatar(p, i)}${escape(p.name)}${p.id === state.actorId ? `<span class="muted tinytext">(you)</span>` : ''}${p.role === 'host' ? ' <span class="tinytext muted">✦</span>' : ''}</div>`).join('')}</div>`;
}

function photoPicker(compact = false) {
  if (!state.gemini) return `<span class="photo-picker-unavailable">Gemini is not configured. Add a menu item manually.</span>`;
  return `<div class="native-upload-control ${compact ? 'compact' : ''}"><input class="receipt-file-input" type="file" accept="image/*,.heic,.heif" multiple aria-label="Upload receipt photos from your photo library" title="Choose receipt photos"><span class="native-upload-hint">${compact ? 'Select photos' : 'Choose photos from your library or files'}</span></div>`;
}

function mobileShareBar(s) {
  if (state.tab !== 'split' || s.status !== 'active') return '';
  const mine = s.summary.people.find(p => p.id === state.actorId);
  const total = s.items.reduce((n, item) => n + item.quantity, 0);
  const taken = s.items.reduce((n, item) => n + assigned(item), 0);
  return `<div class="mobile-share-bar"><div><span>YOUR SHARE</span><strong>${usd(mine?.totalCents || 0)}</strong></div><div class="mobile-share-bar-right"><span>${taken}/${total} portions assigned</span><button class="btn secondary tiny" type="button" data-action="summary-scroll">See totals ↑</button></div></div>`;
}

function sessionView(s) {
  const isHost = state.role === 'host';
  return `<div class="shell workspace"><div class="breadcrumb"><button type="button" class="breadcrumb-link" data-action="home">MY SPLITS</button><span>›</span><strong>${escape(s.title)}</strong></div><div class="workspace-head"><div><div class="row" style="justify-content:flex-start;margin-bottom:8px;gap:9px">${statusTag(s)}<span class="top-note">${s.participants.length} people</span></div><h1>${escape(s.title)}</h1><p>${s.status === 'finalized' ? 'Dinner is done. Track payments here, no need to reopen the bill.' : 'Your shared receipt updates as everyone selects their items.'}</p></div><div class="head-actions">${isHost ? `<button class="btn secondary small" data-action="recovery">${icon('lock')} Save Host recovery link</button>` : ''}</div></div>${s.receipts.some(r => r.kind === 'demo') ? '<div class="demo-banner"><span>✦ Demo loaded from an example BierCraft bill. Try this session with another browser or phone to test collaboration.</span><span class="tag good">DEMO</span></div>' : ''}${s.status === 'active' ? `<section class="invite-strip"><div class="invite-strip-copy"><strong>${s.participants.length} ${s.participants.length === 1 ? 'person' : 'people'} in this split</strong><span>${s.participants.length === 1 ? 'Your friends can join with one link, no account needed.' : 'Everyone can select their own food from their phone.'}</span></div><button class="btn coral" data-action="invite">＋ Invite friends</button></section>` : ''}${participantPills(s)}<div class="workspace-nav" role="navigation" aria-label="Split workspace"><button class="workspace-nav-btn ${state.tab === 'split' ? 'is-active' : ''}" data-action="tab" data-tab="split" aria-current="${state.tab === 'split' ? 'page' : 'false'}">Split the bill</button><button class="workspace-nav-btn ${state.tab === 'receipt' ? 'is-active' : ''}" data-action="tab" data-tab="receipt" aria-current="${state.tab === 'receipt' ? 'page' : 'false'}">Receipt details</button><button class="workspace-nav-btn ${state.tab === 'payments' ? 'is-active' : ''}" data-action="tab" data-tab="payments" aria-current="${state.tab === 'payments' ? 'page' : 'false'}">${s.status === 'finalized' ? 'Track payments' : 'Payments later'}</button></div>${state.tab === 'split' ? splitView(s) : state.tab === 'receipt' ? receiptView(s) : paymentsView(s)}${mobileShareBar(s)}<p class="small-note" style="margin-top:28px">This room expires ${new Date(s.expiresAt).toLocaleDateString()}. Pending bills renew when the Host makes changes. Payment statuses are manual, not bank verified.</p>${isHost ? `<button class="btn warn tiny" style="margin-top:10px" data-action="delete-session">Delete this session</button>` : ''}</div>`;
}

function currentPerson(id) { return state.session?.participants.find(p => p.id === id); }
function totalSolo(item, participantId) { return item.groups.filter(g => g.members.length === 1 && g.members[0] === participantId).reduce((sum, g) => sum + g.quantity, 0); }
function assigned(item) { return item.groups.reduce((n, g) => n + g.quantity, 0); }
function editable(personId) { return state.session.status === 'active' && (state.role === 'host' || state.actorId === personId); }

function itemCard(item, s) {
  const a = assigned(item);
  const available = item.quantity - a;
  const unitCost = item.amountCents / item.quantity;
  const mine = totalSolo(item, state.actorId);
  const status = a === item.quantity ? '<span class="tag good">Assigned</span>' : `<span class="tag orange">${available} left</span>`;
    if (item.quantity === 1) {
    const group = item.groups[0];
    return `<article class="receipt-item"><div class="item-head"><div><div class="item-name">${escape(item.name)}</div><div class="item-meta">1 item · ${escape(item.taxCategory)}${item.discountCents ? ` · ${usd(item.discountCents)} discount` : ''}</div></div><div style="text-align:right"><div class="item-price number">${usd(item.amountCents - item.discountCents)}</div><div style="margin-top:5px">${status}</div></div></div><div class="memberchips">${s.participants.map((p, i) => {
      const selected = Boolean(group?.members.includes(p.id));
      return `<button type="button" class="chip ${selected ? 'active' : ''} ${editable(p.id) ? 'enabled' : ''}" data-action="toggle-claim" data-id="${item.id}" data-target="${p.id}" ${editable(p.id) ? '' : 'disabled'}>${selected ? '✓ ' : '+ '}${escape(p.name)}</button>`;
    }).join('')}</div><div class="item-meta" style="margin-top:10px">${group ? `${group.members.length} ${group.members.length === 1 ? 'person' : 'people'} splitting this equally · ${usd(Math.round((item.amountCents-item.discountCents)/group.members.length))} each before tax & tip` : 'No one has selected this item yet'}</div></article>`;
  }
  return `<article class="receipt-item"><div class="item-head"><div><div class="item-name">${escape(item.name)}</div><div class="item-meta">${item.quantity} ordered · ${usd(Math.round(unitCost))} per unit · ${escape(item.taxCategory)}${item.discountCents ? ` · ${usd(item.discountCents)} discount` : ''}</div></div><div style="text-align:right"><div class="item-price number">${usd(item.amountCents-item.discountCents)}</div><div style="margin-top:5px">${status}</div></div></div><div style="margin-top:15px">${s.participants.map((p, i) => `<div class="allocation-row"><div class="person-label">${avatar(p, i)}<span><strong>${escape(p.name)}${p.id === state.actorId ? ' <span class="muted">(you)</span>' : ''}</strong><small>${totalSolo(item, p.id)} individual unit${totalSolo(item, p.id) === 1 ? '' : 's'}</small></span></div><div class="counter"><button class="btn iconbtn" aria-label="Remove one from ${escape(p.name)}" data-action="claim-minus" data-id="${item.id}" data-target="${p.id}" ${!editable(p.id) || !totalSolo(item, p.id) ? 'disabled' : ''}>−</button><strong>${totalSolo(item, p.id)}</strong><button class="btn iconbtn" aria-label="Add one for ${escape(p.name)}" data-action="claim-plus" data-id="${item.id}" data-target="${p.id}" ${!editable(p.id) || !available ? 'disabled' : ''}>+</button></div></div>`).join('')}</div><div style="margin-top:13px">${item.groups.filter(g => g.shared).map((g, i) => `<div class="sharebox"><div class="row"><strong class="smalltext">Shared item ${i + 1} · 1 of ${item.quantity}</strong><span class="tinytext muted">${g.members.length} ${g.members.length === 1 ? 'person' : 'people'} sharing</span></div><p class="share-help">Tap the people who shared this item. Its price is split equally between them.</p><div class="memberchips" style="margin-top:3px">${s.participants.map(p => {
    const selected = g.members.includes(p.id);
    return `<button class="chip ${selected ? 'active' : ''} ${editable(p.id) ? 'enabled' : ''}" data-action="${selected ? 'leave-share' : 'join-share'}" data-id="${item.id}" data-group="${g.id}" data-target="${p.id}" ${editable(p.id) ? '' : 'disabled'}>${selected ? '✓ ' : '+ '}${escape(p.name)}</button>`;
  }).join('')}</div></div>`).join('')}</div>${s.status === 'active' ? `<div class="share-action"><button class="btn ghost small" data-action="make-share" data-id="${item.id}" ${!mine && !available ? 'disabled' : ''}>${mine ? 'Split one of your items with friends' : 'Split one unclaimed item with friends'}</button><span class="share-hint">One ordered item becomes a shared item. Everyone selected splits its cost equally.</span></div>` : ''}</article>`;
}

function summarySide(s) {
  const summary = s.summary;
  const me = summary.people.find(p => p.id === state.actorId);
  const units = s.items.reduce((n, x) => n + x.quantity, 0);
  const allocatedUnits = s.items.reduce((n, x) => n + assigned(x), 0);
  const pct = units ? Math.round(100 * allocatedUnits / units) : 0;
  return `<div class="side-stack" id="share-summary"><section class="panel pad"><div class="section-heading"><h2>Your share</h2><span class="tag gray">CAD</span></div><div class="big-number">${usd(me?.totalCents || 0)}</div><p class="muted smalltext" style="margin-top:8px">Including your share of taxes and tip</p><div class="subtleline"></div><div class="summary-row"><span>Food & drinks</span><strong>${usd(me?.foodCents || 0)}</strong></div><div class="summary-row"><span>Taxes</span><strong>${usd(me?.taxCents || 0)}</strong></div><div class="summary-row"><span>Tip</span><strong>${usd(me?.tipCents || 0)}</strong></div><div class="subtleline"></div><div class="stats"><strong class="smalltext">Items assigned</strong><strong class="number smalltext">${allocatedUnits} / ${units}</strong></div><div class="progress"><span style="width:${pct}%"></span></div>${!s.tipVerified && s.tipCents === 0 ? '<p class="small-note" style="margin-bottom:0">Tip has not been verified. Current total excludes any unconfirmed tip.</p>' : ''}</section><section class="panel pad"><div class="section-heading"><h2>Group total</h2><span class="tag gray">${s.participants.length} people</span></div><div class="big-number">${usd(summary.totalCents)}</div><p class="smalltext muted" style="margin-top:9px">Calculated from items, discounts, tax and tip.</p>${summary.errors.length ? `<div class="alert" style="margin:15px 0"><strong>Needs attention</strong><div style="margin-top:5px">${summary.errors.slice(0, 5).map(escape).join('<br>')}${summary.errors.length > 5 ? `<br>+${summary.errors.length - 5} more` : ''}</div></div>` : '<div class="alert good" style="margin:15px 0">✓ Everything is allocated and amounts reconcile.</div>'}${state.role === 'host' && s.status === 'active' ? `<button class="btn primary" style="width:100%;margin-top:6px" data-action="finalize" ${!summary.canFinalize ? 'disabled' : ''}>Finalize the split →</button>` : ''}${state.role === 'host' && s.status === 'finalized' ? '<button class="btn secondary" style="width:100%" data-action="reopen">Reopen this bill</button>' : ''}${s.status === 'finalized' ? '<p class="small-note">Finalized amounts are locked. Payments are tracked separately.</p>' : ''}</section></div>`;
}

function splitView(s) {
  const hostActive = state.role === 'host' && s.status === 'active';
  const receiptCount = s.receipts.filter(r => r.kind !== 'demo').length;
  const assignedUnits = s.items.reduce((n, item) => n + assigned(item), 0);
  const totalUnits = s.items.reduce((n, item) => n + item.quantity, 0);
  const receiptReady = s.items.length > 0;
  const imported = state.importNotice ? `<div class="import-success" role="status"><div><strong>${escape(state.importNotice)}</strong><span>Your items are below. Select what you ate, then invite friends.</span></div><button type="button" class="btn secondary small" data-action="dismiss-import">Got it</button></div>` : '';
  const receiptSetup = `<section class="panel receipt-workflow-card"><div class="receipt-workflow-info"><span class="workflow-label">YOUR RECEIPT</span><strong>${receiptReady ? `${s.items.length} menu items · ${usd(s.summary.totalCents)} total` : 'Start by adding your receipt'}</strong><span>${receiptReady ? `${assignedUnits}/${totalUnits} portions assigned${receiptCount ? ` · ${receiptCount} photo${receiptCount === 1 ? '' : 's'} scanned` : ''}` : 'Upload your bill, review it, then choose your food below.'}</span></div><div class="receipt-workflow-actions">${hostActive ? photoPicker(true) : ''}<button type="button" class="btn secondary small" data-action="tab" data-tab="receipt">${hostActive ? 'Review / edit receipt' : 'View receipt'}</button>${hostActive && !state.gemini ? '<button type="button" class="btn secondary small" data-action="add-item">Add item manually</button>' : ''}</div></section>`;
  return `${imported}${receiptSetup}<div class="grid-layout split-main-grid"><div class="panel pad"><div class="section-heading"><div><h2>Who had what?</h2><p class="muted smalltext" style="margin:7px 0 0">Pick your dishes. Share any dish with friends, or choose the number of drinks you had.</p></div>${hostActive ? '<button class="btn secondary small" data-action="add-item">＋ Add item</button>' : ''}</div>${!s.items.length ? `<div class="empty"><div class="symbol">▤</div><h2>Your receipt is waiting</h2><p>${state.role === 'host' ? 'Select receipt photos above or add a menu item manually.' : 'Waiting for the Host to upload the receipt.'}</p>${hostActive ? '<button class="btn secondary" data-action="add-item">Enter an item manually</button>' : ''}</div>` : s.items.map(item => itemCard(item, s)).join('')}${s.status === 'finalized' ? '<div class="alert good" style="margin-top:16px">✓ This bill is finalized. Menu selections are locked; payment records are separate.</div>' : ''}</div>${summarySide(s)}</div>`;
}

function receiptView(s) {
  const hostEdit = state.role === 'host' && s.status === 'active';
  const itemSubtotal = s.items.reduce((n, item) => n + item.amountCents - item.discountCents, 0);
  const taxTotal = s.taxes.reduce((n, tax) => n + tax.amountCents, 0);
  return `<div class="receipt-back"><button type="button" class="btn primary" data-action="go-split">← Back to splitting your bill</button><span class="muted smalltext">Edit receipt information here. Your friends split items on the main screen.</span></div><div class="grid-layout"><div class="panel pad"><div class="section-heading"><div><h2>Receipt details</h2><p class="muted smalltext" style="margin:7px 0 0">Every menu item, every adjustment. Editable by the Host.</p></div>${hostEdit ? photoPicker(true) : ''}</div>${s.receipts.length ? `<div style="margin-bottom:18px">${s.receipts.map(r => `<div class="receipt-row"><div><strong class="smalltext">${escape(r.merchant || 'Receipt')}</strong><small>${escape(r.summary)}</small></div><span class="tag good">${escape(r.kind)}</span></div>`).join('')}</div>` : '<div class="alert" style="margin-bottom:17px">No photos yet. You can still enter every amount manually.</div>'}<div class="section-heading" style="margin-top:22px"><h2>Menu items (${s.items.length})</h2>${hostEdit ? '<button class="btn secondary tiny" data-action="add-item">＋ New</button>' : ''}</div>${s.items.length ? s.items.map(item => `<div class="receipt-row"><div><strong class="smalltext">${escape(item.name)}</strong><small>${item.quantity} × ${usd(Math.round(item.amountCents/item.quantity))} · ${escape(item.taxCategory)}${item.discountCents ? ` · discount ${usd(item.discountCents)}` : ''}</small></div><div class="row"><strong class="smalltext number">${usd(item.amountCents - item.discountCents)}</strong>${hostEdit ? `<button class="btn secondary tiny" data-action="edit-item" data-id="${item.id}">Edit</button>` : ''}</div></div>`).join('') : '<p class="smalltext muted">No items yet.</p>'}<div class="subtleline"></div><div class="section-heading"><h2>Charges</h2>${hostEdit ? '<button class="btn secondary tiny" data-action="edit-charges">Edit</button>' : ''}</div><div class="summary-row"><span>Items after line discounts</span><strong>${usd(itemSubtotal)}</strong></div>${s.orderDiscountCents ? `<div class="summary-row"><span>Order discount</span><strong>−${usd(s.orderDiscountCents)}</strong></div>` : ''}${s.taxes.map(t => `<div class="summary-row"><span>${escape(t.label)} <small class="muted">(${escape(t.category)})</small></span><strong>${usd(t.amountCents)}</strong></div>`).join('')}<div class="summary-row"><span>Tip ${s.tipVerified ? '<span class="tag good">Verified</span>' : '<span class="tag orange">Unverified</span>'}</span><strong>${usd(s.tipCents)}</strong></div><div class="summary-row total"><span>Calculated total</span><span>${usd(s.summary.totalCents)}</span></div>${s.itemizedTotalCents !== null ? `<div class="summary-row"><span>Printed itemized total</span><strong>${usd(s.itemizedTotalCents)}</strong></div>` : ''}${s.verifiedTotalCents !== null ? `<div class="summary-row"><span>Payment receipt total</span><strong>${usd(s.verifiedTotalCents)}</strong></div>` : '<p class="small-note">No payment receipt has confirmed the final paid total.</p>'}</div><div class="side-stack"><section class="panel pad"><h2 style="margin-bottom:13px">The AI is a starting point</h2><p class="muted smalltext" style="line-height:1.65">Gemini extracts the items. You review the details. SplitSnap computes final amounts using exact cents.</p><div class="alert good">Original receipt photos are not stored. The imported menu and charge data are kept until the session expires.</div>${hostEdit ? `<div class="receipt-side-upload">${photoPicker()}<button class="btn secondary" style="margin-top:9px;width:100%" data-action="add-item">Enter item manually</button></div>` : ''}</section></div></div>`;
}

function paymentStatus(payment) {
  if (!payment || payment.paidCents <= 0) return { label: 'Unpaid', style: 'unpaid' };
  if (payment.outstandingCents > 0) return { label: 'Partially paid', style: 'partial' };
  return { label: 'Paid', style: 'paid' };
}

function paymentsView(s) {
  if (s.status !== 'finalized') return `<div class="panel pad empty"><div class="symbol">◷</div><h2>First, finish the split.</h2><p>Once the Host finalizes everyone's amount, this becomes your payment tracker.</p><button class="btn secondary" data-action="tab" data-tab="split">Back to splitting</button></div>`;
  const isHostViewer = state.role === 'host';
  const owedByPerson = s.summary.people;
  const payments = s.summary.payments;
  const mine = payments.find(p => p.participantId === state.actorId);
  const owedByOthers = owedByPerson.filter(p => p.id !== s.hostId).reduce((sum, p) => sum + p.totalCents, 0);
  const received = isHostViewer ? payments.filter(p => p.participantId !== s.hostId).reduce((sum, p) => sum + p.paidCents, 0) : 0;
  const remaining = owedByOthers - received;
  const header = isHostViewer ? `<div class="section-heading"><div><h2>Payment tracking</h2><p class="muted smalltext" style="margin:7px 0 0">Only you, the Host, can see who has paid.</p></div><span class="tag ${remaining ? 'orange' : 'good'}">${remaining ? 'Payments outstanding' : 'All settled'}</span></div>` : `<div class="section-heading"><div><h2>Your payment & group bill</h2><p class="muted smalltext" style="margin:7px 0 0">Everyone's bill amounts are visible. Other people's payment activity is private.</p></div></div>`;
  const mineStatus = paymentStatus(mine);
  const myStatusCard = !isHostViewer ? `<div class="my-payment-card"><div class="row"><strong>Your payment</strong><span class="payment-status ${mineStatus.style}">${mineStatus.label}</span></div><div class="payment-card-amount">${usd(mine?.amountCents || 0)}</div><div class="smalltext muted">${mineStatus.label === 'Paid' ? 'The Host recorded your full payment.' : `${usd(mine?.paidCents || 0)} recorded by the Host · ${usd(mine?.outstandingCents || 0)} remaining`}</div><p class="small-note">Payment status is entered manually by the Host, not verified with a bank.</p></div>` : '';
  const rows = owedByPerson.map((person, i) => {
    const personId = person.id;
    const isBillHost = personId === s.hostId;
    const p = isHostViewer ? payments.find(x => x.participantId === personId) : null;
    const events = isHostViewer ? s.payments.filter(x => x.participantId === personId) : [];
    const status = isHostViewer && !isBillHost ? paymentStatus(p) : null;
    const displayName = `${escape(person.name)}${isBillHost ? ' <span class="tinytext muted">(Host)</span>' : ''}${personId === state.actorId ? ' <span class="tinytext muted">(you)</span>' : ''}`;
    const note = isBillHost ? 'Host paid the restaurant bill' : isHostViewer ? `${usd(p?.paidCents || 0)} received · ${usd(p?.outstandingCents || 0)} remaining` : personId === state.actorId ? 'Your bill amount' : 'Bill amount only';
    const buttons = isHostViewer && !isBillHost && (p?.outstandingCents || 0) > 0 ? `<button type="button" class="btn primary tiny" data-action="record-payment" data-id="${personId}" aria-expanded="${state.paymentTarget === personId}">${state.paymentTarget === personId ? 'Cancel entry' : '+ Record payment'}</button>` : '';
    const undo = isHostViewer && events.length ? `<button class="btn tiny secondary" style="margin-top:7px" data-action="undo-payment" data-id="${events[events.length-1].id}">Undo last ${usd(events[events.length-1].amountCents)}</button>` : '';
    const entry = isHostViewer && !isBillHost && state.paymentTarget === personId && p?.outstandingCents > 0 ? `<form id="payment-form" class="inline-payment-form" data-participant-id="${personId}"><label for="payment-amount">Amount received from ${escape(person.name)} (CAD)</label><div class="payment-entry-row"><input id="payment-amount" name="amount" type="number" inputmode="decimal" min="0.01" max="${dollars(p.outstandingCents)}" step="0.01" value="${dollars(p.outstandingCents)}" required><button class="btn primary" type="submit">Save payment</button></div><p class="small-note">Partial payments are supported. Record only money you actually received.</p></form>` : '';
    return `<div class="list-person"><div class="person-label">${avatar({ name: person.name }, i)}<div><strong>${displayName}</strong><small>${note}</small>${undo}</div></div><div class="payment-row-right"><div class="item-price number">${usd(person.totalCents)}</div>${status ? `<span class="payment-status ${status.style}">${status.label}</span>` : ''}${buttons}</div>${entry}</div>`;
  }).join('');
  const overview = isHostViewer ? `<div class="panel pad"><h2>Settlement overview</h2><p class="muted smalltext">Only you can see these payment totals.</p><div class="payment-amounts"><div><span class="tinytext muted">RECEIVED</span><div class="big-number paid">${usd(received)}</div></div><div style="text-align:right"><span class="tinytext muted">OUTSTANDING</span><div class="big-number outstanding">${usd(remaining)}</div></div></div><div class="progress"><span style="width:${owedByOthers ? 100 * received / owedByOthers : 100}%"></span></div><div class="subtleline"></div><div class="summary-row"><span>Total restaurant bill</span><strong>${usd(s.summary.totalCents)}</strong></div><div class="summary-row"><span>Host's own portion</span><strong>${usd(owedByPerson.find(p => p.id === s.hostId)?.totalCents || 0)}</strong></div><div class="summary-row"><span>Others owe</span><strong>${usd(owedByOthers)}</strong></div><p class="small-note">Only the Host can record payments. SplitSnap never initiates transfers or verifies deposits.</p></div>` : `<div class="panel pad"><h2>Group bill</h2><p class="muted smalltext">These amounts show what everyone owes, not whether anyone has paid.</p><div class="big-number">${usd(s.summary.totalCents)}</div><div class="subtleline"></div><div class="summary-row"><span>Your portion</span><strong>${usd(owedByPerson.find(p => p.id === state.actorId)?.totalCents || 0)}</strong></div><div class="summary-row"><span>Other people's payments</span><strong>Private</strong></div></div>`;
  return `<div class="grid-layout"><div class="panel pad">${header}${myStatusCard}<div class="payment-list">${rows}</div><div class="subtleline"></div><button class="btn secondary" data-action="copy-summary">▢ Copy bill amounts</button></div><div class="side-stack">${overview}</div></div>`;
}

function modalLayout(title, content, wide = false, variant = '') {
  return `<div class="overlay" data-action="overlay"><div class="modal ${wide ? 'wide' : ''} ${variant}" role="dialog" aria-modal="true" aria-label="${title}"><div class="modal-head"><h2>${title}</h2><button class="btn secondary iconbtn" data-action="close" aria-label="Close" ${state.uploadBusy && variant === 'receipt-upload-modal' ? 'disabled' : ''}>×</button></div>${content}</div></div>`;
}

function renderModal() {
  if (!state.modal) return '';
  const s = state.session;
  if (state.modal === 'upload') {
    const loading = state.uploadBusy;
    const stageLabels = { preparing: 'Preparing your photo', reading: 'Reading your receipt', checking: 'Checking restaurant and totals' };
    const counter = state.scanTotal > 1 ? `<span class="scan-counter">Photo ${state.scanTotal - state.pendingFiles.length} of ${state.scanTotal}</span>` : '';
    const progress = `<div class="scan-processing" role="status" aria-live="polite"><div class="scan-art" aria-hidden="true"><div class="scan-paper"><div class="scan-line short"></div><div class="scan-line"></div><div class="scan-line"></div><div class="scan-line short"></div><div class="scan-line"></div><div class="scan-total"></div></div><div class="scan-beam"></div><div class="scan-glow"></div></div><div class="scan-active"><span class="scan-live-dot"></span> AI is processing your image</div><h3>${stageLabels[state.scanStage] || stageLabels.reading}</h3><p>Keep this page open while Gemini analyzes the photo.</p><span class="scan-file">${escape(state.scanFileName)}</span>${counter}<div class="scan-steps" aria-label="Processing steps"><span class="${state.scanStage === 'preparing' ? 'current' : 'complete'}">1. Prepare</span><span class="${state.scanStage === 'reading' ? 'current' : state.scanStage === 'checking' ? 'complete' : ''}">2. Read</span><span class="${state.scanStage === 'checking' ? 'current' : ''}">3. Check</span></div><div class="scan-dots" aria-hidden="true"><i></i><i></i><i></i></div></div>`;
    return modalLayout(loading ? 'Reading your receipt' : 'Add receipt photos', `<p class="upload-description">Upload the itemized bill and any payment slip from the same restaurant. Different restaurants need separate splits.</p>${loading ? progress : `<div class="upload-native-area"><div class="upload-symbol">▣</div><strong>Choose photos from your device</strong>${photoPicker()}<span class="upload-formats">JPG, PNG, WebP or HEIC · Maximum 15 MB each</span></div><div class="upload-status ${state.gemini ? 'is-ready' : 'is-unavailable'}">${state.gemini ? 'Gemini is ready to read photos.' : 'Gemini API key not configured.'}</div>`}<p class="upload-privacy">Photos are processed for the scan and not stored by SplitSnap.</p><div class="modal-actions upload-actions">${loading ? '<button class="btn secondary" type="button" disabled>Processing photo…</button>' : '<button class="btn secondary" data-action="close">Cancel</button><button class="btn primary" data-action="add-item">Enter manually</button>'}</div>`, false, 'receipt-upload-modal');
  }
  if (state.modal === 'receipt-draft') {
    const d = state.draft;
    if (!d) return '';
    const sum = d.items.reduce((n, item) => n + item.amountCents - item.discountCents, 0) - d.orderDiscountCents + d.taxes.reduce((n, t) => n + t.amountCents, 0) + (d.tipCents || 0);
    const currentPretip = s.summary.totalCents - s.tipCents;
    const match = d.kind === 'payment' && d.preTipTotalCents !== null ? d.preTipTotalCents === currentPretip : null;
    const compatibility = state.receiptCompatibility || { status: 'ready', message: '' };
    const merchantAlert = compatibility.status === 'blocked' ? `<div class="receipt-restaurant-alert error" role="alert"><strong>Different restaurant detected</strong><p>${escape(compatibility.message)}</p><button type="button" class="btn secondary" data-action="new-split-for-receipt">Start a separate split</button></div>` : compatibility.status === 'review' ? `<div class="receipt-restaurant-alert" role="alert"><strong>Restaurant confirmation needed</strong><p>${escape(compatibility.message)}</p><label class="receipt-merchant-checkbox"><input type="checkbox" id="confirm-merchant" ${state.merchantConfirmed ? 'checked' : ''}> I confirm this is the same restaurant</label></div>` : '';
    const importError = state.importError ? `<div class="receipt-restaurant-alert error" role="alert">${escape(state.importError)}</div>` : '';
    const details = `<div class="receipt-review-details"><div class="row"><span class="tag">${escape(d.kind)}</span></div><div class="field receipt-merchant-field"><label for="receipt-merchant">Restaurant on this receipt</label><input id="receipt-merchant" type="text" maxlength="120" value="${escape(d.merchant)}" placeholder="Restaurant name"><button type="button" class="btn secondary tiny" data-action="recheck-merchant">Check restaurant</button></div>${merchantAlert}${importError}<p>Compare these values with your receipt before importing. You can edit amounts later in Receipt & charges.</p>${match !== null ? `<div class="alert ${match ? 'good' : 'error'}">${match ? '✓ Payment receipt matches your current pre-tip total.' : `Payment receipt pre-tip ${usd(d.preTipTotalCents)} differs from current pre-tip ${usd(currentPretip)}. Confirm carefully.`}</div>` : ''}<div class="mini-summary receipt-extraction-list">${d.items.map(i => `<div class="row"><span>${escape(i.name)} <span class="muted">×${i.quantity}</span></span><strong>${usd(i.amountCents-i.discountCents)}</strong></div>`).join('')}${d.taxes.map(t => `<div class="row"><span>${escape(t.label)} <small>(${escape(t.category)})</small></span><strong>${usd(t.amountCents)}</strong></div>`).join('')}${d.orderDiscountCents ? `<div class="row"><span>Order discount</span><strong>−${usd(d.orderDiscountCents)}</strong></div>` : ''}${d.tipCents !== null ? `<div class="row"><span>Paid tip</span><strong>${usd(d.tipCents)}</strong></div>` : ''}${d.finalTotalCents !== null ? `<div class="row"><strong>Printed total</strong><strong>${usd(d.finalTotalCents)}</strong></div>` : ''}</div>${d.kind === 'itemized' && d.preTipTotalCents !== null && d.preTipTotalCents !== sum ? `<div class="alert">Extracted line items add up to ${usd(sum)}, but the printed pre-tip total is ${usd(d.preTipTotalCents)}. Edit the values after importing.</div>` : ''}${d.uncertain.length || d.notes.length ? `<div class="alert">${[...d.uncertain, ...d.notes].map(escape).join('<br>')}</div>` : ''}</div>`;
    const photo = state.showReceiptPreview && state.previewUrl ? `<div class="receipt-preview-column"><div class="receipt-preview"><img src="${escape(state.previewUrl)}" alt="Original uploaded receipt for comparison"></div><a class="receipt-open-original" href="${escape(state.previewUrl)}" target="_blank" rel="noopener noreferrer">Open full photo ↗</a></div>` : '';
    return modalLayout('Review AI extraction', `<div class="receipt-preview-toolbar"><span class="smalltext muted">Check the original photo against the extracted amounts</span><button type="button" class="btn secondary tiny" data-action="toggle-receipt-preview" aria-pressed="${state.showReceiptPreview}">${state.showReceiptPreview ? 'Hide original photo' : 'Show original photo'}</button></div><div class="receipt-review-layout ${photo ? 'with-photo' : ''}">${photo}${details}</div><div class="modal-actions"><button class="btn secondary" data-action="skip-receipt">Skip receipt</button><button class="btn primary" data-action="import-receipt" ${d.kind === 'unknown' || compatibility.status === 'blocked' || (compatibility.status === 'review' && !state.merchantConfirmed) ? 'disabled' : ''}>Confirm & import</button></div>`, true, 'receipt-review-modal');
  }
  if (state.modal === 'save-recovery') {
    if (state.role !== 'host' || !state.session) return '';
    const link = createRecoveryLink(location.origin, state.session.id, state.token);
    return modalLayout('Save your Host recovery link', `<div class="recovery-important"><strong>Keep access to this split</strong><p>Your splits appear in My Splits on this browser. To recover them on a new phone, in a Home Screen app, or after clearing website data, keep this private link.</p></div><div class="field"><label for="host-recovery-link">PRIVATE HOST LINK</label><input id="host-recovery-link" class="recovery-url" type="text" readonly value="${escape(link)}" autocomplete="off"></div><div class="alert">Anyone with this link can control the split and record payments. Never send it as a friend invitation.</div><div class="modal-actions"><button type="button" class="btn secondary" data-action="close">Done</button><button type="button" class="btn primary" data-action="copy-recovery">Copy private link</button></div>`);
  }
  if (state.modal === 'install') {
    const ios = /iPad|iPhone|iPod/.test(navigator.userAgent);
    const standalone = window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone === true;
    const instructions = standalone ? 'SplitSnap is already open as a Home Screen app.' : ios ? 'In Safari, tap Share, then choose Add to Home Screen and confirm Add. If the option is missing, open the website in Safari first.' : 'Open your browser menu and choose Install app or Add to Home screen. In supported browsers, you can install directly below.';
    return modalLayout('Install SplitSnap', `<p>${escape(instructions)}</p><div class="recovery-important"><strong>Important: save your Host recovery link</strong><p>A Home Screen app may have separate website storage from Safari. If your previous splits do not appear there, restore them with your private Host link.</p></div><div class="modal-actions"><button class="btn secondary" type="button" data-action="close">Close</button>${state.installPrompt ? '<button class="btn primary" type="button" data-action="install-now">Install app</button>' : ''}</div>`);
  }
  if (state.modal === 'invite') {
    const link = `${location.origin}/s/${s.id}`;
    return modalLayout('Add people to your split', `<p>Send this invitation to your friends. Each person opens it on their phone, enters a nickname, and selects what they ordered.</p><div class="invite-link-card"><label for="invite-link" class="invite-link-label">SHAREABLE INVITE LINK</label><input id="invite-link" class="invite-link-input" type="text" readonly value="${escape(link)}" aria-label="Invitation link"><div class="invite-modal-actions"><button type="button" class="btn primary" data-action="copy-invite">${icon('copy')} Copy invite link</button><button type="button" class="btn secondary" data-action="share-invite">${icon('share')} Share…</button></div></div>${location.hostname === 'localhost' || location.hostname === '127.0.0.1' ? '<div class="alert" style="margin-top:13px">This link uses localhost and only works on this Mac. To invite someone on another device, open SplitSnap on your Mac using its Wi-Fi IP address first.</div>' : ''}<div class="invite-members"><strong>People in this split (${s.participants.length})</strong><div class="invite-member-list">${s.participants.map((p,i) => `<span class="participant-pill">${avatar(p,i)}${escape(p.name)}${p.id === state.actorId ? ' (you)' : ''}</span>`).join('')}</div><p class="muted smalltext">New people appear here automatically when they join.</p></div><div class="modal-actions"><button type="button" class="btn secondary" data-action="close">Done</button></div>`, false, 'invite-modal');
  }
  if (state.modal === 'item') {
    const item = s.items.find(i => i.id === state.editId);
    return modalLayout(item ? 'Edit menu item' : 'Add menu item', `<form id="item-form"><div class="field"><label>Menu name</label><input name="name" required maxlength="130" placeholder="Asahi Beer" value="${escape(item?.name || '')}"></div><div class="field-inline"><div class="field"><label>Quantity</label><input name="quantity" type="number" min="1" max="999" step="1" required value="${item?.quantity || 1}"></div><div class="field"><label>Total item price (CAD)</label><input name="amount" type="number" min="0" max="1000000" step="0.01" required value="${dollars(item?.amountCents || 0)}"></div></div><div class="field-inline"><div class="field"><label>Line discount (CAD)</label><input name="discount" type="number" min="0" max="1000000" step="0.01" required value="${dollars(item?.discountCents || 0)}"></div><div class="field"><label>Tax category</label><select name="category">${['food','alcohol','beverage','other','unknown'].map(x => `<option value="${x}" ${x === (item?.taxCategory || 'food') ? 'selected' : ''}>${x}</option>`).join('')}</select></div></div><div class="alert" style="margin-bottom:13px">Enter the price for all ordered units together, before any separate line discount.</div><div class="modal-actions">${item ? `<button class="btn warn" type="button" data-action="delete-item" data-id="${item.id}">Delete</button>` : ''}<button class="btn secondary" type="button" data-action="close">Cancel</button><button class="btn primary" type="submit">Save item</button></div></form>`);
  }
  if (state.modal === 'charges') {
    const rows = state.newTaxRows || s.taxes;
    return modalLayout('Taxes, discounts & tip', `<form id="charges-form"><div class="field"><label>Order-wide discount (CAD)</label><input type="number" name="orderDiscount" min="0" step="0.01" required value="${dollars(s.orderDiscountCents)}"></div><div class="field"><label>Actual tip (CAD)</label><input type="number" name="tip" min="0" step="0.01" required value="${dollars(s.tipCents)}"></div><div class="field"><label style="text-transform:none;display:flex;align-items:center;gap:7px"><input name="tipVerified" type="checkbox" style="width:16px;height:16px" ${s.tipVerified ? 'checked' : ''}>Tip is verified from a payment receipt</label></div><div class="field"><label>Verified paid total (CAD, optional)</label><input type="number" name="verified" min="0" step="0.01" placeholder="No payment receipt" value="${s.verifiedTotalCents !== null ? dollars(s.verifiedTotalCents) : ''}"></div><div class="section-heading"><h2>Tax lines</h2><button type="button" class="btn secondary tiny" data-action="add-tax-row">＋ Tax</button></div>${rows.map((tax,i)=>`<div class="mini-summary" style="margin-bottom:10px"><div class="field-inline"><div class="field" style="margin-bottom:10px"><label>Tax name</label><input name="tax${i}label" value="${escape(tax.label)}" maxlength="100" required></div><div class="field" style="margin-bottom:10px"><label>Amount (CAD)</label><input name="tax${i}amount" type="number" min="0" step="0.01" value="${dollars(tax.amountCents)}" required></div></div><div class="row"><select name="tax${i}category" style="border:1px solid #dce5dc;padding:8px;border-radius:8px">${['all','food','alcohol','beverage','other','unknown'].map(x=>`<option value="${x}" ${tax.category===x?'selected':''}>${x}</option>`).join('')}</select><button type="button" class="btn tiny warn" data-action="remove-tax-row" data-index="${i}">Remove</button></div></div>`).join('')}<div class="modal-actions"><button class="btn secondary" type="button" data-action="close">Cancel</button><button class="btn primary" type="submit">Save charges</button></div></form>`);
  }
  if (state.modal === 'payment') {
    const p = s.summary.payments.find(p => p.participantId === state.paymentTarget);
    const name = currentPerson(state.paymentTarget)?.name || 'Friend';
    return modalLayout(`Payment from ${escape(name)}`, `<p>Log money you have actually received. Friends can pay in multiple installments.</p><div class="mini-summary"><div class="row"><span>Remaining amount</span><strong>${usd(p?.outstandingCents || 0)}</strong></div></div><form id="payment-form" style="margin-top:20px"><div class="field"><label>Amount received (CAD)</label><input name="amount" type="number" min="0.01" max="${dollars(p?.outstandingCents || 0)}" step="0.01" value="${dollars(p?.outstandingCents || 0)}" required autofocus></div><div class="modal-actions"><button type="button" class="btn secondary" data-action="close">Cancel</button><button type="submit" class="btn primary">Record received payment</button></div></form>`);
  }
  return '';
}

function render() {
  const path = location.pathname;
  const page = !state.session ? path === '/new' ? createView() : path.startsWith('/s/') ? joinView(state.publicInfo) : savedCredentials().length ? dashboardView() : homeView() : sessionView(state.session);
  root.innerHTML = `<div class="page">${nav()}<main>${page}</main>${footer()}${renderModal()}</div>`;
  document.title = state.session ? `${state.session.title} · SplitSnap` : 'SplitSnap · Better bills together';
}

async function create(demo, body = null) {
  const payload = await api('POST', '/api/sessions', demo ? { title: 'BierCraft Dinner', hostName: 'You', demo: true } : body, false);
  state.session = payload.session;
  state.token = payload.token;
  state.actorId = payload.participantId;
  state.role = 'host';
  state.tab = 'split';
  state.paymentTarget = null;
  state.importNotice = null;
  safeStoreToken(payload.session.id, state.token);
  history.pushState(null, '', `/s/${payload.session.id}`);
  render();
  connect();
  state.modal = 'save-recovery';
  render();
  notify('Your room is ready. Save the Host recovery link to avoid losing it.');
}

async function enterSession(id) {
  const hasRecoveryHash = location.hash.startsWith('#access=');
  let hashToken = '';
  if (hasRecoveryHash) {
    try { hashToken = decodeURIComponent(location.hash.slice(8)); } catch {}
    history.replaceState(null, '', location.pathname);
  }
  if (hashToken) {
    if (/^[A-Za-z0-9_-]{32,200}$/.test(hashToken)) {
      try {
        const response = await fetch(`/api/sessions/${id}`, { headers: { Authorization: `Bearer ${hashToken}` }, cache: 'no-store' });
        if (response.ok && (await response.json()).role === 'host') safeStoreToken(id, hashToken);
        else notify('This is not a valid Host recovery link.', 'error');
      } catch {
        notify('Could not verify the recovery link. Try again when connected.', 'error');
      }
    } else notify('Invalid Host recovery link.', 'error');
  }
  state.token = savedCredentials().find(entry => entry.id === id)?.token || '';
  state.session = null;
  state.role = null;
  state.actorId = null;
  if (state.token) {
    try {
      const response = await fetch(`/api/sessions/${id}`, { headers: { Authorization: `Bearer ${state.token}` }, cache: 'no-store' });
      if (response.ok) {
        const result = await response.json();
        state.session = result.session;
        state.role = result.role;
        state.actorId = result.actorId;
        state.tab = state.session.status === 'finalized' ? 'payments' : 'split';
        render();
        connect();
        return;
      }
      if (response.status === 401 || response.status === 404) {
        safeRemoveToken(id);
        state.token = '';
      } else throw new Error(`Unable to load session (${response.status})`);
    } catch (e) {
      state.publicInfo = { title: 'Connection unavailable' };
      render();
      notify(e.message || 'You appear offline. Your saved Host access is still on this device.', 'error');
      return;
    }
  }
  try {
    state.publicInfo = await api('GET', `/api/sessions/${id}/public`, undefined, false);
    render();
  } catch (e) {
    state.publicInfo = { title: 'Unavailable Session' };
    render();
    notify(e.message, 'error');
  }
}

async function refresh() {
  if (!state.session || !state.token) return;
  const result = await api('GET', `/api/sessions/${state.session.id}`);
  if (result.session.revision < state.session.revision) return;
  state.session = result.session;
  state.actorId = result.actorId;
  state.role = result.role;
  if (!state.modal || !['item','charges'].includes(state.modal)) render();
}

function connect() {
  if (state.connection) state.connection.abort();
  if (!state.session || !state.token) return;
  const id = state.session.id;
  const controller = new AbortController();
  state.connection = controller;
  let retry = 700;
  const run = async () => {
    while (!controller.signal.aborted && state.session?.id === id) {
      await new Promise(resolve => {
        const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
        const socket = new WebSocket(`${protocol}//${location.host}/api/sessions/${id}/stream`);
        let finished = false;
        let heartbeat = null;
        const abort = () => { try { socket.close(); } catch {} finish(); };
        const finish = () => {
          if (finished) return;
          finished = true;
          clearInterval(heartbeat);
          controller.signal.removeEventListener('abort', abort);
          resolve();
        };
        controller.signal.addEventListener('abort', abort, { once: true });
        socket.addEventListener('open', () => {
          retry = 700;
          socket.send(JSON.stringify({ type: 'auth', token: state.token }));
          heartbeat = setInterval(() => {
            if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'ping' }));
          }, 25000);
        });
        socket.addEventListener('message', event => {
          let message;
          try { message = JSON.parse(event.data); } catch { return; }
          if (message.type === 'ready' || message.type === 'update') refresh().catch(() => {});
        });
        socket.addEventListener('close', finish);
        socket.addEventListener('error', () => { try { socket.close(); } catch {} finish(); });
      });
      if (controller.signal.aborted || state.session?.id !== id) break;
      await new Promise(resolve => setTimeout(resolve, retry));
      retry = Math.min(retry * 2, 8000);
      refresh().catch(() => {});
    }
  };
  run().catch(() => {});
}

async function mutate(method, path, body) {
  const result = await api(method, `/api/sessions/${state.session.id}${path}`, body);
  await refresh();
  return result;
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const target = document.createElement('textarea');
    target.value = text;
    document.body.appendChild(target);
    target.select();
    document.execCommand('copy');
    target.remove();
  }
  notify('Copied to clipboard');
}

function copySummary() {
  const s = state.session;
  const lines = [`${s.title} · SplitSnap`, `Total: ${usd(s.summary.totalCents)}`, ''];
  for (const p of s.summary.people) lines.push(`${p.name}: ${usd(p.totalCents)}`);
  lines.push('', `Open split: ${location.origin}/s/${s.id}`);
  return lines.join('\n');
}

async function resizeImage(file) {
  const mime = file.type || ({jpg:'image/jpeg',jpeg:'image/jpeg',png:'image/png',webp:'image/webp',heic:'image/heic',heif:'image/heif'}[file.name.split('.').pop().toLowerCase()]);
  if (!['image/jpeg','image/png','image/webp','image/heic','image/heif'].includes(mime)) throw new Error('Use JPG, PNG, WebP or HEIC');
  if (file.size > 15_000_000) throw new Error('File larger than 15 MB');
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    try {
      await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = reject; img.src = url; });
    } catch {
      if (!['image/heic','image/heif'].includes(mime) || file.size > 9_000_000) throw new Error('Cannot read this photo. Convert it to JPEG and try again.');
      const raw = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error('Cannot load this image'));
        reader.readAsDataURL(file);
      });
      return { data: raw.split(',')[1], mimeType: mime };
    }
    const scale = Math.min(1, 1800 / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(img.naturalWidth * scale);
    canvas.height = Math.round(img.naturalHeight * scale);
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    return { data: canvas.toDataURL('image/jpeg', .86).split(',')[1], mimeType: 'image/jpeg' };
  } finally { URL.revokeObjectURL(url); }
}

async function parseNext() {
  if (!state.pendingFiles.length) {
    state.uploadBusy = false;
    state.modal = null;
    render();
    return;
  }
  const file = state.pendingFiles.shift();
  state.uploadBusy = true;
  state.scanStage = 'preparing';
  state.scanFileName = file.name;
  state.receiptCompatibility = null;
  state.importError = '';
  state.merchantConfirmed = false;
  state.modal = 'upload';
  render();
  if (state.previewUrl) URL.revokeObjectURL(state.previewUrl);
  state.previewUrl = URL.createObjectURL(file);
  state.showReceiptPreview = true;
  try {
    const image = await resizeImage(file);
    state.scanStage = 'reading';
    render();
    const result = await api('POST', `/api/sessions/${state.session.id}/parse`, image);
    state.scanStage = 'checking';
    render();
    const checked = await api('POST', `/api/sessions/${state.session.id}/receipts/check`, { receipt: result.receipt });
    state.receiptCompatibility = checked.compatibility;
    state.draft = result.receipt;
    state.parseFingerprint = result.fingerprint;
    state.uploadBusy = false;
    state.modal = 'receipt-draft';
    render();
  } catch (e) {
    notify(`${file.name}: ${e.message}`, 'error');
    state.uploadBusy = false;
    state.modal = 'upload';
    render();
  }
}

async function runAction(el) {
  const action = el.dataset.action;
  if (action === 'recheck-merchant') {
    if (!state.draft) return;
    state.draft.merchant = ($('#receipt-merchant')?.value || '').trim();
    const checked = await api('POST', `/api/sessions/${state.session.id}/receipts/check`, { receipt: state.draft });
    state.receiptCompatibility = checked.compatibility;
    state.merchantConfirmed = false;
    state.importError = '';
    render();
    return;
  }
  if (action === 'new-split-for-receipt') {
    if (state.connection) state.connection.abort();
    if (state.previewUrl) URL.revokeObjectURL(state.previewUrl);
    state.previewUrl = null;
    state.pendingFiles = [];
    state.modal = null;
    state.session = null;
    state.token = '';
    state.uploadBusy = false;
    history.pushState(null, '', '/new');
    render();
    return;
  }
  if (action === 'toggle-receipt-preview') { state.showReceiptPreview = !state.showReceiptPreview; render(); return; }
  if (action === 'home') { goHome(); return; }
  if (action === 'new') { goNew(); return; }
  if (action === 'demo') return create(true);
  if (action === 'close') { state.modal = null; state.newTaxRows = null; render(); return; }
  if (action === 'overlay') { state.modal = null; render(); return; }
  if (action === 'tab') { state.tab = el.dataset.tab; render(); return; }
  if (action === 'invite') { state.modal = 'invite'; render(); return; }
  if (action === 'copy-invite') return copy(`${location.origin}/s/${state.session.id}`);
  if (action === 'recovery') { state.modal = 'save-recovery'; render(); return; }
  if (action === 'copy-recovery') return copy(createRecoveryLink(location.origin, state.session.id, state.token));
  if (action === 'saved-recovery') { const entry = state.savedSplits.find(x => x.id === el.dataset.id && x.role === 'host'); if (!entry) throw new Error('Host access is not available on this device'); return copy(createRecoveryLink(location.origin, entry.id, entry.token)); }
  if (action === 'open-saved') { const id = el.dataset.id; history.pushState(null, '', `/s/${id}`); return enterSession(id); }
  if (action === 'install-pwa') { state.modal = 'install'; render(); return; }
  if (action === 'install-now') { if (state.installPrompt) { const prompt = state.installPrompt; state.installPrompt = null; prompt.prompt(); prompt.userChoice.catch(() => {}); state.modal = null; render(); } else { state.modal = 'install'; render(); } return; }
  if (action === 'copy-summary') return copy(copySummary());
  if (action === 'upload') { state.modal = 'upload'; render(); return; }
  if (action === 'go-split') { state.tab = 'split'; state.importNotice = null; render(); return; }
  if (action === 'dismiss-import') { state.importNotice = null; render(); return; }
  if (action === 'summary-scroll') { document.querySelector('#share-summary')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
  if (action === 'add-item') { state.modal = 'item'; state.editId = null; render(); return; }
  if (action === 'edit-item') { state.modal = 'item'; state.editId = el.dataset.id; render(); return; }
  if (action === 'delete-item') {
    if (!confirm('Delete this menu item and all its allocations?')) return;
    await mutate('DELETE', `/items/${el.dataset.id}`);
    state.modal = null;
    render();
    return;
  }
  if (action === 'edit-charges') { state.modal = 'charges'; state.newTaxRows = state.session.taxes.map(x => ({ ...x })); render(); return; }
  if (action === 'add-tax-row' || action === 'remove-tax-row') {
    const form = $('#charges-form');
    const taxes = state.newTaxRows || state.session.taxes;
    const values = taxes.map((t,i) => ({ id: t.id, label: form.elements[`tax${i}label`]?.value || t.label, amountCents: cents(form.elements[`tax${i}amount`]?.value ?? dollars(t.amountCents)), category: form.elements[`tax${i}category`]?.value || t.category }));
    if (action === 'add-tax-row') values.push({ label: 'Tax', amountCents: 0, category: 'all' });
    else values.splice(Number(el.dataset.index), 1);
    state.newTaxRows = values;
    state.pendingCharges = { orderDiscount: form.elements.orderDiscount.value, tip: form.elements.tip.value, tipVerified: form.elements.tipVerified.checked, verified: form.elements.verified.value };
    render();
    for (const [name,value] of Object.entries(state.pendingCharges)) {
      const input = $('#charges-form').elements[name];
      if (input) { if (name === 'tipVerified') input.checked = value; else input.value = value; }
    }
    return;
  }
  if (action === 'toggle-claim' || action === 'claim-plus' || action === 'claim-minus' || action === 'make-share' || action === 'join-share' || action === 'leave-share') {
    const operations = { 'toggle-claim': 'toggle', 'claim-plus': 'plus', 'claim-minus': 'minus', 'make-share': 'share', 'join-share': 'join', 'leave-share': 'leave' };
    return mutate('POST', '/claims', { itemId: el.dataset.id, targetId: el.dataset.target || state.actorId, op: operations[action], groupId: el.dataset.group });
  }
  if (action === 'finalize') {
    if (!state.session.summary.canFinalize) return notify('Resolve the receipt issues before finalizing', 'error');
    if (!confirm('Lock the menu allocations and finalize these amounts?')) return;
    await mutate('POST', '/finalize', {});
    state.tab = 'payments';
    render();
    notify('Split finalized. You can record payments later.');
    return;
  }
  if (action === 'reopen') {
    if (!confirm('Reopen this bill for editing? Recorded payments must be undone first.')) return;
    await mutate('POST', '/reopen', {});
    state.tab = 'split';
    render();
    return;
  }
  if (action === 'record-payment') { state.paymentTarget = state.paymentTarget === el.dataset.id ? null : el.dataset.id; render(); return; }
  if (action === 'undo-payment') {
    if (!confirm('Undo this recorded payment?')) return;
    await mutate('DELETE', `/payments/${el.dataset.id}`);
    return;
  }
  if (action === 'delete-session') {
    if (!confirm('Permanently delete this split and all records? This cannot be undone.')) return;
    await api('DELETE', `/api/sessions/${state.session.id}`);
    safeRemoveToken(state.session.id);
    if (state.connection) state.connection.abort();
    state.session = null;
    history.pushState(null, '', '/');
    render();
    notify('Session deleted');
    return;
  }
  if (action === 'skip-receipt') { if (state.previewUrl) URL.revokeObjectURL(state.previewUrl); state.previewUrl = null; state.draft = null; state.uploadBusy = false; return parseNext(); }
  if (action === 'import-receipt') {
    state.draft.merchant = ($('#receipt-merchant')?.value || '').trim();
    let result;
    try {
      result = await mutate('POST', '/receipts', { receipt: state.draft, fingerprint: state.parseFingerprint, merchantConfirmed: state.merchantConfirmed });
    } catch (e) {
      state.importError = e.message;
      render();
      return;
    }
    if (result.warning) notify(result.warning, 'error');
    state.draft = null;
    state.parseFingerprint = null;
    if (state.previewUrl) URL.revokeObjectURL(state.previewUrl);
    state.previewUrl = null;
    state.uploadBusy = false;
    if (state.pendingFiles.length) return parseNext();
    state.modal = null;
    state.tab = 'split';
    state.importNotice = 'Receipt imported successfully';
    render();
    window.scrollTo({ top: 0, behavior: 'smooth' });
    notify('Receipt imported. Choose what you ate below.');
  }
}

window.addEventListener('popstate', () => safeRun(init));
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.session) {
    refresh().catch(() => {});
    connect();
  }
});

document.addEventListener('click', event => {
  const el = event.target.closest('[data-action]');
  if (!el) return;
  const action = el.dataset.action;
  if (action === 'share-invite') {
    event.preventDefault();
    const url = `${location.origin}/s/${state.session.id}`;
    if (navigator.share) navigator.share({ title: 'Join my SplitSnap', text: 'Join our bill split', url }).catch(e => { if (e.name !== 'AbortError') notify('Could not share. Use Copy invite link instead.', 'error'); });
    else safeRun(() => copy(url));
    return;
  }
  if (el.tagName === 'A' || action === 'overlay') event.preventDefault();
  if (action === 'overlay' && event.target !== el) return;
  safeRun(() => runAction(el));
});

function selectReceiptFiles(files) {
  if (state.uploadBusy) return;
  if (!state.gemini) return notify('Configure Gemini to scan receipts or enter items manually.', 'error');
  const selected = [...files];
  if (!selected.length) return;
  if (selected.some(file => !['jpg','jpeg','png','webp','heic','heif'].includes(file.name.split('.').pop().toLowerCase()) && !['image/jpeg','image/png','image/webp','image/heic','image/heif'].includes(file.type))) return notify('Choose JPG, PNG, WebP or HEIC photos.', 'error');
  if (selected.some(file => file.size > 15_000_000)) return notify('Each photo must be 15 MB or less.', 'error');
  state.pendingFiles = selected;
  state.scanTotal = selected.length;
  state.uploadBusy = true;
  safeRun(parseNext);
}

document.addEventListener('input', event => {
  if (event.target.id === 'receipt-merchant' && state.draft) {
    state.draft.merchant = event.target.value.trim();
    state.receiptCompatibility = { status: 'review', message: 'Restaurant name edited. Select Check restaurant to validate it before importing.' };
    state.merchantConfirmed = false;
    state.importError = '';
    const importButton = document.querySelector('[data-action="import-receipt"]');
    if (importButton) importButton.disabled = true;
  }
});

document.addEventListener('change', event => {
  if (event.target.id === 'confirm-merchant') {
    state.merchantConfirmed = Boolean(event.target.checked);
    render();
    return;
  }
  if (event.target.matches('.receipt-file-input')) {
    const selected = [...(event.target.files || [])];
    event.target.value = '';
    selectReceiptFiles(selected);
  }
});

document.addEventListener('dragover', event => {
  const target = event.target.closest?.('.upload-area');
  if (!target || state.uploadBusy || !state.gemini) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'copy';
  target.classList.add('is-dragover');
});

document.addEventListener('dragleave', event => {
  const target = event.target.closest?.('.upload-area');
  if (target && !target.contains(event.relatedTarget)) target.classList.remove('is-dragover');
});

document.addEventListener('drop', event => {
  const target = event.target.closest?.('.upload-area');
  if (!target) return;
  event.preventDefault();
  target.classList.remove('is-dragover');
  selectReceiptFiles(event.dataTransfer?.files || []);
});

document.addEventListener('submit', event => {
  if (!['create-form','join-form','item-form','charges-form','payment-form','restore-form'].includes(event.target.id)) return;
  event.preventDefault();
  const form = event.target;
  const values = new FormData(form);
  safeRun(async () => {
    if (form.id === 'restore-form') {
      const recovered = parseRecoveryLink(String(values.get('link') || ''), location.origin);
      const checked = await fetch(`/api/sessions/${recovered.id}`, { headers: { Authorization: `Bearer ${recovered.token}` }, cache: 'no-store' });
      if (!checked.ok) throw new Error('The recovery link is expired or invalid');
      const result = await checked.json();
      if (result.role !== 'host') throw new Error('This link does not provide Host access');
      safeStoreToken(recovered.id, recovered.token);
      history.pushState(null, '', `/s/${recovered.id}`);
      await enterSession(recovered.id);
      notify('Host access restored. This split is now in My Splits.');
      return;
    }
    if (form.id === 'create-form') return create(false, { title: values.get('title'), hostName: values.get('hostName') });
    if (form.id === 'join-form') {
      const id = location.pathname.split('/')[2];
      const payload = await api('POST', `/api/sessions/${id}/join`, { name: values.get('nickname') }, false);
      state.token = payload.token;
      state.actorId = payload.participantId;
      state.role = 'participant';
      state.session = payload.session;
      state.tab = 'split';
      safeStoreToken(id, state.token);
      render();
      connect();
      notify('You joined the split!');
      return;
    }
    if (form.id === 'item-form') {
      const item = { name: values.get('name'), quantity: Number(values.get('quantity')), amountCents: cents(values.get('amount')), discountCents: cents(values.get('discount')), taxCategory: values.get('category') };
      if (state.editId) await mutate('PATCH', `/items/${state.editId}`, item);
      else await mutate('POST', '/items', item);
      state.modal = null;
      render();
      return;
    }
    if (form.id === 'charges-form') {
      const taxes = (state.newTaxRows || state.session.taxes).map((tax,i) => ({ id: tax.id, label: values.get(`tax${i}label`), amountCents: cents(values.get(`tax${i}amount`)), category: values.get(`tax${i}category`) }));
      await mutate('PUT', '/charges', { taxes, orderDiscountCents: cents(values.get('orderDiscount')), tipCents: cents(values.get('tip')), tipVerified: values.has('tipVerified'), verifiedTotalCents: values.get('verified') === '' ? null : cents(values.get('verified')) });
      state.newTaxRows = null;
      state.modal = null;
      render();
      return;
    }
    if (form.id === 'payment-form') {
      const participantId = form.dataset.participantId || state.paymentTarget;
      const amountCents = cents(values.get('amount'));
      const recipient = state.session.summary.payments.find(p => p.participantId === participantId);
      if (!recipient || amountCents < 1 || amountCents > recipient.outstandingCents) throw new Error('Enter an amount between $0.01 and the remaining balance.');
      await mutate('POST', '/payments', { participantId, amountCents });
      state.paymentTarget = null;
      state.modal = null;
      render();
      notify('Payment saved. The outstanding balance has been updated.');
    }
  });
});

async function init() {
  if (state.connection) state.connection.abort();
  state.connection = null;
  state.modal = null;
  if (location.pathname.startsWith('/s/')) {
    const id = location.pathname.split('/')[2];
    await enterSession(id);
  } else {
    state.session = null;
    state.token = '';
    if (location.pathname === '/') await loadDashboard();
    else render();
  }
}

window.addEventListener('beforeinstallprompt', event => {
  event.preventDefault();
  state.installPrompt = event;
  state.installAvailable = true;
  if (state.modal === 'install') render();
});
window.addEventListener('appinstalled', () => { state.installPrompt = null; state.installAvailable = false; notify('SplitSnap installed!'); });
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => { navigator.serviceWorker.register('/sw.js').catch(() => {}); });
}

api('GET', '/api/health', undefined, false).then(r => {
  const next = Boolean(r.geminiConfigured);
  if (state.gemini !== next) { state.gemini = next; if (state.session && !state.uploadBusy) render(); }
}).catch(() => {});
init().catch(e => notify(e.message, 'error'));
