// PHASE 0 — Truck / Load entry tests.
//
// Runs the real app <script> from index.html inside a node:vm sandbox with a
// small fake DOM, so flows are exercised end to end (not just string checks).
// Every scenario gets a fresh sandbox. No network: fetch is a recorder that
// returns canned responses and never reaches a real backend.
//
// Run: node --test tests/phase0-truck-load.test.mjs

import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const htmlContent = readFileSync(join(__dirname, '..', 'index.html'), 'utf8');
const scriptMatch = htmlContent.match(/<script>([\s\S]*?)<\/script>/);
if (!scriptMatch) throw new Error('No script found in index.html');
const appCode = scriptMatch[1];
const staticHtml = htmlContent.replace(appCode, '');

const V3_KEY = 'inventory_manifest_beta_session_v3';
const V2_KEY = 'inventory_manifest_beta_session_v2';

// Endpoints that change inventory/listings. Phase 0 must never call these.
const WRITE_ENDPOINTS = [
  '/sb/update-inventory', '/ss/create-product', '/shopify-create-product',
  '/promote-item', '/img-upload', '/img-delete', '/manifest/add-row',
  '/manifest/add-rows', '/manifest/save-original', 'script.google.com'
];

// ── Fake DOM ────────────────────────────────────────────────────────────
function makeElement(id, registry, attrs = {}) {
  const classes = new Set();
  const el = {
    id,
    value: attrs.value || '',
    textContent: '',
    style: { display: '' },
    dataset: {},
    files: [],
    _html: '',
    focused: false,
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      toggle: (c) => (classes.has(c) ? classes.delete(c) : classes.add(c)),
      contains: (c) => classes.has(c),
    },
    addEventListener: () => {},
    focus() { this.focused = true; },
    click: () => {},
    querySelector: () => null,
    querySelectorAll: () => [],
    get innerHTML() { return this._html; },
    set innerHTML(v) {
      this._html = String(v);
      // Register elements created by this markup so getElementById finds them
      const re = /<(\w+)([^>]*?)\sid="([^"]+)"([^>]*)>/g;
      let m;
      while ((m = re.exec(this._html))) {
        const all = m[2] + ' ' + m[4];
        const valueMatch = all.match(/\svalue="([^"]*)"/);
        registry[m[3]] = makeElement(m[3], registry, { value: valueMatch ? valueMatch[1] : '' });
      }
    },
  };
  return el;
}

function createApp(opts = {}) {
  const registry = {};
  // Only ids that really exist in the static markup (missing ids stay null)
  for (const m of staticHtml.matchAll(/\sid="([^"]+)"/g)) registry[m[1]] = makeElement(m[1], registry);
  registry['scr-home'].classList.add('on');

  const store = (initial = {}) => {
    const data = { ...initial };
    return {
      data,
      failWrites: false,
      clearCalls: 0,
      getItem(k) { return Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null; },
      setItem(k, v) { if (this.failWrites) throw new Error('QuotaExceededError'); data[k] = String(v); },
      removeItem(k) { delete data[k]; },
      clear() { this.clearCalls++; for (const k of Object.keys(data)) delete data[k]; },
    };
  };
  const localStorage = store(opts.localStorage || {});
  const sessionStorage = store(opts.authenticated === false ? {} : { savvy_session_token: 'test-token', savvy_session_user: 'tester' });

  const fetchCalls = [];
  const scannerStarts = [];
  const confirmCalls = [];
  const promptCalls = [];
  const toasts = [];
  const domListeners = [];

  const respond = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });
  const fetchImpl = async (url, options = {}) => {
    const u = String(url);
    fetchCalls.push({ url: u, method: (options.method || 'GET').toUpperCase() });
    if (opts.fetch) { const r = opts.fetch(u, options); if (r) return r; }
    if (u.includes('/api/identify-by-upc')) {
      const upc = new URL(u).searchParams.get('upc');
      return respond(200, { status: 'success', identified: true,
        identity: { title: 'Nature Made Collagen Gummies 60ct 1 Pack', brand: 'Nature Made', upc, category: 'Vitamins', condition: 'New' },
        market: { ebay: { matches: 4, low: 9.5, average: 12.25, high: 15 } } });
    }
    if (u.includes('/sb/search')) return respond(404, { status: 'not_found' });
    return respond(503, { status: 'error' });
  };

  const context = {
    console: { log() {}, warn() {}, error() {}, group() {}, groupEnd() {} },
    localStorage, sessionStorage,
    fetch: fetchImpl,
    URL, Headers,
    setTimeout: (fn) => 0, clearTimeout: () => {},
    confirm: (msg) => { confirmCalls.push(msg); return opts.confirm === undefined ? true : (typeof opts.confirm === 'function' ? opts.confirm(msg) : opts.confirm); },
    prompt: (msg, def) => { promptCalls.push(msg); return opts.prompt === undefined ? def : opts.prompt; },
    alert: () => {},
    Html5Qrcode: class {
      constructor(id) { this.id = id; }
      start(camera, config, onSuccess) { scannerStarts.push({ camera, onSuccess }); return Promise.resolve(); }
      stop() { return Promise.resolve(); }
    },
    FileReader: class {},
    Image: class {},
    document: {
      getElementById: (id) => registry[id] || null,
      querySelectorAll: (sel) => (sel === '.scr' ? Object.values(registry).filter(e => /^scr-/.test(e.id)) : []),
      createElement: () => makeElement('', registry),
      addEventListener: (type, fn) => domListeners.push({ type, fn }),
      body: { appendChild: () => {} },
    },
  };
  context.window = context;
  context.addEventListener = (type, fn) => domListeners.push({ type, fn });
  vm.createContext(context);
  new vm.Script(appCode, { filename: 'index.html<script>' }).runInContext(context, { timeout: 10000 });

  const app = {
    ctx: context, registry, localStorage, sessionStorage, fetchCalls, scannerStarts,
    confirmCalls, promptCalls, toasts, domListeners,
    run: (code) => vm.runInContext(code, context),
    el: (id) => registry[id] || null,
    boot() { domListeners.filter(l => l.type === 'DOMContentLoaded').forEach(l => l.fn()); },
    currentScreen() { const on = Object.values(registry).filter(e => /^scr-/.test(e.id) && e.classList.contains('on')); return on.length === 1 ? on[0].id : on.map(e => e.id).join(','); },
    session() { return vm.runInContext('manifestSession', context); },
    stored(key = V3_KEY) { const v = localStorage.getItem(key); return v === null ? null : JSON.parse(v); },
    writeCalls() { return fetchCalls.filter(c => WRITE_ENDPOINTS.some(w => c.url.includes(w))); },
    setValue(id, v) { registry[id].value = v; },
  };
  return app;
}

