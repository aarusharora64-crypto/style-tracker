const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
app.use(express.json());

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data.json');

// ── Email IMAP Config ─────────────────────────────────
const EMAIL_USER = process.env.EMAIL_USER || 'orders@internetexportsindia.com';
const EMAIL_PASS = process.env.EMAIL_PASS || '';  // Email password
const EMAIL_HOST = process.env.EMAIL_HOST || 'imap.rediffmailpro.com';
const EMAIL_PORT = parseInt(process.env.EMAIL_PORT) || 993;
const EMAIL_TLS = EMAIL_PORT === 993;  // Implicit TLS on 993
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
if (!db.processedEmailUIDs) db.processedEmailUIDs = [];
if (!db.users) db.users = [{ id: 'admin', name: 'Admin', role: 'admin', dept: 'all', pin: DEFAULT_ADMIN_PIN }];
if (!db.orders) db.orders = {};
if (!db.deptPasswords) db.deptPasswords = {};
if (!db.pendingChanges) db.pendingChanges = [];
if (!db.productionUnits) db.productionUnits = [];
if (!db.dailyProduction) db.dailyProduction = [];
if (!db.defects) db.defects = [];
if (!db.purchaseOrders) db.purchaseOrders = {};
if (!db.fabricInward) db.fabricInward = [];
if (!db.trimInward) db.trimInward = [];
if (!db.materialIssue) db.materialIssue = [];
if (!db.samples) db.samples = [];
if (!db.shipments) db.shipments = {};
if (!db.contacts) db.contacts = { buyers: {}, suppliers: {} };
if (!db.activityLog) db.activityLog = [];
if (!db.approvals) db.approvals = [];
if (!db.costings) db.costings = {};

// Migration: Add new fields to existing orders
Object.values(db.orders).forEach(order => {
  if (!order.stageQuantities) order.stageQuantities = {};
  if (!order.sizeColorMatrix) order.sizeColorMatrix = [];
  if (!order.sizeColorStages) order.sizeColorStages = {};
  if (!order.costSheet) order.costSheet = {};
  if (!order.assignment) order.assignment = {};
  if (!order.season) order.season = '';
  if (!order.paymentTerms) order.paymentTerms = '';
  if (!order.shipDate) order.shipDate = '';
  if (!order.orderDate) order.orderDate = '';
  if (!order.shipMode) order.shipMode = '';
  if (!order.currency) order.currency = '';
  if (!order.fobRate) order.fobRate = '';
  if (!order.totalValue) order.totalValue = '';
  if (!order.ourRef) order.ourRef = '';
});
saveData();

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

// Chat status → Order stage mapping (for sequential enforcement via chat)
const CHAT_STATUS_TO_STAGE = {
  cutting:   'cutting',
  stitching: 'stitching',
  finishing: 'finishing_qc',
  packing:   'packing',
  shipped:   'ex_factory'
};

// Find order by style number
function findOrderByStyle(styleNo) {
  if (!styleNo) return null;
  const upper = styleNo.toUpperCase();
  return Object.values(db.orders).find(o => {
    const oStyle = (o.styleNo || '').toUpperCase().replace(/\s+/g, '-');
    return oStyle === upper || oStyle.replace(/-/g, '') === upper.replace(/-/g, '');
  }) || null;
}

