'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function createApp() {
  const root = { innerHTML: '' };
  const storage = new Map();
  const listeners = {};
  const document = {
    activeElement: null,
    body: { addEventListener: (name, callback) => { listeners[name] = callback; } },
    documentElement: { dataset: {} },
    getElementById: () => root
  };
  const window = { addEventListener() {}, crypto: require('node:crypto').webcrypto };
  const context = {
    document,
    window,
    navigator: {},
    localStorage: {
      getItem: key => storage.has(key) ? storage.get(key) : null,
      setItem: (key, value) => storage.set(key, value),
      removeItem: key => storage.delete(key)
    },
    confirm: () => true,
    setTimeout,
    clearTimeout,
    console,
    URL,
    Blob,
    alert() {}
  };
  vm.createContext(context);
  context.CONFIG = {
    lowShakes: 2, expiringSoonDays: 3, supabase: { url: '', anonKey: '' }, packTypes: []
  };
  context.createClient = () => ({});
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const appScript = html.match(/<script type="module">\s*([\s\S]*?)<\/script>/)[1];
  const executableScript = appScript.replace(/^import .*;\s*$/gm, '');
  vm.runInContext(executableScript + `
    globalThis.testApi = {
      state, orderTotal, orderBalance, balanceOf, attendanceCount, shakesRemaining,
      doAdjustAttendance, doDeletePayment, activeCustomers, mergeRecords, migrateCustomer,
      migrateBackupCustomer, portalFor, saveData, renderLogin, currentClubName, renderAdminPage,
      renderApp, authErrorText, OWNER_APPROVAL_WHATSAPP
    };
  `, context);
  return { api: context.testApi, context };
}

test('order quantities affect totals and deleted lines are excluded', () => {
  const { api } = createApp();
  const order = {
    items: [
      { price: 125, quantity: 4 },
      { price: 80, quantity: 2, deleted: true }
    ],
    payments: [{ amount: 300 }]
  };
  assert.equal(api.orderTotal(order), 500);
  assert.equal(api.orderBalance(order), 200);
});

test('attendance counts multiple shakes and permits a confirmed override', () => {
  const { api, context } = createApp();
  const customer = {
    id: 'c1', name: 'Test', joinDate: '2026-01-01', visits: [], attendanceCounts: {},
    attendanceRecords: [],
    packs: [{ id: 'p1', totalShakes: 2, cost: 100, startDate: '2026-01-01', expiryDate: '2027-01-01' }],
    payments: []
  };
  api.state.customers = [customer];
  api.state.attendanceDate = '2026-10-25';
  api.doAdjustAttendance('c1', 1);
  api.doAdjustAttendance('c1', 1);
  context.confirm = () => false;
  api.doAdjustAttendance('c1', 1);
  assert.equal(api.attendanceCount(customer, api.state.attendanceDate), 2);
  context.confirm = () => true;
  api.doAdjustAttendance('c1', 1);
  assert.equal(api.attendanceCount(customer, api.state.attendanceDate), 3);
  assert.equal(api.shakesRemaining(customer), 0);
});

test('payments are soft-deleted without affecting retained history', () => {
  const { api } = createApp();
  const customer = {
    id: 'c2', name: 'Test', joinDate: '2026-01-01', visits: [], attendanceCounts: {},
    attendanceRecords: [],
    packs: [{ id: 'p2', totalShakes: 5, cost: 100, startDate: '2026-01-01', expiryDate: '2027-01-01' }],
    payments: [{ id: 'pay1', amount: 40, date: '2026-10-25', deleted: false }]
  };
  api.state.customers = [customer];
  assert.equal(api.balanceOf(customer), 60);
  api.doDeletePayment('c2', 'pay1');
  assert.equal(api.balanceOf(customer), 100);
  assert.equal(customer.payments.length, 1);
  assert.equal(customer.payments[0].deleted, true);
});

