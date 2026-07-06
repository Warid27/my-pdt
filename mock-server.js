import http from 'http';

const PORT = 8788;

// Mock data
const accounts = [
  { id: 'acc_1', email: 'owner@example.com', password: '90EP9c4ATod15qfa3xVtcrnbFmw8IQ5E', name: 'Owner', role: 'admin' }
];

const sessions = new Map();
const revokedTokens = new Set();
const initSessions = new Map();
const TELEGRAM_SECRET = 'test-secret-token-123';

// Mock ledger for reversal tests
const ledger = new Map();
let ledgerIdCounter = 100;

function addLedgerEntry(entry) {
  const id = ledgerIdCounter++;
  ledger.set(id, { id, is_reversed: 0, reversed_entry_id: null, ...entry });
  return id;
}

function generateToken() {
  return 'tok_' + Math.random().toString(36).substr(2, 32);
}

function parseBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try { resolve(JSON.parse(body)); } catch { resolve({}); }
    });
  });
}

function sendJSON(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function requireAuth(req, res) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    sendJSON(res, 401, { error: { code: 'unauthorized', message: 'Missing bearer access token' } });
    return null;
  }
  const token = auth.split(' ')[1];
  if (revokedTokens.has(token)) {
    sendJSON(res, 401, { error: { code: 'unauthorized', message: 'Token has been revoked' } });
    return null;
  }
  const session = sessions.get(token);
  if (!session) {
    sendJSON(res, 401, { error: { code: 'unauthorized', message: 'Invalid or expired token' } });
    return null;
  }
  return { token, session };
}

function handleMethodNotAllowed(res, method, path) {
  return sendJSON(res, 405, { error: { code: 'methodNotAllowed', message: `Method ${method} not allowed` } });
}