// Check if a stage can be activated (previous stage must be done)
function checkStageSequence(order, stageId) {
  const idx = ORDER_STAGES.findIndex(s => s.id === stageId);
  if (idx <= 0) return { allowed: true };
  const prev = ORDER_STAGES[idx - 1];
  const prevStatus = order.stages[prev.id] ? order.stages[prev.id].status : 'pending';
  if (prevStatus !== 'done') {
    return { allowed: false, blockedBy: prev.label };
  }
  return { allowed: true };
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
  const { buyer, styleNo, description, quantity, exFactoryDate, merchant, poNumber, season, paymentTerms, shipDate, orderDate, shipMode, currency, fobRate, totalValue, ourRef } = req.body;
  if (!buyer || !styleNo) return res.status(400).json({ error: 'Buyer and Style No required' });
  const id = 'ORD-' + Date.now().toString(36).toUpperCase();
  const stages = {};
  ORDER_STAGES.forEach(s => { stages[s.id] = { status: 'pending', targetDate: '', actualDate: '', notes: '', updatedBy: '', updatedAt: '' }; });
  const order = {
    id, buyer, styleNo, description: description || '', quantity: parseInt(quantity) || 0, exFactoryDate: exFactoryDate || '', merchant: merchant || '', poNumber: poNumber || '',
    season: season || '', paymentTerms: paymentTerms || '', shipDate: shipDate || '', orderDate: orderDate || '', shipMode: shipMode || '',
    currency: currency || '', fobRate: fobRate || '', totalValue: totalValue || '', ourRef: ourRef || '',
    stages,
    stageQuantities: {},
    sizeColorMatrix: [],
    sizeColorStages: {},
    costSheet: {},
    assignment: {},
    createdAt: new Date().toISOString(),
    history: []
  };
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

  // ── Sequential Stage Enforcement ──
  // Cannot mark a stage as 'active' or 'done' unless the previous stage is 'done'
  // (Setting target dates, notes, delayed, or issue status is always allowed)
  if (status === 'active' || status === 'done') {
    const stageIdx = ORDER_STAGES.findIndex(s => s.id === stageId);
    if (stageIdx > 0) {
      const prevStage = ORDER_STAGES[stageIdx - 1];
      const prevStatus = order.stages[prevStage.id] ? order.stages[prevStage.id].status : 'pending';
      if (prevStatus !== 'done') {
        return res.status(400).json({
          error: `Cannot update "${ORDER_STAGES[stageIdx].label}" — previous stage "${prevStage.label}" must be completed first.`,
          sequenceError: true,
          blockedBy: prevStage.label
        });
      }
    }
  }

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
  const { buyer, styleNo, description, quantity, exFactoryDate, merchant, poNumber, season, paymentTerms, shipDate, orderDate, shipMode, currency, fobRate, totalValue, ourRef } = req.body;
  if (buyer) order.buyer = buyer;
  if (styleNo) order.styleNo = styleNo;
  if (description !== undefined) order.description = description;
  if (quantity !== undefined) order.quantity = parseInt(quantity) || order.quantity;
  if (exFactoryDate !== undefined) order.exFactoryDate = exFactoryDate;
  if (merchant !== undefined) order.merchant = merchant;
  if (poNumber !== undefined) order.poNumber = poNumber;
  if (season !== undefined) order.season = season;
  if (paymentTerms !== undefined) order.paymentTerms = paymentTerms;
  if (shipDate !== undefined) order.shipDate = shipDate;
  if (orderDate !== undefined) order.orderDate = orderDate;
  if (shipMode !== undefined) order.shipMode = shipMode;
  if (currency !== undefined) order.currency = currency;
  if (fobRate !== undefined) order.fobRate = fobRate;
  if (totalValue !== undefined) order.totalValue = totalValue;
  if (ourRef !== undefined) order.ourRef = ourRef;
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

// ── Stage-wise Quantity Tracking ────────────────────
app.put('/api/orders/:id/stage-quantity', (req, res) => {
  const order = db.orders[req.params.id];
  if (!order) return res.status(404).json({ error: 'Order not found' });
  const { stageId, quantityReceived, quantityCompleted, quantityRejected, userName } = req.body;
  if (!stageId) return res.status(400).json({ error: 'stageId required' });

  if (!order.stageQuantities) order.stageQuantities = {};
  order.stageQuantities[stageId] = {
    quantityReceived: quantityReceived || 0,
    quantityCompleted: quantityCompleted || 0,
    quantityRejected: quantityRejected || 0,
    updatedBy: userName || '',
    updatedAt: new Date().toISOString()
  };
  saveData();
  io.emit('order-updated', { orderId: req.params.id, stageQuantities: order.stageQuantities });
  res.json({ ok: true, stageQuantities: order.stageQuantities });
});

app.get('/api/orders/:id/yield', (req, res) => {
  const order = db.orders[req.params.id];
  if (!order) return res.status(404).json({ error: 'Order not found' });

  const stageQuantities = order.stageQuantities || {};
  const stageYields = [];
  const shortageAlerts = [];

  ORDER_STAGES.forEach(stage => {
    if (stageQuantities[stage.id]) {
      const sq = stageQuantities[stage.id];
      const yieldPercent = sq.quantityReceived > 0
        ? Math.round((sq.quantityCompleted / sq.quantityReceived) * 100)
        : 0;

      stageYields.push({
        stage: stage.label,
        stageId: stage.id,
        received: sq.quantityReceived,
        completed: sq.quantityCompleted,
        rejected: sq.quantityRejected,
        yieldPercent
      });

      // Flag shortage if received < order quantity
      if (sq.quantityReceived < order.quantity) {
        shortageAlerts.push({
          stage: stage.label,
          stageId: stage.id,
          received: sq.quantityReceived,
          expected: order.quantity,
          shortage: order.quantity - sq.quantityReceived,
          shortagePercent: Math.round(((order.quantity - sq.quantityReceived) / order.quantity) * 100)
        });
      }
    }
  });

  // Overall yield: final packed / order quantity
  const packingStage = stageQuantities['packing'];
  const overallYield = packingStage && packingStage.quantityCompleted
    ? Math.round((packingStage.quantityCompleted / order.quantity) * 100)
    : 0;

  res.json({
    orderId: req.params.id,
    orderQuantity: order.quantity,
    stageYields,
    overallYield,
    shortageAlerts
  });
});

// ── Size-Color Matrix ────────────────────────────────
app.put('/api/orders/:id/size-color', (req, res) => {
  const order = db.orders[req.params.id];
  if (!order) return res.status(404).json({ error: 'Order not found' });
  const { sizeColorMatrix } = req.body;
  if (!Array.isArray(sizeColorMatrix)) return res.status(400).json({ error: 'sizeColorMatrix must be an array' });

  order.sizeColorMatrix = sizeColorMatrix;
  saveData();
  io.emit('order-updated', { orderId: req.params.id, sizeColorMatrix });
  res.json({ ok: true, sizeColorMatrix: order.sizeColorMatrix });
});

app.put('/api/orders/:id/size-color-stage', (req, res) => {
  const order = db.orders[req.params.id];
  if (!order) return res.status(404).json({ error: 'Order not found' });
  const { stageId, sizeColorBreakdown } = req.body;
  if (!stageId || !Array.isArray(sizeColorBreakdown)) {
    return res.status(400).json({ error: 'stageId and sizeColorBreakdown (array) required' });
  }

  if (!order.sizeColorStages) order.sizeColorStages = {};
  order.sizeColorStages[stageId] = sizeColorBreakdown;
  saveData();
  io.emit('order-updated', { orderId: req.params.id, sizeColorStages: order.sizeColorStages });
  res.json({ ok: true, sizeColorStages: order.sizeColorStages });
});

// ── Daily Production Logging ────────────────────────
app.post('/api/daily-production', (req, res) => {
  const { date, orderId, unitId, lineId, stage, quantityProduced, quantityRejected, targetQuantity, userName } = req.body;
  if (!date || !orderId || !stage) {
    return res.status(400).json({ error: 'date, orderId, and stage required' });
  }

  const id = 'DP-' + Date.now().toString(36).toUpperCase();
  const entry = {
    id,
    date,
    orderId,
    unitId: unitId || '',
    lineId: lineId || '',
    stage,
    quantityProduced: quantityProduced || 0,
    quantityRejected: quantityRejected || 0,
    targetQuantity: targetQuantity || 0,
    userName: userName || '',
    createdAt: new Date().toISOString()
  };

  db.dailyProduction.push(entry);
  saveData();
  io.emit('daily-production-created', entry);
  res.json({ ok: true, entry });
});

app.get('/api/daily-production', (req, res) => {
  const { date, orderId } = req.query;
  let results = db.dailyProduction || [];

  if (date) {
    results = results.filter(e => e.date === date);
  }
  if (orderId) {
    results = results.filter(e => e.orderId === orderId);
  }

  res.json(results);
});

app.get('/api/daily-production/summary', (req, res) => {
  const { from, to } = req.query;
  let entries = db.dailyProduction || [];

  if (from) {
    entries = entries.filter(e => e.date >= from);
  }
  if (to) {
    entries = entries.filter(e => e.date <= to);
  }

  // Aggregate by date
  const summary = {};
  entries.forEach(e => {
    if (!summary[e.date]) {
      summary[e.date] = {
        date: e.date,
        totalProduced: 0,
        totalRejected: 0,
        totalTarget: 0,
        entries: 0
      };
    }
    summary[e.date].totalProduced += e.quantityProduced || 0;
    summary[e.date].totalRejected += e.quantityRejected || 0;
    summary[e.date].totalTarget += e.targetQuantity || 0;
    summary[e.date].entries++;
  });

  res.json(Object.values(summary).sort((a, b) => a.date.localeCompare(b.date)));
});

// ── Production Unit Assignment ──────────────────────
app.put('/api/orders/:id/assignment', (req, res) => {
  const order = db.orders[req.params.id];
  if (!order) return res.status(404).json({ error: 'Order not found' });
  const { unitId, lineIds, cuttingTableIds } = req.body;

  order.assignment = {
    unitId: unitId || '',
    lineIds: lineIds || [],
    cuttingTableIds: cuttingTableIds || [],
    assignedAt: new Date().toISOString()
  };

  saveData();
  io.emit('order-updated', { orderId: req.params.id, assignment: order.assignment });
  res.json({ ok: true, assignment: order.assignment });
});

// ── Defect/QC Tracking ──────────────────────────────
// Standard defect types
const DEFECT_TYPES = [
  { id: 'broken_stitch', label: 'Broken Stitch', category: 'stitching' },
  { id: 'skip_stitch', label: 'Skip Stitch', category: 'stitching' },
  { id: 'open_seam', label: 'Open Seam', category: 'stitching' },
  { id: 'uneven_hem', label: 'Uneven Hem', category: 'stitching' },
  { id: 'puckering', label: 'Puckering', category: 'stitching' },
  { id: 'raw_edge', label: 'Raw Edge', category: 'stitching' },
  { id: 'shade_variation', label: 'Shade Variation', category: 'fabric' },
  { id: 'fabric_defect', label: 'Fabric Defect', category: 'fabric' },
  { id: 'stain', label: 'Stain/Spot', category: 'fabric' },
  { id: 'hole', label: 'Hole', category: 'fabric' },
  { id: 'measurement_out', label: 'Measurement Out', category: 'measurement' },
  { id: 'size_mismatch', label: 'Size Label Mismatch', category: 'measurement' },
  { id: 'pressing_mark', label: 'Pressing Mark', category: 'finishing' },
  { id: 'iron_damage', label: 'Iron Damage', category: 'finishing' },
  { id: 'poor_folding', label: 'Poor Folding', category: 'packing' },
  { id: 'wrong_label', label: 'Wrong Label/Tag', category: 'labeling' },
  { id: 'missing_trim', label: 'Missing Trim/Accessory', category: 'trims' },
  { id: 'other', label: 'Other', category: 'other' }
];

app.get('/api/defect-types', (req, res) => {
  res.json(DEFECT_TYPES);
});

app.post('/api/orders/:id/defects', (req, res) => {
  const order = db.orders[req.params.id];
  if (!order) return res.status(404).json({ error: 'Order not found' });

  const { stage, defectType, severity, quantity, description, action, inspector } = req.body;
  if (!stage || !defectType) {
    return res.status(400).json({ error: 'stage and defectType required' });
  }

  const id = 'DEF-' + Date.now().toString(36).toUpperCase();
  const defect = {
    id,
    orderId: req.params.id,
    stage,
    defectType,
    severity: severity || 'minor',
    quantity: quantity || 1,
    description: description || '',
    action: action || '',
    inspector: inspector || '',
    createdAt: new Date().toISOString()
  };

  db.defects.push(defect);
  saveData();
  io.emit('defect-created', defect);
  res.json({ ok: true, defect });
});

app.get('/api/orders/:id/defects', (req, res) => {
  const orderId = req.params.id;
  const defects = (db.defects || []).filter(d => d.orderId === orderId);
  res.json(defects);
});

app.get('/api/defect-summary', (req, res) => {
  const { orderId } = req.query;
  const defects = orderId
    ? (db.defects || []).filter(d => d.orderId === orderId)
    : (db.defects || []);

  let totalDefects = 0;
  const byType = {};
  const byStage = {};
  const bySeverity = {};
  let totalQuantity = 0;

  defects.forEach(d => {
    totalDefects++;
    totalQuantity += d.quantity || 1;

    if (!byType[d.defectType]) byType[d.defectType] = 0;
    byType[d.defectType]++;

    if (!byStage[d.stage]) byStage[d.stage] = 0;
    byStage[d.stage]++;

    if (!bySeverity[d.severity]) bySeverity[d.severity] = 0;
    bySeverity[d.severity]++;
  });

  const defectRate = totalQuantity > 0 ? Math.round((totalDefects / totalQuantity) * 100) / 100 : 0;

  res.json({
    totalDefects,
    totalQuantity,
    defectRate,
    byType,
    byStage,
    bySeverity
  });
});

// ── Lightweight Costing ─────────────────────────────
app.put('/api/orders/:id/cost-sheet', (req, res) => {
  const order = db.orders[req.params.id];
  if (!order) return res.status(404).json({ error: 'Order not found' });

  const costSheet = req.body;
  order.costSheet = costSheet;
  saveData();
  io.emit('order-updated', { orderId: req.params.id, costSheet });
  res.json({ ok: true, costSheet: order.costSheet });
});

app.get('/api/orders/:id/cost-sheet', (req, res) => {
  const order = db.orders[req.params.id];
  if (!order) return res.status(404).json({ error: 'Order not found' });
  res.json(order.costSheet || {});
});

// ── CSV Export ──────────────────────────────────────
function escapeCSV(str) {
  if (!str) return '';
  const s = String(str);
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

app.get('/api/exports/orders', (req, res) => {
  const orders = Object.values(db.orders);
  const rows = [['Order ID', 'Buyer', 'Style No', 'PO Number', 'Quantity', 'Ex-Factory Date', 'Current Stage', 'Progress %', 'Created At']];

  orders.forEach(o => {
    const doneStages = ORDER_STAGES.filter(s => o.stages[s.id] && o.stages[s.id].status === 'done').length;
    const progressPct = Math.round((doneStages / ORDER_STAGES.length) * 100);
    const currentStage = ORDER_STAGES.find(s => !o.stages[s.id] || o.stages[s.id].status !== 'done');

    rows.push([
      escapeCSV(o.id),
      escapeCSV(o.buyer),
      escapeCSV(o.styleNo),
      escapeCSV(o.poNumber),
      o.quantity,
      escapeCSV(o.exFactoryDate),
      escapeCSV(currentStage ? currentStage.label : 'Complete'),
      progressPct,
      escapeCSV(o.createdAt)
    ]);
  });

  const csv = rows.map(r => r.join(',')).join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="orders.csv"');
  res.send(csv);
});

app.get('/api/exports/daily-production', (req, res) => {
  const { from, to } = req.query;
  let entries = db.dailyProduction || [];

  if (from) entries = entries.filter(e => e.date >= from);
  if (to) entries = entries.filter(e => e.date <= to);

  const rows = [['ID', 'Date', 'Order ID', 'Unit ID', 'Line ID', 'Stage', 'Quantity Produced', 'Quantity Rejected', 'Target Quantity', 'User Name', 'Created At']];

  entries.forEach(e => {
    rows.push([
      escapeCSV(e.id),
      escapeCSV(e.date),
      escapeCSV(e.orderId),
      escapeCSV(e.unitId),
      escapeCSV(e.lineId),
      escapeCSV(e.stage),
      e.quantityProduced,
      e.quantityRejected,
      e.targetQuantity,
      escapeCSV(e.userName),
      escapeCSV(e.createdAt)
    ]);
  });

  const csv = rows.map(r => r.join(',')).join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="daily-production.csv"');
  res.send(csv);
});

app.get('/api/exports/defects', (req, res) => {
  const { orderId } = req.query;
  const defects = orderId
    ? (db.defects || []).filter(d => d.orderId === orderId)
    : (db.defects || []);

  const rows = [['ID', 'Order ID', 'Stage', 'Defect Type', 'Severity', 'Quantity', 'Description', 'Action', 'Inspector', 'Created At']];

  defects.forEach(d => {
    rows.push([
      escapeCSV(d.id),
      escapeCSV(d.orderId),
      escapeCSV(d.stage),
      escapeCSV(d.defectType),
      escapeCSV(d.severity),
      d.quantity,
      escapeCSV(d.description),
      escapeCSV(d.action),
      escapeCSV(d.inspector),
      escapeCSV(d.createdAt)
    ]);
  });

  const csv = rows.map(r => r.join(',')).join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="defects.csv"');
  res.send(csv);
});

// ── Shortage Alert Endpoint ─────────────────────────
app.get('/api/alerts/shortages', (req, res) => {
  const alerts = [];
  const orders = Object.values(db.orders);

  orders.forEach(order => {
    const stageQuantities = order.stageQuantities || {};

    ORDER_STAGES.forEach(stage => {
      if (stageQuantities[stage.id]) {
        const sq = stageQuantities[stage.id];
        if (sq.quantityReceived < order.quantity) {
          alerts.push({
            orderId: order.id,
            buyer: order.buyer,
            styleNo: order.styleNo,
            orderQuantity: order.quantity,
            stage: stage.label,
            stageId: stage.id,
            received: sq.quantityReceived,
            shortage: order.quantity - sq.quantityReceived,
            shortagePercent: Math.round(((order.quantity - sq.quantityReceived) / order.quantity) * 100)
          });
        }
      }
    });
  });

  // Sort by shortage percentage descending
  alerts.sort((a, b) => b.shortagePercent - a.shortagePercent);

  res.json(alerts);
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

// ── Production Units APIs ─────────────────────────────
app.get('/api/production-units', (req, res) => {
  res.json(db.productionUnits || []);
});

app.post('/api/production-units', (req, res) => {
  if (!isAdmin(req.body.adminPin)) return res.status(403).json({ error: 'Invalid admin PIN' });
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'Unit name required' });
  const unit = {
    id: 'unit_' + Date.now().toString(36), name,
    sewingLines: [], totalSewingOperators: 0, numSewingLines: 0,
    cuttingTables: [], totalCuttingTables: 0,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
  };
  db.productionUnits.push(unit);
  saveData();
  io.emit('production-units-updated', db.productionUnits);
  res.json({ ok: true, unit });
});

app.put('/api/production-units/:id', (req, res) => {
  if (!isAdmin(req.body.adminPin)) return res.status(403).json({ error: 'Invalid admin PIN' });
  const unit = (db.productionUnits || []).find(u => u.id === req.params.id);
  if (!unit) return res.status(404).json({ error: 'Unit not found' });
  if (req.body.name) unit.name = req.body.name;
  if (req.body.totalSewingOperators !== undefined) unit.totalSewingOperators = parseInt(req.body.totalSewingOperators);
  if (req.body.numSewingLines !== undefined) unit.numSewingLines = parseInt(req.body.numSewingLines);
  if (req.body.totalCuttingTables !== undefined) unit.totalCuttingTables = parseInt(req.body.totalCuttingTables);
  unit.updatedAt = new Date().toISOString();
  saveData();
  io.emit('production-units-updated', db.productionUnits);
  res.json({ ok: true, unit });
});

app.delete('/api/production-units/:id', (req, res) => {
  if (!isAdmin(req.body.adminPin)) return res.status(403).json({ error: 'Invalid admin PIN' });
  db.productionUnits = (db.productionUnits || []).filter(u => u.id !== req.params.id);
  saveData();
  io.emit('production-units-updated', db.productionUnits);
  res.json({ ok: true });
});

app.post('/api/production-units/:id/sewing-lines', (req, res) => {
  if (!isAdmin(req.body.adminPin)) return res.status(403).json({ error: 'Invalid admin PIN' });
  const unit = (db.productionUnits || []).find(u => u.id === req.params.id);
  if (!unit) return res.status(404).json({ error: 'Unit not found' });
  const line = {
    id: 'line_' + Date.now().toString(36),
    name: req.body.name || 'New Line',
    operators: parseInt(req.body.operators) || 0,
    dailyOutput: parseInt(req.body.dailyOutput) || 0
  };
  if (!unit.sewingLines) unit.sewingLines = [];
  unit.sewingLines.push(line);
  unit.updatedAt = new Date().toISOString();
  saveData();
  io.emit('production-units-updated', db.productionUnits);
  res.json({ ok: true, line });
});

app.put('/api/production-units/:uid/sewing-lines/:lid', (req, res) => {
  if (!isAdmin(req.body.adminPin)) return res.status(403).json({ error: 'Invalid admin PIN' });
  const unit = (db.productionUnits || []).find(u => u.id === req.params.uid);
  if (!unit) return res.status(404).json({ error: 'Unit not found' });
  const line = (unit.sewingLines || []).find(l => l.id === req.params.lid);
  if (!line) return res.status(404).json({ error: 'Line not found' });
  if (req.body.name) line.name = req.body.name;
  if (req.body.operators !== undefined) line.operators = parseInt(req.body.operators);
  if (req.body.dailyOutput !== undefined) line.dailyOutput = parseInt(req.body.dailyOutput);
  unit.updatedAt = new Date().toISOString();
  saveData();
  io.emit('production-units-updated', db.productionUnits);
  res.json({ ok: true, line });
});

app.delete('/api/production-units/:uid/sewing-lines/:lid', (req, res) => {
  if (!isAdmin(req.body.adminPin)) return res.status(403).json({ error: 'Invalid admin PIN' });
  const unit = (db.productionUnits || []).find(u => u.id === req.params.uid);
  if (!unit) return res.status(404).json({ error: 'Unit not found' });
  unit.sewingLines = (unit.sewingLines || []).filter(l => l.id !== req.params.lid);
  unit.updatedAt = new Date().toISOString();
  saveData();
  io.emit('production-units-updated', db.productionUnits);
  res.json({ ok: true });
});

app.post('/api/production-units/:id/cutting-tables', (req, res) => {
  if (!isAdmin(req.body.adminPin)) return res.status(403).json({ error: 'Invalid admin PIN' });
  const unit = (db.productionUnits || []).find(u => u.id === req.params.id);
  if (!unit) return res.status(404).json({ error: 'Unit not found' });
  const table = {
    id: 'ct_' + Date.now().toString(36),
    name: req.body.name || 'New Table',
    dailyCapacity: parseInt(req.body.dailyCapacity) || 0
  };
  if (!unit.cuttingTables) unit.cuttingTables = [];
  unit.cuttingTables.push(table);
  unit.updatedAt = new Date().toISOString();
  saveData();
  io.emit('production-units-updated', db.productionUnits);
  res.json({ ok: true, table });
});

app.put('/api/production-units/:uid/cutting-tables/:tid', (req, res) => {
  if (!isAdmin(req.body.adminPin)) return res.status(403).json({ error: 'Invalid admin PIN' });
  const unit = (db.productionUnits || []).find(u => u.id === req.params.uid);
  if (!unit) return res.status(404).json({ error: 'Unit not found' });
  const table = (unit.cuttingTables || []).find(t => t.id === req.params.tid);
  if (!table) return res.status(404).json({ error: 'Table not found' });
  if (req.body.name) table.name = req.body.name;
  if (req.body.dailyCapacity !== undefined) table.dailyCapacity = parseInt(req.body.dailyCapacity);
  unit.updatedAt = new Date().toISOString();
  saveData();
  io.emit('production-units-updated', db.productionUnits);
  res.json({ ok: true, table });
});

app.delete('/api/production-units/:uid/cutting-tables/:tid', (req, res) => {
  if (!isAdmin(req.body.adminPin)) return res.status(403).json({ error: 'Invalid admin PIN' });
  const unit = (db.productionUnits || []).find(u => u.id === req.params.uid);
  if (!unit) return res.status(404).json({ error: 'Unit not found' });
  unit.cuttingTables = (unit.cuttingTables || []).filter(t => t.id !== req.params.tid);
  unit.updatedAt = new Date().toISOString();
  saveData();
  io.emit('production-units-updated', db.productionUnits);
  res.json({ ok: true });
});

// ── Purchase Order Management ─────────────────────
app.get('/api/purchase-orders', (req, res) => {
  const { orderId, type, status } = req.query;
  let pos = Object.values(db.purchaseOrders);
  if (orderId) pos = pos.filter(p => p.orderId === orderId);
  if (type) pos = pos.filter(p => p.type === type);
  if (status) pos = pos.filter(p => p.status === status);
  res.json(pos);
});

app.post('/api/purchase-orders', (req, res) => {
  const { orderId, type, supplier, items, totalAmount, currency, notes, createdBy } = req.body;
  if (!type || !supplier) return res.status(400).json({ error: 'type and supplier required' });
  const id = 'PO-' + Date.now().toString(36).toUpperCase();
  const po = {
    id, orderId: orderId || '', type, // fabric, trim, process
    supplier, items: items || [], totalAmount: totalAmount || 0, currency: currency || 'INR',
    notes: notes || '', status: 'draft', // draft, pending_approval, approved, partially_received, received, cancelled
    createdBy: createdBy || '', createdAt: new Date().toISOString(),
    approvedBy: '', approvedAt: '', history: []
  };
  db.purchaseOrders[id] = po;
  saveData();
  io.emit('po-created', po);
  res.json({ ok: true, po });
});

app.put('/api/purchase-orders/:id', (req, res) => {
  const po = db.purchaseOrders[req.params.id];
  if (!po) return res.status(404).json({ error: 'PO not found' });
  const fields = ['supplier', 'items', 'totalAmount', 'currency', 'notes', 'orderId', 'type'];
  fields.forEach(f => { if (req.body[f] !== undefined) po[f] = req.body[f]; });
  po.history.push({ action: 'updated', by: req.body.userName || '', at: new Date().toISOString() });
  saveData();
  io.emit('po-updated', po);
  res.json({ ok: true, po });
});

app.put('/api/purchase-orders/:id/status', (req, res) => {
  const po = db.purchaseOrders[req.params.id];
  if (!po) return res.status(404).json({ error: 'PO not found' });
  const { status, userName } = req.body;
  if (!status) return res.status(400).json({ error: 'status required' });
  const oldStatus = po.status;
  po.status = status;
  if (status === 'approved') { po.approvedBy = userName || ''; po.approvedAt = new Date().toISOString(); }
  po.history.push({ action: `status: ${oldStatus} → ${status}`, by: userName || '', at: new Date().toISOString() });
  saveData();
  io.emit('po-updated', po);
  io.emit('notify', { title: `PO ${po.id} ${status}`, body: `${po.supplier} - ${po.type} PO ${status}`, targetDepts: ['all'], fromUser: userName || '', at: new Date().toISOString() });
  res.json({ ok: true, po });
});

app.delete('/api/purchase-orders/:id', (req, res) => {
  if (!db.purchaseOrders[req.params.id]) return res.status(404).json({ error: 'PO not found' });
  delete db.purchaseOrders[req.params.id];
  saveData();
  io.emit('po-deleted', req.params.id);
  res.json({ ok: true });
});

// ── Inventory / Store Management ──────────────────
app.get('/api/inventory/fabric', (req, res) => {
  const { orderId } = req.query;
  let items = db.fabricInward || [];
  if (orderId) items = items.filter(i => i.orderId === orderId);
  res.json(items);
});

app.post('/api/inventory/fabric', (req, res) => {
  const { orderId, poId, fabricType, quality, color, quantityReceived, unit, supplierName, challanNo, receivedBy, notes } = req.body;
  const id = 'FI-' + Date.now().toString(36).toUpperCase();
  const entry = {
    id, orderId: orderId || '', poId: poId || '', fabricType: fabricType || '',
    quality: quality || '', color: color || '', quantityReceived: quantityReceived || 0,
    unit: unit || 'MTR', supplierName: supplierName || '', challanNo: challanNo || '',
    receivedBy: receivedBy || '', notes: notes || '', date: new Date().toISOString().split('T')[0],
    createdAt: new Date().toISOString()
  };
  db.fabricInward.push(entry);
  saveData();
  io.emit('fabric-inward-created', entry);
  res.json({ ok: true, entry });
});

app.get('/api/inventory/trims', (req, res) => {
  const { orderId } = req.query;
  let items = db.trimInward || [];
  if (orderId) items = items.filter(i => i.orderId === orderId);
  res.json(items);
});

app.post('/api/inventory/trims', (req, res) => {
  const { orderId, poId, trimType, description, quantityReceived, unit, supplierName, challanNo, receivedBy, notes } = req.body;
  const id = 'TI-' + Date.now().toString(36).toUpperCase();
  const entry = {
    id, orderId: orderId || '', poId: poId || '', trimType: trimType || '',
    description: description || '', quantityReceived: quantityReceived || 0,
    unit: unit || 'PCS', supplierName: supplierName || '', challanNo: challanNo || '',
    receivedBy: receivedBy || '', notes: notes || '', date: new Date().toISOString().split('T')[0],
    createdAt: new Date().toISOString()
  };
  db.trimInward.push(entry);
  saveData();
  io.emit('trim-inward-created', entry);
  res.json({ ok: true, entry });
});

app.post('/api/inventory/issue', (req, res) => {
  const { orderId, materialType, materialId, quantityIssued, issuedTo, issuedBy, notes } = req.body;
  const id = 'MI-' + Date.now().toString(36).toUpperCase();
  const entry = {
    id, orderId: orderId || '', materialType: materialType || '', materialId: materialId || '',
    quantityIssued: quantityIssued || 0, issuedTo: issuedTo || '', issuedBy: issuedBy || '',
    notes: notes || '', date: new Date().toISOString().split('T')[0], createdAt: new Date().toISOString()
  };
  db.materialIssue.push(entry);
  saveData();
  io.emit('material-issued', entry);
  res.json({ ok: true, entry });
});

app.get('/api/inventory/issue', (req, res) => {
  const { orderId } = req.query;
  let items = db.materialIssue || [];
  if (orderId) items = items.filter(i => i.orderId === orderId);
  res.json(items);
});

app.get('/api/inventory/balance/:orderId', (req, res) => {
  const orderId = req.params.orderId;
  const fabricIn = (db.fabricInward || []).filter(i => i.orderId === orderId);
  const trimIn = (db.trimInward || []).filter(i => i.orderId === orderId);
  const issued = (db.materialIssue || []).filter(i => i.orderId === orderId);

  const fabricReceived = fabricIn.reduce((sum, i) => sum + (i.quantityReceived || 0), 0);
  const trimReceived = trimIn.reduce((sum, i) => sum + (i.quantityReceived || 0), 0);
  const fabricIssued = issued.filter(i => i.materialType === 'fabric').reduce((sum, i) => sum + (i.quantityIssued || 0), 0);
  const trimIssued = issued.filter(i => i.materialType === 'trim').reduce((sum, i) => sum + (i.quantityIssued || 0), 0);

  res.json({
    orderId,
    fabric: { received: fabricReceived, issued: fabricIssued, balance: fabricReceived - fabricIssued, entries: fabricIn },
    trims: { received: trimReceived, issued: trimIssued, balance: trimReceived - trimIssued, entries: trimIn },
    issues: issued
  });
});

// ── Sampling Management ───────────────────────────
const SAMPLE_TYPES = ['proto', 'development', 'fit', 'size_set', 'pp', 'production', 'photo', 'salesman'];
const SAMPLE_STATUSES = ['pending', 'in_progress', 'submitted', 'approved', 'rejected', 'revision'];

app.get('/api/samples', (req, res) => {
  const { orderId, type, status } = req.query;
  let samples = db.samples || [];
  if (orderId) samples = samples.filter(s => s.orderId === orderId);
  if (type) samples = samples.filter(s => s.type === type);
  if (status) samples = samples.filter(s => s.status === status);
  res.json(samples);
});

app.post('/api/samples', (req, res) => {
  const { orderId, styleNo, buyer, type, quantity, fabricComposition, description, assignedTo, dueDate, createdBy } = req.body;
  if (!type) return res.status(400).json({ error: 'sample type required' });
  const id = 'SMP-' + Date.now().toString(36).toUpperCase();
  const sample = {
    id, orderId: orderId || '', styleNo: styleNo || '', buyer: buyer || '',
    type, quantity: quantity || 1, fabricComposition: fabricComposition || '',
    description: description || '', assignedTo: assignedTo || '', dueDate: dueDate || '',
    status: 'pending', courier: null, // { trackingNo, carrier, weight, mode, bookedDate, cost }
    comments: [], createdBy: createdBy || '', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
  };
  db.samples.push(sample);
  saveData();
  io.emit('sample-created', sample);
  res.json({ ok: true, sample });
});

app.put('/api/samples/:id', (req, res) => {
  const sample = (db.samples || []).find(s => s.id === req.params.id);
  if (!sample) return res.status(404).json({ error: 'Sample not found' });
  const fields = ['status', 'assignedTo', 'dueDate', 'description', 'quantity', 'fabricComposition'];
  fields.forEach(f => { if (req.body[f] !== undefined) sample[f] = req.body[f]; });
  sample.updatedAt = new Date().toISOString();
  if (req.body.comment) {
    sample.comments.push({ text: req.body.comment, by: req.body.userName || '', at: new Date().toISOString() });
  }
  saveData();
  io.emit('sample-updated', sample);
  res.json({ ok: true, sample });
});

app.put('/api/samples/:id/courier', (req, res) => {
  const sample = (db.samples || []).find(s => s.id === req.params.id);
  if (!sample) return res.status(404).json({ error: 'Sample not found' });
  const { trackingNo, carrier, weight, mode, cost, bookedBy } = req.body;
  sample.courier = {
    trackingNo: trackingNo || '', carrier: carrier || '', weight: weight || '',
    mode: mode || '', cost: cost || '', bookedBy: bookedBy || '',
    bookedDate: new Date().toISOString().split('T')[0]
  };
  sample.updatedAt = new Date().toISOString();
  saveData();
  io.emit('sample-updated', sample);
  res.json({ ok: true, sample });
});

app.delete('/api/samples/:id', (req, res) => {
  const idx = (db.samples || []).findIndex(s => s.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Sample not found' });
  db.samples.splice(idx, 1);
  saveData();
  io.emit('sample-deleted', req.params.id);
  res.json({ ok: true });
});

// ── Shipment & Documentation ──────────────────────
app.get('/api/shipments', (req, res) => {
  const { orderId, status } = req.query;
  let shipments = Object.values(db.shipments);
  if (orderId) shipments = shipments.filter(s => s.orderId === orderId);
  if (status) shipments = shipments.filter(s => s.status === status);
  res.json(shipments);
});

app.post('/api/shipments', (req, res) => {
  const { orderId, buyer, styleNo, quantity, cartons, grossWeight, netWeight, cbm, courierMode, carrier, trackingNo, destination, etd, eta, invoiceNo, notes, createdBy } = req.body;
  if (!orderId) return res.status(400).json({ error: 'orderId required' });
  const id = 'SHP-' + Date.now().toString(36).toUpperCase();
  const shipment = {
    id, orderId, buyer: buyer || '', styleNo: styleNo || '',
    quantity: quantity || 0, cartons: cartons || 0,
    grossWeight: grossWeight || '', netWeight: netWeight || '', cbm: cbm || '',
    courierMode: courierMode || '', carrier: carrier || '', trackingNo: trackingNo || '',
    destination: destination || '', etd: etd || '', eta: eta || '',
    invoiceNo: invoiceNo || '', notes: notes || '',
    status: 'booked', // booked, dispatched, in_transit, delivered
    createdBy: createdBy || '', createdAt: new Date().toISOString(), history: []
  };
  db.shipments[id] = shipment;
  saveData();
  io.emit('shipment-created', shipment);
  res.json({ ok: true, shipment });
});

app.put('/api/shipments/:id', (req, res) => {
  const shipment = db.shipments[req.params.id];
  if (!shipment) return res.status(404).json({ error: 'Shipment not found' });
  const fields = ['quantity', 'cartons', 'grossWeight', 'netWeight', 'cbm', 'courierMode', 'carrier', 'trackingNo', 'destination', 'etd', 'eta', 'invoiceNo', 'notes', 'status'];
  fields.forEach(f => { if (req.body[f] !== undefined) shipment[f] = req.body[f]; });
  shipment.history.push({ action: 'updated', by: req.body.userName || '', at: new Date().toISOString(), changes: req.body });
  saveData();
  io.emit('shipment-updated', shipment);
  res.json({ ok: true, shipment });
});

app.delete('/api/shipments/:id', (req, res) => {
  if (!db.shipments[req.params.id]) return res.status(404).json({ error: 'Shipment not found' });
  delete db.shipments[req.params.id];
  saveData();
  io.emit('shipment-deleted', req.params.id);
  res.json({ ok: true });
});

// ── Contacts Directory ────────────────────────────
app.get('/api/contacts', (req, res) => {
  res.json(db.contacts);
});

app.get('/api/contacts/buyers', (req, res) => {
  res.json(db.contacts.buyers || {});
});

app.post('/api/contacts/buyers', (req, res) => {
  const { name, country, email, phone, contactPerson, paymentTerms, notes } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  const id = 'BUY-' + Date.now().toString(36).toUpperCase();
  const buyer = { id, name, country: country || '', email: email || '', phone: phone || '', contactPerson: contactPerson || '', paymentTerms: paymentTerms || '', notes: notes || '', createdAt: new Date().toISOString() };
  if (!db.contacts.buyers) db.contacts.buyers = {};
  db.contacts.buyers[id] = buyer;
  saveData();
  res.json({ ok: true, buyer });
});

app.put('/api/contacts/buyers/:id', (req, res) => {
  const buyer = (db.contacts.buyers || {})[req.params.id];
  if (!buyer) return res.status(404).json({ error: 'Buyer not found' });
  const fields = ['name', 'country', 'email', 'phone', 'contactPerson', 'paymentTerms', 'notes'];
  fields.forEach(f => { if (req.body[f] !== undefined) buyer[f] = req.body[f]; });
  saveData();
  res.json({ ok: true, buyer });
});

app.delete('/api/contacts/buyers/:id', (req, res) => {
  if (!(db.contacts.buyers || {})[req.params.id]) return res.status(404).json({ error: 'Buyer not found' });
  delete db.contacts.buyers[req.params.id];
  saveData();
  res.json({ ok: true });
});

app.get('/api/contacts/suppliers', (req, res) => {
  res.json(db.contacts.suppliers || {});
});

app.post('/api/contacts/suppliers', (req, res) => {
  const { name, type, email, phone, contactPerson, address, gstNo, panNo, bankDetails, notes } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  const id = 'SUP-' + Date.now().toString(36).toUpperCase();
  const supplier = { id, name, type: type || '', email: email || '', phone: phone || '', contactPerson: contactPerson || '', address: address || '', gstNo: gstNo || '', panNo: panNo || '', bankDetails: bankDetails || '', notes: notes || '', createdAt: new Date().toISOString() };
  if (!db.contacts.suppliers) db.contacts.suppliers = {};
  db.contacts.suppliers[id] = supplier;
  saveData();
  res.json({ ok: true, supplier });
});

app.put('/api/contacts/suppliers/:id', (req, res) => {
  const supplier = (db.contacts.suppliers || {})[req.params.id];
  if (!supplier) return res.status(404).json({ error: 'Supplier not found' });
  const fields = ['name', 'type', 'email', 'phone', 'contactPerson', 'address', 'gstNo', 'panNo', 'bankDetails', 'notes'];
  fields.forEach(f => { if (req.body[f] !== undefined) supplier[f] = req.body[f]; });
  saveData();
  res.json({ ok: true, supplier });
});

app.delete('/api/contacts/suppliers/:id', (req, res) => {
  if (!(db.contacts.suppliers || {})[req.params.id]) return res.status(404).json({ error: 'Supplier not found' });
  delete db.contacts.suppliers[req.params.id];
  saveData();
  res.json({ ok: true });
});

// ── Dashboard / Analytics ─────────────────────────
app.get('/api/dashboard', (req, res) => {
  const orders = Object.values(db.orders);
  const today = new Date();
  const todayStr = today.toISOString().split('T')[0];

  // Order stats
  const totalOrders = orders.length;
  let activeOrders = 0, completedOrders = 0, overdueOrders = 0, urgentOrders = 0;
  const stageDistribution = {};
  ORDER_STAGES.forEach(s => { stageDistribution[s.id] = { label: s.label, count: 0 }; });

  orders.forEach(o => {
    const doneCount = ORDER_STAGES.filter(s => o.stages[s.id] && o.stages[s.id].status === 'done').length;
    if (doneCount === ORDER_STAGES.length) { completedOrders++; return; }
    activeOrders++;

    // Find current stage
    const currentStage = ORDER_STAGES.find(s => !o.stages[s.id] || o.stages[s.id].status !== 'done');
    if (currentStage) stageDistribution[currentStage.id].count++;

    // Overdue check
    if (o.exFactoryDate) {
      const exDate = new Date(o.exFactoryDate);
      const daysLeft = Math.round((exDate - today) / 86400000);
      if (daysLeft < 0) overdueOrders++;
      else if (daysLeft <= 14) urgentOrders++;
    }
  });

  // PO stats
  const pos = Object.values(db.purchaseOrders || {});
  const pendingPOs = pos.filter(p => p.status === 'pending_approval').length;
  const activePOs = pos.filter(p => ['draft', 'pending_approval', 'approved'].includes(p.status)).length;

  // Sample stats
  const samples = db.samples || [];
  const pendingSamples = samples.filter(s => s.status === 'pending' || s.status === 'in_progress').length;

  // Shipment stats
  const shipments = Object.values(db.shipments || {});
  const activeShipments = shipments.filter(s => s.status !== 'delivered').length;

  // Today's production
  const todayProduction = (db.dailyProduction || []).filter(e => e.date === todayStr);
  const todayProduced = todayProduction.reduce((sum, e) => sum + (e.quantityProduced || 0), 0);

  // Pending approvals
  const pendingApprovals = (db.pendingChanges || []).filter(p => p.status === 'pending').length;

  res.json({
    orders: { total: totalOrders, active: activeOrders, completed: completedOrders, overdue: overdueOrders, urgent: urgentOrders },
    stageDistribution,
    purchaseOrders: { total: pos.length, active: activePOs, pendingApproval: pendingPOs },
    samples: { total: samples.length, pending: pendingSamples },
    shipments: { total: shipments.length, active: activeShipments },
    production: { todayProduced, todayEntries: todayProduction.length },
    pendingApprovals,
    contacts: { buyers: Object.keys(db.contacts.buyers || {}).length, suppliers: Object.keys(db.contacts.suppliers || {}).length }
  });
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

    // ── Sequential Stage Enforcement via Chat ──
    // If this chat message maps to a production stage, check if the previous stage is done
    if (styleNum && status && status !== 'issue' && status !== 'other') {
      const mappedStage = CHAT_STATUS_TO_STAGE[status];
      if (mappedStage) {
        const order = findOrderByStyle(styleNum);
        if (order) {
          const check = checkStageSequence(order, mappedStage);
          if (!check.allowed) {
            // Send a system reply back to the user
            const sysMsg = {
              id: Date.now().toString(36) + 'sys',
              userId: 'system', userName: 'Style Tracker', userDept: 'system',
              text: `⛔ Cannot update ${styleNum} to "${status}" — previous stage "${check.blockedBy}" must be completed first. Please complete stages in order.`,
              styleNum: null, status: null, time: now, isSystem: true
            };
            db.messages.push(sysMsg);
            if (db.messages.length > 5000) db.messages = db.messages.slice(-5000);
            saveData();
            io.emit('new-message', sysMsg);
            return; // Block the update
          }
        }
      }
    }

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
  const rate = extractField(text, 'Rate(FOB)') || extractField(text, 'Rate') || extractField(htmlAndText, 'Rate(FOB)') || extractField(htmlAndText, 'Rate');
  const totalValue = extractField(text, 'Total Order Value') || extractField(htmlAndText, 'Total Order Value');
  const shipMode = extractField(text, 'Mode of Shipment') || extractField(htmlAndText, 'Mode of Shipment');
  const paymentTerms = extractField(text, 'Terms of Payment') || extractField(htmlAndText, 'Terms of Payment');
  const ourRef = extractField(text, 'Our Ref') || extractField(htmlAndText, 'Our Ref');
  const poNumber = extractField(text, 'EO No') || extractField(htmlAndText, 'EO No') || eoNo;

  // Quantity
  let quantity = 0;
  const qtyStr = extractField(text, 'Quantity') || extractField(htmlAndText, 'Quantity');
  if (qtyStr) quantity = parseInt(qtyStr.replace(/,/g, '')) || 0;

  // Dates
  const exFactoryDate = parseEODate(extractField(text, 'Ex Factory Date') || extractField(htmlAndText, 'Ex Factory Date'));
  const shipDate = parseEODate(extractField(text, 'Ship Date') || extractField(htmlAndText, 'Ship Date'));
  const orderDate = parseEODate(extractField(text, 'Order Date') || extractField(htmlAndText, 'Order Date'));

  // Parse FOB Rate and Currency from "11.150000 EUR" format
  let fobRate = '';
  let currency = '';
  if (rate) {
    const rateMatch = rate.match(/^([\d.]+)\s*([A-Z]{3})?/);
    if (rateMatch) {
      fobRate = rateMatch[1];
      if (rateMatch[2]) currency = rateMatch[2];
    }
  }

  // Parse Total Value and Currency from "123456.50 EUR" format
  let totalValueAmount = '';
  let totalValueCurrency = '';
  if (totalValue) {
    const valueMatch = totalValue.match(/^([\d,.]+)\s*([A-Z]{3})?/);
    if (valueMatch) {
      totalValueAmount = valueMatch[1];
      if (valueMatch[2]) totalValueCurrency = valueMatch[2];
      // Use currency from totalValue if not already set
      if (!currency && totalValueCurrency) currency = totalValueCurrency;
    }
  }

  // Build description with useful info
  const descParts = [];
  if (styleDesc) descParts.push(styleDesc);
  if (season) descParts.push(`Season: ${season}`);
  if (rate) descParts.push(`Rate: ${rate}`);
  if (totalValue) descParts.push(`Value: ${totalValue}`);
  if (shipMode) descParts.push(`Ship: ${shipMode}`);
  const description = descParts.join(' | ');

  return { buyer, styleNo, poNumber, quantity, exFactoryDate, shipDate, orderDate, description, merchandiser, season, paymentTerms, ourRef, fobRate, currency, totalValue: totalValueAmount };
}

// ── Workflow Engine - Email Classification & Processing ──
function classifyAndProcessEmail(subject, body, from, to, date) {
  const combined = (subject + ' ' + body).toLowerCase();
  const fullText = body || '';
  const actions = [];

  let emailType = 'general';
  let extractedData = {};

  // Classify email type
  if (subject.includes('New EO:')) {
    emailType = 'eo_alert';
  } else if (combined.includes('fab consumption revised')) {
    emailType = 'fab_consumption';
  } else if (combined.includes('cash payment report')) {
    emailType = 'cash_payment';
  } else if (combined.includes('bank payment report')) {
    emailType = 'bank_payment';
  } else if (combined.includes('daily present') || combined.includes('todays absentisam')) {
    emailType = 'attendance';
  } else if (subject.includes('APPROVE PO')) {
    emailType = 'po_approval';
  } else if (subject.includes('FOR COST UPDATE') || subject.includes('COST UPDATE')) {
    emailType = 'cost_update';
  } else if (subject.includes('plz add') || from.includes('store5@') || from.includes('jagjit')) {
    emailType = 'process_cost';
  } else if (subject.includes('COURIER DETAILS')) {
    emailType = 'courier_details';
  } else if (subject.includes('EXCESS RECEIVE')) {
    emailType = 'excess_receive';
  } else if (subject.includes('PACKING LIST')) {
    emailType = 'packing_list';
  } else if (subject.includes('EXTRA PCS')) {
    emailType = 'extra_pcs';
  } else if (subject.includes('Gate pass')) {
    emailType = 'gate_pass';
  }

  // Extract structured data by email type
  switch (emailType) {
    case 'eo_alert':
      extractedData = {
        type: 'eo_alert',
        eoNo: subject.match(/EO[:\s]+(\d+)/i)?.[1] || '',
        buyer: extractField(fullText, 'Buyer') || '',
        styleNo: extractField(fullText, 'Style No') || '',
        quantity: parseInt(extractField(fullText, 'Quantity')?.replace(/,/g, '') || 0)
      };
      if (extractedData.eoNo) {
        actions.push(`EO Alert: ${extractedData.eoNo} from ${extractedData.buyer}`);
      }
      break;

    case 'fab_consumption':
      extractedData = {
        type: 'fab_consumption',
        styleNo: extractField(fullText, 'Style') || extractField(fullText, 'Style No') || '',
        fabricQuality: extractField(fullText, 'Quality') || extractField(fullText, 'Fabric Quality') || '',
        consumption: extractField(fullText, 'Consumption') || extractField(fullText, 'Qty') || ''
      };
      if (extractedData.styleNo) {
        actions.push(`Fabric Consumption: ${extractedData.styleNo} - ${extractedData.consumption}`);
      }
      break;

    case 'cost_update':
      extractedData = {
        type: 'cost_update',
        ourRef: extractField(fullText, 'Our Ref') || extractField(fullText, 'Order Ref') || '',
        costDetails: extractField(fullText, 'Cost') || extractField(fullText, 'Price') || '',
        status: 'pending_approval'
      };
      if (extractedData.ourRef) {
        const approval = {
          id: 'APR-' + Date.now().toString(36).toUpperCase(),
          type: 'cost_update',
          ourRef: extractedData.ourRef,
          subject: subject,
          details: extractedData.costDetails,
          status: 'pending',
          createdAt: new Date().toISOString(),
          createdBy: from
        };
        db.approvals.push(approval);
        actions.push(`Cost Update approval created: ${approval.id}`);
      }
      break;

    case 'po_approval':
      extractedData = {
        type: 'po_approval',
        poNumber: extractField(fullText, 'PO') || extractField(fullText, 'Order') || '',
        status: 'pending_approval'
      };
      if (extractedData.poNumber) {
        const approval = {
          id: 'APR-' + Date.now().toString(36).toUpperCase(),
          type: 'po_approval',
          poNumber: extractedData.poNumber,
          subject: subject,
          status: 'pending',
          createdAt: new Date().toISOString(),
          createdBy: from
        };
        db.approvals.push(approval);
        actions.push(`PO Approval created: ${approval.id}`);
      }
      break;

    case 'process_cost':
      extractedData = {
        type: 'process_cost',
        styleNo: extractField(fullText, 'Style') || extractField(fullText, 'Style No') || '',
        processor: extractField(fullText, 'Processor') || extractField(fullText, 'Process') || '',
        rate: extractField(fullText, 'Rate') || extractField(fullText, 'Cost') || ''
      };
      if (extractedData.styleNo) {
        actions.push(`Process Cost: ${extractedData.styleNo} - ${extractedData.processor} @ ${extractedData.rate}`);
      }
      break;

    case 'courier_details':
      extractedData = {
        type: 'courier_details',
        courierName: extractField(fullText, 'Courier') || extractField(fullText, 'Company') || '',
        trackingNumber: extractField(fullText, 'Tracking') || extractField(fullText, 'AWB') || '',
        ourRef: extractField(fullText, 'Our Ref') || extractField(fullText, 'Order Ref') || ''
      };
      if (extractedData.trackingNumber) {
        actions.push(`Courier Details: ${extractedData.courierName} - Tracking: ${extractedData.trackingNumber}`);
      }
      break;

    case 'excess_receive':
      extractedData = {
        type: 'excess_receive',
        ourRef: extractField(fullText, 'Our Ref') || extractField(fullText, 'Order Ref') || '',
        material: extractField(fullText, 'Material') || extractField(fullText, 'Item') || '',
        excessQty: extractField(fullText, 'Excess') || extractField(fullText, 'Extra Qty') || ''
      };
      if (extractedData.ourRef) {
        const approval = {
          id: 'APR-' + Date.now().toString(36).toUpperCase(),
          type: 'excess_receive',
          ourRef: extractedData.ourRef,
          material: extractedData.material,
          quantity: extractedData.excessQty,
          status: 'pending',
          createdAt: new Date().toISOString(),
          createdBy: from
        };
        db.approvals.push(approval);
        actions.push(`Excess Receive approval: ${approval.id}`);
      }
      break;

    case 'extra_pcs':
      extractedData = {
        type: 'extra_pcs',
        ourRef: extractField(fullText, 'Our Ref') || extractField(fullText, 'Order Ref') || '',
        quantity: parseInt(extractField(fullText, 'Qty') || extractField(fullText, 'Pieces') || 0)
      };
      if (extractedData.ourRef) {
        const approval = {
          id: 'APR-' + Date.now().toString(36).toUpperCase(),
          type: 'extra_pcs',
          ourRef: extractedData.ourRef,
          quantity: extractedData.quantity,
          status: 'pending',
          createdAt: new Date().toISOString(),
          createdBy: from
        };
        db.approvals.push(approval);
        actions.push(`Extra Pieces approval: ${approval.id}`);
      }
      break;

    case 'cash_payment':
      extractedData = {
        type: 'cash_payment',
        amount: extractField(fullText, 'Amount') || extractField(fullText, 'Total') || '',
        description: subject
      };
      if (extractedData.amount) {
        actions.push(`Cash Payment: ${extractedData.amount}`);
      }
      break;

    case 'bank_payment':
      extractedData = {
        type: 'bank_payment',
        amount: extractField(fullText, 'Amount') || extractField(fullText, 'Total') || '',
        reference: extractField(fullText, 'Ref') || extractField(fullText, 'Transaction') || '',
        description: subject
      };
      if (extractedData.amount) {
        actions.push(`Bank Payment: ${extractedData.amount} - ${extractedData.reference}`);
      }
      break;

    case 'packing_list':
      extractedData = {
        type: 'packing_list',
        ourRef: extractField(fullText, 'Our Ref') || extractField(fullText, 'Order Ref') || '',
        packingNo: extractField(fullText, 'Packing') || extractField(fullText, 'PL') || ''
      };
      if (extractedData.packingNo) {
        actions.push(`Packing List: ${extractedData.packingNo}`);
      }
      break;

    case 'gate_pass':
      extractedData = {
        type: 'gate_pass',
        ourRef: extractField(fullText, 'Our Ref') || extractField(fullText, 'Order Ref') || '',
        passNumber: extractField(fullText, 'Pass') || extractField(fullText, 'Gate Pass') || '',
        material: extractField(fullText, 'Material') || extractField(fullText, 'Item') || ''
      };
      if (extractedData.passNumber) {
        actions.push(`Gate Pass: ${extractedData.passNumber} - ${extractedData.material}`);
      }
      break;

    case 'attendance':
      extractedData = {
        type: 'attendance',
        date: date || new Date().toISOString().split('T')[0],
        details: subject
      };
      actions.push(`Attendance Report: ${subject}`);
      break;
  }

  // Log activity for trackable records
  if (extractedData.ourRef || extractedData.eoNo) {
    const orderId = findOrderByRef(extractedData.ourRef || extractedData.eoNo);
    const activity = {
      id: 'ACT-' + Date.now().toString(36).toUpperCase(),
      orderId: orderId || '',
      ourRef: extractedData.ourRef || extractedData.eoNo || '',
      type: emailType,
      description: actions.join('; ') || subject,
      from: from,
      timestamp: new Date().toISOString(),
      emailSubject: subject,
      module: getModuleForType(emailType)
    };
    db.activityLog.push(activity);
    // Keep only last 1000 activities
    if (db.activityLog.length > 1000) {
      db.activityLog = db.activityLog.slice(-1000);
    }
  }

  return {
    emailType,
    extractedData,
    actions,
    processed: actions.length > 0
  };
}

// Helper: Find order ID by Our Ref or EO number
function findOrderByRef(ref) {
  if (!ref) return '';
  const order = Object.values(db.orders).find(o =>
    o.ourRef === ref || o.poNumber === ref
  );
  return order ? order.id : '';
}

// Helper: Get module name for email type
function getModuleForType(emailType) {
  const moduleMap = {
    'eo_alert': 'merchandising',
    'fab_consumption': 'purchase',
    'cost_update': 'accounts',
    'po_approval': 'accounts',
    'process_cost': 'store',
    'courier_details': 'shipping',
    'excess_receive': 'store',
    'extra_pcs': 'accounts',
    'cash_payment': 'accounts',
    'bank_payment': 'accounts',
    'packing_list': 'packing',
    'gate_pass': 'store',
    'attendance': 'hr'
  };
  return moduleMap[emailType] || 'general';
}

async function checkEmails() {
  if (!EMAIL_PASS) {
    return; // No password configured, skip silently
  }

  let client;
  try {
    client = new ImapFlow({
      host: EMAIL_HOST,
      port: EMAIL_PORT,
      secure: EMAIL_TLS,
      auth: {
        user: EMAIL_USER,
        pass: EMAIL_PASS
      },
      tls: { rejectUnauthorized: false },
      logger: false
    });

    await client.connect();

    // Open INBOX
    const lock = await client.getMailboxLock('INBOX');
    try {
      // Search for all messages
      const messages = client.fetch('1:*', { envelope: true, source: true, uid: true });

      let newCount = 0;

      for await (const msg of messages) {
        try {
          const messageId = msg.envelope.messageId || `uid-${msg.uid}`;

          // Skip already-processed emails
          if (db.processedEmailUIDs.includes(messageId)) {
            continue;
          }

          // Parse the full email source
          const parsed = await simpleParser(msg.source);

          newCount++;
          if (newCount === 1) console.log(`📧 Processing new email(s)...`);

          const from = parsed.from ? parsed.from.text : '';
          const fromEmail = parsed.from && parsed.from.value && parsed.from.value[0] ? parsed.from.value[0].address.toLowerCase() : '';
          const subject = parsed.subject || '';
          const body = parsed.text || '';
          const htmlBody = parsed.html || '';

          console.log(`  📩 Email from: ${from} (${fromEmail}) | Subject: ${subject}`);

          // Mark as processed regardless of sender
          db.processedEmailUIDs.push(messageId);
          // Keep only the last 500 IDs to avoid unbounded growth
          if (db.processedEmailUIDs.length > 500) {
            db.processedEmailUIDs = db.processedEmailUIDs.slice(-500);
          }

          // Only process emails from allowed senders (ERP system)
          if (!ALLOWED_EMAIL_SENDERS.includes(fromEmail)) {
            console.log(`  ⏭️ Skipping — sender not in allowed list`);
            continue;
          }

          // Parse order details from ERP email
          const fullBody = body + '\n' + htmlBody;
          const orderData = parseOrderFromEmail(subject, fullBody, from);

          // Classify and process email with workflow engine
          const emailDate = parsed.date ? new Date(parsed.date).toISOString().split('T')[0] : new Date().toISOString().split('T')[0];
          const workflowResult = classifyAndProcessEmail(subject, fullBody, fromEmail, EMAIL_USER, emailDate);
          if (workflowResult.processed) {
            console.log(`  🔄 Workflow: ${workflowResult.emailType} — ${workflowResult.actions.join(', ')}`);
            io.emit('workflow-processed', {
              emailType: workflowResult.emailType,
              actions: workflowResult.actions,
              extractedData: workflowResult.extractedData,
              timestamp: new Date().toISOString()
            });
          }

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
              season: orderData.season || '',
              paymentTerms: orderData.paymentTerms || '',
              shipDate: orderData.shipDate || '',
              orderDate: orderData.orderDate || '',
              shipMode: orderData.shipMode || '',
              currency: orderData.currency || '',
              fobRate: orderData.fobRate || '',
              totalValue: orderData.totalValue || '',
              ourRef: orderData.ourRef || '',
              stages,
              stageQuantities: {},
              sizeColorMatrix: [],
              sizeColorStages: {},
              costSheet: {},
              assignment: {},
              createdAt: new Date().toISOString(),
              history: [{ stageId: 'order_confirm', status: 'pending', notes: `Auto-created from ERP alert: EO ${orderData.poNumber}`, by: 'ERP System', at: new Date().toISOString() }],
              source: 'email',
              emailFrom: from,
              emailSubject: subject
            };

            db.orders[id] = order;
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
        } catch (msgErr) {
          console.error(`  IMAP message error (uid ${msg.uid}):`, msgErr.message);
        }
      }

      saveData();
    } finally {
      lock.release();
    }

    await client.logout();
  } catch (err) {
    console.error('IMAP error:', err.message);
    try { if (client) await client.logout(); } catch (e) { /* ignore logout error */ }
  }
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

// ── Claude AI Integration ────────────────────────
const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY || '';
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-20250514';

async function callClaude(systemPrompt, userMessage) {
  if (!CLAUDE_API_KEY) throw new Error('Claude API key not configured');
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': CLAUDE_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 1024,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }]
    })
  });
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error('Claude API error: ' + resp.status + ' ' + err);
  }
  const data = await resp.json();
  return data.content[0].text;
}