test('sync merge uses the latest record timestamp and keeps tombstones', () => {
  const { api } = createApp();
  const local = [{ id: 'c3', name: 'Newer', updatedAt: 20, createdAt: 1, deleted: true }];
  const remote = [{ id: 'c3', name: 'Older', updatedAt: 10, createdAt: 1, deleted: false }];
  const merged = api.mergeRecords(local, remote, api.migrateCustomer);
  assert.equal(merged[0].name, 'Newer');
  assert.equal(merged[0].deleted, true);
  api.state.customers = merged;
  assert.equal(api.activeCustomers().length, 0);
});

test('sync merges independent nested payments and retains attendance tombstones', () => {
  const { api } = createApp();
  const local = [{
    id: 'c5', name: 'Local', updatedAt: 30, createdAt: 1,
    packs: [], payments: [{ id: 'local-pay', amount: 10, updatedAt: 20 }],
    attendanceRecords: [{ id: 'visit-1', date: '2026-10-01', shakes: 0, deleted: true, updatedAt: 30 }],
    visits: []
  }];
  const remote = [{
    id: 'c5', name: 'Remote', updatedAt: 40, createdAt: 1,
    packs: [], payments: [{ id: 'remote-pay', amount: 20, updatedAt: 25 }],
    attendanceRecords: [{ id: 'visit-1', date: '2026-10-01', shakes: 1, deleted: false, updatedAt: 10 }],
    visits: ['2026-10-01']
  }];
  const merged = api.mergeRecords(local, remote, api.migrateCustomer)[0];
  assert.equal(merged.name, 'Remote');
  assert.equal(merged.payments.length, 2);
  assert.equal(merged.attendanceRecords[0].deleted, true);
  assert.equal(merged.visits.length, 0);
});

test('customer portal snapshot contains only that customer history', () => {
  const { api } = createApp();
  const customer = {
    id: 'c4', name: 'Private customer', joinDate: '2026-10-01',
    packs: [{ id: 'p4', packType: '12-day', totalShakes: 12, cost: 600, startDate: '2026-10-01', expiryDate: '2026-10-13' }],
    payments: [{ id: 'pay4', date: '2026-10-02', amount: 100, note: 'cash' }],
    visits: ['2026-10-02'], attendanceCounts: { '2026-10-02': 2 },
    attendanceRecords: [{ id: 'a4', date: '2026-10-02', shakes: 2, deleted: false }]
  };
  const portal = api.portalFor(customer);
  assert.equal(portal.name, 'Private customer');
  assert.equal(portal.payments.length, 1);
  assert.equal(portal.attendanceCounts['2026-10-02'], 2);
  assert.equal(portal.packs[0].startDate, '2026-10-01');
});

test('customer registration asks for identity, mobile, password confirmation, and club', () => {
  const { api } = createApp();
  api.state.authForm.role = 'customer';
  api.state.authForm.mode = 'register';
  api.state.clubDirectory = [{ id: 'club-a', name: 'Nutrition Club A' }];
  api.state.authForm.clubId = 'club-a';
  const html = api.renderLogin();
  assert.match(html, /Back to customer login/);
  assert.match(html, /Name/);
  assert.match(html, /Mobile Number \(with country code\)/);
  assert.match(html, /Confirm password/);
  assert.match(html, /Nutrition Club A/);
  assert.match(html, /approve and link/i);
});

test('owner setup requests club owner name, club name, mobile, and password confirmation', () => {
  const { api } = createApp();
  api.state.authForm.role = 'owner';
  api.state.authForm.mode = 'setup';
  const html = api.renderLogin();
  assert.match(html, /Club Owner name/);
  assert.match(html, /Nutrition Club Name/);
  assert.match(html, /Mobile Number \(with country code\)/);
  assert.match(html, /Confirm password/);
});

