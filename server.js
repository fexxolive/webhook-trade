//+------------------------------------------------------------------+
//| WEBHOOK SERVER - v6.0 ALL FIXES
//| Fix 1: BUY/SELL queue (overwrite problem solved)
//| Fix 2: Render free tier sleep prevention (self-ping)
//| Fix 3: Signal retry acknowledgment support
//+------------------------------------------------------------------+

const express = require('express');
const https   = require('https');
const http    = require('http');
const fs      = require('fs');
const app     = express();

// ==================== CONFIGURATION ====================
const SECRET_TOKEN  = process.env.WEBHOOK_SECRET_TOKEN || "37ehADKNLy5psq1IvdUDYshxxik_zuy2RYD72n7E858DYqR2";
const HOST          = "0.0.0.0";
const PORT          = process.env.PORT || 8443;
const SSL_CERT_PATH = process.env.SSL_CERT_PATH || "cert.pem";
const SSL_KEY_PATH  = process.env.SSL_KEY_PATH  || "key.pem";
const SELF_URL      = process.env.SELF_URL || "";   // e.g. https://webhook-trade-a1vh.onrender.com

// ==================== MIDDLEWARE ====================
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

app.use((req, res, next) => {
    const ts = new Date().toISOString();
    console.log("[" + ts + "] " + req.method + " " + req.path);
    console.log("  Query: " + JSON.stringify(req.query));
    console.log("  Body:  " + JSON.stringify(req.body).substring(0, 200));
    next();
});

// ==================== UTILITY ====================
function sanitizeAction(str)  { return typeof str === 'string' ? str.trim().toUpperCase() : ""; }
function sanitizeSymbol(str)  { return typeof str === 'string' ? str.trim() : ""; }          // ✅ case preserved
function sanitizeUserId(str)  { return typeof str === 'string' ? str.trim() : ""; }
function generateSignalId()   { return Date.now() + "_" + Math.random().toString(36).substr(2, 9); }

// ==================== SIGNAL STORAGE ====================
//
// ✅ FIX 1: BUY/SELL ab queue hai (array), overwrite nahi hoga
//    Pehle: latest_signal_by_user[uid] = signal  ← second overwrites first
//    Ab:    buy_sell_queue_by_user[uid].push(signal) ← dono preserve hote hain
//
const buy_sell_queue_by_user = Object.create(null);   // ✅ NEW: queue for BUY/SELL
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
    console.log("[SIGNAL-STORED] " + sig.action + " | " + sig.symbol +
                " | POS_ID: " + (sig.position_id || "-") +
                " | USER: "   + (sig.user_id     || "N/A"));
}