function legacyV3Session(extra = {}) {
  return {
    version: 3, id: 'ms_legacy', fileName: '', fileType: '', sheetName: null,
    uploadedAt: '2026-10-01T10:00:00.000Z', headerRowIndex: -1, sourceHeaderRowNumber: 0,
    rawHeaders: [], originalRawRows: [], originalSourceRowMap: {}, mapping: {}, rows: [],
    status: 'ready', receivedRecords: [], allocationRecords: [], receivingActive: true,
    isManifestLoaded: false, ...extra,
  };
}

function createLoadViaForm(app, { name = 'Target GM Truck - 10/05/2026', vendor = '', loadId = '', notes = '' } = {}) {
  app.run('startLoadWithoutManifest()');
  app.setValue('new-manifest-name', name);
  app.setValue('new-manifest-vendor', vendor);
  app.setValue('new-manifest-loadid', loadId);
  app.setValue('new-manifest-notes', notes);
  return app.run('submitNewManifest()');
}

function extractFunction(name) {
  const re = new RegExp('^(async\\s+)?function\\s+' + name + '\\s*\\(', 'm');
  const m = re.exec(appCode);
  if (!m) return null;
  const end = appCode.indexOf('\n}\n', m.index);
  return appCode.slice(m.index, end + 2);
}
const fingerprint = (name) => {
  const src = extractFunction(name);
  return src ? createHash('sha256').update(src).digest('hex').slice(0, 16) : 'MISSING';
};

const flush = () => new Promise(r => setImmediate(r));
async function settle() { for (let i = 0; i < 10; i++) await flush(); }

// ═════════════════════════════════════════════════════════════════════════
// 1–2. HOME
// ═════════════════════════════════════════════════════════════════════════

test('1. Home contains PROCESS A TRUCK / LOAD with YES — UPLOAD MANIFEST and NO — CREATE NEW MANIFEST', () => {
  const home = staticHtml.slice(staticHtml.indexOf('id="scr-home"'), staticHtml.indexOf('<!-- SCANNER SCREEN -->'));
  assert.ok(/Process a Truck \/ Load/i.test(home), 'section title');
  assert.ok(home.includes('Does this truck/load have a manifest?'), 'question');
  assert.ok(home.includes('YES — UPLOAD MANIFEST'), 'YES button');
  assert.ok(home.includes('NO — CREATE NEW MANIFEST'), 'NO button');
  assert.ok(home.includes('CSV · Excel'), 'YES subtitle');
  assert.ok(home.includes('Build it as you scan'), 'NO subtitle');
  assert.ok(home.includes('onclick="startLoadWithManifest()"'), 'YES wired');
  assert.ok(home.includes('onclick="startLoadWithoutManifest()"'), 'NO wired');
  // Load section comes before Quick Lookup
  assert.ok(home.indexOf('YES — UPLOAD MANIFEST') < home.indexOf('Quick Lookup (Inventory)'));
});

test('2. Existing Quick Lookup remains present on Home (scan, photo, manual, recent)', () => {
  const home = staticHtml.slice(staticHtml.indexOf('id="scr-home"'), staticHtml.indexOf('<!-- SCANNER SCREEN -->'));
  assert.ok(home.includes('Quick Lookup (Inventory)'));
  assert.ok(home.includes("openScanner('lookup')"), 'Scan Barcode card');
  assert.ok(home.includes('onclick="openPhotoIdentify()"'), 'Identify by Photo card');
  assert.ok(home.includes('Identify by Photo<span class="beta-tag">BETA</span>'));
  assert.ok(home.includes('id="manualUpc"') && home.includes('onclick="searchManual()"'), 'manual UPC/SKU box');
  assert.ok(home.includes('id="recent-searches"'), 'recent searches');
});

