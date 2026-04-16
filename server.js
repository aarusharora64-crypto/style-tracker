const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');
const Imap = require('imap');
const { simpleParser } = require('mailparser');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
app.use(express.json());

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data.json');

// ── Gmail IMAP Config ─────────────────────────────────
const EMAIL_USER = process.env.EMAIL_USER || 'internetexportsindia202@gmail.com';
const EMAIL_PASS = process.env.EMAIL_PASS || '';  // Gmail App Password
const EMAIL_CHECK_INTERVAL = parseInt(process.env.EMAIL_CHECK_INTERVAL) || 60000; // 1 min

// ── Default admin password (change on first login) ──
const DEFAULT_ADMIN_PIN = '1234';

// ── Data Persistence ───────────────────────────────────
function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    }
  } catch (e) { console.error('Data load error:', e); }
  return {
    users: [
      { id: 'admin', name: 'Admin', role: 'admin', dept: 'all', pin: DEFAULT_ADMIN_PIN },
    ],
    styles: {},
    messages: [],
    orders: {},
    settings: { adminPin: DEFAULT_ADMIN_PIN, companyName: 'Style Tracker' }
  };
}

function saveData() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
}

let db = loadData();

// Ensure settings exist on old data files
if (!db.settings) db.settings = { adminPin: DEFAULT_ADMIN_PIN, companyName: 'Style Tracker' };
if (!db.users) db.users = [{ id: 'admin', name: 'Admin', role: 'admin', dept: 'all', pin: DEFAULT_ADMIN_PIN }];
if (!db.orders) db.orders = {};
if (!db.deptPasswords) db.deptPasswords = {};
if (!db.pendingChanges) db.pendingChanges = [];

// Default department passwords (admin can change these)
const DEFAULT_DEPT_PASSWORDS = {
  merchandising: 'merch123', sampling: 'sample123', accounts: 'acc123',
  purchase: 'purchase123', 'fabric-purchase': 'fabric123', trims: 'trims123',
  store: 'store123', production: 'prod123', cutting: 'cut123',
  stitching: 'stitch123', embroidery: 'emb123', printing: 'print123',
  washing: 'wash123', finishing: 'finish123', quality: 'qc123',
  packing: 'pack123', shipping: 'ship123', admin: DEFAULT_ADMIN_PIN, all: DEFAULT_ADMIN_PIN
};
// Initialize dept passwords if empty
if (Object.keys(db.deptPasswords).length === 0) {
  db.deptPasswords = { ...DEFAULT_DEPT_PASSWORDS };
  saveData();
}

// ── Order Process Stages ──────────────────────────────
const ORDER_STAGES = [
  { id: 'cost_approve',     label: 'Costing Approval',          icon: '💰', dept: 'accounts' },
  { id: 'order_confirm',    label: 'Order Confirmation',        icon: '📋', dept: 'merchandising' },
  { id: 'fabric_acc_pr',    label: 'Fabric & Accessory PR',     icon: '📝', dept: 'purchase' },
  { id: 'lab_dip_approve',  label: 'Lab Dip Approval',          icon: '🎨', dept: 'sampling' },
  { id: 'fit_sample',       label: 'Fit / Size Set Sample',     icon: '📐', dept: 'sampling' },
  { id: 'pp_sample',        label: 'PP Sample Submission',      icon: '👔', dept: 'sampling' },
  { id: 'prod_file',        label: 'Production File Handover',  icon: '📂', dept: 'merchandising' },
  { id: 'fabric_inhouse',   label: 'Fabric In-House',           icon: '🧶', dept: 'store' },
  { id: 'trims_inhouse',    label: 'Trims In-House',            icon: '🔘', dept: 'store' },
  { id: 'rnd',              label: 'R&D',                       icon: '🔬', dept: 'production' },
  { id: 'production_plan',  label: 'Production Planning',       icon: '📊', dept: 'production' },
  { id: 'cutting',          label: 'Cutting',                   icon: '✂️', dept: 'cutting' },
  { id: 'stitching',        label: 'Stitching',                 icon: '🧵', dept: 'stitching' },
  { id: 'finishing_qc',     label: 'Finishing & QC',            icon: '✨', dept: 'finishing' },
  { id: 'pp_approve',       label: 'PP Sample Approval',        icon: '🏷️', dept: 'buyer' },
  { id: 'final_inspection', label: 'Final Inspection',          icon: '🔍', dept: 'quality' },
  { id: 'packing',          label: 'Packing',                   icon: '📦', dept: 'packing' },
  { id: 'ex_factory',       label: 'Ex-Factory / Dispatch',     icon: '🚚', dept: 'shipping' },
];

