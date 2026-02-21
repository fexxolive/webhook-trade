//+------------------------------------------------------------------+
//| WEBHOOK SERVER - v5.0 WITH CLOSE ACTION SUPPORT
//| XM Copy Trading Integration
//| Actions: BUY, SELL, CLOSE (position_id based)
//+------------------------------------------------------------------+

const express = require('express');
const https = require('https');
const fs = require('fs');
const app = express();

// ==================== CONFIGURATION ====================
const SECRET_TOKEN = process.env.WEBHOOK_SECRET_TOKEN || "37ehADKNLy5psq1IvdUDYshxxik_zuy2RYD72n7E858DYqR2";
const HOST = "0.0.0.0";
const PORT = process.env.PORT || 8443;
const SSL_CERT_PATH = process.env.SSL_CERT_PATH || "cert.pem";
const SSL_KEY_PATH  = process.env.SSL_KEY_PATH  || "key.pem";

// ==================== MIDDLEWARE ====================
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

app.use((req, res, next) => {
    const timestamp = new Date().toISOString();
    console.log("[" + timestamp + "] " + req.method + " " + req.path);
    console.log("  Query: " + JSON.stringify(req.query));
    console.log("  Body: " + JSON.stringify(req.body).substring(0, 200));
    next();
});

app.use((err, req, res, next) => {
    console.log("  ERROR: " + err.message);
    res.status(400).json({ status: "error", message: err.message, timestamp: new Date().toISOString() });
});

// ==================== SIGNAL STORAGE ====================

function emptySignal() {
    return {
        signal: 0,
        symbol: "",
        timestamp: null,
        action: "",
        id: "",
        position_id: "",
        price: "",
        timeframe: "",
        user_id: ""
    };
}

// Per-user latest signal (for BUY/SELL)
const latest_signal_by_user = Object.create(null);

// Per-user CLOSE queue (multiple closes possible)
// { "user_Msbbtc": [ {position_id, symbol, price}, ... ] }
const close_queue_by_user = Object.create(null);

const signal_history = [];
const MAX_HISTORY = 100;

// ==================== UTILITY ====================

function sanitize(str) {
    if (typeof str === 'string') return str.trim().toUpperCase();
    return "";
}

function sanitizeUserId(str) {
    if (typeof str === 'string') return str.trim();
    return "";
}

function generateSignalId() {
    return Date.now() + "_" + Math.random().toString(36).substr(2, 9);
}

function logSignal(signal_obj) {
    signal_history.push({
        signal:     signal_obj.signal,
        symbol:     signal_obj.symbol,
        action:     signal_obj.action,
        id:         signal_obj.id,
        position_id: signal_obj.position_id || "",
        user_id:    signal_obj.user_id || "",
        receivedAt: new Date().toISOString()
    });
    if (signal_history.length > MAX_HISTORY) signal_history.shift();
    console.log("[SIGNAL-STORED] " + signal_obj.action + " | " + signal_obj.symbol + " | POS_ID: " + (signal_obj.position_id || "-") + " | USER: " + (signal_obj.user_id || "N/A"));
}

function validateToken(req) {
    const token = req.query.token || "";
    const isValid = token === SECRET_TOKEN;
    if (!isValid) console.log("  Token FAILED | Got: " + token.substring(0, 10) + "...");
    else          console.log("  Token OK");
    return isValid;
}

function hasPendingAnyUser() {
    const hasBuySell = Object.keys(latest_signal_by_user).some(uid => latest_signal_by_user[uid] && latest_signal_by_user[uid].signal !== 0);
    const hasClose   = Object.keys(close_queue_by_user).some(uid => close_queue_by_user[uid] && close_queue_by_user[uid].length > 0);
    return hasBuySell || hasClose;
}

function getPendingUsers() {
    const users = new Set();
    Object.keys(latest_signal_by_user).forEach(uid => {
        if (latest_signal_by_user[uid] && latest_signal_by_user[uid].signal !== 0) users.add(uid);
    });
    Object.keys(close_queue_by_user).forEach(uid => {
        if (close_queue_by_user[uid] && close_queue_by_user[uid].length > 0) users.add(uid);
    });
    return [...users];
}

// ==================== GET SIGNAL ENDPOINT ====================

/**
 * GET /get_signal?token=TOKEN&user_id=user_Msbbtc
 * EA yahan se signal leta hai
 * 
 * Response for BUY/SELL:
 * { status:"ok", signal:1, action:"BUY", symbol:"XAUUSD", position_id:"pos_abc123", price:"2670" }
 * 
 * Response for CLOSE:
 * { status:"ok", signal:0, action:"CLOSE", symbol:"XAUUSD", position_id:"pos_abc123" }
 * 
 * Response when nothing:
 * { status:"no_signal", signal:0 }
 */