// Build context summary of current orders for AI
function buildOrderContext() {
  const orders = Object.values(db.orders);
  if (!orders.length) return 'No orders in the system yet.';

  const summary = orders.slice(0, 50).map(o => {
    const doneStages = ORDER_STAGES.filter(s => o.stages[s.id] && o.stages[s.id].status === 'done').length;
    const activeStage = ORDER_STAGES.find(s => o.stages[s.id] && (o.stages[s.id].status === 'active' || (o.stages[s.id].status === 'pending' && doneStages > 0)));
    const currentStage = ORDER_STAGES.find(s => !o.stages[s.id] || o.stages[s.id].status !== 'done');
    const delayedStages = ORDER_STAGES.filter(s => o.stages[s.id] && o.stages[s.id].status === 'delayed');
    const issueStages = ORDER_STAGES.filter(s => o.stages[s.id] && o.stages[s.id].status === 'issue');

    let line = `${o.id}: ${o.buyer} / ${o.styleNo} | Qty: ${o.quantity} | Progress: ${doneStages}/${ORDER_STAGES.length} stages`;
    if (o.exFactoryDate) line += ` | Ex-Factory: ${o.exFactoryDate}`;
    if (currentStage) line += ` | Current: ${currentStage.label}`;
    if (delayedStages.length) line += ` | DELAYED: ${delayedStages.map(s => s.label).join(', ')}`;
    if (issueStages.length) line += ` | ISSUES: ${issueStages.map(s => s.label).join(', ')}`;
    if (o.merchant) line += ` | Merchant: ${o.merchant}`;
    return line;
  }).join('\n');

  return `Total orders: ${orders.length}\n\n${summary}`;
}

