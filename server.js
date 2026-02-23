//+------------------------------------------------------------------+
//| WEBHOOK SERVER - v6.0 FINAL — All Fixes
//| Fix 1: BUY/SELL queue (no overwrite)
//| Fix 2: Render self-ping (no sleep)
//| Fix 3: Duplicate position_id protection on all queues
//+------------------------------------------------------------------+

const express = require('express');
const https   = require('https');
const http    = require('http');
const fs      = require('fs');
const app     = express();

// ==================== CONFIG ====================
const SECRET_TOKEN  = process.env.WEBHOOK_SECRET_TOKEN || "37ehADKNLy5psq1IvdUDYshxxik_zuy2RYD72n7E858DYqR2";
const HOST          = "0.0.0.0";
const PORT          = process.env.PORT || 8443;
const SSL_CERT_PATH = process.env.SSL_CERT_PATH || "cert.pem";
const SSL_KEY_PATH  = process.env.SSL_KEY_PATH  || "key.pem";

// FIX 2: Render self-ping — set this in Render environment variables
// SELF_URL = https://webhook-trade-a1vh.onrender.com
const SELF_URL = process.env.SELF_URL || "";

// ==================== MIDDLEWARE ====================
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

app.use((req, res, next) => {
    const ts = new Date().toISOString();
    console.log(`[${ts}] ${req.method} ${req.path}`);
    console.log(`  Query: ${JSON.stringify(req.query)}`);
    console.log(`  Body:  ${JSON.stringify(req.body).substring(0, 200)}`);
    next();
});

// ==================== UTILS ====================
function sanitizeAction(str) { return typeof str === 'string' ? str.trim().toUpperCase() : ""; }
function sanitizeSymbol(str) { return typeof str === 'string' ? str.trim() : ""; }  // case preserved
function sanitizeUserId(str) { return typeof str === 'string' ? str.trim() : ""; }
function generateSignalId()  { return Date.now() + "_" + Math.random().toString(36).substr(2, 9); }

// ==================== QUEUES ====================
//
// FIX 1: buy_sell_queue — array, NOT single object
//   Before: latest_signal_by_user[uid] = signal  ← second overwrites first
//   Now:    buy_sell_queue_by_user[uid].push(sig) ← all signals preserved
//
const buy_sell_queue_by_user = Object.create(null);
const close_queue_by_user    = Object.create(null);
const signal_history         = [];
const MAX_HISTORY            = 200;

function ensureQueues(uid) {
    if (!buy_sell_queue_by_user[uid]) buy_sell_queue_by_user[uid] = [];
    if (!close_queue_by_user[uid])    close_queue_by_user[uid]    = [];
}

function logSignal(sig) {
    signal_history.push({
        symbol:      sig.symbol,
        action:      sig.action,
        id:          sig.id,
        position_id: sig.position_id || "",
        user_id:     sig.user_id     || "",
        receivedAt:  new Date().toISOString()
    });
    if (signal_history.length > MAX_HISTORY) signal_history.shift();
    console.log(`[SIGNAL] ${sig.action} | ${sig.symbol} | POS: ${sig.position_id || '-'} | USER: ${sig.user_id || 'N/A'}`);
}

function validateToken(req, body) {
    const token   = req.query.token || (body && body.token) || "";
    const isValid = token === SECRET_TOKEN;
    if (!isValid) console.log(`  ❌ Token FAILED | Got: ${token.substring(0, 10)}...`);
    else          console.log(`  ✅ Token OK`);
    return isValid;
}

function getPendingUsers() {
    const users = new Set();
    Object.keys(buy_sell_queue_by_user).forEach(uid => {
        if (buy_sell_queue_by_user[uid].length > 0) users.add(uid);
    });
    Object.keys(close_queue_by_user).forEach(uid => {
        if (close_queue_by_user[uid].length > 0) users.add(uid);
    });
    return [...users];
}

function getQueueSizes(uid) {
    return {
        buy_sell: (buy_sell_queue_by_user[uid] || []).length,
        close:    (close_queue_by_user[uid]    || []).length
    };
}

