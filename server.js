//+------------------------------------------------------------------+
//| WEBHOOK SERVER - v5.1 SYMBOL CASE PRESERVED
//| XM Copy Trading Integration
//| Actions: BUY, SELL, CLOSE (position_id based)
//| Fix: symbol case preserve (US30Cash not US30CASH)
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

// ==================== UTILITY ====================

// ✅ FIX: action/event uppercase karo (BUY, SELL, CLOSE, ALERT)
//         lekin symbol ka case PRESERVE karo (US30Cash, EURUSDm)
function sanitizeAction(str) {
    if (typeof str === 'string') return str.trim().toUpperCase();
    return "";
}

// ✅ Symbol as-is — sirf trim, NO uppercase
function sanitizeSymbol(str) {
    if (typeof str === 'string') return str.trim();
    return "";
}

function sanitizeUserId(str) {
    if (typeof str === 'string') return str.trim();
    return "";
}

function generateSignalId() {
    return Date.now() + "_" + Math.random().toString(36).substr(2, 9);
}

// ==================== SIGNAL STORAGE ====================

function emptySignal() {
    return {
        signal: 0, symbol: "", timestamp: null,
        action: "", id: "", position_id: "",
        price: "", timeframe: "", user_id: ""
    };
}

const latest_signal_by_user = Object.create(null);
const close_queue_by_user   = Object.create(null);
const signal_history        = [];
const MAX_HISTORY           = 100;

function logSignal(signal_obj) {
    signal_history.push({
        signal:      signal_obj.signal,
        symbol:      signal_obj.symbol,
        action:      signal_obj.action,
        id:          signal_obj.id,
        position_id: signal_obj.position_id || "",
        user_id:     signal_obj.user_id || "",
        receivedAt:  new Date().toISOString()
    });
    if (signal_history.length > MAX_HISTORY) signal_history.shift();
    console.log("[SIGNAL-STORED] " + signal_obj.action + " | " + signal_obj.symbol +
                " | POS_ID: " + (signal_obj.position_id || "-") +
                " | USER: " + (signal_obj.user_id || "N/A"));
}

function validateToken(req, body) {
    // GET request: query param | POST request: body mein
    const token = req.query.token || (body && body.token) || "";
    const isValid = token === SECRET_TOKEN;
    if (!isValid) console.log("  Token FAILED | Got: " + token.substring(0, 10) + "...");
    else          console.log("  Token OK");
    return isValid;
}