test('RESUME LOAD card shows name + progress only when a load is active', () => {
  const empty = createApp();
  empty.boot();
  assert.strictEqual(empty.el('manifest-session-indicator').innerHTML, '');

  const app = createApp({ localStorage: { [V3_KEY]: JSON.stringify(legacyV3Session({
    name: 'Walmart Load 7', meta: { vendor: 'Walmart', loadId: 'TRK-7', notes: '' },
    allocationRecords: [
      { id: 'a1', upc: '111', sku: '', quantity: 5, destination: 'SAVVY', productKey: 'UPC:111' },
      { id: 'a2', upc: '111', sku: '', quantity: 3, destination: 'DWI', productKey: 'UPC:111' },
      { id: 'a3', upc: '222', sku: '', quantity: 2, destination: 'SAVVY', productKey: 'UPC:222' },
    ] })) } });
  app.boot();
  const html = app.el('manifest-session-indicator').innerHTML;
  assert.ok(html.includes('Resume Load'));
  assert.ok(html.includes('Walmart Load 7'));
  assert.ok(html.includes('Load / Truck ID: TRK-7'));
  assert.ok(html.includes('2 products allocated'));
  assert.ok(html.includes('10 units'));
  assert.ok(html.includes('resumeActiveLoad()'));
  app.run('resumeActiveLoad()');
  assert.strictEqual(app.currentScreen(), 'scr-receiving-workspace');
});

// ═════════════════════════════════════════════════════════════════════════
// 3–8. NO PATH — CREATE NEW MANIFEST
// ═════════════════════════════════════════════════════════════════════════

test('3. NO path requires Manifest Name', () => {
  const app = createApp();
  app.boot();
  assert.strictEqual(app.run('startLoadWithoutManifest()'), true);
  assert.strictEqual(app.currentScreen(), 'scr-new-manifest');
  app.setValue('new-manifest-name', '   ');
  assert.strictEqual(app.run('submitNewManifest()'), false);
  assert.ok(app.el('new-manifest-msg').textContent.includes('Manifest Name is required'));
  assert.strictEqual(app.stored(), null, 'nothing saved');
  assert.strictEqual(app.session(), null, 'no session created');
  assert.strictEqual(app.currentScreen(), 'scr-new-manifest');
  assert.ok(staticHtml.includes('Manifest Name *'));
});

test('4. Manifest Name is saved into the receiving session (v3, receivingActive)', () => {
  const app = createApp();
  app.boot();
  assert.strictEqual(createLoadViaForm(app, { name: '  Target GM Truck - 10/05/2026  ' }), true);
  const s = app.stored();
  assert.strictEqual(s.name, 'Target GM Truck - 10/05/2026');
  assert.strictEqual(s.version, 3, 'still schema v3');
  assert.strictEqual(s.receivingActive, true);
  assert.strictEqual(s.isManifestLoaded, false);
  assert.ok(Array.isArray(s.allocationRecords));
  assert.strictEqual(app.session().name, 'Target GM Truck - 10/05/2026');
  assert.strictEqual(app.currentScreen(), 'scr-receiving-workspace');
});

test('5. Vendor is optional and preserved', () => {
  const a = createApp(); a.boot(); createLoadViaForm(a, { vendor: '' });
  assert.strictEqual(a.stored().meta.vendor, '');
  const b = createApp(); b.boot(); createLoadViaForm(b, { vendor: ' Target ' });
  assert.strictEqual(b.stored().meta.vendor, 'Target');
});

test('6. Load/Truck ID is optional and preserved', () => {
  const a = createApp(); a.boot(); createLoadViaForm(a, { loadId: '' });
  assert.strictEqual(a.stored().meta.loadId, '');
  const b = createApp(); b.boot(); createLoadViaForm(b, { loadId: 'TRK-4471' });
  assert.strictEqual(b.stored().meta.loadId, 'TRK-4471');
});

test('7. Notes are optional and preserved', () => {
  const a = createApp(); a.boot(); createLoadViaForm(a, { notes: '' });
  assert.strictEqual(a.stored().meta.notes, '');
  const b = createApp(); b.boot(); createLoadViaForm(b, { notes: 'Pallets 3-5 damaged' });
  assert.strictEqual(b.stored().meta.notes, 'Pallets 3-5 damaged');
});

test('8. Date is automatic (no date field; createdAt/uploadedAt set to now)', () => {
  const form = staticHtml.slice(staticHtml.indexOf('id="scr-new-manifest"'), staticHtml.indexOf('<!-- PHASE 5A: START RECEIVING SCREEN -->'));
  assert.ok(!/type="date"/.test(form), 'no date input');
  assert.ok(!/id="new-manifest-date"/.test(form));
  const before = Date.now();
  const app = createApp(); app.boot(); createLoadViaForm(app);
  const s = app.stored();
  const created = Date.parse(s.createdAt);
  assert.ok(created >= before - 1000 && created <= Date.now() + 1000, 'createdAt is now');
  assert.strictEqual(s.uploadedAt, s.createdAt);
});

// ═════════════════════════════════════════════════════════════════════════
// 9–10. NAMES / BACKWARD COMPATIBILITY
// ═════════════════════════════════════════════════════════════════════════