test('new owner signup displays the requested administrator WhatsApp approval dialog', () => {
  const { api } = createApp();
  api.state.ownerApprovalNotice = true;
  const html = api.renderLogin();
  assert.match(html, /Owner account submitted/);
  assert.match(html, /waiting for administrator approval/);
  assert.equal(api.OWNER_APPROVAL_WHATSAPP, 'https://api.whatsapp.com/send/?phone=+919787801006&text=Hi+Trishul%21%21%21%21+Kindly+Approve+the+New+Club+Registered%21%21%21++Thanks.&type=phone_number&app_absent=0');
  assert.ok(html.includes('href="' + api.OWNER_APPROVAL_WHATSAPP + '"'));
  assert.match(html, /Contact admin on WhatsApp/);
});

test('admin route renders a sign-in screen and an owner approval queue', () => {
  const { api } = createApp();
  const loginHtml = api.renderAdminPage();
  assert.match(loginHtml, /Admin login/);
  assert.match(loginHtml, /value="neonutritionclub@gmail\.com"/);
  assert.match(loginHtml, /id="admin-password"[^>]*value=""/);
  api.state.adminAuthenticated = true;
  api.state.adminRequests = [{
    uid: 'owner-1', ownerName: 'Owner One', clubName: 'Nutrition Club One',
    mobile: '+919876543210', createdAt: Date.now()
  }];
  const html = api.renderAdminPage();
  assert.match(html, /Pending owner requests \(1\)/);
  assert.match(html, /Nutrition Club One/);
  assert.match(html, /data-action="approveOwner"/);
  assert.match(html, /data-action="rejectOwner"/);
});

test('registration-only customer migration does not create an unpriced shake pack', () => {
  const { api } = createApp();
  const customer = api.migrateCustomer({
    id: 'pending-customer', name: 'New customer', registrationOnly: true, packs: []
  });
  assert.equal(customer.packs.length, 0);
  assert.equal(api.portalFor(customer).shakesTotal, 0);
});

test('Firebase backup account links are removed but Supabase account links remain', () => {
  const { api } = createApp();
  const legacy = api.migrateBackupCustomer({ id: 'old', name: 'Legacy', login: { uid: 'firebaseuid123' } });
  const supabase = api.migrateBackupCustomer({
    id: 'new', name: 'Current', login: { uid: '2de0c5e0-65cf-4ec3-b932-8739d1f5d723' }
  });
  assert.equal(legacy.login, undefined);
  assert.equal(supabase.login.uid, '2de0c5e0-65cf-4ec3-b932-8739d1f5d723');
});

test('legacy-login restore notice remains visible without changing sync status', () => {
  const { api } = createApp();
  api.state.session = { status: 'in', role: 'owner', uid: 'owner-1', username: 'Owner' };
  api.state.dataNotice = 'Old account link(s) were removed.';
  const html = api.renderApp();
  assert.match(html, /Old account link\(s\) were removed\./);
  assert.match(html, /data-action="dismissDataNotice"/);
});

test('signup rate-limit errors explain why owner requests are not listed', () => {
  const { api } = createApp();
  const message = api.authErrorText({ code: 'over_email_send_rate_limit' });
  assert.match(message, /email confirmation/i);
  assert.match(message, /No owner request is created until signup succeeds/i);
  assert.match(api.authErrorText({ code: 'over_request_rate_limit' }), /wait for the limit to reset/i);
});

test('Supabase schema scopes data and protects owner approvals', () => {
  const schema = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'schema.sql'), 'utf8');
  assert.match(schema, /create table if not exists public\.owner_requests/);
  assert.match(schema, /create table if not exists public\.platform_admins/);
  assert.match(schema, /create table if not exists public\.customer_registrations/);
  assert.match(schema, /create table if not exists public\.customer_portals/);
  assert.match(schema, /create or replace function public\.review_owner_request/);
  assert.match(schema, /if not public\.is_platform_admin\(\)/);
  assert.match(schema, /public\.is_club_owner\(club_id\)/);
  assert.match(schema, /select public\.is_club_owner\(target_club_id\) and exists/);
  assert.match(schema, /customer_uid = auth\.uid\(\)::text/);
  assert.doesNotMatch(schema, /raise exception 'Supabase Realtime publication is unavailable'/);
  assert.match(schema, /from pg_publication where pubname = 'supabase_realtime'/);
  assert.doesNotMatch(schema, /to_regclass\('public\.supabase_realtime'\)/);
});