// Build detailed order info for a specific order
function buildOrderDetail(order) {
  let detail = `Order ${order.id}:\nBuyer: ${order.buyer}\nStyle: ${order.styleNo}\nDescription: ${order.description || 'N/A'}\nQuantity: ${order.quantity}\nEx-Factory: ${order.exFactoryDate || 'Not set'}\nMerchant: ${order.merchant || 'N/A'}\nPO: ${order.poNumber || 'N/A'}\nCreated: ${order.createdAt}\n\nStage Details:\n`;
  ORDER_STAGES.forEach(s => {
    const stg = order.stages[s.id] || {};
    detail += `  ${s.icon} ${s.label} (${s.dept}): ${stg.status || 'pending'}`;
    if (stg.targetDate) detail += ` | Target: ${stg.targetDate}`;
    if (stg.actualDate) detail += ` | Actual: ${stg.actualDate}`;
    if (stg.notes) detail += ` | Notes: ${stg.notes}`;
    if (stg.updatedBy) detail += ` | By: ${stg.updatedBy}`;
    detail += '\n';
  });
  if (order.history && order.history.length) {
    detail += '\nRecent History:\n';
    order.history.slice(-10).forEach(h => {
      const stg = ORDER_STAGES.find(x => x.id === h.stageId);
      detail += `  ${h.at}: ${stg ? stg.label : h.stageId} → ${h.status} by ${h.by}${h.notes ? ' (' + h.notes + ')' : ''}\n`;
    });
  }
  return detail;
}