test('9. Old v3 session without name loads safely (fallback: file name, then "Untitled Load")', () => {
  const noFile = createApp({ localStorage: { [V3_KEY]: JSON.stringify(legacyV3Session()) } });
  noFile.boot();
  assert.ok(noFile.session(), 'session loaded');
  assert.strictEqual(noFile.run('getLoadDisplayName(manifestSession)'), 'Untitled Load');
  assert.ok(noFile.el('manifest-session-indicator').innerHTML.includes('Untitled Load'));
  noFile.run('renderReceivingWorkspace()');
  assert.ok(noFile.el('receiving-workspace-content').innerHTML.includes('Untitled Load'));
  // Loading did not rewrite the stored session
  assert.strictEqual(noFile.stored().name, undefined);

  const withFile = createApp({ localStorage: { [V3_KEY]: JSON.stringify(legacyV3Session({ fileName: 'target_manifest.xlsx', isManifestLoaded: true })) } });
  withFile.boot();
  assert.strictEqual(withFile.run('getLoadDisplayName(manifestSession)'), 'target_manifest.xlsx');
  assert.ok(withFile.el('manifest-session-indicator').innerHTML.includes('target_manifest.xlsx'));

  // v2-only legacy session still loads too
  const v2 = createApp({ localStorage: { [V2_KEY]: JSON.stringify({ version: 2, fileName: 'old.csv', status: 'ready', rows: [{}, {}] }) } });
  v2.boot();
  assert.strictEqual(v2.run('getLoadDisplayName(manifestSession)'), 'old.csv');
  assert.ok(v2.el('manifest-session-indicator').innerHTML.includes('2 manifest rows'));
});

test('10. Imported manifest gets a usable default name from the file name (editable later)', () => {
  const app = createApp();
  app.boot();
  assert.strictEqual(app.run("deriveDefaultLoadName('Target GM Truck 10-05.xlsx')"), 'Target GM Truck 10-05');
  assert.strictEqual(app.run("deriveDefaultLoadName('manifest.csv')"), 'manifest');
  assert.strictEqual(app.run("deriveDefaultLoadName('')"), 'Untitled Load');
  assert.strictEqual(app.run("deriveDefaultLoadName('.csv')"), 'Untitled Load');

  // Simulate the existing import flow reaching the mapping step
  app.run(`manifestSession = {
    version: 3, id: 'ms_imp', fileName: 'Target GM Truck 10-05.xlsx', fileType: 'xlsx',
    uploadedAt: '2026-10-05T09:00:00.000Z', rawHeaders: ['UPC','Description','Qty'],
    mapping: { upc: 'UPC', title: 'Description', expectedQty: 'Qty' },
    rows: [{ rowId: 0, sourceRowNumber: 2, original: { UPC: '031604032678', Description: 'Gummies', Qty: '48' },
      normalized: { upc: '', sku: '', title: '', brand: '', category: '', expectedQty: null, palletId: '', unitRetail: null, extendedRetail: null },
      receivedQty: 0, status: 'pending', notes: '' }],
    status: 'mapping', receivedRecords: [], allocationRecords: [] };`);
  app.run('submitManifestMapping()');
  const s = app.stored();
  assert.strictEqual(s.name, 'Target GM Truck 10-05');
  assert.deepStrictEqual(s.meta, { vendor: '', loadId: '', notes: '' });
  assert.strictEqual(s.createdAt, '2026-10-05T09:00:00.000Z');
  assert.strictEqual(s.rows[0].normalized.upc, '031604032678', 'existing normalization untouched');
  assert.strictEqual(s.rows[0].original.UPC, '031604032678', 'source data preserved');
  assert.strictEqual(app.currentScreen(), 'scr-receiving-workspace');
  assert.ok(app.el('receiving-workspace-content').innerHTML.includes('Target GM Truck 10-05'));

  // Editable later from the Workspace header
  const edit = createApp({ localStorage: { [V3_KEY]: JSON.stringify(s) }, prompt: '  Target GM — Dock 4 ' });
  edit.boot();
  edit.run('editLoadName()');
  assert.strictEqual(edit.stored().name, 'Target GM — Dock 4');
  assert.ok(edit.el('receiving-workspace-content').innerHTML.includes('Target GM — Dock 4'));
  // Empty name is rejected, previous name kept
  const empty = createApp({ localStorage: { [V3_KEY]: JSON.stringify(edit.stored()) }, prompt: '   ' });
  empty.boot();
  empty.run('editLoadName()');
  assert.strictEqual(empty.stored().name, 'Target GM — Dock 4');
});

test('YES path routes to the EXISTING import flow (upload screen, existing handler)', () => {
  const app = createApp();
  app.boot();
  app.el('manifest-file-input').value = 'C:\\fakepath\\previous.csv';
  assert.strictEqual(app.run('startLoadWithManifest()'), true);
  assert.strictEqual(app.currentScreen(), 'scr-manifest-upload');
  assert.strictEqual(app.el('manifest-file-input').value, '', 'file input reset so the same file can be re-picked');
  assert.strictEqual(app.confirmCalls.length, 0, 'no confirm without an active load');
  assert.ok(extractFunction('handleManifestFileSelected').includes('importManifestFile(file)'), 'existing importer reused');
});

// ═════════════════════════════════════════════════════════════════════════
// 11–13. WORKSPACE + OVERWRITE PROTECTION
// ═════════════════════════════════════════════════════════════════════════

test('11. Workspace displays manifest name, vendor and load/truck ID', () => {
  const app = createApp(); app.boot();
  createLoadViaForm(app, { name: 'Costco <Return> Load', vendor: 'Costco', loadId: 'TRK-9', notes: 'long notes here' });
  const html = app.el('receiving-workspace-content').innerHTML;
  assert.ok(html.includes('Costco &lt;Return&gt; Load'), 'name shown and escaped');
  assert.ok(html.includes('Vendor / Source: Costco'));
  assert.ok(html.includes('Load / Truck ID: TRK-9'));
  assert.ok(!html.includes('long notes here'), 'notes not shown prominently');
  assert.ok(html.includes('editLoadName()'), 'name editable from header');
  // Existing destinations and identify methods are still there
  for (const d of ['SAVVY', 'DWI', 'OTHER', 'UNASSIGNED']) assert.ok(html.includes(d), d);
  for (const m of ["'barcode'", "'photo'", "'upc-sku'", "'manual-product'"]) assert.ok(html.includes(m), m);
});