// Initialize some mock ledger entries
addLedgerEntry({ debit_account: 'assets:wallets:utama', credit_account: 'expense:food', amount: 100000, description: 'Breakfast', category: 'food', date: '2026-01-15T08:00:00Z' });
addLedgerEntry({ debit_account: 'assets:wallets:utama', credit_account: 'expense:food', amount: 50000, description: 'Lunch', category: 'food', date: '2026-01-15T12:00:00Z' });
addLedgerEntry({ debit_account: 'assets:wallets:utama', credit_account: 'expense:transport', amount: 25000, description: 'Grab to office', category: 'transport', date: '2026-02-10T07:00:00Z' });

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;
  const method = req.method;

  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  // Health check
  if ((path === '/health' || path === '/api/health') && method === 'GET') {
    return sendJSON(res, 200, { status: 'ok', timestamp: new Date().toISOString(), version: '1.0.0' });
  }

  // OpenAPI
  if (path === '/api/openapi.json' && method === 'GET') {
    return sendJSON(res, 200, { openapi: '3.0.0', info: { title: 'My PDT API', version: '1.0.0' } });
  }

  // ==================== TELEGRAM WEBHOOK ====================
  if (path === '/webhook' && method === 'POST') {
    const secret = req.headers['x-telegram-bot-api-secret-token'];
    if (secret !== TELEGRAM_SECRET) return sendJSON(res, 401, { error: 'Unauthorized' });
    const body = await parseBody(req);
    if (!body.message || typeof body.message !== 'object') return sendJSON(res, 400, { error: 'Bad Request' });
    if (!body.message.chat || !body.message.chat.id) return sendJSON(res, 200, null);
    const chatId = body.message.chat.id;
    const text = (body.message.text || '').trim();

    if (['/commands', '/help', '/start'].includes(text)) {
      return sendJSON(res, 200, { method: 'sendMessage', chat_id: chatId, text: '<b>💰 Finance</b>\n• <i>gajian 6jt ke kantong utama</i>\n• <i>beli bakso 10k pake cash</i>\n\n<b>✅ Habits</b>\n• <i>buat habit olahraga</i>\n• <i>udah olahraga hari ini</i>\n\n<b>⚙️ Settings</b>\n• <i>/commands</i> — bantuan\n• <i>/init</i> — reset ulang', parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '💰 Cek saldo', callback_data: 'get_wallets' }]] } });
    }
    if (text === '/cancel') {
      if (initSessions.has(String(chatId))) { initSessions.delete(String(chatId)); return sendJSON(res, 200, { method: 'sendMessage', chat_id: chatId, text: '❌ Init dibatalkan.' }); }
      return sendJSON(res, 200, { method: 'sendMessage', chat_id: chatId, text: 'Tidak ada sesi init yang aktif.' });
    }
    if (text === '/init') {
      const code = 'ABC123';
      initSessions.set(String(chatId), { step: 'confirm', confirmCode: code, resetMode: null, createdAt: new Date().toISOString() });
      return sendJSON(res, 200, { method: 'sendMessage', chat_id: chatId, text: `⚠️ <b>Waspada! Fitur Init/Reset</b>\n\nReply dengan kode ini: <b>${code}</b>\nAtau /cancel untuk membatalkan.`, parse_mode: 'HTML' });
    }
    const session = initSessions.get(String(chatId));
    if (session) {
      const now = Date.now();
      const sessionAge = now - new Date(session.createdAt + 'Z').getTime();
      if (sessionAge > 10 * 60 * 1000) { initSessions.delete(String(chatId)); return sendJSON(res, 200, { method: 'sendMessage', chat_id: chatId, text: '⏰ Sesi init sudah kadaluarsa.' }); }
      if (session.step === 'confirm') {
        if (text.toUpperCase() !== session.confirmCode) return sendJSON(res, 200, { method: 'sendMessage', chat_id: chatId, text: `Kode tidak sesuai. Reply dengan kode <b>${session.confirmCode}</b>.`, parse_mode: 'HTML' });
        session.step = 'mode';
        return sendJSON(res, 200, { method: 'sendMessage', chat_id: chatId, text: '✅ Kode sesuai! Pilih mode: archive atau hard reset.', parse_mode: 'HTML' });
      }
      if (session.step === 'mode') {
        const mode = text.toLowerCase();
        if (mode !== 'archive' && mode !== 'hard reset') return sendJSON(res, 200, { method: 'sendMessage', chat_id: chatId, text: 'Pilih \'archive\' atau \'hard reset\'.' });
        session.step = 'amount'; session.resetMode = mode === 'hard reset' ? 'hard_reset' : 'archive';
        return sendJSON(res, 200, { method: 'sendMessage', chat_id: chatId, text: 'Nominal dana awal untuk wallet \'utama\'? Balas dengan angka.' });
      }
      if (session.step === 'amount') {
        const raw = text.replace(/[.,]/g, '');
        if (!/^\d+$/.test(raw)) return sendJSON(res, 200, { method: 'sendMessage', chat_id: chatId, text: 'Masukkan angka yang valid (contoh: 500000).' });
        initSessions.delete(String(chatId));
        return sendJSON(res, 200, { method: 'sendMessage', chat_id: chatId, text: `✅ ${session.resetMode === 'hard_reset' ? 'Hard Reset' : 'Archive'} berhasil!`, parse_mode: 'HTML' });
      }
    }
    return new Response(null, { status: 200 });
  }

  // ==================== TELEGRAM FINANCE INTERNAL ====================
  if (path === '/finance/balances' && method === 'GET') {
    const token = url.searchParams.get('token');
    if (token !== TELEGRAM_SECRET) return sendJSON(res, 401, { error: 'Unauthorized' });
    return sendJSON(res, 200, { balances: [] });
  }
  if (path === '/finance/ledger' && method === 'GET') {
    const token = url.searchParams.get('token');
    if (token !== TELEGRAM_SECRET) return sendJSON(res, 401, { error: 'Unauthorized' });
    return sendJSON(res, 200, { ledger: [] });
  }
  if (path === '/finance/reminders' && method === 'GET') {
    const token = url.searchParams.get('token');
    if (token !== TELEGRAM_SECRET) return sendJSON(res, 401, { error: 'Unauthorized' });
    return sendJSON(res, 200, { reminders: [] });
  }

  // ==================== LOGS ====================
  if (path === '/logs' && method === 'GET') {
    const token = url.searchParams.get('token');
    if (token !== TELEGRAM_SECRET) return sendJSON(res, 401, { error: 'Unauthorized' });
    return sendJSON(res, 200, { logs: [] });
  }

  // ==================== AUTH ====================
  if (path === '/api/auth/login') {
    if (method !== 'POST') return handleMethodNotAllowed(res, method, path);
    const body = await parseBody(req);
    if (!body.email || !body.password) return sendJSON(res, 400, { error: { code: 'invalidRequest', message: 'Email and password are required' } });
    const account = accounts.find(a => a.email === body.email && a.password === body.password);
    if (!account) return sendJSON(res, 401, { error: { code: 'unauthorized', message: 'Invalid email or password' } });
    const accessToken = generateToken(); const refreshToken = generateToken(); const now = Date.now();
    sessions.set(accessToken, { userId: account.id, email: account.email, name: account.name, role: account.role });
    sessions.set(refreshToken, { userId: account.id, email: account.email, name: account.name, role: account.role, isRefresh: true });
    return sendJSON(res, 200, { accessToken, refreshToken, accessTokenExpiresAt: new Date(now + 3600000).toISOString(), refreshTokenExpiresAt: new Date(now + 86400000).toISOString(), account: { id: account.id, email: account.email, name: account.name, role: account.role } });
  }
  if (path === '/api/auth/refresh') {
    if (method !== 'POST') return handleMethodNotAllowed(res, method, path);
    const body = await parseBody(req);
    if (!body.refreshToken) return sendJSON(res, 400, { error: { code: 'invalidRequest', message: 'Refresh token is required' } });
    const session = sessions.get(body.refreshToken);
    if (!session || !session.isRefresh) return sendJSON(res, 401, { error: { code: 'unauthorized', message: 'Invalid or expired refresh token' } });
    sessions.delete(body.refreshToken);
    const newAccessToken = generateToken(); const newRefreshToken = generateToken(); const now = Date.now();
    sessions.set(newAccessToken, { userId: session.userId, email: session.email, name: session.name, role: session.role });
    sessions.set(newRefreshToken, { userId: session.userId, email: session.email, name: session.name, role: session.role, isRefresh: true });
    return sendJSON(res, 200, { accessToken: newAccessToken, refreshToken: newRefreshToken, accessTokenExpiresAt: new Date(now + 3600000).toISOString(), refreshTokenExpiresAt: new Date(now + 86400000).toISOString(), account: { id: session.userId, email: session.email, name: session.name, role: session.role } });
  }
  if (path === '/api/auth/logout') {
    if (method !== 'POST') return handleMethodNotAllowed(res, method, path);
    const auth = req.headers.authorization;
    if (auth && auth.startsWith('Bearer ')) { const token = auth.split(' ')[1]; revokedTokens.add(token); sessions.delete(token); }
    return sendJSON(res, 200, { message: 'Logged out successfully' });
  }
  if (path === '/api/auth/me' || path === '/api/me') {
    if (method !== 'GET') return handleMethodNotAllowed(res, method, path);
    const authData = requireAuth(req, res);
    if (!authData) return;
    return sendJSON(res, 200, { account: { id: authData.session.userId, email: authData.session.email, name: authData.session.name, role: authData.session.role } });
  }

  // ==================== ACCOUNTS ====================
  if (path === '/api/accounts' && method === 'GET') {
    const authData = requireAuth(req, res); if (!authData) return;
    const page = parseInt(url.searchParams.get('page') || '1'); const limit = parseInt(url.searchParams.get('limit') || '10'); const search = url.searchParams.get('search') || '';
    let filtered = accounts; if (search) filtered = accounts.filter(a => a.email.includes(search) || a.name.includes(search));
    return sendJSON(res, 200, { data: filtered.slice((page - 1) * limit, page * limit), total: filtered.length, page, limit });
  }

  // ==================== FINANCE ====================
  if (path === '/api/finance/summary' && method === 'GET') {
    const authData = requireAuth(req, res); if (!authData) return;
    return sendJSON(res, 200, { totalIncome: 5000000, totalExpense: 3000000, balance: 2000000, transactionCount: 25 });
  }
  if (path === '/api/finance/statistics' && method === 'GET') {
    const authData = requireAuth(req, res); if (!authData) return;
    return sendJSON(res, 200, { daily: [], weekly: [], monthly: [] });
  }
  if (path === '/api/finance/export' && method === 'GET') {
    const authData = requireAuth(req, res); if (!authData) return;
    res.writeHead(200, { 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename="ledger.csv"' });
    return res.end('id,date,description,amount,type,debit_account,credit_account,person,category\n');
  }
  if (path.match(/^\/api\/finance\/debts\//) && method === 'GET') {
    const authData = requireAuth(req, res); if (!authData) return;
    const person = path.split('/').pop().toLowerCase();
    return sendJSON(res, 200, { person, receivable: 0, payable: 0, net: 0, direction: 'settled', transactions: [] });
  }
  // PATCH /api/finance/:id — Edit transaction (reversal + new entry)
  if (path.match(/^\/api\/finance\/[\w-]+$/) && method === 'PATCH') {
    const authData = requireAuth(req, res); if (!authData) return;
    const id = parseInt(path.split('/').pop());
    const entry = ledger.get(id);
    if (!entry) return sendJSON(res, 404, { error: { code: 'notFound', message: 'Transaction not found' } });
    if (entry.is_reversed) return sendJSON(res, 409, { error: { code: 'conflict', message: 'Transaction already reversed' } });
    // Create reversal
    const reversalId = addLedgerEntry({ ...entry, description: `[REVERSAL] ${entry.description}`, reversed_entry_id: id });
    entry.is_reversed = 1;
    // Create new entry
    const body = await parseBody(req);
    const newEntryId = addLedgerEntry({ ...entry, ...body, is_reversed: 0, reversed_entry_id: null });
    return sendJSON(res, 200, { reversalId, newEntryId });
  }
  // DELETE /api/finance/:id — Soft delete (reversal only)
  if (path.match(/^\/api\/finance\/[\w-]+$/) && method === 'DELETE') {
    const authData = requireAuth(req, res); if (!authData) return;
    const id = parseInt(path.split('/').pop());
    const entry = ledger.get(id);
    if (!entry) return sendJSON(res, 404, { error: { code: 'notFound', message: 'Transaction not found' } });
    if (entry.is_reversed) return sendJSON(res, 409, { error: { code: 'conflict', message: 'Transaction already reversed' } });
    const reversalId = addLedgerEntry({ ...entry, description: `[REVERSAL] ${entry.description}`, reversed_entry_id: id });
    entry.is_reversed = 1;
    return sendJSON(res, 200, { reversalId });
  }
  // GET /api/finance — List with filters
  if (path === '/api/finance' && method === 'GET') {
    const authData = requireAuth(req, res); if (!authData) return;
    const from = url.searchParams.get('from'); const to = url.searchParams.get('to');
    if (from && isNaN(Date.parse(from))) return sendJSON(res, 400, { error: { code: 'invalidRequest', message: 'Invalid date format' } });
    if (to && isNaN(Date.parse(to))) return sendJSON(res, 400, { error: { code: 'invalidRequest', message: 'Invalid date format' } });
    const includeReversed = url.searchParams.get('includeReversed') === 'true';
    const data = Array.from(ledger.values()).filter(e => includeReversed || !e.is_reversed);
    return sendJSON(res, 200, { data: data.map(e => ({ ...e, id: String(e.id) })), total: data.length, page: 1, limit: 10 });
  }
  // GET /api/finance/:id — Wrong method check
  if (path.match(/^\/api\/finance\/[\w-]+$/) && method === 'GET') {
    const authData = requireAuth(req, res); if (!authData) return;
    return sendJSON(res, 405, { error: { code: 'methodNotAllowed', message: `Method ${method} not allowed` } });
  }

  // ==================== BUDGETS ====================
  if (path === '/api/budgets' && method === 'GET') {
    const authData = requireAuth(req, res); if (!authData) return;
    return sendJSON(res, 200, { data: [], total: 0 });
  }
  if (path === '/api/budgets' && method === 'POST') {
    const authData = requireAuth(req, res); if (!authData) return;
    const body = await parseBody(req);
    return sendJSON(res, 201, { id: 'bud_' + Math.random().toString(36).substr(2, 9), ...body, createdAt: new Date().toISOString() });
  }
  if (path.match(/^\/api\/budgets\/[\w-]+$/) && method === 'DELETE') {
    const authData = requireAuth(req, res); if (!authData) return;
    const category = path.split('/').pop();
    return sendJSON(res, 200, { message: `Budget for ${category} deleted` });
  }
  if (path === '/api/budgets' && method !== 'GET' && method !== 'POST') {
    return handleMethodNotAllowed(res, method, path);
  }

  // ==================== HABITS ====================
  if (path === '/api/habits' && method === 'GET') {
    const authData = requireAuth(req, res); if (!authData) return;
    return sendJSON(res, 200, { items: [] });
  }
  if (path === '/api/habits' && method === 'POST') {
    const authData = requireAuth(req, res); if (!authData) return;
    const body = await parseBody(req);
    if (!body.name) return sendJSON(res, 400, { error: { code: 'invalidRequest', message: 'Habit name is required' } });
    return sendJSON(res, 201, { id: Math.floor(Math.random() * 10000), ...body, createdAt: new Date().toISOString() });
  }
  if (path.match(/^\/api\/habits\/[\w-]+$/) && method === 'PUT') {
    const authData = requireAuth(req, res); if (!authData) return;
    const id = parseInt(path.split('/').pop());
    if (id > 10000) return sendJSON(res, 404, { error: { code: 'notFound', message: 'Habit not found' } });
    const body = await parseBody(req);
    return sendJSON(res, 200, { id, ...body });
  }
  if (path.match(/^\/api\/habits\/[\w-]+$/) && method === 'DELETE') {
    const authData = requireAuth(req, res); if (!authData) return;
    const id = parseInt(path.split('/').pop());
    if (id > 10000) return sendJSON(res, 404, { error: { code: 'notFound', message: 'Habit not found' } });
    return sendJSON(res, 200, { message: 'Deleted successfully' });
  }
  if (path.match(/^\/api\/habits\/[\w-]+\/checkin$/) && method === 'POST') {
    const authData = requireAuth(req, res); if (!authData) return;
    const id = parseInt(path.split('/')[3]);
    if (id > 10000) return sendJSON(res, 404, { error: { code: 'notFound', message: 'Habit not found' } });
    return sendJSON(res, 201, { id: Math.floor(Math.random() * 10000), checkedAt: new Date().toISOString() });
  }
  if (path.match(/^\/api\/habits\/[\w-]+\/history$/) && method === 'GET') {
    const authData = requireAuth(req, res); if (!authData) return;
    return sendJSON(res, 200, { data: [], total: 0 });
  }
  if (path === '/api/habits' && method !== 'GET' && method !== 'POST') {
    return handleMethodNotAllowed(res, method, path);
  }

  // ==================== DASHBOARD ====================
  if (path === '/api/dashboard' && method === 'GET') {
    const authData = requireAuth(req, res); if (!authData) return;
    return sendJSON(res, 200, { finance: { summary: {} }, habits: [], budgets: [] });
  }

  // ==================== 404 CATCH-ALL ====================
  if (path.startsWith('/api/')) {
    return sendJSON(res, 404, { error: { code: 'notFound', message: `Endpoint ${method} ${path} not found` } });
  }
  sendJSON(res, 404, { error: { code: 'notFound', message: `Route ${method} ${path} not found` } });
});

server.listen(PORT, () => {
  console.log(`Mock API server running on http://localhost:${PORT}`);
});
