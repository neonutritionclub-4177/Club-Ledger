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
    getElementById: () => root,
    querySelector: () => null
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
    URLSearchParams,
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
      migrateBackupCustomer, portalFor, saveData, doSaveApprovalPack, renderLogin, currentClubName, renderAdminPage, renderAdminReports,
      applyAdminClubFilter, renderCustomers, renderDashboard, renderAdminClubs, valueBars, adminReportRanges, handleAction,
      renderApp, renderModal, authErrorText, OWNER_APPROVAL_WHATSAPP,
      buildAdminReportData, renderAdminReportDocument, adminReportPrintHtml,
      renderOwnerPaymentSettings, renderPortalCard, upiPaymentLink,
      saveOwnerPaymentSettings, doSaveApprovalPack, doRenewPack,
      setSupabaseClient: function (client) { supabaseClient = client; }
    };
  `, context);
  return { api: context.testApi, context, root, listeners };
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

test('customer registration asks for identity, email, mobile, password confirmation, and club', () => {
  const { api } = createApp();
  api.state.authForm.role = 'customer';
  api.state.authForm.mode = 'register';
  api.state.clubDirectory = [{ id: 'club-a', name: 'Nutrition Club A' }];
  api.state.authForm.clubId = 'club-a';
  const html = api.renderLogin();
  assert.match(html, /Back to customer login/);
  assert.match(html, /Name/);
  assert.match(html, /id="auth-email" type="email"/);
  assert.match(html, /Mobile Number \(with country code\)/);
  assert.match(html, /Confirm password/);
  assert.match(html, /Nutrition Club A/);
  assert.match(html, /approve and link/i);
});

test('owner setup requests owner name, club name, real email, mobile, and password confirmation', () => {
  const { api } = createApp();
  api.state.authForm.role = 'owner';
  api.state.authForm.mode = 'setup';
  const html = api.renderLogin();
  assert.match(html, /Club Owner name/);
  assert.match(html, /Nutrition Club Name/);
  assert.match(html, /id="auth-email" type="email"/);
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

test('admin route renders sign-in and keeps owner approvals in Clubs', () => {
  const { api } = createApp();
  const loginHtml = api.renderAdminPage();
  assert.match(loginHtml, /Admin login/);
  assert.match(loginHtml, /value="neonutritionclub@gmail\.com"/);
  assert.match(loginHtml, /id="admin-password"[^>]*value=""/);
  api.state.adminAuthenticated = true;
  api.state.adminRequests = [{
    uid: 'owner-1', ownerName: 'Owner One', clubName: 'Nutrition Club One',
    mobile: '+919876543210', email: 'owner@example.com', status: 'pending',
    createdAt: Date.now(), archived: false
  }];
  const dashboard = api.renderAdminPage();
  assert.doesNotMatch(dashboard, /Pending owner requests/);
  api.state.adminTab = 'clubs';
  const html = api.renderAdminPage();
  assert.match(html, /Pending owner approvals \(1\)/);
  assert.match(html, /Nutrition Club One/);
  assert.match(html, /owner@example\.com/);
  assert.match(html, /data-action="approveOwner"/);
  assert.match(html, /data-action="rejectOwner"/);
  assert.match(html, /type="month" data-bind="adminForm.monthFilter"/);
  assert.match(html, /Past approvals &amp; requests/);
  assert.match(html, /data-action="archiveOwnerRequest"/);
  assert.match(html, /data-action="editOwnerRequest"/);
  api.state.adminRequests.push(
    { uid: 'owner-approved', ownerName: 'Approved', clubName: 'Approved Club', status: 'approved', createdAt: Date.now() },
    { uid: 'owner-revoked', ownerName: 'Revoked', clubName: 'Revoked Club', status: 'revoked', createdAt: Date.now() }
  );
  const historyHtml = api.renderAdminPage();
  assert.match(historyHtml, /data-action="revokeOwner"/);
  assert.match(historyHtml, /data-action="restoreOwnerAccess"/);
});

test('admin reports aggregate clubs and identify the club for daily and monthly entries', () => {
  const { api } = createApp();
  api.state.adminAuthenticated = true;
  api.state.adminClubs = [
    {
      id: 'club-a', name: 'Nutrition Club A', approved: true,
      ledger: {
        customers: [{
          id: 'customer-a', name: 'A Customer', joinDate: '2026-10-01',
          visits: ['2026-10-28'], packs: [],
          payments: [{ id: 'payment-a', date: '2026-10-28', amount: 250 }]
        }],
        orders: []
      }
    },
    {
      id: 'club-b', name: 'Nutrition Club B', approved: true,
      ledger: {
        customers: [{
          id: 'customer-b', name: 'B Customer', joinDate: '2026-10-01',
          visits: ['2026-10-28'], packs: [],
          payments: [{ id: 'payment-b', date: '2026-10-28', amount: 450 }]
        }],
        orders: []
      }
    }
  ];
  api.applyAdminClubFilter();
  api.state.adminTab = 'reports';
  api.state.adminReportPeriod = 'monthly';
  const html = api.renderAdminPage();
  assert.match(html, /All registered clubs/);
  assert.match(html, /Nutrition Club A · A Customer/);
  assert.match(html, /Nutrition Club B · B Customer/);
  assert.match(html, /₹700/);
  assert.match(html, /Daily/);
  assert.match(html, /Monthly/);
});

test('all admin navigation buttons open their matching screens', () => {
  const { api, root } = createApp();
  api.state.adminAuthenticated = true;
  api.state.adminClubs = [{
    id: 'club-nav', name: 'Navigation Club', approved: true,
    ledger: {
      customers: [{
        id: 'customer-nav', name: 'Navigation Customer', phone: '1234567890',
        joinDate: '2026-10-01', visits: [], packs: [], payments: []
      }],
      orders: [{
        id: 'order-nav', customerName: 'Order Customer', date: '2026-10-01',
        items: [{ id: 'item-nav', name: 'Shake', price: 100, quantity: 1 }],
        payments: []
      }]
    }
  }];
  api.applyAdminClubFilter();

  for (const [tab, heading] of [
    ['clubs', 'Registered clubs'],
    ['customers', 'Customers joined in this period'],
    ['orders', 'Orders in this period'],
    ['attendance', 'Attendance ·'],
    ['reports', 'Daily']
  ]) {
    api.handleAction('setAdminTab', { dataset: { value: tab } });
    assert.equal(api.state.adminTab, tab);
    const html = api.renderAdminPage();
    assert.match(html, new RegExp(heading));
    if (['clubs', 'customers', 'orders', 'attendance'].includes(tab)) {
      assert.match(html, /data-action="setAdminReportPeriod" data-value="daily"/);
      assert.match(html, /data-action="setAdminReportPeriod" data-value="weekly"/);
      assert.match(html, /data-action="setAdminReportPeriod" data-value="monthly"/);
    }
  }
});

test('admin daily, weekly, and monthly controls filter the customer, order, and attendance pages', () => {
  const { api } = createApp();
  api.state.adminAuthenticated = true;
  const today = new Date();
  const dateString = date => date.getFullYear() + '-' +
    String(date.getMonth() + 1).padStart(2, '0') + '-' +
    String(date.getDate()).padStart(2, '0');
  const offsetDate = offset => {
    const date = new Date(today);
    date.setDate(date.getDate() + offset);
    return dateString(date);
  };
  const recent = offsetDate(-3);
  const priorMonth = offsetDate(-40);
  api.state.adminClubs = [{
    id: 'period-club', name: 'Period Club', approved: true,
    ledger: {
      customers: [
        { id: 'customer-today', name: 'Today Customer', joinDate: offsetDate(0), visits: [offsetDate(0)], packs: [], payments: [] },
        { id: 'customer-week', name: 'Week Customer', joinDate: recent, visits: [recent], packs: [], payments: [] },
        { id: 'customer-month', name: 'Month Customer', joinDate: offsetDate(-15), visits: [offsetDate(-15)], packs: [], payments: [] },
        { id: 'customer-older', name: 'Older Customer', joinDate: priorMonth, visits: [priorMonth], packs: [], payments: [] }
      ],
      orders: [
        { id: 'order-today', customerName: 'Today Customer', date: offsetDate(0), items: [], payments: [] },
        { id: 'order-week', customerName: 'Week Customer', date: recent, items: [], payments: [] },
        { id: 'order-older', customerName: 'Older Customer', date: priorMonth, items: [], payments: [] }
      ]
    }
  }];
  api.applyAdminClubFilter();

  api.state.adminTab = 'customers';
  api.state.adminReportPeriod = 'daily';
  assert.match(api.renderAdminPage(), /Today Customer/);
  assert.doesNotMatch(api.renderAdminPage(), /Week Customer/);
  api.state.adminReportPeriod = 'weekly';
  assert.match(api.renderAdminPage(), /Week Customer/);
  assert.doesNotMatch(api.renderAdminPage(), /Older Customer/);
  api.state.adminReportPeriod = 'monthly';
  assert.match(api.renderAdminPage(), /Month Customer/);
  assert.doesNotMatch(api.renderAdminPage(), /Older Customer/);

  api.state.adminTab = 'orders';
  api.state.adminReportPeriod = 'weekly';
  assert.match(api.renderAdminPage(), /Week Customer/);
  assert.doesNotMatch(api.renderAdminPage(), /Older Customer/);

  api.state.adminTab = 'attendance';
  api.state.attendanceDate = offsetDate(0);
  api.state.adminReportPeriod = 'weekly';
  assert.match(api.renderAdminPage(), /Attendance ·/);
  assert.match(api.renderAdminPage(), /data-value="weekly" aria-pressed="true"/);
});

test('admin dashboard metrics navigate to the correct workspace tabs', () => {
  const { api } = createApp();
  api.state.adminAuthenticated = true;
  for (const [metric, tab] of [
    ['Registered clubs', 'clubs'],
    ['Customers', 'customers'],
    ["Today's visits", 'attendance'],
    ['Total collected', 'reports'],
    ['Collected today', 'reports'],
    ['Total balance due', 'reports']
  ]) {
    api.handleAction('goAdminTab', { dataset: { value: tab } });
    assert.equal(api.state.adminTab, tab, metric);
  }
});

test('admin has club-wise numeric charts and selected-club daily weekly monthly reports', () => {
  const { api } = createApp();
  api.state.adminAuthenticated = true;
  const today = new Date();
  const todayText = today.getFullYear() + '-' + String(today.getMonth() + 1).padStart(2, '0') + '-' + String(today.getDate()).padStart(2, '0');
  api.state.adminClubs = [
    {
      id: 'club-chart-a', name: 'Chart Club Alpha', approved: true,
      ledger: { customers: [{ id: 'customer-a', name: 'A', visits: [todayText], payments: [{ id: 'payment-a', date: todayText, amount: 350 }], packs: [] }], orders: [] }
    },
    {
      id: 'club-chart-b', name: 'Chart Club Beta', approved: true,
      ledger: { customers: [], orders: [{ id: 'order-b', customerName: 'B', date: todayText, items: [], payments: [{ id: 'payment-b', date: todayText, amount: 150 }] }] }
    }
  ];
  api.applyAdminClubFilter();
  api.state.adminTab = 'reports';
  let html = api.renderAdminPage();
  assert.match(html, /Chart Club Alpha/);
  assert.match(html, /Chart Club Beta/);
  assert.match(html, /admin-chart-value/);
  assert.match(html, /Daily/);
  assert.match(html, /Weekly/);
  assert.match(html, /Monthly/);

  api.state.adminForm.clubFilter = 'club-chart-a';
  api.applyAdminClubFilter();
  api.state.adminReportPeriod = 'monthly';
  const selectedReport = api.renderAdminReports();
  assert.match(selectedReport, /Chart Club Alpha · monthly collections/);
  assert.doesNotMatch(selectedReport, /Chart Club Beta/);
});

test('admin Clubs page owns owner-approval controls and dashboard no longer shows the queue', () => {
  const { api } = createApp();
  api.state.adminAuthenticated = true;
  api.state.adminClubs = [{ id: 'club-owner', name: 'Owner Club', approved: false, ledger: {} }];
  api.state.adminRequests = [{
    uid: 'owner-pending', ownerName: 'Pending Owner', clubName: 'Owner Club',
    mobile: '1234567890', email: 'owner@example.com', status: 'pending', createdAt: Date.now()
  }];
  const dashboard = api.renderAdminPage();
  assert.doesNotMatch(dashboard, /Pending owner approvals/);
  api.state.adminTab = 'clubs';
  const clubs = api.renderAdminPage();
  assert.match(clubs, /Registered clubs/);
  assert.match(clubs, /Pending owner approvals/);
  assert.match(clubs, /Pending Owner/);
  assert.match(clubs, /data-action="approveOwner"/);
});

test('admin theme toggle control is available and report labels have dark-mode contrast rules', () => {
  const { api } = createApp();
  api.state.adminAuthenticated = true;
  const html = api.renderAdminPage();
  assert.match(html, /Toggle admin light or dark mode/);
  const source = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.match(source, /html\[data-theme="dark"\] \.report-row \.name/);
  assert.match(source, /html\[data-theme="dark"\] \.admin-club-name/);
});

test('all report charts show complete dates below their matching bars', () => {
  const { api } = createApp();
  const bars = api.valueBars(['Oct 15', 'Oct 16'], [20, 35], 1);
  assert.match(bars, /vbar-track[\s\S]*vbar-day">Oct 15/);
  assert.match(bars, /vbar-track[\s\S]*vbar-day">Oct 16/);
  const dailyLabels = api.adminReportRanges('daily').map(range => range.label);
  const weeklyLabels = api.adminReportRanges('weekly').map(range => range.label);
  const monthlyLabels = api.adminReportRanges('monthly').map(range => range.label);
  assert.match(dailyLabels[0], /[A-Za-z]{3}/);
  assert.match(weeklyLabels[0], /–/);
  assert.match(monthlyLabels[0], /20\d{2}/);
  const source = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.doesNotMatch(source.match(/\.admin-chart-name \{[^}]+\}/)[0], /transform:\s*rotate/);
});

test('admin report export includes custom-range club, daily, weekly, and monthly charts', () => {
  const { api, context } = createApp();
  api.state.adminForm = { clubFilter: 'all' };
  api.state.adminClubs = [
    {
      id: 'report-a', name: 'Report Club A', approved: true,
      ledger: {
        customers: [{
          id: 'report-customer', name: 'Report Customer', visits: ['2026-10-28'],
          attendanceCounts: { '2026-10-28': 2 }, packs: [],
          payments: [{ id: 'report-payment', date: '2026-10-28', amount: 350 }]
        }],
        orders: []
      }
    },
    {
      id: 'report-b', name: 'Report Club B', approved: true,
      ledger: {
        customers: [],
        orders: [{
          id: 'report-order', customerName: 'Order Customer', date: '2026-10-29',
          items: [], payments: [{ id: 'report-order-payment', date: '2026-10-29', amount: 150 }]
        }]
      }
    }
  ];

  const data = api.buildAdminReportData('2026-10-28', '2026-10-29', 'all');
  assert.equal(data.summary.collected, 500);
  assert.deepEqual(JSON.parse(JSON.stringify(data.charts.collectionByClub)), [
    { label: 'Report Club A', value: 350 },
    { label: 'Report Club B', value: 150 }
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(data.charts.dailyCollections)), [
    { label: 'Wed, 28 Oct, 2026', value: 350 },
    { label: 'Thu, 29 Oct, 2026', value: 150 }
  ]);
  assert.equal(data.charts.weeklyCollections.length, 1);
  assert.equal(data.charts.monthlyCollections.length, 1);

  const previewHtml = api.renderAdminReportDocument(data);
  const printHtml = api.adminReportPrintHtml(data);
  for (const html of [previewHtml, printHtml]) {
    assert.match(html, /Collections by club/);
    assert.match(html, /Daily collections/);
    assert.match(html, /Weekly collections/);
    assert.match(html, /Monthly collections/);
    assert.match(html, /Report Club A/);
    assert.match(html, /28 Oct, 2026/);
    assert.match(html, /admin-print-chart-value/);
    assert.match(html, /admin-print-chart-label/);
  }

  api.state.adminAuthenticated = true;
  api.state.modal = { type: 'adminReportExport' };
  api.state.modalForm = { startDate: '2026-10-29', endDate: '2026-10-28', error: '' };
  api.handleAction('previewAdminReport', { dataset: {} });
  assert.equal(api.state.modalForm.error, 'Choose a valid start and end date.');

  api.state.modalForm = { preview: true, reportData: data, error: '' };
  context.window.open = () => null;
  api.handleAction('downloadAdminReportPdf', { dataset: {} });
  assert.match(api.state.modalForm.error, /print window was blocked/i);
});

test('deleted customers are accessible from Customers and offer restore or permanent delete', () => {
  const { api } = createApp();
  api.state.filter = 'deleted';
  api.state.customers = [{
    id: 'deleted-customer', name: 'Deleted Customer', phone: '1234567890',
    joinDate: '2026-10-01', createdAt: Date.now(), updatedAt: Date.now(),
    deleted: true, packs: [], payments: [], visits: []
  }];
  const html = api.renderCustomers();
  assert.match(html, /Deleted customers/);
  assert.match(html, /Download backup|Open backup &amp; restore/);
  assert.match(html, /data-action="restoreCustomer"/);
  assert.match(html, /data-action="openPermanentDeleteCustomer"/);

  api.state.modal = { type: 'permanentDeleteCustomer', id: 'deleted-customer' };
  api.state.modalForm = { busy: false, error: '' };
  const confirmHtml = api.renderModal();
  assert.match(confirmHtml, /Permanently delete customer/);
  assert.match(confirmHtml, /attendance, pack, and payment history/);
});

test('customer approval continues to a priced pack payment request', () => {
  const { api, context } = createApp();
  context.CONFIG.packTypes = [
    { id: '6-day', label: '6-day', totalShakes: 6, durationDays: 6 },
    { id: 'custom', label: 'Custom', totalShakes: 30, durationDays: 30 }
  ];
  api.state.ownerPaymentSettings = { upiId: 'owner@upi', packPrices: { '6-day': 600, custom: 3000 } };
  api.state.customers = [{
    id: 'approved-customer', name: 'Approved Customer', joinDate: '2026-10-01',
    login: { uid: 'customer-auth-uid' }, packs: [], payments: [], visits: []
  }];
  api.state.modal = { type: 'approvalPack', id: 'approved-customer' };
  api.state.modalForm = {
    packType: '6-day', busy: false, error: ''
  };
  const html = api.renderModal();
  assert.match(html, /Choose customer pack/);
  assert.match(html, /send a payment request/i);
  assert.match(html, /6-day · 6 shakes · ₹600/);
  assert.match(html, /Send payment request/);
  assert.doesNotMatch(html, /Payment received now/);
});

test('owner can edit UPI pack prices and customer notification offers verified UPI payment', () => {
  const { api, context } = createApp();
  context.CONFIG.packTypes = [
    { id: '6-day', label: '6-day', totalShakes: 6, durationDays: 6 },
    { id: 'custom', label: 'Custom', totalShakes: 30, durationDays: 30 }
  ];
  api.state.ownerPaymentSettings = {
    upiId: 'owner@upi',
    packPrices: { '6-day': 600, custom: 3000 }
  };
  const settings = api.renderOwnerPaymentSettings();
  assert.match(settings, /Owner UPI ID/);
  assert.match(settings, /data-bind="ownerPaymentSettings\.packPrices\.6-day"/);
  assert.match(settings, /Save payment settings/);

  const request = {
    id: 'payment-request-1', status: 'pending', pack_type: '6-day',
    total_shakes: 6, amount: 600, upi_id: 'owner@upi'
  };
  const paymentUrl = api.upiPaymentLink(request, 'gpay');
  assert.match(paymentUrl, /^intent:\/\/pay\?/);
  assert.match(paymentUrl, /package=com\.google\.android\.apps\.nbu\.paisa\.user/);
  assert.match(paymentUrl, /pa=owner%40upi/);
  assert.match(paymentUrl, /am=600\.00/);
  assert.match(paymentUrl, /cu=INR/);
  assert.equal(api.upiPaymentLink(request), '');
  assert.match(api.upiPaymentLink(request, 'phonepe'), /package=com\.phonepe\.app/);
  assert.match(api.upiPaymentLink(request, 'paytm'), /package=net\.one97\.paytm/);
  assert.match(api.upiPaymentLink(request, 'supermoney'), /package=money\.super\.payments/);

  api.state.customerPaymentRequests = [request];
  api.state.paymentError = '';
  api.state.paymentSettingsMessage = '';
  const notification = api.renderPortalCard({
    name: 'Customer', shakesLeft: 0, shakesTotal: 0, lowAt: 2,
    packExpiryDate: '', balance: 0, credit: 0, packs: [], payments: [],
    visits: [], attendanceCounts: [], paymentSettings: {
      upiId: 'owner@upi', packPrices: { '6-day': 600, custom: 3000 }
    }
  });
  assert.match(notification, /Payment notification/);
  assert.match(notification, /Google Pay/);
  assert.match(notification, /PhonePe/);
  assert.match(notification, /Paytm/);
  assert.match(notification, /SuperMoney/);
  assert.match(notification, /Pending amount: ₹600/);
  assert.doesNotMatch(notification, /Renew or choose a pack/);
  assert.doesNotMatch(notification, /upi:\/\/pay\?/);
  assert.match(notification, /UPI transaction ID \/ UTR/);
  assert.match(notification, /I have paid/);
  assert.match(notification, /Decline request/);
  assert.match(notification, /activates only after the owner verifies payment/);
  api.state.session = { profile: { clubId: 'club-pay' } };
  assert.equal(api.portalFor({
    name: 'Customer', packs: [], payments: [], visits: [], attendanceCounts: {}
  }).pendingPackAmount, 600);
});

test('customers cannot choose or request their own renewal pack', () => {
  const { api, context } = createApp();
  context.CONFIG.packTypes = [{ id: '6-day', label: '6-day', totalShakes: 6, durationDays: 6 }];
  api.state.customerPaymentRequests = [];
  const portal = api.renderPortalCard({
    name: 'Customer', shakesLeft: 1, shakesTotal: 6, lowAt: 2,
    packExpiryDate: '', balance: 0, credit: 0, packs: [], payments: [],
    visits: [], attendanceCounts: []
  });
  assert.doesNotMatch(portal, /Renew or choose a pack|Choose a pack to request|requestCustomerPack/);
  const appSource = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.doesNotMatch(appSource, /function requestCustomerPack/);
  assert.doesNotMatch(appSource, /data-action="requestCustomerPack"/);
});

test('owner can set a custom shake count and amount for a customer renewal', () => {
  const { api, context } = createApp();
  context.CONFIG.packTypes = [
    { id: '6-day', label: '6-day', totalShakes: 6, durationDays: 6 },
    { id: 'custom', label: 'Custom', totalShakes: 30, durationDays: 30 }
  ];
  api.state.ownerPaymentSettings = { upiId: 'owner@upi', packPrices: { '6-day': 600 } };
  const customer = {
    id: 'renew-customer', name: 'Renew Customer', login: { uid: 'customer-uid' },
    packs: [{ totalShakes: 6, usedOffset: 5, cost: 600, startDate: '2026-10-01', expiryDate: '2026-10-31' }],
    payments: [], visits: []
  };
  api.state.customers = [customer];
  api.state.session = {
    status: 'in', role: 'owner', uid: 'owner-uid',
    profile: { clubId: 'club-pay', clubName: 'Payment Club' }
  };
  api.state.modal = { type: 'renew', id: customer.id };
  api.state.modalForm = { packType: 'custom', totalShakes: '18', cost: '1450', busy: false, error: '' };
  const modal = api.renderModal();
  assert.match(modal, /Pack size \(shakes\)/);
  assert.match(modal, /Customer amount \(₹\)/);
  assert.match(modal, /Send pack payment request/);

  const calls = [];
  api.setSupabaseClient({
    rpc: (name, args) => {
      calls.push({ name, args });
      return Promise.resolve({ data: { id: args.request_id, status: 'pending' }, error: null });
    },
    from: () => {
      const builder = {
        select() { return builder; },
        eq() { return builder; },
        order() { return builder; },
        limit() { return builder; },
        then(resolve, reject) { return Promise.resolve({ data: [], error: null }).then(resolve, reject); }
      };
      return builder;
    }
  });
  api.doRenewPack();
  return Promise.resolve().then(() => Promise.resolve()).then(() => Promise.resolve()).then(() => {
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, 'create_owner_pack_request');
    assert.equal(calls[0].args.target_customer_id, customer.id);
    assert.equal(calls[0].args.target_pack_type, 'custom');
    assert.equal(calls[0].args.target_total_shakes, 18);
    assert.equal(calls[0].args.target_duration_days, 30);
    assert.equal(calls[0].args.target_amount, 1450);
    assert.equal(customer.packs.length, 1);
    assert.equal(api.state.modal, null);
  });
});

test('approval pack request does not activate the pack until owner payment verification', async () => {
  const { api, context } = createApp();
  context.CONFIG.packTypes = [{ id: 'custom', label: 'Custom', totalShakes: 30, durationDays: 30 }];
  api.state.ownerPaymentSettings = { upiId: 'owner@upi', packPrices: { custom: 3000 } };
  api.state.session = {
    status: 'in', role: 'owner', uid: 'owner-uid', username: 'Owner',
    profile: { clubId: 'club-pay', clubName: 'Payment Club' }
  };
  const customer = {
    id: 'approved-customer', name: 'Approved Customer', joinDate: '2026-10-01',
    login: { uid: 'customer-uid' }, packs: [], payments: [], visits: []
  };
  api.state.customers = [customer];
  api.state.modal = { type: 'approvalPack', id: customer.id };
  api.state.modalForm = {
    packType: 'custom', busy: false, error: ''
  };
  const calls = [];
  api.setSupabaseClient({
    rpc: (name, args) => {
      calls.push({ name, args });
      return Promise.resolve({ data: { id: args.request_id, status: 'pending' }, error: null });
    },
    from: () => {
      const builder = {
        select() { return builder; },
        eq() { return builder; },
        order() { return builder; },
        limit() { return builder; },
        then(resolve, reject) { return Promise.resolve({ data: [], error: null }).then(resolve, reject); }
      };
      return builder;
    }
  });

  api.doSaveApprovalPack();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'create_owner_pack_request');
  assert.equal(calls[0].args.target_customer_id, customer.id);
  assert.equal(calls[0].args.target_pack_type, 'custom');
  assert.equal(customer.packs.length, 0);
  assert.equal(customer.payments.length, 0);
  assert.equal(api.state.modal, null);
  assert.match(api.state.paymentSettingsMessage, /after you confirm/);
});

test('pending customer registrations display their Supabase creation date', () => {
  const { api } = createApp();
  api.state.pendingRegistrations = [{
    id: 'pending-1', name: 'New Customer', mobile: '1234567890',
    createdAt: Date.now()
  }];
  const html = api.renderDashboard({
    totalCollected: 0, totalOutstanding: 0, totalCustomers: 0, withLogin: 0,
    todayVisits: 0, todayShakes: 0, todayCollected: 0,
    balanceFollowUps: [], shakeFollowUps: [], expiringFollowUps: [], orderFollowUps: []
  });
  assert.match(html, /Customer registrations awaiting approval/);
  assert.match(html, /data-action="openLinkRegistration"/);
  assert.doesNotMatch(html, /Invalid Date/);
  const source = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.match(source, /createdAt:\s*entry\.created_at/);
});

test('admin history can show archived rows and the owner edit form', () => {
  const { api } = createApp();
  api.state.adminAuthenticated = true;
  api.state.adminShowArchived = true;
  api.state.adminTab = 'clubs';
  api.state.adminRequests = [{
    uid: 'owner-2', ownerName: 'Owner Two', clubName: 'Club Two',
    mobile: '+919876543211', email: 'owner2@example.com', status: 'revoked',
    createdAt: Date.now(), reviewedAt: Date.now(), archived: true
  }];
  const archivedHtml = api.renderAdminPage();
  assert.match(archivedHtml, /Archived owner requests \(1\)/);
  assert.match(archivedHtml, /Status: revoked/);
  assert.match(archivedHtml, /data-action="restoreOwnerRequest"/);

  api.state.modal = { type: 'adminEditOwner', id: 'owner-2' };
  api.state.modalForm = {
    ownerName: 'Owner Two', clubName: 'Club Two', mobile: '+919876543211',
    email: 'owner2@example.com', password: '', busy: false, error: ''
  };
  const modal = api.renderModal();
  assert.match(modal, /data-form="adminOwnerEdit"/);
  assert.match(modal, /Set new password \(optional\)/);
  assert.match(modal, /Leave blank to keep (?:the )?current password/);
});

test('typing into a bound edit field updates state without rebuilding the page', () => {
  const { api, listeners, root } = createApp();
  api.state.modal = { type: 'adminEditOwner', id: 'owner-1' };
  api.state.modalForm = {
    ownerName: '', clubName: '', mobile: '', email: '',
    password: '', busy: false, error: ''
  };
  root.innerHTML = '<input value="">';
  listeners.input({
    target: { dataset: { bind: 'modalForm.ownerName' }, value: 'N' }
  });
  listeners.input({
    target: { dataset: { bind: 'modalForm.ownerName' }, value: 'Ne' }
  });
  listeners.input({
    target: { dataset: { bind: 'modalForm.ownerName' }, value: 'Neo' }
  });
  assert.equal(api.state.modalForm.ownerName, 'Neo');
  assert.equal(root.innerHTML, '<input value="">');
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
  assert.match(message, /No registration request is saved until signup succeeds/i);
  assert.match(api.authErrorText({ code: 'over_request_rate_limit' }), /wait for the limit to reset/i);
});

test('outdated account function errors explain that deployment is required', () => {
  const { api } = createApp();
  assert.match(
    api.authErrorText({ message: 'Unsupported account operation.' }),
    /manage-account function is outdated.*Deploy the latest function/i
  );
});

test('Supabase schema scopes data and protects owner approvals', () => {
  const schema = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'schema.sql'), 'utf8');
  assert.match(schema, /create table if not exists public\.owner_requests/);
  assert.match(schema, /alter table public\.owner_requests add column if not exists email text not null default ''/);
  assert.match(schema, /create or replace function public\.create_owner_request_from_auth\(\)/);
  assert.match(schema, /after insert on auth\.users/);
  assert.match(schema, /new\.raw_user_meta_data ->> 'role' is distinct from 'owner'/);
  assert.match(schema, /on conflict \(user_uid\) do nothing/);
  assert.doesNotMatch(schema, /Users can create their own owner request/);
  assert.match(schema, /alter table public\.customer_registrations add column if not exists email text not null default ''/);
  assert.match(schema, /create table if not exists public\.platform_admins/);
  assert.match(schema, /create table if not exists public\.customer_registrations/);
  assert.match(schema, /create table if not exists public\.customer_portals/);
  assert.match(schema, /create or replace function public\.review_owner_request/);
  assert.match(schema, /archived boolean not null default false/);
  assert.match(schema, /create or replace function public\.set_owner_request_archived/);
  assert.match(schema, /create or replace function public\.set_owner_access/);
  assert.match(schema, /create or replace function public\.admin_update_owner_details/);
  assert.match(schema, /create or replace function public\.permanently_delete_customer/);
  assert.match(schema, /'revoked'/);
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
  assert.match(schema, /create policy "Platform admins can read all club ledgers"/);
  assert.match(schema, /grant select, insert, update on public\.customer_registrations to authenticated/);
  assert.match(schema, /create policy "Customers and club owners can read portal cards"/);
  assert.match(schema, /grant select on public\.clubs to anon/);
  const migration = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'migrations', '20261028000000_admin_club_reports_access.sql'), 'utf8');
  assert.match(migration, /grant usage on schema public to authenticated/);
  assert.match(migration, /grant select, insert, update on public\.club_ledgers to authenticated/);
  assert.match(migration, /grant select, insert, update on public\.customer_registrations to authenticated/);
  assert.match(migration, /create policy "Customers and club owners can read registrations"/);
  assert.match(migration, /create policy "Platform admins can read all club ledgers"/);
  const combinedMigrations = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'combined-migrations.sql'), 'utf8');
  assert.match(combinedMigrations, /grant usage on schema public to authenticated/);
  assert.match(combinedMigrations, /create policy "Platform admins can read all club ledgers"/);
  assert.match(combinedMigrations, /create or replace function public\.permanently_delete_customer/);
  assert.match(combinedMigrations, /grant execute on function public\.permanently_delete_customer/);
  const deletionMigration = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'migrations', '20261028000001_permanent_customer_deletion.sql'), 'utf8');
  assert.match(deletionMigration, /Move the customer to Deleted before permanent removal/);
  assert.match(deletionMigration, /to service_role/);
});

test('UPI payment migration only activates packs after owner confirmation', () => {
  const migration = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'migrations', '20261029000000_manual_upi_pack_payments.sql'), 'utf8');
  assert.match(migration, /create table if not exists public\.club_payment_settings/);
  assert.match(migration, /create table if not exists public\.pack_payment_requests/);
  assert.match(migration, /customer_uid = auth\.uid\(\)::text/);
  assert.match(migration, /create or replace function public\.submit_customer_pack_payment/);
  assert.match(migration, /create or replace function public\.decline_customer_pack_request/);
  assert.match(migration, /create or replace function public\.review_customer_pack_payment/);
  assert.match(migration, /target_total_shakes integer default null/);
  assert.match(migration, /grant execute on function public\.create_owner_pack_request\(text, text, text, integer, integer, numeric\) to authenticated/);
  assert.match(migration, /drop function if exists public\.create_customer_pack_request\(text, text\)/);
  assert.doesNotMatch(migration, /create or replace function public\.create_customer_pack_request/);
  assert.doesNotMatch(migration, /grant execute on function public\.create_owner_pack_offer/);
  assert.match(migration, /current_pack ->> 'totalShakes'/);
  assert.match(migration, /current_expiry \+ request_row\.duration_days/);
  assert.match(migration, /pg_advisory_xact_lock\(hashtextextended\(customer_uid, 0\)\)/);
  assert.match(migration, /requests\.status in \('pending', 'payment_submitted'\)/);
  assert.match(migration, /if request_row\.status <> 'payment_submitted'/);
  assert.match(migration, /if not approve_payment then/);
  assert.match(migration, /'status', 'confirmed'/);
  assert.match(migration, /'{lastModified}', to_jsonb\(now_ms\), true/);
  assert.match(migration, /grant execute on function public\.review_customer_pack_payment\(text, boolean\) to authenticated/);
  assert.match(migration, /array\['club_payment_settings', 'pack_payment_requests'\]/);

  const schema = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'schema.sql'), 'utf8');
  const combined = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'combined-migrations.sql'), 'utf8');
  assert.match(schema, /create table if not exists public\.club_payment_settings/);
  assert.match(combined, /create table if not exists public\.club_payment_settings/);
  const marker = '-- Manual UPI pack request flow';
  assert.equal(schema.slice(schema.indexOf(marker) + marker.length).trim(), migration.trim());
  assert.equal(combined.slice(combined.indexOf(marker) + marker.length).trim(), migration.trim());
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
  assert.match(html, /supabaseClient\.auth\.signUp\(\{\s*email:\s*email,/);
  assert.match(html, /role:\s*'owner',\s*mobile:\s*mobile,\s*email:\s*email,\s*owner_name:\s*f\.ownerName\.trim\(\),\s*club_name:\s*f\.clubName\.trim\(\)/);
  assert.match(html, /owner_name:\s*f\.ownerName\.trim\(\),\s*club_name:\s*f\.clubName\.trim\(\)/);
  assert.doesNotMatch(html, /owner_requests'\)\.insert\(/);
  assert.match(html, /customer_registrations'\)\.insert\(\{[\s\S]*?email:\s*email/);
  assert.doesNotMatch(html, /@owner\.club-ledger\.app|@customer\.club-ledger\.app/);
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
  assert.match(functionSource, /action === "admin-owner-edit"/);
  assert.match(functionSource, /action === "customer-delete-permanently"/);
  assert.match(functionSource, /permanently_delete_customer/);
  assert.match(functionSource, /from\("platform_admins"\)/);
  assert.match(functionSource, /const email = cleanEmail\(body\.email\)/);
  assert.match(functionSource, /email,/);
  assert.doesNotMatch(functionSource, /club-ledger\.app/);
  assert.match(functionSource, /is required/);
});