app.get("/get_signal", (req, res) => {
    console.log("  GET /get_signal called");

    if (!validateToken(req)) {
        return res.status(401).json({ status: "unauthorized", message: "Invalid token" });
    }

    const requested_user_id = sanitizeUserId(req.query.user_id || "");
    if (!requested_user_id) {
        return res.status(200).json({ status: "no_signal", signal: 0, symbol: "", id: "" });
    }

    // ✅ CLOSE queue pehle check karo (priority)
    if (!close_queue_by_user[requested_user_id]) close_queue_by_user[requested_user_id] = [];

    if (close_queue_by_user[requested_user_id].length > 0) {
        const closeSignal = close_queue_by_user[requested_user_id].shift(); // FIFO
        console.log("  CLOSE SIGNAL SENT | USER: " + requested_user_id + " | POS_ID: " + closeSignal.position_id);
        return res.status(200).json({
            status:      "ok",
            signal:      0,
            action:      "CLOSE",
            symbol:      closeSignal.symbol,
            position_id: closeSignal.position_id,
            price:       closeSignal.price,
            id:          closeSignal.id,
            user_id:     requested_user_id,
            timestamp:   closeSignal.timestamp
        });
    }

    // BUY/SELL check
    if (!latest_signal_by_user[requested_user_id]) latest_signal_by_user[requested_user_id] = emptySignal();
    const bucket = latest_signal_by_user[requested_user_id];

    if (bucket.signal !== 0) {
        const signal_to_send = { ...bucket };
        latest_signal_by_user[requested_user_id] = emptySignal(); // consume
        console.log("  BUY/SELL SIGNAL SENT: " + signal_to_send.action + " " + signal_to_send.symbol + " | USER: " + requested_user_id);
        return res.status(200).json({
            status:      "ok",
            signal:      signal_to_send.signal,
            symbol:      signal_to_send.symbol,
            action:      signal_to_send.action,
            timestamp:   signal_to_send.timestamp,
            id:          signal_to_send.id,
            position_id: signal_to_send.position_id,
            price:       signal_to_send.price,
            timeframe:   signal_to_send.timeframe,
            user_id:     signal_to_send.user_id
        });
    }

    return res.status(200).json({ status: "no_signal", signal: 0, symbol: "", id: "" });
});

// ==================== WEBHOOK ENDPOINT ====================

/**
 * POST /webhook
 * XM Monitor script yahan alerts bhejta hai
 *
 * BUY/SELL:
 * { "event":"ALERT", "symbol":"XAUUSD", "action":"BUY", "price":"2670", "position_id":"pos_abc", "user_ids":["user_Msbbtc"], "token":"..." }
 *
 * CLOSE:
 * { "event":"ALERT", "symbol":"XAUUSD", "action":"CLOSE", "price":"2680", "position_id":"pos_abc", "user_ids":["user_Msbbtc"], "token":"..." }
 */