const AI_SYSTEM_PROMPT = `You are the AI assistant for Style Tracker, a garment export order management system. You help users understand order status, identify delays, and manage their production pipeline.

The garment production pipeline has these 18 stages in order:
1. Costing Approval (accounts)
2. Order Confirmation (merchandising)
3. Fabric & Accessory PR (purchase)
4. Lab Dip Approval (sampling)
5. Fit / Size Set Sample (sampling)
6. PP Sample Submission (sampling)
7. Production File Handover (merchandising)
8. Fabric In-House (store)
9. Trims In-House (store)
10. R&D (production)
11. Production Planning (production)
12. Cutting (cutting)
13. Stitching (stitching)
14. Finishing & QC (finishing)
15. PP Sample Approval (buyer)
16. Final Inspection (quality)
17. Packing (packing)
18. Ex-Factory / Dispatch (shipping)

Keep responses concise and practical. Use bullet points for lists. When asked about delays, be specific about which orders and stages. For action commands (like "mark cutting done for ST-101"), output a JSON action block at the end of your response in this exact format:
###ACTION###
{"type":"stage_update","orderId":"ORD-XXX","stageId":"cutting","status":"done"}
###END_ACTION###

Only output the ACTION block when the user is clearly requesting a change, not when asking questions. Valid stage IDs: cost_approve, order_confirm, fabric_acc_pr, lab_dip_approve, fit_sample, pp_sample, prod_file, fabric_inhouse, trims_inhouse, rnd, production_plan, cutting, stitching, finishing_qc, pp_approve, final_inspection, packing, ex_factory.
Valid statuses: pending, active, done, delayed, issue.`;