// ── Status Detection ───────────────────────────────────
const STATUS_KEYWORDS = {
  cutting:   ['cutting', 'cut', 'fabric cut', 'lay cut', 'spreading'],
  stitching: ['stitching', 'stitch', 'sewing', 'sew', 'sewn', 'assembly'],
  finishing: ['finishing', 'finish', 'wash', 'iron', 'press', 'quality', 'qc', 'checking', 'inspection'],
  packing:   ['packing', 'pack', 'packed', 'folding', 'fold', 'tagging'],
  shipped:   ['shipped', 'ship', 'dispatch', 'dispatched', 'delivered', 'sent', 'loaded'],
  issue:     ['issue', 'problem', 'defect', 'reject', 'hold', 'delay', 'damaged', 'rework', 'shortage', 'faulty']
};

function detectStatus(text) {
  const lower = text.toLowerCase();
  for (const [status, keywords] of Object.entries(STATUS_KEYWORDS)) {
    for (const kw of keywords) {
      if (lower.includes(kw)) return status;
    }
  }
  return 'other';
}

function parseStyleNumber(text) {
  const patterns = [
    /\b([A-Z]{1,5}[-\s]?\d{2,6})\b/i,
    /\b(\d{3,6})\b/
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) return m[1].toUpperCase().replace(/\s+/g, '-');
  }
  return null;
}

// Dept notification mapping
const DEPT_NOTIFY = {
  cutting:   ['cutting'],
  stitching: ['cutting', 'stitching'],
  finishing: ['stitching', 'finishing'],
  packing:   ['finishing', 'packing'],
  shipping:  ['packing', 'shipped'],
  all:       ['cutting', 'stitching', 'finishing', 'packing', 'shipped', 'issue', 'other']
};

// ── Online Users Tracking ──────────────────────────────
const onlineUsers = new Map();

// ── Serve Static Files ─────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ── REST APIs ──────────────────────────────────────────
app.get('/api/users', (req, res) => {
  // Return users without pins
  res.json(db.users.map(u => ({ id: u.id, name: u.name, role: u.role, dept: u.dept })));
});

app.get('/api/data', (req, res) => res.json({ styles: db.styles }));
app.get('/api/online', (req, res) => res.json([...onlineUsers.values()]));
app.get('/api/settings', (req, res) => res.json({ companyName: db.settings.companyName }));
app.get('/api/dept-list', (req, res) => res.json(Object.keys(db.deptPasswords).filter(d => d !== 'admin' && d !== 'all')));

// Department login - verify password for a department
app.post('/api/dept-login', (req, res) => {
  const { name, dept, password } = req.body;
  if (!name || !dept || !password) return res.status(400).json({ error: 'Name, department and password required' });
  const deptPwd = db.deptPasswords[dept];
  if (!deptPwd || deptPwd !== password) return res.json({ ok: false, error: 'Wrong department password' });
  // Find or create the user
  let user = db.users.find(u => u.name.toLowerCase() === name.toLowerCase() && u.dept === dept);
  if (!user) {
    const id = name.toLowerCase().replace(/[^a-z0-9]/g, '') + '_' + Date.now().toString(36);
    user = { id, name, role: 'operator', dept };
    db.users.push(user);
    saveData();
    io.emit('users-updated', db.users.map(u => ({ id: u.id, name: u.name, role: u.role, dept: u.dept })));
  }
  res.json({ ok: true, user: { id: user.id, name: user.name, role: user.role, dept: user.dept } });
});
app.get('/api/order-stages', (req, res) => res.json(ORDER_STAGES));
app.get('/api/orders', (req, res) => res.json(db.orders));

// ── Order Process APIs ────────────────────────────────
app.post('/api/orders', (req, res) => {
  const { buyer, styleNo, description, quantity, exFactoryDate, merchant, poNumber } = req.body;
  if (!buyer || !styleNo) return res.status(400).json({ error: 'Buyer and Style No required' });
  const id = 'ORD-' + Date.now().toString(36).toUpperCase();
  const stages = {};
  ORDER_STAGES.forEach(s => { stages[s.id] = { status: 'pending', targetDate: '', actualDate: '', notes: '', updatedBy: '', updatedAt: '' }; });
  const order = { id, buyer, styleNo, description: description || '', quantity: parseInt(quantity) || 0, exFactoryDate: exFactoryDate || '', merchant: merchant || '', poNumber: poNumber || '', stages, createdAt: new Date().toISOString(), history: [] };
  db.orders[id] = order;
  saveData();
  io.emit('order-created', order);
  res.json({ ok: true, order });
});