test('12. ← Home does not destroy the active session', () => {
  const ws = staticHtml.slice(staticHtml.indexOf('id="scr-receiving-workspace"'), staticHtml.indexOf('<!-- PHASE 5A: PRODUCT REVIEW SCREEN -->'));
  assert.ok(ws.includes('onclick="goHomeFromLoad()"') && ws.includes('← Home'));
  assert.ok(!ws.includes('← New Receiving'), 'misleading button removed');
  assert.ok(!ws.includes("showScreen('scr-start-receiving')"), 'no route to start screen');

  const app = createApp(); app.boot();
  createLoadViaForm(app, { name: 'Keep Me' });
  const before = app.localStorage.getItem(V3_KEY);
  app.run('goHomeFromLoad()');
  assert.strictEqual(app.currentScreen(), 'scr-home');
  assert.strictEqual(app.localStorage.getItem(V3_KEY), before, 'storage untouched');
  assert.strictEqual(app.session().name, 'Keep Me', 'in-memory session kept');
  assert.ok(app.el('manifest-session-indicator').innerHTML.includes('Keep Me'), 'Resume card shown');
});

test('13. Starting a new load while one is active requires confirmation (both paths)', () => {
  const active = JSON.stringify(legacyV3Session({ name: 'Active Load',
    allocationRecords: [{ id: 'a1', upc: '111', quantity: 4, destination: 'SAVVY', productKey: 'UPC:111' }] }));

  // NO path — declined
  const declineNo = createApp({ localStorage: { [V3_KEY]: active }, confirm: false });
  declineNo.boot();
  assert.strictEqual(declineNo.run('startLoadWithoutManifest()'), false);
  assert.strictEqual(declineNo.confirmCalls.length, 1);
  assert.ok(declineNo.confirmCalls[0].includes('Active Load'));
  assert.strictEqual(declineNo.currentScreen(), 'scr-home');
  assert.strictEqual(declineNo.localStorage.getItem(V3_KEY), active, 'not overwritten');

  // YES path — declined
  const declineYes = createApp({ localStorage: { [V3_KEY]: active }, confirm: false });
  declineYes.boot();
  assert.strictEqual(declineYes.run('startLoadWithManifest()'), false);
  assert.strictEqual(declineYes.currentScreen(), 'scr-home');
  assert.strictEqual(declineYes.localStorage.getItem(V3_KEY), active);

  // NO path — confirmed: replaced only once the new load is created
  const accept = createApp({ localStorage: { [V3_KEY]: active }, confirm: true });
  accept.boot();
  assert.strictEqual(accept.run('startLoadWithoutManifest()'), true);
  assert.strictEqual(accept.localStorage.getItem(V3_KEY), active, 'still intact while on the form');
  accept.setValue('new-manifest-name', 'New Load');
  accept.run('submitNewManifest()');
  assert.strictEqual(accept.stored().name, 'New Load');
  assert.strictEqual(accept.stored().allocationRecords.length, 0);

  // Legacy start-receiving screen buttons are guarded too
  const start = staticHtml.slice(staticHtml.indexOf('id="scr-start-receiving"'), staticHtml.indexOf('<!-- PHASE 5A: ACTIVE RECEIVING SESSION SCREEN -->'));
  assert.ok(start.includes('onclick="startLoadWithManifest()"'));
  assert.ok(start.includes('onclick="startLoadWithoutManifest()"'));
  assert.ok(!start.includes('onclick="startReceivingWithoutManifest()"'), 'unguarded overwrite no longer wired');

  // Reused existing confirmation behavior still exists
  assert.ok(extractFunction('startNewReceivingConfirm').includes('confirm('));
});

// ═════════════════════════════════════════════════════════════════════════
// 14–17. BUG FIXES
// ═════════════════════════════════════════════════════════════════════════

test('14. renderUpcSkuEntry actually renders visible content and stays in the load', async () => {
  const app = createApp(); app.boot();
  createLoadViaForm(app);
  app.el('manual-product-form-content').innerHTML = '';
  app.run("startIdentificationMethod('upc-sku')");
  const html = app.el('manual-product-form-content').innerHTML;
  assert.ok(html.includes('id="upc-sku-entry-input"'), 'input rendered');
  assert.ok(html.includes('submitUpcSkuEntry()'), 'continue button rendered');
  assert.strictEqual(app.currentScreen(), 'scr-manual-product-entry');

  // Works: entering a UPC goes to Product Review inside the load, not Home
  app.setValue('upc-sku-entry-input', '031604032678');
  app.run('submitUpcSkuEntry()');
  await settle();
  assert.strictEqual(app.currentScreen(), 'scr-product-review');
  assert.strictEqual(app.run('receivingState.currentProduct.upc'), '031604032678');
  assert.strictEqual(app.run('receivingState.currentProduct.identificationMethod'), 'manual_upc');
  assert.ok(app.session().receivingActive, 'still inside the active load');

  // SKU entry also works
  app.run("startIdentificationMethod('upc-sku')");
  app.setValue('upc-sku-entry-input', 'NAT-031604032678-1');
  app.run('submitUpcSkuEntry()');
  assert.strictEqual(app.currentScreen(), 'scr-product-review');
  assert.strictEqual(app.run('receivingState.currentProduct.sku'), 'NAT-031604032678-1');
});