// AI Chat endpoint
app.post('/api/ai/chat', async (req, res) => {
  if (!CLAUDE_API_KEY) return res.status(400).json({ error: 'Claude AI not configured. Ask admin to set CLAUDE_API_KEY environment variable on Render.' });

  const { message, userName, userDept } = req.body;
  if (!message) return res.status(400).json({ error: 'Message required' });

  try {
    const orderContext = buildOrderContext();

    // Check if user is asking about a specific order
    let specificOrder = '';
    const orderMatch = message.match(/ORD-[A-Z0-9]+/i) || message.match(/\b([A-Z]{1,5}[-\s]?\d{2,6})\b/i);
    if (orderMatch) {
      const searchTerm = orderMatch[0].toUpperCase();
      const found = Object.values(db.orders).find(o =>
        o.id.toUpperCase() === searchTerm ||
        o.styleNo.toUpperCase() === searchTerm ||
        o.poNumber.toUpperCase() === searchTerm
      );
      if (found) specificOrder = '\n\nDetailed info for referenced order:\n' + buildOrderDetail(found);
    }

    const buyerInsights = JSON.stringify(computeBuyerInsights(), null, 2);

    const userMsg = `User: ${userName || 'Unknown'} (Dept: ${userDept || 'unknown'})
Message: ${message}

Current Orders Summary:
${orderContext}
${specificOrder}

Buyer Intelligence Data:
${buyerInsights.slice(0, 2000)}`;

    const reply = await callClaude(AI_SYSTEM_PROMPT, userMsg);

    // Check for action commands in the response
    let action = null;
    const actionMatch = reply.match(/###ACTION###\s*([\s\S]*?)\s*###END_ACTION###/);
    if (actionMatch) {
      try {
        action = JSON.parse(actionMatch[1].trim());
      } catch (e) { /* ignore parse errors */ }
    }

    // Clean response (remove action block from visible text)
    const cleanReply = reply.replace(/###ACTION###[\s\S]*?###END_ACTION###/, '').trim();

    res.json({ ok: true, reply: cleanReply, action });
  } catch (e) {
    console.error('AI chat error:', e.message);
    res.json({ ok: false, error: e.message });
  }
});

// AI Execute action (from natural language commands)
app.post('/api/ai/execute-action', async (req, res) => {
  const { action, userName, userRole } = req.body;
  if (!action || !action.type) return res.status(400).json({ error: 'Invalid action' });

  if (action.type === 'stage_update') {
    const { orderId, stageId, status, notes } = action;
    const order = db.orders[orderId];
    if (!order) return res.status(404).json({ error: `Order ${orderId} not found` });
    if (!order.stages[stageId]) return res.status(400).json({ error: `Invalid stage ${stageId}` });

    if (userRole === 'admin') {
      applyStageChange(orderId, stageId, status, undefined, status === 'done' ? new Date().toISOString().split('T')[0] : undefined, notes || '', userName + ' (via AI)');
      return res.json({ ok: true, approved: true, message: `Updated ${stageId} to ${status} for ${order.buyer} - ${order.styleNo}` });
    } else {
      // Queue for approval
      const pendingId = 'PC-' + Date.now().toString(36).toUpperCase();
      const stageInfo = ORDER_STAGES.find(s => s.id === stageId);
      const pending = {
        id: pendingId, orderId, stageId,
        stageLabel: stageInfo ? stageInfo.label : stageId,
        buyer: order.buyer, styleNo: order.styleNo,
        changes: { status, actualDate: status === 'done' ? new Date().toISOString().split('T')[0] : undefined, notes: notes || '' },
        currentValues: { ...order.stages[stageId] },
        requestedBy: userName + ' (via AI)', requestedAt: new Date().toISOString(), status: 'pending'
      };
      db.pendingChanges.push(pending);
      saveData();
      io.emit('pending-change', pending);
      return res.json({ ok: true, approved: false, message: `Change queued for admin approval` });
    }
  }

  res.status(400).json({ error: 'Unknown action type' });
});

// Smart Delay Detection
app.get('/api/ai/delay-check', async (req, res) => {
  const orders = Object.values(db.orders);
  const today = new Date();
  const alerts = [];

  for (const o of orders) {
    // Check if ex-factory is approaching but progress is low
    if (o.exFactoryDate) {
      const exDate = new Date(o.exFactoryDate);
      const daysLeft = Math.round((exDate - today) / 86400000);
      const doneStages = ORDER_STAGES.filter(s => o.stages[s.id] && o.stages[s.id].status === 'done').length;
      const pct = Math.round(doneStages / ORDER_STAGES.length * 100);

      // Alert if less than 30 days and less than 70% done
      if (daysLeft > 0 && daysLeft <= 30 && pct < 70) {
        alerts.push({
          type: 'deadline_risk', severity: daysLeft <= 14 ? 'critical' : 'warning',
          orderId: o.id, buyer: o.buyer, styleNo: o.styleNo,
          message: `${o.buyer} - ${o.styleNo}: Only ${pct}% done with ${daysLeft} days to ex-factory (${o.exFactoryDate})`,
          daysLeft, progress: pct
        });
      }

      // Alert if already past ex-factory and not complete
      if (daysLeft < 0 && pct < 100) {
        alerts.push({
          type: 'overdue', severity: 'critical',
          orderId: o.id, buyer: o.buyer, styleNo: o.styleNo,
          message: `${o.buyer} - ${o.styleNo}: OVERDUE by ${Math.abs(daysLeft)} days! Only ${pct}% complete.`,
          daysLeft, progress: pct
        });
      }
    }

    // Check for stages marked as delayed or issue
    ORDER_STAGES.forEach(s => {
      const stg = o.stages[s.id];
      if (stg && stg.status === 'delayed') {
        alerts.push({
          type: 'stage_delayed', severity: 'warning',
          orderId: o.id, buyer: o.buyer, styleNo: o.styleNo,
          message: `${o.buyer} - ${o.styleNo}: ${s.label} is delayed${stg.notes ? ' — ' + stg.notes : ''}`,
          stageId: s.id, stageLabel: s.label
        });
      }
      if (stg && stg.status === 'issue') {
        alerts.push({
          type: 'stage_issue', severity: 'critical',
          orderId: o.id, buyer: o.buyer, styleNo: o.styleNo,
          message: `${o.buyer} - ${o.styleNo}: Issue at ${s.label}${stg.notes ? ' — ' + stg.notes : ''}`,
          stageId: s.id, stageLabel: s.label
        });
      }

      // Check if target date passed but stage not done
      if (stg && stg.targetDate && stg.status !== 'done') {
        const targetDate = new Date(stg.targetDate);
        const daysOverdue = Math.round((today - targetDate) / 86400000);
        if (daysOverdue > 0) {
          alerts.push({
            type: 'target_missed', severity: daysOverdue > 7 ? 'critical' : 'warning',
            orderId: o.id, buyer: o.buyer, styleNo: o.styleNo,
            message: `${o.buyer} - ${o.styleNo}: ${s.label} target date missed by ${daysOverdue} days`,
            stageId: s.id, stageLabel: s.label, daysOverdue
          });
        }
      }
    });
  }

  // Sort: critical first, then by days
  alerts.sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === 'critical' ? -1 : 1;
    return (a.daysLeft || 0) - (b.daysLeft || 0);
  });

  // If Claude API is available, get AI summary
  let aiSummary = null;
  if (CLAUDE_API_KEY && alerts.length > 0) {
    try {
      const alertText = alerts.slice(0, 20).map(a => `[${a.severity.toUpperCase()}] ${a.message}`).join('\n');
      aiSummary = await callClaude(
        'You are a garment production manager AI. Analyze these delay alerts and provide a brief priority action plan. Be specific about which orders need attention first and what actions to take. Keep it under 200 words.',
        `Current delay alerts:\n${alertText}\n\nTotal active orders: ${orders.length}`
      );
    } catch (e) { /* AI summary optional */ }
  }

  res.json({ alerts, aiSummary, total: alerts.length, critical: alerts.filter(a => a.severity === 'critical').length });
});