// Helper: apply a stage change and send notifications
function applyStageChange(orderId, stageId, status, targetDate, actualDate, notes, userName) {
  const order = db.orders[orderId];
  if (!order || !order.stages[stageId]) return;
  const stage = order.stages[stageId];
  const oldStatus = stage.status;
  const oldTarget = stage.targetDate;
  if (status) stage.status = status;
  if (targetDate !== undefined) stage.targetDate = targetDate;
  if (actualDate !== undefined) stage.actualDate = actualDate;
  if (notes !== undefined) stage.notes = notes;
  stage.updatedBy = userName || '';
  stage.updatedAt = new Date().toISOString();
  order.history.push({ stageId, status: stage.status, notes: stage.notes, by: userName || '', at: stage.updatedAt });
  saveData();
  io.emit('order-updated', { orderId, stageId, stage, history: order.history });

  // Send department notifications
  const stageInfo = ORDER_STAGES.find(s => s.id === stageId);
  if (stageInfo) {
    const stageIdx = ORDER_STAGES.findIndex(s => s.id === stageId);
    const nextStage = ORDER_STAGES[stageIdx + 1];
    const targetDepts = new Set([stageInfo.dept, 'all', 'merchandising']);
    if (status === 'done' && nextStage) targetDepts.add(nextStage.dept);

    let title = '', body = '';
    if (status && status !== oldStatus) {
      if (status === 'done') {
        title = `✅ ${stageInfo.label} Completed`;
        body = `${order.buyer} - ${order.styleNo}: ${stageInfo.label} is done.${nextStage ? ' Next: ' + nextStage.label : ' All stages complete!'}`;
      } else if (status === 'active') {
        title = `▶️ ${stageInfo.label} Started`;
        body = `${order.buyer} - ${order.styleNo}: ${stageInfo.label} is now in progress.`;
      } else if (status === 'delayed') {
        title = `⚠️ ${stageInfo.label} Delayed`;
        body = `${order.buyer} - ${order.styleNo}: ${stageInfo.label} has been marked as delayed.${notes ? ' Note: ' + notes : ''}`;
      } else if (status === 'issue') {
        title = `🚨 Issue at ${stageInfo.label}`;
        body = `${order.buyer} - ${order.styleNo}: Issue reported at ${stageInfo.label}.${notes ? ' Note: ' + notes : ''}`;
      }
    } else if (targetDate !== undefined && targetDate !== oldTarget) {
      title = `📅 Timeline Updated: ${stageInfo.label}`;
      body = `${order.buyer} - ${order.styleNo}: Target date changed to ${targetDate || 'not set'}.`;
    }

    if (title) {
      io.emit('notify', { title, body, orderId, stageId, status: status || oldStatus, targetDepts: [...targetDepts], fromUser: userName || '', at: new Date().toISOString() });
    }
  }
}

app.put('/api/orders/:id/stage', (req, res) => {
  const order = db.orders[req.params.id];
  if (!order) return res.status(404).json({ error: 'Order not found' });
  const { stageId, status, targetDate, actualDate, notes, userName, userRole } = req.body;
  if (!stageId || !order.stages[stageId]) return res.status(400).json({ error: 'Invalid stage' });

  // If user is admin, apply immediately
  if (userRole === 'admin') {
    applyStageChange(req.params.id, stageId, status, targetDate, actualDate, notes, userName);
    return res.json({ ok: true, approved: true });
  }

  // Non-admin: queue for approval
  const pendingId = 'PC-' + Date.now().toString(36).toUpperCase();
  const stageInfo = ORDER_STAGES.find(s => s.id === stageId);
  const pending = {
    id: pendingId,
    orderId: req.params.id,
    stageId,
    stageLabel: stageInfo ? stageInfo.label : stageId,
    buyer: order.buyer,
    styleNo: order.styleNo,
    changes: { status, targetDate, actualDate, notes },
    currentValues: { ...order.stages[stageId] },
    requestedBy: userName || 'Unknown',
    requestedAt: new Date().toISOString(),
    status: 'pending'  // pending, approved, rejected
  };

  db.pendingChanges.push(pending);
  saveData();

  // Notify admin about pending approval
  io.emit('pending-change', pending);
  io.emit('notify', {
    title: `🔒 Approval Required`,
    body: `${userName} wants to update ${stageInfo ? stageInfo.label : stageId} for ${order.buyer} - ${order.styleNo}`,
    orderId: req.params.id,
    stageId,
    status: 'pending',
    targetDepts: ['all', 'admin'],
    fromUser: userName || '',
    at: new Date().toISOString()
  });

  res.json({ ok: true, approved: false, pendingId, message: 'Change submitted for admin approval' });
});