test('15. renderManualProductEntry actually renders visible content and stays in the load', () => {
  const app = createApp(); app.boot();
  createLoadViaForm(app);
  app.el('manual-product-form-content').innerHTML = '';
  app.run("startIdentificationMethod('manual-product')");
  const html = app.el('manual-product-form-content').innerHTML;
  for (const id of ['manual-sku-input', 'manual-upc-input', 'manual-desc-input', 'manual-qty-input', 'manual-retail-input', 'manual-ropa-input']) {
    assert.ok(html.includes('id="' + id + '"'), id);
  }
  assert.strictEqual(app.currentScreen(), 'scr-manual-product-entry');

  app.setValue('manual-desc-input', 'Mixed kitchen gadgets');
  app.setValue('manual-qty-input', '3');
  app.run('submitManualProductEntry()');
  assert.strictEqual(app.currentScreen(), 'scr-product-review');
  assert.strictEqual(app.run('receivingState.currentProduct.description'), 'Mixed kitchen gadgets');
  assert.strictEqual(app.run('receivingState.currentProduct.qty'), 3);
});

test('16. Workspace barcode action calls/reuses openScanner() and starts the camera', () => {
  const app = createApp(); app.boot();
  createLoadViaForm(app);
  app.run("startIdentificationMethod('barcode')");
  assert.strictEqual(app.scannerStarts.length, 1, 'camera started');
  assert.strictEqual(app.scannerStarts[0].camera.facingMode, 'environment');
  assert.strictEqual(app.currentScreen(), 'scr-scan');

  // It goes through the one existing openScanner implementation
  const calls = [];
  const spyApp = createApp(); spyApp.boot(); createLoadViaForm(spyApp);
  const original = spyApp.ctx.openScanner;
  spyApp.ctx.openScanner = (ctx) => { calls.push(ctx); return original(ctx); };
  spyApp.run("startIdentificationMethod('barcode')");
  assert.strictEqual(JSON.stringify(calls), JSON.stringify(['receiving']));
  // One barcode scanner ('reader'); the only other instance is the pre-existing
  // ShipStation location QR modal. No new scanner was added by Phase 0.
  assert.strictEqual((appCode.match(/new Html5Qrcode\('reader'\)/g) || []).length, 1, 'no second barcode scanner');
  assert.strictEqual((appCode.match(/new Html5Qrcode\(/g) || []).length, 2, 'no new scanner instances');
});

test('17. Barcode scan from the Workspace preserves receiving context', async () => {
  const app = createApp(); app.boot();
  createLoadViaForm(app, { name: 'Ctx Load' });
  app.run("startIdentificationMethod('barcode')");
  app.scannerStarts[0].onSuccess(' 031604032678 ');
  await settle();
  assert.strictEqual(app.currentScreen(), 'scr-product-review', 'receiving product review, not Quick Lookup details');
  assert.strictEqual(app.run('receivingState.currentProduct.upc'), '031604032678');
  assert.strictEqual(app.run('receivingState.currentProduct.identificationMethod'), 'barcode');
  assert.strictEqual(app.session().name, 'Ctx Load');

  // Typed fallback on the scanner screen keeps the context too
  app.run("startIdentificationMethod('barcode')");
  app.setValue('scanUpc', '012345678905');
  app.run('searchFromScan()');
  await settle();
  assert.strictEqual(app.currentScreen(), 'scr-product-review');
  assert.strictEqual(app.run('receivingState.currentProduct.upc'), '012345678905');

  // Back from the scanner returns to the Workspace
  app.run("startIdentificationMethod('barcode')");
  app.run('backFromReceivingScanner()');
  assert.strictEqual(app.currentScreen(), 'scr-receiving-workspace');
});

// ═════════════════════════════════════════════════════════════════════════
// 18–21. EXISTING BEHAVIOR UNCHANGED
// ═════════════════════════════════════════════════════════════════════════

// Fingerprints of the original (pre-Phase-0, commit 6bf6b41) function source.
// If one of these must change intentionally in a later phase, update it here.
const PROTECTED = {
  searchUPC: '88f09c6e310924a7', identifyUpcOnline: 'ee379b56ad6bc4cd', renderProductDetails: '08b0cce2a51709b3',
  loadSellbriteStatus: 'f796a863f449e38e', renderSellbriteStatus: '335abd6be475fdc2', deriveBrandCandidates: 'b5dc53c36cac1b7d',
  extractPackCount: '9af65fe08d835e03', extractPackCountFromSku: '8e43fee31fa1b80a', selectVariantByPackCount: '50b7ef0f3fcc5934',
  showProductFromProxy: '584681f74f35f533', updateInventory: '5f2c4b268e51ebc6', identifyPhotoFetch: 'a525d5844a9a0eec',
  openPhotoIdentify: '47656146f646b5b3', compressImageToBase64: '36ddbbf46db1da8a', handlePhotoFileSelected: '906c8a5328d9c9c1',
  renderPhotoCandidates: '0bbe1658bba37683', selectPhotoCandidateWithContext: '0dab4d0e0c0c3a16', selectPhotoCandidate: '0cd0d577723810f7',
  confirmUpcInSellbriteAndShow: 'd31e5062feafb600', sendPhotoFeedback: '18436f66bf8d64dd', tryAnotherPhoto: '3a3f1842c55fb23f',
  savvyAuthFetch: '72790c5dd01524fd', savvyLogin: '307d8d383d8404b4', importManifestFile: 'da4185ab6de0c32e',
  confirmDetectedHeader: 'e83fbe9c743d2033', identifyReceivingByUpc: 'fb50fda268bb49ad', recordAllocation: '3e937219ca296a97',
  confirmProductReview: 'e0c893b77afba2e7', submitUpcSkuEntry: '96d4b314ad79e192',
};

test('18. Existing Quick Lookup barcode still works — and never routes into an active load', async () => {
  // No active load
  const app = createApp(); app.boot();
  app.run("openScanner('lookup')");
  assert.strictEqual(app.scannerStarts.length, 1);
  app.scannerStarts[0].onSuccess('031604032678');
  await settle();
  assert.strictEqual(app.currentScreen(), 'scr-product-details');
  assert.ok(app.el('pd-identity').innerHTML.includes('Product Identified — Online (eBay)'));
  assert.ok(app.fetchCalls.some(c => c.url.includes('/api/identify-by-upc?upc=031604032678')));
  assert.ok(app.fetchCalls.some(c => c.url.includes('/sb/search?upc=031604032678')));

  // With an active load: Quick Lookup is still a lookup, the load is untouched
  const active = JSON.stringify(legacyV3Session({ name: 'Busy Load' }));
  const busy = createApp({ localStorage: { [V3_KEY]: active } }); busy.boot();
  busy.run("openScanner('lookup')");
  busy.scannerStarts[0].onSuccess('031604032678');
  await settle();
  assert.strictEqual(busy.currentScreen(), 'scr-product-details');
  assert.strictEqual(busy.run('receivingState.currentProduct'), null, 'nothing pushed into the load');
  assert.strictEqual(busy.localStorage.getItem(V3_KEY), active);
  busy.run("openScanner('lookup')");
  busy.run('backFromReceivingScanner()');
  assert.strictEqual(busy.currentScreen(), 'scr-home', 'Quick Lookup back goes Home');

  // Manual Quick Lookup box: lookup, with or without an active load (previously threw with a load active)
  busy.setValue('manualUpc', '012345678905');
  busy.run('searchManual()');
  await settle();
  assert.strictEqual(busy.currentScreen(), 'scr-product-details');
  assert.ok(busy.fetchCalls.some(c => c.url.includes('/api/identify-by-upc?upc=012345678905')));
});

test('19. Existing Quick Lookup Photo BETA remains unchanged', () => {
  for (const name of ['identifyPhotoFetch', 'openPhotoIdentify', 'compressImageToBase64', 'handlePhotoFileSelected',
    'renderPhotoCandidates', 'selectPhotoCandidateWithContext', 'selectPhotoCandidate', 'confirmUpcInSellbriteAndShow',
    'sendPhotoFeedback', 'tryAnotherPhoto']) {
    assert.strictEqual(fingerprint(name), PROTECTED[name], name + ' source changed');
  }
  for (const id of ['scr-photo-capture', 'scr-photo-candidates', 'scr-photo-verify-fail', 'photo-input-camera', 'photo-input-library']) {
    assert.ok(staticHtml.includes('id="' + id + '"'), id);
  }
  const app = createApp(); app.boot();
  app.run('openPhotoIdentify()');
  assert.strictEqual(app.currentScreen(), 'scr-photo-capture');
});

test('20. Existing online eBay Product Details remain unchanged', async () => {
  for (const name of ['searchUPC', 'identifyUpcOnline', 'renderProductDetails']) {
    assert.strictEqual(fingerprint(name), PROTECTED[name], name + ' source changed');
  }
  const app = createApp(); app.boot();
  await app.run("searchUPC('031604032678')");
  await settle();
  const market = app.el('pd-market').innerHTML;
  assert.ok(market.includes('$9.50 – $15.00'));
  assert.ok(market.includes('Average asking price: $12.25'));
  assert.ok(app.el('pd-identity').innerHTML.includes('Nature Made Collagen Gummies'));
});

test('21. Existing Sellbrite status behavior remains unchanged', async () => {
  for (const name of ['loadSellbriteStatus', 'renderSellbriteStatus', 'deriveBrandCandidates', 'extractPackCount',
    'extractPackCountFromSku', 'selectVariantByPackCount', 'savvyAuthFetch']) {
    assert.strictEqual(fingerprint(name), PROTECTED[name], name + ' source changed');
  }
  // found
  const found = createApp({ fetch: (u) => u.includes('/sb/search')
    ? { status: 200, ok: true, json: async () => ({ status: 'success', products: [{ sku: 'NAT-031604032678-1', inventory: { total_quantity: 7, total_on_hand: 9 } }] }) } : null });
  found.boot();
  await found.run("searchUPC('031604032678')");
  await settle();
  const fHtml = found.el('pd-inventory-status').innerHTML;
  assert.ok(fHtml.includes('Already Listed in Sellbrite') && fHtml.includes('NAT-031604032678-1'));
  assert.ok(found.fetchCalls.some(c => c.url.includes('/sb/search?upc=031604032678&brand=')), 'brand fast-path param still sent');
  // not found
  const nf = createApp(); nf.boot();
  await nf.run("searchUPC('031604032678')"); await settle();
  assert.ok(nf.el('pd-inventory-status').innerHTML.includes('Not Currently Listed in Sellbrite'));
  // error
  const err = createApp({ fetch: (u) => u.includes('/sb/search') ? { status: 500, ok: false, json: async () => ({ status: 'error' }) } : null });
  err.boot();
  await err.run("searchUPC('031604032678')"); await settle();
  assert.ok(err.el('pd-inventory-status').innerHTML.includes('Sellbrite Status Unavailable'));
});

test('Protected Quick Lookup / receiving / auth functions are byte-identical to pre-Phase-0', () => {
  for (const [name, hash] of Object.entries(PROTECTED)) {
    assert.strictEqual(fingerprint(name), hash, name + ' source changed');
  }
});

// ═════════════════════════════════════════════════════════════════════════
// 22. NO INVENTORY WRITES / DATA SAFETY / CONFIG
// ═════════════════════════════════════════════════════════════════════════

test('22. No inventory write endpoint is called by Phase 0', async () => {
  // Static: the Phase 0 code block contains no network calls at all
  const start = appCode.indexOf('// PHASE 0: TRUCK / LOAD ENTRY');
  const end = appCode.indexOf('// PHASE 5A: Unified receiving entry point');
  assert.ok(start > 0 && end > start, 'Phase 0 block found');
  const block = appCode.slice(start, end);
  assert.ok(!/fetch\(|savvyAuthFetch\(|identifyPhotoFetch\(|sbFetch\(/.test(block), 'no network calls in Phase 0 block');
  for (const w of WRITE_ENDPOINTS) assert.ok(!block.includes(w), w);
  for (const fn of ['updateInventory(', 'saveLocation(', 'saveLocations(', 'exitSubmit(', 'manualExitSubmit(']) {
    assert.ok(!block.includes(fn), fn);
  }

  // Dynamic: run every Phase 0 flow and record all requests
  const app = createApp(); app.boot();
  createLoadViaForm(app, { vendor: 'V', loadId: 'L', notes: 'N' });
  app.run('goHomeFromLoad()');
  app.run('resumeActiveLoad()');
  app.run("startIdentificationMethod('upc-sku')");
  app.setValue('upc-sku-entry-input', '031604032678');
  app.run('submitUpcSkuEntry()');
  await settle();
  app.run('confirmProductReview()');
  app.run("startIdentificationMethod('manual-product')");
  app.setValue('manual-desc-input', 'Thing');
  app.run('submitManualProductEntry()');
  app.run('confirmProductReview()');
  app.run("startIdentificationMethod('barcode')");
  app.scannerStarts[0].onSuccess('012345678905');
  await settle();
  app.run('editLoadName()');
  app.run('startLoadWithManifest()');
  assert.deepStrictEqual(app.writeCalls(), [], 'no write endpoint requested');
  assert.ok(app.fetchCalls.every(c => c.method === 'GET'), 'only GET lookups: ' + JSON.stringify(app.fetchCalls));
  assert.strictEqual(app.stored().allocationRecords.length, 2, 'allocations recorded locally only');
});

test('Data safety: v2 storage never deleted, localStorage.clear() never called, save failures are visible', () => {
  const v2 = JSON.stringify({ version: 2, fileName: 'keep.csv', status: 'ready', rows: [] });
  const app = createApp({ localStorage: { [V2_KEY]: v2, [V3_KEY]: JSON.stringify(legacyV3Session({ name: 'Old' })) }, confirm: true });
  app.boot();
  createLoadViaForm(app, { name: 'Replacement' });
  app.run('goHomeFromLoad()');
  app.run('startLoadWithManifest()');
  assert.strictEqual(app.localStorage.getItem(V2_KEY), v2, 'v2 untouched');
  assert.strictEqual(app.localStorage.clearCalls, 0);
  assert.ok(!appCode.includes('localStorage.clear()'));

  // Storage full: banner shown, user told it was NOT saved, no fake success
  const full = createApp(); full.boot();
  full.localStorage.failWrites = true;
  assert.strictEqual(full.el('save-error-banner').style.display, '');
  createLoadViaForm(full, { name: 'Unsaved' });
  assert.strictEqual(full.el('save-error-banner').style.display, 'block');
  assert.ok(full.el('toast').textContent.includes('NOT saved'));
  assert.strictEqual(full.stored(), null);
  assert.strictEqual(full.run('saveManifestSessionToStorageV3(manifestSession)'), false);
  // Recovers once storage works again
  full.localStorage.failWrites = false;
  assert.strictEqual(full.run('saveManifestSessionToStorageV3(manifestSession)'), true);
  assert.strictEqual(full.el('save-error-banner').style.display, 'none');
  assert.strictEqual(full.stored().name, 'Unsaved');
});

test('Config unchanged: backend URLs, no production hostname, TID not implemented', () => {
  assert.ok(appCode.includes("const SB_PROXY = 'https://ample-imagination-clothing-staging.up.railway.app';"));
  assert.ok(appCode.includes("const SAVVY_API_STAGING = 'https://resourceful-passion-production-aa22.up.railway.app';"));
  assert.ok(!htmlContent.includes('savvy-ebay-prices-production'), 'no production backend hostname');
  const start = appCode.indexOf('// PHASE 0: TRUCK / LOAD ENTRY');
  const end = appCode.indexOf('// PHASE 5A: Unified receiving entry point');
  assert.ok(!/\bTID\b|tcin|dpci/i.test(appCode.slice(start, end)), 'TID deferred');
  const form = staticHtml.slice(staticHtml.indexOf('id="scr-new-manifest"'), staticHtml.indexOf('<!-- PHASE 5A: START RECEIVING SCREEN -->'));
  assert.ok(!/\bTID\b|cost/i.test(form), 'no TID / cost fields on the form');
});