app.get('/api/ai/status', (req, res) => {
  res.json({ configured: !!CLAUDE_API_KEY, model: CLAUDE_MODEL });
});

// ── Workflow API Endpoints ───────────────────────────────
// Activity Log
app.post('/api/activity', (req, res) => {
  const { orderId, ourRef, type, description, from, module, emailSubject } = req.body;
  if (!type || !description) {
    return res.status(400).json({ error: 'type and description required' });
  }
  const activity = {
    id: 'ACT-' + Date.now().toString(36).toUpperCase(),
    orderId: orderId || '',
    ourRef: ourRef || '',
    type: type,
    description: description,
    from: from || 'system',
    timestamp: new Date().toISOString(),
    emailSubject: emailSubject || '',
    module: module || ''
  };
  db.activityLog.push(activity);
  if (db.activityLog.length > 1000) {
    db.activityLog = db.activityLog.slice(-1000);
  }
  saveData();
  io.emit('activity-logged', activity);
  res.json(activity);
});

app.get('/api/activity/:orderId', (req, res) => {
  const { orderId } = req.params;
  const activities = db.activityLog.filter(a => a.orderId === orderId || a.ourRef === orderId);
  res.json(activities);
});

app.get('/api/activity', (req, res) => {
  const recent = db.activityLog.slice(-50).reverse();
  res.json(recent);
});