// ── Approval APIs ────────────────────────────────
app.get('/api/pending-changes', (req, res) => {
  const pending = (db.pendingChanges || []).filter(p => p.status === 'pending');
  res.json(pending);
});

app.post('/api/pending-changes/:id/approve', (req, res) => {
  if (!isAdmin(req.body.adminPin)) return res.status(403).json({ error: 'Invalid admin PIN' });
  const pc = db.pendingChanges.find(p => p.id === req.params.id);
  if (!pc) return res.status(404).json({ error: 'Pending change not found' });
  if (pc.status !== 'pending') return res.status(400).json({ error: 'Already processed' });

  pc.status = 'approved';
  pc.processedAt = new Date().toISOString();
  pc.processedBy = 'Admin';

  // Apply the change
  const { status, targetDate, actualDate, notes } = pc.changes;
  applyStageChange(pc.orderId, pc.stageId, status, targetDate, actualDate, notes, pc.requestedBy);
  saveData();

  io.emit('pending-resolved', { id: pc.id, status: 'approved' });
  io.emit('notify', {
    title: `✅ Change Approved`,
    body: `${pc.requestedBy}'s update to ${pc.stageLabel} for ${pc.buyer} - ${pc.styleNo} was approved.`,
    orderId: pc.orderId,
    stageId: pc.stageId,
    status: 'approved',
    targetDepts: ['all'],
    fromUser: 'Admin',
    at: new Date().toISOString()
  });

  res.json({ ok: true });
});

app.post('/api/pending-changes/:id/reject', (req, res) => {
  if (!isAdmin(req.body.adminPin)) return res.status(403).json({ error: 'Invalid admin PIN' });
  const pc = db.pendingChanges.find(p => p.id === req.params.id);
  if (!pc) return res.status(404).json({ error: 'Pending change not found' });
  if (pc.status !== 'pending') return res.status(400).json({ error: 'Already processed' });

  pc.status = 'rejected';
  pc.processedAt = new Date().toISOString();
  pc.processedBy = 'Admin';
  pc.rejectReason = req.body.reason || '';
  saveData();

  io.emit('pending-resolved', { id: pc.id, status: 'rejected', reason: pc.rejectReason });
  io.emit('notify', {
    title: `❌ Change Rejected`,
    body: `${pc.requestedBy}'s update to ${pc.stageLabel} for ${pc.buyer} - ${pc.styleNo} was rejected.${pc.rejectReason ? ' Reason: ' + pc.rejectReason : ''}`,
    orderId: pc.orderId,
    stageId: pc.stageId,
    status: 'rejected',
    targetDepts: ['all'],
    fromUser: 'Admin',
    at: new Date().toISOString()
  });

  res.json({ ok: true });
});

app.put('/api/orders/:id', (req, res) => {
  const order = db.orders[req.params.id];
  if (!order) return res.status(404).json({ error: 'Order not found' });
  const { buyer, styleNo, description, quantity, exFactoryDate, merchant, poNumber } = req.body;
  if (buyer) order.buyer = buyer;
  if (styleNo) order.styleNo = styleNo;
  if (description !== undefined) order.description = description;
  if (quantity !== undefined) order.quantity = parseInt(quantity) || order.quantity;
  if (exFactoryDate !== undefined) order.exFactoryDate = exFactoryDate;
  if (merchant !== undefined) order.merchant = merchant;
  if (poNumber !== undefined) order.poNumber = poNumber;
  saveData();
  io.emit('order-info-updated', order);
  res.json({ ok: true });
});

app.delete('/api/orders/:id', (req, res) => {
  if (!db.orders[req.params.id]) return res.status(404).json({ error: 'Order not found' });
  delete db.orders[req.params.id];
  saveData();
  io.emit('order-deleted', req.params.id);
  res.json({ ok: true });
});