// ==================== GET SIGNAL (EA polls this) ====================
app.get("/get_signal", (req, res) => {
    if (!validateToken(req, null)) {
        return res.status(401).json({ status: "unauthorized" });
    }

    const uid = sanitizeUserId(req.query.user_id || "");
    if (!uid) {
        return res.status(200).json({ status: "no_signal", signal: 0, symbol: "", id: "" });
    }

    ensureQueues(uid);

    // PRIORITY 1: CLOSE (close pehle execute ho — zyada important)
    if (close_queue_by_user[uid].length > 0) {
        const sig = close_queue_by_user[uid].shift();
        const remaining = close_queue_by_user[uid].length;
        console.log(`  📤 CLOSE SENT | USER: ${uid} | ${sig.symbol} | POS: ${sig.position_id} | Remaining: ${remaining}`);
        return res.status(200).json({
            status:      "ok",
            signal:      0,
            action:      "CLOSE",
            symbol:      sig.symbol,
            position_id: sig.position_id,
            price:       sig.price,
            id:          sig.id,
            user_id:     uid,
            timestamp:   sig.timestamp
        });
    }

    // PRIORITY 2: BUY/SELL queue
    if (buy_sell_queue_by_user[uid].length > 0) {
        const sig       = buy_sell_queue_by_user[uid].shift();
        const remaining = buy_sell_queue_by_user[uid].length;
        console.log(`  📤 ${sig.action} SENT | USER: ${uid} | ${sig.symbol} @ ${sig.price} | Remaining: ${remaining}`);
        return res.status(200).json({
            status:      "ok",
            signal:      sig.action === "BUY" ? 1 : -1,
            symbol:      sig.symbol,
            action:      sig.action,
            timestamp:   sig.timestamp,
            id:          sig.id,
            position_id: sig.position_id,
            price:       sig.price,
            timeframe:   sig.timeframe,
            user_id:     uid
        });
    }

    return res.status(200).json({ status: "no_signal", signal: 0, symbol: "", id: "" });
});

// ==================== WEBHOOK (Python → Server) ====================
app.post("/webhook", (req, res) => {
    const body       = req.body || {};
    const event_type = sanitizeAction(body.event || "");

    if (event_type === "PING") {
        return res.status(200).json({ status: "pong", timestamp: new Date().toISOString() });
    }

    if (event_type !== "ALERT") {
        return res.status(200).json({ status: "ignored", message: `Unknown event: ${event_type}` });
    }

    if (!validateToken(req, body)) {
        return res.status(401).json({ status: "unauthorized" });
    }

    const symbol      = sanitizeSymbol(body.symbol || "");
    const action      = sanitizeAction(body.action || "");
    const price       = body.price       || "";
    const timeframe   = body.timeframe   || "";
    const position_id = body.position_id || "";

    if (!symbol) {
        return res.status(400).json({ status: "bad_request", message: "symbol required" });
    }
    if (!["BUY", "SELL", "CLOSE"].includes(action)) {
        return res.status(400).json({ status: "bad_request", message: "action must be BUY, SELL, or CLOSE" });
    }

    // Resolve targets
    let targets = [];
    if (Array.isArray(body.user_ids) && body.user_ids.length > 0) {
        targets = body.user_ids.map(sanitizeUserId).filter(Boolean);
    }
    if (targets.length === 0) {
        const single = sanitizeUserId(body.user_id || "");
        if (single) targets = [single];
    }
    if (targets.length === 0) {
        return res.status(400).json({ status: "bad_request", message: "user_id or user_ids[] required" });
    }

    const signal_id = generateSignalId();

    // ─── CLOSE ───────────────────────────────────────────────────────
    if (action === "CLOSE") {
        if (!position_id) {
            return res.status(400).json({ status: "bad_request", message: "position_id required for CLOSE" });
        }
        targets.forEach(uid => {
            ensureQueues(uid);
            // FIX 3: Duplicate position_id guard
            const already = close_queue_by_user[uid].some(c => c.position_id === position_id);
            if (!already) {
                close_queue_by_user[uid].push({
                    position_id, symbol, price,
                    id:        signal_id,
                    timestamp: new Date().toISOString()
                });
                logSignal({ symbol, action: "CLOSE", id: signal_id, position_id, user_id: uid });
                console.log(`  📥 CLOSE QUEUED | USER: ${uid} | ${symbol} | POS: ${position_id} | Queue: ${close_queue_by_user[uid].length}`);
            } else {
                console.log(`  ⚠️  CLOSE DUPLICATE IGNORED | USER: ${uid} | POS: ${position_id}`);
            }
        });
        return res.status(200).json({
            status: "ok", message: "CLOSE queued",
            position_id, symbol, targets, id: signal_id,
            timestamp: new Date().toISOString()
        });
    }

    // ─── BUY / SELL ──────────────────────────────────────────────────
    targets.forEach(uid => {
        ensureQueues(uid);
        // FIX 3: Duplicate position_id guard (ek hi position_id ka ek hi BUY/SELL)
        const already = position_id &&
            buy_sell_queue_by_user[uid].some(s => s.position_id === position_id);

        if (!already) {
            const sig = {
                symbol, action, price, timeframe,
                position_id: position_id,
                id:          signal_id,
                timestamp:   new Date().toISOString(),
                user_id:     uid
            };
            buy_sell_queue_by_user[uid].push(sig);
            logSignal(sig);
            console.log(`  📥 ${action} QUEUED | USER: ${uid} | ${symbol} @ ${price} | POS: ${position_id} | Queue: ${buy_sell_queue_by_user[uid].length}`);
        } else {
            console.log(`  ⚠️  ${action} DUPLICATE IGNORED | USER: ${uid} | POS: ${position_id}`);
        }
    });

    return res.status(200).json({
        status: "ok",
        message: `${action} queued`,
        signal: action === "BUY" ? 1 : -1,
        id: signal_id, symbol, targets,
        timestamp: new Date().toISOString()
    });
});