test('Supabase schema restricts ledger access to club owners', () => {
  const schema = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'schema.sql'), 'utf8');
  assert.match(schema, /create table if not exists public\.club_ledgers/);
  assert.match(schema, /alter table public\.club_ledgers enable row level security/);
  assert.match(schema, /where club_id = target_club_id\s+and owner_uid = auth\.uid\(\)::text/);
  assert.match(schema, /create policy "Club owners can access their ledger"/);
  assert.match(schema, /create policy "Customers and club owners can read portal cards"/);
  assert.match(schema, /grant select on public\.clubs to anon/);
});

test('Vercel static deployment disables stale service worker caching', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  assert.equal(packageJson.scripts['supabase:login'], 'supabase login');
  assert.equal(packageJson.scripts['supabase:deploy'], 'supabase functions deploy manage-account');
  assert.equal(packageJson.devDependencies.supabase, '2.122.0');
  assert.equal(packageJson.scripts.build, 'vite build');
  assert.equal(packageJson.scripts.dev, 'vite --host 0.0.0.0');
  assert.ok(packageJson.dependencies['@supabase/supabase-js']);
  const vercel = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'vercel.json'), 'utf8'));
  assert.equal(vercel.trailingSlash, false);
  assert.equal(vercel.rewrites[0].source, '/admin/login');
  assert.equal(vercel.rewrites[0].destination, '/');
  assert.equal(vercel.rewrites[1].source, '/(.*)');
  assert.equal(vercel.rewrites[1].destination, '/');
  assert.equal(vercel.buildCommand, 'npm run build');
  assert.equal(vercel.outputDirectory, 'dist');
  assert.equal(vercel.headers[0].source, '/sw.js');
  assert.match(vercel.headers[0].headers[0].value, /no-cache/);
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.match(html, /href="\/manifest\.json"/);
  assert.match(html, /import \{ createClient \} from '@supabase\/supabase-js'/);
  assert.match(html, /import CONFIG from '\/js\/config\.js'/);
  assert.match(html, /<script type="module">/);
  assert.match(html, /register\('\/sw\.js'\)/);
  assert.doesNotMatch(html, /firebase/i);
  assert.match(html, /supabaseClient\.auth\.signInWithPassword/);
  assert.match(html, /supabaseClient\.rpc\('review_owner_request'/);
  const config = fs.readFileSync(path.join(__dirname, '..', 'js', 'config.js'), 'utf8');
  assert.match(config, /supabase:/);
  assert.match(config, /import\.meta\.env\.VITE_SUPABASE_URL/);
  assert.match(config, /import\.meta\.env\.VITE_SUPABASE_ANON_KEY/);
  assert.doesNotMatch(config, /firebase/i);
  const worker = fs.readFileSync(path.join(__dirname, '..', 'sw.js'), 'utf8');
  assert.doesNotMatch(worker, /firebase/i);
  assert.doesNotMatch(worker, /supabase-js/);
  const viteConfig = fs.readFileSync(path.join(__dirname, '..', 'vite.config.js'), 'utf8');
  assert.match(viteConfig, /publicDir: 'public'/);
  const functionSource = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'functions', 'manage-account', 'index.ts'), 'utf8');
  assert.match(functionSource, /auth\.admin\.createUser/);
  assert.match(functionSource, /auth\.admin\.updateUserById/);
  assert.match(functionSource, /is required/);
});