// ── Buyer Analytics / Self-Learning Engine ────────────
function computeBuyerInsights() {
  const buyers = {};
  const orders = Object.values(db.orders);

  for (const order of orders) {
    const buyerKey = (order.buyer || '').trim().toLowerCase();
    if (!buyerKey) continue;

    if (!buyers[buyerKey]) {
      buyers[buyerKey] = {
        buyer: order.buyer,
        totalOrders: 0,
        completedOrders: 0,
        avgQuantity: 0,
        totalQuantity: 0,
        stageDurations: {},  // stageId -> [days taken]
        stageToStage: {},    // "stageA->stageB" -> [days]
        avgLeadTime: null,   // order creation to ex-factory (days)
        leadTimes: [],
        styles: new Set(),
        lastOrder: null,
      };
    }

    const b = buyers[buyerKey];
    b.totalOrders++;
    b.totalQuantity += order.quantity || 0;
    if (order.styleNo) b.styles.add(order.styleNo);

    const createdAt = new Date(order.createdAt);
    if (!b.lastOrder || new Date(order.createdAt) > new Date(b.lastOrder)) {
      b.lastOrder = order.createdAt;
    }

    // Analyze stage completion times
    let prevStageDate = createdAt;
    let prevStageId = '_start';
    let allDone = true;

    for (const s of ORDER_STAGES) {
      const stg = order.stages[s.id];
      if (!stg || stg.status !== 'done' || !stg.actualDate) { allDone = false; continue; }

      const doneDate = new Date(stg.actualDate);
      if (isNaN(doneDate.getTime())) continue;

      // Duration from order creation to this stage completion
      const daysFromStart = Math.max(0, Math.round((doneDate - createdAt) / 86400000));
      if (!b.stageDurations[s.id]) b.stageDurations[s.id] = [];
      b.stageDurations[s.id].push(daysFromStart);

      // Stage-to-stage duration
      const key = prevStageId + '->' + s.id;
      const gap = Math.max(0, Math.round((doneDate - prevStageDate) / 86400000));
      if (!b.stageToStage[key]) b.stageToStage[key] = [];
      b.stageToStage[key].push(gap);

      prevStageDate = doneDate;
      prevStageId = s.id;
    }

    // Lead time if order has ex-factory date done
    const exStage = order.stages.ex_factory;
    if (exStage && exStage.status === 'done' && exStage.actualDate) {
      const exDate = new Date(exStage.actualDate);
      const lead = Math.round((exDate - createdAt) / 86400000);
      if (lead > 0) b.leadTimes.push(lead);
      b.completedOrders++;
    }
  }

  // Compute averages
  const result = {};
  for (const [key, b] of Object.entries(buyers)) {
    const avgStageDays = {};
    for (const [sid, durations] of Object.entries(b.stageDurations)) {
      avgStageDays[sid] = Math.round(durations.reduce((a, c) => a + c, 0) / durations.length);
    }

    result[key] = {
      buyer: b.buyer,
      totalOrders: b.totalOrders,
      completedOrders: b.completedOrders,
      avgQuantity: b.totalOrders ? Math.round(b.totalQuantity / b.totalOrders) : 0,
      avgStageDays,
      avgLeadTime: b.leadTimes.length ? Math.round(b.leadTimes.reduce((a, c) => a + c, 0) / b.leadTimes.length) : null,
      styles: [...b.styles],
      lastOrder: b.lastOrder,
      dataPoints: Object.values(b.stageDurations).reduce((a, c) => a + c.length, 0),
    };
  }
  return result;
}

// Suggest target dates for a buyer's new order
function suggestTimeline(buyerName, startDate) {
  const insights = computeBuyerInsights();
  const buyerKey = (buyerName || '').trim().toLowerCase();
  const buyerData = insights[buyerKey];
  if (!buyerData || !buyerData.avgStageDays || Object.keys(buyerData.avgStageDays).length === 0) {
    return null;  // Not enough data
  }

  const start = new Date(startDate || new Date());
  const suggested = {};
  for (const s of ORDER_STAGES) {
    const avgDays = buyerData.avgStageDays[s.id];
    if (avgDays !== undefined) {
      const d = new Date(start);
      d.setDate(d.getDate() + avgDays);
      suggested[s.id] = d.toISOString().split('T')[0];
    }
  }
  return { suggested, avgLeadTime: buyerData.avgLeadTime, basedOnOrders: buyerData.totalOrders };
}

app.get('/api/buyer-insights', (req, res) => {
  res.json(computeBuyerInsights());
});

app.get('/api/buyer-insights/:buyer', (req, res) => {
  const insights = computeBuyerInsights();
  const key = (req.params.buyer || '').trim().toLowerCase();
  res.json(insights[key] || null);
});

app.get('/api/suggest-timeline/:buyer', (req, res) => {
  const result = suggestTimeline(req.params.buyer, req.query.startDate);
  if (!result) return res.json({ available: false, message: 'Not enough historical data for this buyer yet' });
  res.json({ available: true, ...result });
});

// ── Admin APIs ─────────────────────────────────────────
function isAdmin(pin) {
  return pin === db.settings.adminPin;
}

app.post('/api/admin/verify', (req, res) => {
  res.json({ ok: isAdmin(req.body.pin) });
});