app.post("/webhook", (req, res) => {
    console.log("  POST /webhook called");

    const body = req.body || {};
    const event_type = sanitize(body.event || "");

    // ========== ALERT ==========
    if (event_type === "ALERT") {

        // Token validate
        const token = body.token || "";
        if (token !== SECRET_TOKEN) {
            return res.status(401).json({ status: "unauthorized", message: "Invalid token" });
        }

        const symbol      = sanitize(body.symbol || "");
        const action      = sanitize(body.action || "");
        const price       = body.price || "";
        const timeframe   = body.timeframe || "";
        const position_id = body.position_id || "";

        if (!symbol) {
            return res.status(400).json({ status: "bad_request", message: "symbol required" });
        }

        if (action !== "BUY" && action !== "SELL" && action !== "CLOSE") {
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

        // ✅ CLOSE action → close queue mein store karo
        if (action === "CLOSE") {
            if (!position_id) {
                return res.status(400).json({ status: "bad_request", message: "position_id required for CLOSE action" });
            }

            targets.forEach(uid => {
                if (!close_queue_by_user[uid]) close_queue_by_user[uid] = [];

                // Duplicate position_id check
                const alreadyQueued = close_queue_by_user[uid].some(c => c.position_id === position_id);
                if (!alreadyQueued) {
                    close_queue_by_user[uid].push({
                        position_id: position_id,
                        symbol:      symbol,
                        price:       price,
                        id:          signal_id,
                        timestamp:   new Date().toISOString()
                    });
                    console.log("  CLOSE QUEUED | USER: " + uid + " | POS_ID: " + position_id + " | " + symbol);
                    logSignal({ signal: 0, symbol, action: "CLOSE", id: signal_id, position_id, user_id: uid });
                } else {
                    console.log("  CLOSE DUPLICATE IGNORED | USER: " + uid + " | POS_ID: " + position_id);
                }
            });

            return res.status(200).json({
                status:      "ok",
                message:     "CLOSE queued",
                position_id: position_id,
                symbol:      symbol,
                targets:     targets,
                id:          signal_id,
                timestamp:   new Date().toISOString()
            });
        }

        // ✅ BUY/SELL → latest_signal store karo
        const numeric_signal = action === "BUY" ? 1 : -1;

        targets.forEach(uid => {
            latest_signal_by_user[uid] = {
                signal:      numeric_signal,
                symbol:      symbol,
                action:      action,
                timestamp:   new Date().toISOString(),
                id:          signal_id,
                position_id: position_id,
                price:       price,
                timeframe:   timeframe,
                user_id:     uid
            };
            logSignal(latest_signal_by_user[uid]);
            console.log("  " + action + " STORED | USER: " + uid + " | " + symbol + " @ " + price + " | POS_ID: " + position_id);
        });

        return res.status(200).json({
            status:    "ok",
            message:   action + " stored",
            signal:    numeric_signal,
            id:        signal_id,
            symbol:    symbol,
            targets:   targets,
            timestamp: new Date().toISOString()
        });
    }

    // ========== PING ==========
    if (event_type === "PING") {
        return res.status(200).json({ status: "pong", timestamp: new Date().toISOString() });
    }

    return res.status(200).json({ status: "ignored", message: "Unknown event: " + event_type });
});

// ==================== COMPAT ENDPOINT ====================
app.get("/signal", (req, res) => {
    req.url = "/get_signal" + (req.url.includes("?") ? req.url.substring(req.url.indexOf("?")) : "");
    app.handle(req, res);
});

// ==================== STATUS ====================
app.get("/health", (req, res) => {
    res.status(200).json({ status: "healthy", uptime: process.uptime(), timestamp: new Date().toISOString(), pending: hasPendingAnyUser() });
});

app.get("/status", (req, res) => {
    res.status(200).json({
        status:                  "running",
        version:                 "5.0-close-support",
        uptime:                  process.uptime(),
        timestamp:               new Date().toISOString(),
        pending_users:           getPendingUsers(),
        latest_signal_by_user:   latest_signal_by_user,
        close_queue_by_user:     close_queue_by_user,
        recent_history:          signal_history.slice(-10),
        total_signals_processed: signal_history.length
    });
});

app.get("/", (req, res) => {
    res.status(200).json({
        status:    "running",
        version:   "5.0-close-support",
        endpoints: {
            "GET /get_signal?token=TOKEN&user_id=USER": "MT5 EA signal fetch",
            "POST /webhook": "XM Monitor / TradingView alerts (BUY, SELL, CLOSE)",
            "GET /health":   "Health check",
            "GET /status":   "Detailed status"
        },
        actions_supported: ["BUY", "SELL", "CLOSE"],
        timestamp: new Date().toISOString()
    });
});

app.use((req, res) => {
    res.status(404).json({ status: "not_found", path: req.method + " " + req.path });
});

// ==================== HEARTBEAT ====================
setInterval(() => {
    const pending = getPendingUsers();
    console.log("[HEARTBEAT] " + new Date().toISOString() + " | Pending: " + pending.length + (pending.length ? " => " + pending.join(",") : ""));
}, 30000);

// ==================== ERROR HANDLING ====================
process.on('uncaughtException',   err    => console.error("UNCAUGHT: " + err.message));
process.on('unhandledRejection',  reason => console.error("UNHANDLED: " + reason));

// ==================== START ====================
function startServer() {
    const hasSSL = fs.existsSync(SSL_CERT_PATH) && fs.existsSync(SSL_KEY_PATH);
    if (hasSSL) {
        try {
            const options = { key: fs.readFileSync(SSL_KEY_PATH), cert: fs.readFileSync(SSL_CERT_PATH) };
            https.createServer(options, app).listen(PORT, HOST, () => printBanner("HTTPS"));
        } catch(e) {
            console.error("SSL Error: " + e.message);
            app.listen(PORT, HOST, () => printBanner("HTTP"));
        }
    } else {
        app.listen(PORT, HOST, () => printBanner("HTTP"));
    }
}

function printBanner(protocol) {
    console.log("\n=================================================================");
    console.log("  WEBHOOK SERVER v5.0 — BUY / SELL / CLOSE Support");
    console.log("=================================================================");
    console.log("  Protocol: " + protocol + " | Port: " + PORT);
    console.log("  Actions:  BUY, SELL, CLOSE (position_id based)");
    console.log("=================================================================\n");
}

startServer();