function hasPendingAnyUser() {
    const hasBuySell = Object.keys(latest_signal_by_user).some(uid =>
        latest_signal_by_user[uid] && latest_signal_by_user[uid].signal !== 0);
    const hasClose = Object.keys(close_queue_by_user).some(uid =>
        close_queue_by_user[uid] && close_queue_by_user[uid].length > 0);
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

// ==================== GET SIGNAL (EA polling) ====================
app.get("/get_signal", (req, res) => {
    console.log("  GET /get_signal called");

    if (!validateToken(req, null)) {
        return res.status(401).json({ status: "unauthorized", message: "Invalid token" });
    }

    const requested_user_id = sanitizeUserId(req.query.user_id || "");
    if (!requested_user_id) {
        return res.status(200).json({ status: "no_signal", signal: 0, symbol: "", id: "" });
    }

    // ✅ CLOSE queue pehle (priority)
    if (!close_queue_by_user[requested_user_id]) close_queue_by_user[requested_user_id] = [];

    if (close_queue_by_user[requested_user_id].length > 0) {
        const closeSignal = close_queue_by_user[requested_user_id].shift();
        console.log("  CLOSE SIGNAL SENT | USER: " + requested_user_id +
                    " | POS_ID: " + closeSignal.position_id +
                    " | SYM: " + closeSignal.symbol);
        return res.status(200).json({
            status:      "ok",
            signal:      0,
            action:      "CLOSE",
            symbol:      closeSignal.symbol,      // ✅ case preserved
            position_id: closeSignal.position_id,
            price:       closeSignal.price,
            id:          closeSignal.id,
            user_id:     requested_user_id,
            timestamp:   closeSignal.timestamp
        });
    }

    // BUY/SELL check
    if (!latest_signal_by_user[requested_user_id])
        latest_signal_by_user[requested_user_id] = emptySignal();

    const bucket = latest_signal_by_user[requested_user_id];

    if (bucket.signal !== 0) {
        const sig = { ...bucket };
        latest_signal_by_user[requested_user_id] = emptySignal();
        console.log("  BUY/SELL SIGNAL SENT: " + sig.action + " " + sig.symbol +
                    " | USER: " + requested_user_id);
        return res.status(200).json({
            status:      "ok",
            signal:      sig.signal,
            symbol:      sig.symbol,              // ✅ case preserved
            action:      sig.action,
            timestamp:   sig.timestamp,
            id:          sig.id,
            position_id: sig.position_id,
            price:       sig.price,
            timeframe:   sig.timeframe,
            user_id:     sig.user_id
        });
    }

    return res.status(200).json({ status: "no_signal", signal: 0, symbol: "", id: "" });
});

// ==================== WEBHOOK (Python script → server) ====================
app.post("/webhook", (req, res) => {
    console.log("  POST /webhook called");

    const body       = req.body || {};
    const event_type = sanitizeAction(body.event || "");

    // ========== ALERT ==========
    if (event_type === "ALERT") {

        if (!validateToken(req, body)) {
            return res.status(401).json({ status: "unauthorized", message: "Invalid token" });
        }

        // ✅ FIX: symbol case preserve — sanitizeSymbol use karo
        const symbol      = sanitizeSymbol(body.symbol || "");
        const action      = sanitizeAction(body.action || "");  // BUY/SELL/CLOSE uppercase OK
        const price       = body.price     || "";
        const timeframe   = body.timeframe || "";
        const position_id = body.position_id || "";

        console.log("  Symbol (case-preserved): '" + symbol + "' | Action: " + action);

        if (!symbol) {
            return res.status(400).json({ status: "bad_request", message: "symbol required" });
        }
        if (action !== "BUY" && action !== "SELL" && action !== "CLOSE") {
            return res.status(400).json({ status: "bad_request", message: "action must be BUY, SELL, or CLOSE" });
        }

        // Targets resolve
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

        // ✅ CLOSE → queue
        if (action === "CLOSE") {
            if (!position_id) {
                return res.status(400).json({ status: "bad_request", message: "position_id required for CLOSE" });
            }
            targets.forEach(uid => {
                if (!close_queue_by_user[uid]) close_queue_by_user[uid] = [];
                const alreadyQueued = close_queue_by_user[uid].some(c => c.position_id === position_id);
                if (!alreadyQueued) {
                    close_queue_by_user[uid].push({
                        position_id: position_id,
                        symbol:      symbol,       // ✅ case preserved
                        price:       price,
                        id:          signal_id,
                        timestamp:   new Date().toISOString()
                    });
                    console.log("  CLOSE QUEUED | USER: " + uid + " | " + symbol + " | POS_ID: " + position_id);
                    logSignal({ signal: 0, symbol, action: "CLOSE", id: signal_id, position_id, user_id: uid });
                } else {
                    console.log("  CLOSE DUPLICATE IGNORED | USER: " + uid + " | POS_ID: " + position_id);
                }
            });
            return res.status(200).json({
                status: "ok", message: "CLOSE queued",
                position_id, symbol, targets, id: signal_id,
                timestamp: new Date().toISOString()
            });
        }

        // ✅ BUY/SELL → latest signal
        const numeric_signal = action === "BUY" ? 1 : -1;
        targets.forEach(uid => {
            latest_signal_by_user[uid] = {
                signal:      numeric_signal,
                symbol:      symbol,               // ✅ case preserved
                action:      action,
                timestamp:   new Date().toISOString(),
                id:          signal_id,
                position_id: position_id,
                price:       price,
                timeframe:   timeframe,
                user_id:     uid
            };
            logSignal(latest_signal_by_user[uid]);
            console.log("  " + action + " STORED | USER: " + uid +
                        " | " + symbol + " @ " + price + " | POS_ID: " + position_id);
        });

        return res.status(200).json({
            status: "ok", message: action + " stored",
            signal: numeric_signal, id: signal_id,
            symbol, targets, timestamp: new Date().toISOString()
        });
    }

    // ========== PING ==========
    if (event_type === "PING") {
        return res.status(200).json({ status: "pong", timestamp: new Date().toISOString() });
    }

    return res.status(200).json({ status: "ignored", message: "Unknown event: " + event_type });
});

// ==================== COMPAT ====================
app.get("/signal", (req, res) => {
    req.url = "/get_signal" + (req.url.includes("?") ? req.url.substring(req.url.indexOf("?")) : "");
    app.handle(req, res);
});

// ==================== STATUS ====================
app.get("/health", (req, res) => {
    res.status(200).json({
        status: "healthy", uptime: process.uptime(),
        timestamp: new Date().toISOString(), pending: hasPendingAnyUser()
    });
});

app.get("/status", (req, res) => {
    res.status(200).json({
        status:                  "running",
        version:                 "5.1-symbol-case-preserved",
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
        status:  "running",
        version: "5.1-symbol-case-preserved",
        fix:     "symbol case preserved — US30Cash stays US30Cash, not US30CASH",
        endpoints: {
            "GET /get_signal?token=TOKEN&user_id=USER": "MT5 EA signal fetch",
            "POST /webhook": "XM Monitor alerts (BUY, SELL, CLOSE)",
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
    console.log("[HEARTBEAT] " + new Date().toISOString() +
                " | Pending: " + pending.length +
                (pending.length ? " => " + pending.join(",") : ""));
}, 30000);

// ==================== ERROR HANDLING ====================
process.on('uncaughtException',  err    => console.error("UNCAUGHT: "    + err.message));
process.on('unhandledRejection', reason => console.error("UNHANDLED: " + reason));

// ==================== START ====================
function startServer() {
    const hasSSL = fs.existsSync(SSL_CERT_PATH) && fs.existsSync(SSL_KEY_PATH);
    if (hasSSL) {
        try {
            const options = {
                key:  fs.readFileSync(SSL_KEY_PATH),
                cert: fs.readFileSync(SSL_CERT_PATH)
            };
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
    console.log("  WEBHOOK SERVER v5.1 — Symbol Case Preserved");
    console.log("=================================================================");
    console.log("  Protocol : " + protocol + " | Port: " + PORT);
    console.log("  Fix      : symbol as-is (US30Cash ≠ US30CASH)");
    console.log("  Actions  : BUY, SELL, CLOSE (position_id based)");
    console.log("=================================================================\n");
}

startServer();