function validateToken(req, body) {
    const token   = req.query.token || (body && body.token) || "";
    const isValid = token === SECRET_TOKEN;
    if (!isValid) console.log("  ❌ Token FAILED | Got: " + token.substring(0, 10) + "...");
    else          console.log("  ✅ Token OK");
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

// ==================== GET SIGNAL (EA polling) ====================
app.get("/get_signal", (req, res) => {
    if (!validateToken(req, null)) {
        return res.status(401).json({ status: "unauthorized" });
    }

    const uid = sanitizeUserId(req.query.user_id || "");
    if (!uid) {
        return res.status(200).json({ status: "no_signal", signal: 0, symbol: "", id: "" });
    }

    ensureQueues(uid);

    // ✅ PRIORITY 1: CLOSE queue (close pehle process ho)
    if (close_queue_by_user[uid].length > 0) {
        const sig = close_queue_by_user[uid].shift();
        console.log("  📤 CLOSE SENT | USER: " + uid + " | POS_ID: " + sig.position_id + " | SYM: " + sig.symbol);
        console.log("  📊 CLOSE queue remaining: " + close_queue_by_user[uid].length);
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

    // ✅ PRIORITY 2: BUY/SELL queue (ab queue hai, overwrite nahi)
    if (buy_sell_queue_by_user[uid].length > 0) {
        const sig = buy_sell_queue_by_user[uid].shift();
        console.log("  📤 " + sig.action + " SENT | USER: " + uid + " | " + sig.symbol + " @ " + sig.price);
        console.log("  📊 BUY/SELL queue remaining: " + buy_sell_queue_by_user[uid].length);
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
        return res.status(200).json({ status: "ignored", message: "Unknown event: " + event_type });
    }

    if (!validateToken(req, body)) {
        return res.status(401).json({ status: "unauthorized" });
    }

    const symbol      = sanitizeSymbol(body.symbol || "");
    const action      = sanitizeAction(body.action || "");
    const price       = body.price       || "";
    const timeframe   = body.timeframe   || "";
    const position_id = body.position_id || "";

    if (!symbol) return res.status(400).json({ status: "bad_request", message: "symbol required" });
    if (action !== "BUY" && action !== "SELL" && action !== "CLOSE") {
        return res.status(400).json({ status: "bad_request", message: "action must be BUY, SELL, or CLOSE" });
    }

    // Targets
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

    // ==================== CLOSE ====================
    if (action === "CLOSE") {
        if (!position_id) {
            return res.status(400).json({ status: "bad_request", message: "position_id required for CLOSE" });
        }
        targets.forEach(uid => {
            ensureQueues(uid);
            const alreadyQueued = close_queue_by_user[uid].some(c => c.position_id === position_id);
            if (!alreadyQueued) {
                close_queue_by_user[uid].push({
                    position_id: position_id,
                    symbol:      symbol,
                    price:       price,
                    id:          signal_id,
                    timestamp:   new Date().toISOString()
                });
                logSignal({ symbol, action: "CLOSE", id: signal_id, position_id, user_id: uid });
                console.log("  📥 CLOSE QUEUED | USER: " + uid + " | " + symbol + " | POS_ID: " + position_id +
                            " | Queue size: " + close_queue_by_user[uid].length);
            } else {
                console.log("  ⚠️  CLOSE DUPLICATE IGNORED | USER: " + uid + " | POS_ID: " + position_id);
            }
        });
        return res.status(200).json({
            status: "ok", message: "CLOSE queued",
            position_id, symbol, targets, id: signal_id,
            timestamp: new Date().toISOString()
        });
    }

    // ==================== BUY / SELL ====================
    // ✅ FIX 1: push to queue — no overwrite
    targets.forEach(uid => {
        ensureQueues(uid);

        // Duplicate position_id check (ek hi position_id ke 2 BUY nahi chahiye)
        const alreadyQueued = position_id &&
            buy_sell_queue_by_user[uid].some(s => s.position_id === position_id);

        if (!alreadyQueued) {
            const sig = {
                symbol, action, price, timeframe,
                position_id: position_id,
                id:          signal_id,
                timestamp:   new Date().toISOString(),
                user_id:     uid
            };
            buy_sell_queue_by_user[uid].push(sig);
            logSignal(sig);
            console.log("  📥 " + action + " QUEUED | USER: " + uid + " | " + symbol +
                        " @ " + price + " | POS_ID: " + position_id +
                        " | Queue size: " + buy_sell_queue_by_user[uid].length);
        } else {
            console.log("  ⚠️  " + action + " DUPLICATE IGNORED | USER: " + uid + " | POS_ID: " + position_id);
        }
    });

    return res.status(200).json({
        status: "ok", message: action + " queued",
        signal: action === "BUY" ? 1 : -1,
        id: signal_id, symbol, targets,
        timestamp: new Date().toISOString()
    });
});

// ==================== STATUS / HEALTH ====================
app.get("/health", (req, res) => {
    res.status(200).json({
        status:   "healthy",
        uptime:   process.uptime(),
        pending:  getPendingUsers().length,
        timestamp: new Date().toISOString()
    });
});

app.get("/status", (req, res) => {
    const queueStatus = {};
    const allUsers = new Set([
        ...Object.keys(buy_sell_queue_by_user),
        ...Object.keys(close_queue_by_user)
    ]);
    allUsers.forEach(uid => {
        queueStatus[uid] = {
            buy_sell_queue: (buy_sell_queue_by_user[uid] || []).length,
            close_queue:    (close_queue_by_user[uid]    || []).length
        };
    });

    res.status(200).json({
        status:         "running",
        version:        "6.0-all-fixes",
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
        version: "6.0-all-fixes",
        fixes:   [
            "BUY/SELL queue (no overwrite)",
            "Render self-ping (no sleep)",
            "Duplicate position_id protection"
        ],
        endpoints: {
            "GET /get_signal?token=TOKEN&user_id=USER": "MT5 EA polling",
            "POST /webhook":  "Python monitor alerts",
            "GET /health":    "Health check",
            "GET /status":    "Queue status"
        }
    });
});

app.use((req, res) => {
    res.status(404).json({ status: "not_found", path: req.method + " " + req.path });
});

// ==================== FIX 2: RENDER SELF-PING ====================
// Render free tier 15 min inactivity pe server ko sleep kar deta hai
// Self-ping har 10 min mein server ko jagraat rakhta hai
if (SELF_URL) {
    setInterval(() => {
        const pingUrl = SELF_URL + "/health";
        console.log("[SELF-PING] " + pingUrl);
        try {
            const mod = pingUrl.startsWith("https") ? https : http;
            const req = mod.get(pingUrl, (res) => {
                console.log("[SELF-PING] Response: " + res.statusCode);
            });
            req.on('error', (e) => console.log("[SELF-PING] Error: " + e.message));
            req.setTimeout(8000, () => { req.destroy(); console.log("[SELF-PING] Timeout"); });
        } catch(e) {
            console.log("[SELF-PING] Exception: " + e.message);
        }
    }, 10 * 60 * 1000); // 10 minutes
    console.log("[SELF-PING] Enabled → " + SELF_URL);
} else {
    console.log("[SELF-PING] Disabled — SELF_URL env var set karo Render pe");
}

// ==================== HEARTBEAT ====================
setInterval(() => {
    const pending = getPendingUsers();
    console.log("[HEARTBEAT] " + new Date().toISOString() +
                " | Pending users: " + pending.length +
                (pending.length ? " → " + pending.join(",") : ""));
}, 30000);

// ==================== ERROR HANDLING ====================
process.on('uncaughtException',  err    => console.error("UNCAUGHT: "   + err.message));
process.on('unhandledRejection', reason => console.error("UNHANDLED: " + reason));

// ==================== START ====================
function startServer() {
    const hasSSL = fs.existsSync(SSL_CERT_PATH) && fs.existsSync(SSL_KEY_PATH);
    if (hasSSL) {
        try {
            const opts = { key: fs.readFileSync(SSL_KEY_PATH), cert: fs.readFileSync(SSL_CERT_PATH) };
            https.createServer(opts, app).listen(PORT, HOST, () => printBanner("HTTPS"));
        } catch(e) {
            console.error("SSL Error: " + e.message);
            app.listen(PORT, HOST, () => printBanner("HTTP (SSL fallback)"));
        }
    } else {
        app.listen(PORT, HOST, () => printBanner("HTTP"));
    }
}

function printBanner(protocol) {
    console.log("\n================================================================");
    console.log("  WEBHOOK SERVER v6.0 — All Fixes Applied");
    console.log("================================================================");
    console.log("  Protocol  : " + protocol + " | Port: " + PORT);
    console.log("  Fix 1     : BUY/SELL queue — no signal overwrite");
    console.log("  Fix 2     : Self-ping — Render sleep prevention");
    console.log("  Fix 3     : Duplicate position_id protection");
    console.log("  SELF_URL  : " + (SELF_URL || "NOT SET — set karo Render env vars mein"));
    console.log("================================================================\n");
}

startServer();