// ==================== STATUS / HEALTH ====================
app.get("/health", (req, res) => {
    res.status(200).json({
        status:    "healthy",
        uptime:    process.uptime(),
        pending:   getPendingUsers().length,
        timestamp: new Date().toISOString()
    });
});

app.get("/status", (req, res) => {
    const allUsers = new Set([
        ...Object.keys(buy_sell_queue_by_user),
        ...Object.keys(close_queue_by_user)
    ]);
    const queueStatus = {};
    allUsers.forEach(uid => { queueStatus[uid] = getQueueSizes(uid); });

    res.status(200).json({
        status:         "running",
        version:        "6.0-final",
        uptime:         process.uptime(),
        timestamp:      new Date().toISOString(),
        pending_users:  getPendingUsers(),
        queue_status:   queueStatus,
        recent_history: signal_history.slice(-10),
        total_signals:  signal_history.length
    });
});

app.get("/", (req, res) => {
    res.status(200).json({
        status:  "running",
        version: "6.0-final",
        fixes: [
            "BUY/SELL array queue — no signal overwrite",
            "Render self-ping — set SELF_URL env var",
            "Duplicate position_id protection on all queues"
        ],
        endpoints: {
            "GET /get_signal?token=T&user_id=U": "MT5 EA polling",
            "POST /webhook":  "Python monitor → server",
            "GET /health":    "Health check",
            "GET /status":    "Queue status"
        }
    });
});

app.use((req, res) => {
    res.status(404).json({ status: "not_found", path: `${req.method} ${req.path}` });
});

// ==================== FIX 2: RENDER SELF-PING ====================
// Render free tier: 15 min inactivity pe server so jata hai
// Self-ping har 10 min mein jagraat rakhta hai
//
// Setup: Render dashboard → Environment Variables → SELF_URL = https://your-app.onrender.com
if (SELF_URL) {
    const pingUrl = SELF_URL.replace(/\/$/, '') + "/health";
    setInterval(() => {
        console.log(`[SELF-PING] → ${pingUrl}`);
        try {
            const mod = pingUrl.startsWith("https") ? https : http;
            const req = mod.get(pingUrl, (res) => {
                console.log(`[SELF-PING] ← ${res.statusCode}`);
            });
            req.on('error', (e) => console.log(`[SELF-PING] Error: ${e.message}`));
            req.setTimeout(8000, () => { req.destroy(); console.log("[SELF-PING] Timeout"); });
        } catch(e) {
            console.log(`[SELF-PING] Exception: ${e.message}`);
        }
    }, 10 * 60 * 1000);  // 10 minutes
    console.log(`[SELF-PING] Enabled → ${pingUrl}`);
} else {
    console.log("[SELF-PING] DISABLED — Render env var 'SELF_URL' set karo!");
}

// ==================== HEARTBEAT ====================
setInterval(() => {
    const pending = getPendingUsers();
    console.log(`[HB] ${new Date().toISOString()} | Pending: ${pending.length}${pending.length ? ' → ' + pending.join(',') : ''}`);
}, 30000);

// ==================== ERROR HANDLING ====================
process.on('uncaughtException',  err    => console.error(`UNCAUGHT: ${err.message}`));
process.on('unhandledRejection', reason => console.error(`UNHANDLED: ${reason}`));

// ==================== START ====================
function startServer() {
    const hasSSL = fs.existsSync(SSL_CERT_PATH) && fs.existsSync(SSL_KEY_PATH);
    if (hasSSL) {
        try {
            const opts = { key: fs.readFileSync(SSL_KEY_PATH), cert: fs.readFileSync(SSL_CERT_PATH) };
            https.createServer(opts, app).listen(PORT, HOST, () => printBanner("HTTPS"));
        } catch(e) {
            console.error(`SSL Error: ${e.message}`);
            app.listen(PORT, HOST, () => printBanner("HTTP (SSL fallback)"));
        }
    } else {
        app.listen(PORT, HOST, () => printBanner("HTTP"));
    }
}

function printBanner(protocol) {
    console.log("\n================================================================");
    console.log("  WEBHOOK SERVER v6.0 FINAL");
    console.log("================================================================");
    console.log(`  Protocol  : ${protocol} | Port: ${PORT}`);
    console.log("  Fix 1     : BUY/SELL array queue (no overwrite)");
    console.log(`  Fix 2     : Self-ping ${SELF_URL ? '✅ ' + SELF_URL : '❌ SELF_URL not set'}`);
    console.log("  Fix 3     : Duplicate position_id protection");
    console.log("================================================================\n");
}

startServer();