app.post('/api/admin/users', (req, res) => {
  if (!isAdmin(req.body.adminPin)) return res.status(403).json({ error: 'Invalid admin PIN' });
  const { name, dept, role } = req.body;
  if (!name || !dept) return res.status(400).json({ error: 'Name and department required' });
  const id = name.toLowerCase().replace(/[^a-z0-9]/g, '') + '_' + Date.now().toString(36);
  const user = { id, name, role: role || 'operator', dept };
  db.users.push(user);
  saveData();
  io.emit('users-updated', db.users.map(u => ({ id: u.id, name: u.name, role: u.role, dept: u.dept })));
  res.json({ ok: true, user: { id, name, role: role || 'operator', dept } });
});

app.put('/api/admin/users/:id', (req, res) => {
  if (!isAdmin(req.body.adminPin)) return res.status(403).json({ error: 'Invalid admin PIN' });
  const user = db.users.find(u => u.id === req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (req.body.name) user.name = req.body.name;
  if (req.body.dept) user.dept = req.body.dept;
  if (req.body.role) user.role = req.body.role;
  saveData();
  io.emit('users-updated', db.users.map(u => ({ id: u.id, name: u.name, role: u.role, dept: u.dept })));
  res.json({ ok: true });
});

app.delete('/api/admin/users/:id', (req, res) => {
  if (!isAdmin(req.body.adminPin)) return res.status(403).json({ error: 'Invalid admin PIN' });
  if (req.params.id === 'admin') return res.status(400).json({ error: 'Cannot delete admin' });
  db.users = db.users.filter(u => u.id !== req.params.id);
  saveData();
  io.emit('users-updated', db.users.map(u => ({ id: u.id, name: u.name, role: u.role, dept: u.dept })));
  res.json({ ok: true });
});

app.post('/api/admin/settings', (req, res) => {
  if (!isAdmin(req.body.currentPin)) return res.status(403).json({ error: 'Invalid admin PIN' });
  if (req.body.newPin) db.settings.adminPin = req.body.newPin;
  if (req.body.companyName) db.settings.companyName = req.body.companyName;
  saveData();
  res.json({ ok: true });
});

// Department password management
app.get('/api/admin/dept-passwords', (req, res) => {
  res.json(db.deptPasswords);
});

app.post('/api/admin/dept-passwords', (req, res) => {
  if (!isAdmin(req.body.adminPin)) return res.status(403).json({ error: 'Invalid admin PIN' });
  const { dept, password } = req.body;
  if (!dept || !password) return res.status(400).json({ error: 'Department and password required' });
  db.deptPasswords[dept] = password;
  saveData();
  res.json({ ok: true });
});

app.post('/api/admin/clear-messages', (req, res) => {
  if (!isAdmin(req.body.adminPin)) return res.status(403).json({ error: 'Invalid admin PIN' });
  db.messages = [];
  db.styles = {};
  saveData();
  io.emit('data-cleared');
  res.json({ ok: true });
});

// ── WebSocket ──────────────────────────────────────────
io.on('connection', (socket) => {
  socket.on('login', (userId) => {
    const user = db.users.find(u => u.id === userId);
    if (!user) return;
    onlineUsers.set(socket.id, { id: user.id, name: user.name, role: user.role, dept: user.dept });
    io.emit('online-users', [...onlineUsers.values()]);
    socket.emit('history', db.messages.slice(-200));
    socket.emit('style-data', db.styles);
  });

  socket.on('chat-message', (text) => {
    const user = onlineUsers.get(socket.id);
    if (!user) return;

    const styleNum = parseStyleNumber(text);
    const status = styleNum ? detectStatus(text) : null;
    const now = new Date().toISOString();

    const msg = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      userId: user.id, userName: user.name, userDept: user.dept,
      text, styleNum, status, time: now
    };

    if (styleNum) {
      if (!db.styles[styleNum]) db.styles[styleNum] = { status, updates: [] };
      db.styles[styleNum].status = status;
      db.styles[styleNum].updates.push({ text, time: now, status, userId: user.id, userName: user.name });
    }

    db.messages.push(msg);
    // Keep only last 5000 messages
    if (db.messages.length > 5000) db.messages = db.messages.slice(-5000);
    saveData();

    io.emit('new-message', msg);

    if (styleNum && status) {
      const notifyDepts = new Set(['all']);
      for (const [dept, statuses] of Object.entries(DEPT_NOTIFY)) {
        if (statuses.includes(status)) notifyDepts.add(dept);
      }
      io.emit('notify', {
        title: `${styleNum} — ${status.charAt(0).toUpperCase() + status.slice(1)}`,
        body: `${user.name}: ${text}`,
        styleNum, status, time: now,
        fromUser: user.name,
        targetDepts: [...notifyDepts]
      });
    }
  });

  socket.on('disconnect', () => {
    onlineUsers.delete(socket.id);
    io.emit('online-users', [...onlineUsers.values()]);
  });
});