// Approvals Queue
app.get('/api/approvals', (req, res) => {
  const { status } = req.query;
  let approvals = db.approvals;
  if (status) {
    approvals = approvals.filter(a => a.status === status);
  }
  // Sort by creation date, newest first
  approvals = approvals.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json(approvals);
});

app.post('/api/approvals', (req, res) => {
  const { type, subject, details, poNumber, ourRef, material, quantity } = req.body;
  if (!type || !subject) {
    return res.status(400).json({ error: 'type and subject required' });
  }
  const approval = {
    id: 'APR-' + Date.now().toString(36).toUpperCase(),
    type: type,
    subject: subject,
    details: details || '',
    poNumber: poNumber || '',
    ourRef: ourRef || '',
    material: material || '',
    quantity: quantity || '',
    status: 'pending',
    createdAt: new Date().toISOString(),
    createdBy: 'system'
  };
  db.approvals.push(approval);
  saveData();
  io.emit('approval-created', approval);
  res.json(approval);
});

app.put('/api/approvals/:id', (req, res) => {
  const { id } = req.params;
  const { status, approvedBy, notes } = req.body;
  if (!status) {
    return res.status(400).json({ error: 'status required' });
  }
  const approval = db.approvals.find(a => a.id === id);
  if (!approval) {
    return res.status(404).json({ error: 'Approval not found' });
  }
  approval.status = status;
  approval.approvedBy = approvedBy || 'system';
  approval.approvalNotes = notes || '';
  approval.approvedAt = new Date().toISOString();
  saveData();
  io.emit('approval-updated', approval);
  res.json(approval);
});

// Costing Records
app.get('/api/costings', (req, res) => {
  const costings = Object.values(db.costings);
  // Sort by creation date, newest first
  costings.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json(costings);
});

app.get('/api/costings/:orderId', (req, res) => {
  const { orderId } = req.params;
  const costing = db.costings[orderId];
  if (!costing) {
    return res.status(404).json({ error: 'Costing not found' });
  }
  res.json(costing);
});

app.post('/api/costings', (req, res) => {
  const { orderId, ourRef, styleNo, processor, prNo, fabricQuality, orderQty, color, greigeCost, shrinkage, processRate, wastage, gst } = req.body;
  if (!orderId || !styleNo) {
    return res.status(400).json({ error: 'orderId and styleNo required' });
  }

  const totalProcessRate = (parseFloat(processRate) || 0) * (parseFloat(orderQty) || 0);
  const totalCost = (parseFloat(greigeCost) || 0) + totalProcessRate + (parseFloat(wastage) || 0);
  const gstAmount = (totalCost * (parseFloat(gst) || 0)) / 100;

  const costing = {
    id: 'CST-' + Date.now().toString(36).toUpperCase(),
    orderId: orderId,
    ourRef: ourRef || '',
    styleNo: styleNo,
    processor: processor || '',
    prNo: prNo || '',
    fabricQuality: fabricQuality || '',
    orderQty: orderQty || 0,
    color: color || '',
    greigeCost: greigeCost || 0,
    shrinkage: shrinkage || 0,
    processRate: processRate || 0,
    totalProcessRate: totalProcessRate,
    wastage: wastage || 0,
    totalCost: totalCost,
    gst: gstAmount,
    status: 'draft',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  db.costings[orderId] = costing;
  saveData();
  io.emit('costing-updated', costing);
  res.json(costing);
});

app.put('/api/costings/:orderId', (req, res) => {
  const { orderId } = req.params;
  const { status, notes } = req.body;

  const costing = db.costings[orderId];
  if (!costing) {
    return res.status(404).json({ error: 'Costing not found' });
  }

  if (status) costing.status = status;
  if (notes) costing.notes = notes;
  costing.updatedAt = new Date().toISOString();

  saveData();
  io.emit('costing-updated', costing);
  res.json(costing);
});

server.listen(PORT, () => {
  console.log(`\n  Style Tracker running at http://localhost:${PORT}`);
  console.log(`  Admin PIN: ${db.settings.adminPin} (change this in Admin settings)`);

  // Start email checking if configured
  if (EMAIL_PASS) {
    console.log(`  📧 Email checking enabled for ${EMAIL_USER} (every ${EMAIL_CHECK_INTERVAL / 1000}s)`);
    console.log(`  📧 IMAP: ${EMAIL_HOST}:${EMAIL_PORT} TLS=${EMAIL_TLS}`);
    // Check immediately on startup, then on interval
    setTimeout(checkEmails, 5000);
    setInterval(checkEmails, EMAIL_CHECK_INTERVAL);
  } else {
    console.log(`  📧 Email checking disabled (set EMAIL_PASS env var to enable)\n`);
  }
});