// ── Email-to-Order Integration ────────────────────────
// Only process emails from ERP system
const ALLOWED_EMAIL_SENDERS = ['alert@internetexportsindia.com'];

function extractField(text, fieldName) {
  // Match "FieldName\tValue" or "FieldName  Value" pattern from ERP emails
  const patterns = [
    new RegExp(fieldName + '\\s*\\t+\\s*([^\\t\\n]+)', 'i'),
    new RegExp(fieldName + '\\s*:\\s*([^\\n]+)', 'i'),
    new RegExp('<td>' + fieldName + '</td>\\s*<td>([^<]*)</td>', 'i'),
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m && m[1].trim()) return m[1].trim();
  }
  return '';
}

function parseEODate(dateStr) {
  // Parse DD/MM/YYYY format from ERP
  if (!dateStr) return '';
  const m = dateStr.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) {
    const [, day, month, year] = m;
    return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
  }
  // Try ISO format
  const d = new Date(dateStr);
  if (!isNaN(d)) return d.toISOString().split('T')[0];
  return '';
}

function parseOrderFromEmail(subject, body, from) {
  const text = body || '';
  const htmlAndText = (body + ' ' + subject).replace(/<[^>]*>/g, ' ');

  // Extract EO number from subject: "New EO:      23764 Added"
  let eoNo = '';
  const eoSubjectMatch = subject.match(/EO[:\s]+(\d+)/i);
  if (eoSubjectMatch) eoNo = eoSubjectMatch[1];

  // Extract structured fields from ERP email body
  const buyer = extractField(text, 'Buyer') || extractField(htmlAndText, 'Buyer');
  const styleNo = extractField(text, 'Style No') || extractField(htmlAndText, 'Style No');
  const styleDesc = extractField(text, 'Style Desc') || extractField(htmlAndText, 'Style Desc');
  const merchandiser = extractField(text, 'Merchandiser') || extractField(htmlAndText, 'Merchandiser');
  const season = extractField(text, 'Season') || extractField(htmlAndText, 'Season');
  const rate = extractField(text, 'Rate') || extractField(htmlAndText, 'Rate');
  const totalValue = extractField(text, 'Total Order Value') || extractField(htmlAndText, 'Total Order Value');
  const shipMode = extractField(text, 'Mode of Shipment') || extractField(htmlAndText, 'Mode of Shipment');
  const poNumber = extractField(text, 'EO No') || extractField(htmlAndText, 'EO No') || eoNo;

  // Quantity
  let quantity = 0;
  const qtyStr = extractField(text, 'Quantity') || extractField(htmlAndText, 'Quantity');
  if (qtyStr) quantity = parseInt(qtyStr.replace(/,/g, '')) || 0;

  // Dates
  const exFactoryDate = parseEODate(extractField(text, 'Ex Factory Date') || extractField(htmlAndText, 'Ex Factory Date'));
  const shipDate = parseEODate(extractField(text, 'Ship Date') || extractField(htmlAndText, 'Ship Date'));
  const orderDate = parseEODate(extractField(text, 'Order Date') || extractField(htmlAndText, 'Order Date'));

  // Build description with useful info
  const descParts = [];
  if (styleDesc) descParts.push(styleDesc);
  if (season) descParts.push(`Season: ${season}`);
  if (rate) descParts.push(`Rate: ${rate}`);
  if (totalValue) descParts.push(`Value: ${totalValue}`);
  if (shipMode) descParts.push(`Ship: ${shipMode}`);
  const description = descParts.join(' | ');

  return { buyer, styleNo, poNumber, quantity, exFactoryDate, shipDate, orderDate, description, merchandiser };
}

function checkEmails() {
  if (!EMAIL_PASS) {
    return; // No password configured, skip silently
  }

  const imap = new Imap({
    user: EMAIL_USER,
    password: EMAIL_PASS,
    host: 'imap.gmail.com',
    port: 993,
    tls: true,
    tlsOptions: { rejectUnauthorized: false },
    authTimeout: 10000
  });

  function openInbox(cb) {
    imap.openBox('INBOX', false, cb);
  }

  imap.once('ready', () => {
    openInbox((err, box) => {
      if (err) { console.error('IMAP inbox error:', err.message); imap.end(); return; }

      // Search for unseen emails
      imap.search(['UNSEEN'], (err, results) => {
        if (err) { console.error('IMAP search error:', err.message); imap.end(); return; }
        if (!results || results.length === 0) { imap.end(); return; }

        console.log(`📧 Found ${results.length} new email(s)`);

        const fetch = imap.fetch(results, { bodies: '', markSeen: true });

        fetch.on('message', (msg) => {
          msg.on('body', (stream) => {
            simpleParser(stream, (err, parsed) => {
              if (err) { console.error('Parse error:', err.message); return; }

              const from = parsed.from ? parsed.from.text : '';
              const fromEmail = parsed.from && parsed.from.value && parsed.from.value[0] ? parsed.from.value[0].address.toLowerCase() : '';
              const subject = parsed.subject || '';
              const body = parsed.text || '';
              const htmlBody = parsed.html || '';

              console.log(`  📩 Email from: ${from} (${fromEmail}) | Subject: ${subject}`);

              // Only process emails from allowed senders (ERP system)
              if (!ALLOWED_EMAIL_SENDERS.includes(fromEmail)) {
                console.log(`  ⏭️ Skipping — sender not in allowed list`);
                return;
              }

              // Parse order details from ERP email
              const fullBody = body + '\n' + htmlBody;
              const orderData = parseOrderFromEmail(subject, fullBody, from);

              // Create order if we have buyer or style
              if (orderData.buyer || orderData.styleNo) {
                const id = 'ORD-' + Date.now().toString(36).toUpperCase();
                const stages = {};
                ORDER_STAGES.forEach(s => {
                  stages[s.id] = { status: 'pending', targetDate: '', actualDate: '', notes: '', updatedBy: '', updatedAt: '' };
                });

                // Set ex-factory date as target for the ex_factory stage
                if (orderData.exFactoryDate) {
                  stages['ex_factory'].targetDate = orderData.exFactoryDate;
                }

                const order = {
                  id,
                  buyer: orderData.buyer || 'Unknown Buyer',
                  styleNo: orderData.styleNo || 'TBD-' + Date.now().toString(36).toUpperCase().slice(-4),
                  description: orderData.description,
                  quantity: orderData.quantity,
                  exFactoryDate: orderData.exFactoryDate,
                  merchant: orderData.merchandiser || '',
                  poNumber: orderData.poNumber,
                  stages,
                  createdAt: new Date().toISOString(),
                  history: [{ stageId: 'order_confirm', status: 'pending', notes: `Auto-created from ERP alert: EO ${orderData.poNumber}`, by: 'ERP System', at: new Date().toISOString() }],
                  source: 'email',
                  emailFrom: from,
                  emailSubject: subject
                };

                db.orders[id] = order;
                saveData();
                io.emit('order-created', order);
                io.emit('notify', {
                  title: `📧 New EO: ${orderData.poNumber} — ${orderData.buyer}`,
                  body: `Style: ${orderData.styleNo} | Qty: ${orderData.quantity} | Ex-Factory: ${orderData.exFactoryDate}`,
                  styleNum: orderData.styleNo,
                  status: 'other',
                  time: new Date().toISOString(),
                  fromUser: 'ERP System',
                  targetDepts: ['all']
                });
                console.log(`  ✅ Order created: ${id} — EO ${orderData.poNumber} | ${orderData.buyer} | ${orderData.styleNo} | Qty: ${orderData.quantity}`);
              } else {
                console.log(`  ⚠️ Could not extract order info from ERP email, skipping`);
              }
            });
          });
        });

        fetch.once('end', () => {
          imap.end();
        });
      });
    });
  });

  imap.once('error', (err) => {
    console.error('IMAP error:', err.message);
  });

  imap.connect();
}

// ── Email Check API (manual trigger) ──────────────────
app.post('/api/check-email', (req, res) => {
  if (!EMAIL_PASS) return res.status(400).json({ error: 'Email not configured. Set EMAIL_PASS environment variable.' });
  checkEmails();
  res.json({ ok: true, message: 'Email check triggered' });
});

app.get('/api/email-status', (req, res) => {
  res.json({
    configured: !!EMAIL_PASS,
    email: EMAIL_USER,
    checkInterval: EMAIL_CHECK_INTERVAL / 1000 + 's'
  });
});

server.listen(PORT, () => {
  console.log(`\n  Style Tracker running at http://localhost:${PORT}`);
  console.log(`  Admin PIN: ${db.settings.adminPin} (change this in Admin settings)`);

  // Start email checking if configured
  if (EMAIL_PASS) {
    console.log(`  📧 Email checking enabled for ${EMAIL_USER} (every ${EMAIL_CHECK_INTERVAL / 1000}s)`);
    // Check immediately on startup, then on interval
    setTimeout(checkEmails, 5000);
    setInterval(checkEmails, EMAIL_CHECK_INTERVAL);
  } else {
    console.log(`  📧 Email checking disabled (set EMAIL_PASS env var to enable)\n`);
  }
});
