//+------------------------------------------------------------------+
//| WEBHOOK SERVER - v4.6 QUEUE-BASED + SL_RAW + WINDOWS SUPPORT
//| TradingView + MT5 EA Integration | Token in Query Parameter
//| FIX v4.5: Signal QUEUE per user — multiple alerts same second pe
//|           koi signal miss/overwrite nahi hoga
//| FIX v4.6: /get_windows endpoint added + WINDOWS_UPDATE event
//|           handling — Pine scripts ka hourly window-schedule alert
//|           ab STORE hota hai aur EA usse poll karke fetch kar sakta
//|           hai. Pehle ye missing tha, isliye EA kabhi live windows
//|           populate nahi kar pata tha (silent dead system).
//| PRESERVED: sl_raw field — TradingView sends {{low}} or {{high}}
//|            EA calculates final SL using wickPercent + slBuffer inputs
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
const SSL_KEY_PATH = process.env.SSL_KEY_PATH || "key.pem";

// Windows are considered "stale" if not refreshed by any Pine script
// alert for longer than this — helps /health and /status flag a dead feed.
const WINDOWS_STALE_MS = 2 * 60 * 60 * 1000; // 2 hours

// ==================== MIDDLEWARE ====================
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Request logging
app.use((req, res, next) => {
    const timestamp = new Date().toISOString();
    console.log("[" + timestamp + "] " + req.method + " " + req.path);
    console.log("  Query: " + JSON.stringify(req.query));
    console.log("  Body: " + JSON.stringify(req.body).substring(0, 200));
    next();
});

// Custom error handler
app.use((err, req, res, next) => {
    console.log("  ERROR: " + err.message);
    res.status(400).json({
        status: "error",
        message: err.message,
        timestamp: new Date().toISOString()
    });
});

// ==================== SIGNAL STORAGE (QUEUE PER USER) ====================
// ✅ FIX v4.5: Array (queue) per user instead of single object
// Multiple alerts same second pe aayein toh koi signal overwrite nahi hoga
// EA FIFO order mein signals consume karega

const signal_queue_by_user = Object.create(null); // { "user_Asheen1": [signal1, signal2, ...] }
const signal_history = [];
const MAX_HISTORY = 50;
const MAX_QUEUE_PER_USER = 20; // safety cap

// ==================== WINDOWS STORAGE (NEW in v4.6) ====================
// Pine scripts (Group A / Group B) har hour "WINDOWS_UPDATE" event bhejte
// hain jisme us group ke qualifying time-windows (numeric, full-day)
// hote hain. Ye yahan group-wise store hote hain, aur EA GET /get_windows
// se poll karke fetch karta hai. Shape EA ke ParseWindowsJson() se match:
//   {"windows":[{"start_h":X,"start_m":Y,"end_h":Z,"end_m":W,"winrate":P}, ...]}

const windowsByGroup = {
    A: { windows: [], active_windows: "", symbol: "", timeframe: "", min_accuracy: "", updatedAt: null },
    B: { windows: [], active_windows: "", symbol: "", timeframe: "", min_accuracy: "", updatedAt: null }
};

function isValidGroup(g) {
    return g === "A" || g === "B";
}

function sanitizeWindowsArray(arr) {
    // Defensive re-validation of incoming windows payload before storing.
    if (!Array.isArray(arr)) return [];
    return arr
        .filter(w => w && typeof w === "object")
        .map(w => ({
            start_h: Number(w.start_h),
            start_m: Number(w.start_m),
            end_h: Number(w.end_h),
            end_m: Number(w.end_m),
            winrate: Number(w.winrate)
        }))
        .filter(w =>
            Number.isFinite(w.start_h) && w.start_h >= 0 && w.start_h <= 23 &&
            Number.isFinite(w.start_m) &&
            Number.isFinite(w.end_h) && w.end_h >= 0 && w.end_h <= 23 &&
            Number.isFinite(w.end_m) &&
            Number.isFinite(w.winrate)
        );
}

function storeWindowsUpdate(body) {
    const group = sanitize(body.group || ""); // sanitize() uppercases + trims
    if (!isValidGroup(group)) {
        console.log("  WINDOWS_UPDATE ignored — invalid/missing group: " + body.group);
        return { ok: false, message: "group must be 'A' or 'B'" };
    }

    const cleanWindows = sanitizeWindowsArray(body.windows);

    windowsByGroup[group] = {
        windows: cleanWindows,
        active_windows: typeof body.active_windows === "string" ? body.active_windows : "",
        symbol: typeof body.symbol === "string" ? body.symbol : "",
        timeframe: typeof body.timeframe === "string" ? body.timeframe : "",
        min_accuracy: typeof body.min_accuracy === "string" ? body.min_accuracy : "",
        updatedAt: new Date().toISOString()
    };

    console.log("  WINDOWS_UPDATE stored | Group " + group + " | " +
        cleanWindows.length + " window(s) | symbol=" + windowsByGroup[group].symbol +
        " | active=" + (windowsByGroup[group].active_windows || "none right now"));

    return { ok: true, group, count: cleanWindows.length };
}

function windowsFeedStatus() {
    const now = Date.now();
    const status = {};
    for (const g of ["A", "B"]) {
        const entry = windowsByGroup[g];
        const updatedAtMs = entry.updatedAt ? new Date(entry.updatedAt).getTime() : null;
        status[g] = {
            count: entry.windows.length,
            updatedAt: entry.updatedAt,
            stale: updatedAtMs === null ? true : (now - updatedAtMs) > WINDOWS_STALE_MS
        };
    }
    return status;
}

// ==================== UTILITY FUNCTIONS ====================

function getOrCreateQueue(user_id) {
    if (!signal_queue_by_user[user_id]) {
        signal_queue_by_user[user_id] = [];
    }
    return signal_queue_by_user[user_id];
}

function logSignal(signal_obj) {
    signal_history.push({
        signal: signal_obj.signal,
        symbol: signal_obj.symbol,
        action: signal_obj.action,
        id: signal_obj.id,
        price: signal_obj.price,
        sl_raw: signal_obj.sl_raw,
        user_id: signal_obj.user_id || "",
        receivedAt: new Date().toISOString()
    });

    if (signal_history.length > MAX_HISTORY) {
        signal_history.shift();
    }

    console.log("[SIGNAL-QUEUED] " + signal_obj.action + " | " + signal_obj.symbol +
        " | Price: " + signal_obj.price +
        " | SL_RAW: " + signal_obj.sl_raw +
        " | ID: " + signal_obj.id +
        " | USER: " + (signal_obj.user_id || "N/A"));
}

function validateToken(req) {
    const token = req.query.token || "";
    const isValid = token === SECRET_TOKEN;
    if (!isValid) {
        console.log("  Token validation FAILED | Received: " + token.substring(0, 10) + "...");
    } else {
        console.log("  Token validation SUCCESS");
    }
    return isValid;
}

function sanitize(str) {
    if (typeof str === 'string') return str.trim().toUpperCase();
    return "";
}

function sanitizeUserId(str) {
    if (typeof str === 'string') return str.trim();
    return "";
}

function generateSignalId() {
    // ✅ FIX v4.5: hrtime use karo for truly unique IDs even at same millisecond
    return Date.now() + "_" + process.hrtime.bigint().toString().slice(-9) + "_" + Math.random().toString(36).substr(2, 6);
}

function hasPendingAnyUser() {
    return Object.keys(signal_queue_by_user).some(uid =>
        signal_queue_by_user[uid] && signal_queue_by_user[uid].length > 0);
}

function getPendingUsers() {
    return Object.keys(signal_queue_by_user).filter(uid =>
        signal_queue_by_user[uid] && signal_queue_by_user[uid].length > 0);
}

function getQueueSummary() {
    const summary = {};
    for (const uid of Object.keys(signal_queue_by_user)) {
        summary[uid] = signal_queue_by_user[uid].length;
    }
    return summary;
}

// ==================== HELPER: Build signal response ====================

function buildSignalResponse(signal_to_send, queue_remaining) {
    return {
        status: "ok",
        signal: signal_to_send.signal,
        symbol: signal_to_send.symbol,
        action: signal_to_send.action,
        timestamp: signal_to_send.timestamp,
        id: signal_to_send.id,
        price: signal_to_send.price,
        sl_raw: signal_to_send.sl_raw,       // ✅ EA uses this to calculate final SL
        timeframe: signal_to_send.timeframe,
        user_id: signal_to_send.user_id,
        queue_remaining: queue_remaining      // ✅ EA dekh sakta hai kitne aur signals hain
    };
}

// ==================== HELPER: Build windows response ====================

function buildWindowsResponse(group) {
    const entry = windowsByGroup[group];
    return {
        status: "ok",
        group: group,
        symbol: entry.symbol,
        timeframe: entry.timeframe,
        min_accuracy: entry.min_accuracy,
        windows: entry.windows,              // ✅ numeric full-day array — EA parser consumes this
        active_windows: entry.active_windows, // human-readable, debug only
        updatedAt: entry.updatedAt,
        timestamp: new Date().toISOString()
    };
}

// ==================== GET /get_signal ====================

app.get("/get_signal", (req, res) => {
    console.log("  GET /get_signal endpoint called");

    if (!validateToken(req)) {
        return res.status(401).json({
            status: "unauthorized",
            message: "Invalid or missing token in URL",
            example: "/get_signal?token=YOUR_TOKEN_HERE&user_id=user_Asheen",
            timestamp: new Date().toISOString()
        });
    }

    const requested_user_id = sanitizeUserId(req.query.user_id || "");
    if (!requested_user_id) {
        return res.status(200).json({ status: "no_signal", signal: 0, symbol: "", id: "" });
    }

    const queue = getOrCreateQueue(requested_user_id);
    console.log("  Checking queue for USER: " + requested_user_id + " | Queue size: " + queue.length);

    if (queue.length > 0) {
        const signal_to_send = queue.shift(); // ✅ FIFO

        console.log("  SIGNAL FOUND: " + signal_to_send.action + " " + signal_to_send.symbol +
            " | Price: " + signal_to_send.price +
            " | SL_RAW: " + signal_to_send.sl_raw +
            " | Remaining: " + queue.length);

        return res.status(200).json(buildSignalResponse(signal_to_send, queue.length));
    }

    return res.status(200).json({ status: "no_signal", signal: 0, symbol: "", id: "" });
});

// ==================== GET /get_windows (NEW in v4.6) ====================
// EA calls this once per InpPollIntervalSec (per group) to fetch the
// latest qualifying time-windows produced by the Pine "WINDOWS_UPDATE"
// hourly alert. Response shape matches EA's ParseWindowsJson() exactly.

app.get("/get_windows", (req, res) => {
    console.log("  GET /get_windows endpoint called");

    if (!validateToken(req)) {
        return res.status(401).json({
            status: "unauthorized",
            message: "Invalid or missing token in URL",
            example: "/get_windows?token=YOUR_TOKEN_HERE&group=A",
            timestamp: new Date().toISOString()
        });
    }

    const group = sanitize(req.query.group || "");
    if (!isValidGroup(group)) {
        return res.status(400).json({
            status: "bad_request",
            message: "group query param must be 'A' or 'B'",
            example: "/get_windows?token=YOUR_TOKEN_HERE&group=A",
            timestamp: new Date().toISOString()
        });
    }

    return res.status(200).json(buildWindowsResponse(group));
});

// ==================== POST /webhook ====================

app.post("/webhook", (req, res) => {
    console.log("  POST /webhook endpoint called");

    const body = req.body || {};
    const event_type = sanitize(body.event || "");
    console.log("  Event type: " + event_type);

    // ========== GET_SIGNAL via POST ==========
    if (event_type === "GET_SIGNAL") {
        const token = body.token || "";
        if (token !== SECRET_TOKEN) {
            return res.status(401).json({ status: "unauthorized", message: "Invalid token" });
        }

        const requested_user_id = sanitizeUserId(body.user_id || "");
        if (!requested_user_id) {
            return res.status(200).json({ status: "no_signal", signal: 0, id: "" });
        }

        const queue = getOrCreateQueue(requested_user_id);

        if (queue.length > 0) {
            const signal_to_send = queue.shift(); // ✅ FIFO
            console.log("  SIGNAL SENT (POST): " + signal_to_send.action + " | USER: " + requested_user_id + " | Remaining: " + queue.length);
            return res.status(200).json(buildSignalResponse(signal_to_send, queue.length));
        }

        return res.status(200).json({ status: "no_signal", signal: 0, id: "" });
    }

    // ========== ALERT from TradingView ==========
    if (event_type === "ALERT") {
        const token = body.token || "";
        if (token !== SECRET_TOKEN) {
            return res.status(401).json({ status: "unauthorized", message: "Invalid token" });
        }

        const symbol    = sanitize(body.symbol || "");
        const action    = sanitize(body.action || body.signal || "");
        const price     = body.price     || "";
        const sl_raw    = body.sl_raw    || "";    // ✅ {{low}} or {{high}} from TradingView
        const timeframe = body.timeframe || "";

        if (!symbol) {
            return res.status(400).json({ status: "bad_request", message: "Symbol is required" });
        }

        if (action !== "BUY" && action !== "SELL") {
            return res.status(400).json({ status: "bad_request", message: "Action must be BUY or SELL" });
        }

        // ✅ Log warning if sl_raw missing
        if (!sl_raw) {
            console.log("  ⚠️  WARNING: sl_raw is empty! BUY alert should send {{low}}, SELL should send {{high}}");
        } else {
            console.log("  ✅ sl_raw received: " + sl_raw + " (" + action + " → " + (action === "BUY" ? "{{low}}" : "{{high}}") + ")");
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
            return res.status(400).json({
                status: "bad_request",
                message: "user_id or user_ids[] is required"
            });
        }

        const numeric_signal = action === "BUY" ? 1 : -1;

        // ✅ FIX v4.5: Push to queue (not overwrite) + per-user unique ID
        const queued_targets = [];
        const skipped_targets = [];

        targets.forEach((uid) => {
            const queue = getOrCreateQueue(uid);

            if (queue.length >= MAX_QUEUE_PER_USER) {
                console.log("  QUEUE FULL for USER: " + uid + " - skipping");
                skipped_targets.push(uid);
                return;
            }

            const signal_id = generateSignalId(); // ✅ har user ke liye alag unique ID

            const new_signal = {
                signal: numeric_signal,
                symbol: symbol,
                action: action,
                timestamp: new Date().toISOString(),
                id: signal_id,
                price: price,
                sl_raw: sl_raw,       // ✅ stored per user
                timeframe: timeframe,
                user_id: uid
            };

            queue.push(new_signal);
            queued_targets.push(uid);

            logSignal(new_signal);
            console.log("  SIGNAL QUEUED: " + action + " " + symbol + " | USER: " + uid + " | Queue size now: " + queue.length);
        });

        return res.status(200).json({
            status: "ok",
            message: "Alert received and queued",
            signal: numeric_signal,
            symbol: symbol,
            price: price,
            sl_raw: sl_raw,
            queued_targets: queued_targets,
            skipped_targets: skipped_targets,
            timestamp: new Date().toISOString()
        });
    }

    // ========== WINDOWS_UPDATE from TradingView (NEW in v4.6) ==========
    // Sent hourly by both Group A and Group B Pine scripts. No trade
    // signal — just the day's qualifying time-window schedule. Stored
    // in windowsByGroup so the EA can pull it via GET /get_windows.
    if (event_type === "WINDOWS_UPDATE") {
        const token = body.token || "";
        if (token !== SECRET_TOKEN) {
            return res.status(401).json({ status: "unauthorized", message: "Invalid token" });
        }

        const result = storeWindowsUpdate(body);
        if (!result.ok) {
            return res.status(400).json({
                status: "bad_request",
                message: result.message,
                timestamp: new Date().toISOString()
            });
        }

        return res.status(200).json({
            status: "ok",
            message: "Windows update stored",
            group: result.group,
            windows_count: result.count,
            timestamp: new Date().toISOString()
        });
    }

    // ========== PING ==========
    if (event_type === "PING") {
        return res.status(200).json({ status: "pong", timestamp: new Date().toISOString() });
    }

    return res.status(200).json({
        status: "ignored",
        message: "Unknown event: " + event_type,
        available_events: ["GET_SIGNAL", "ALERT", "WINDOWS_UPDATE", "PING"],
        timestamp: new Date().toISOString()
    });
});

// ==================== GET /signal (compatibility) ====================

app.get("/signal", (req, res) => {
    if (!validateToken(req)) {
        return res.status(401).json({ status: "unauthorized", message: "Invalid or missing token" });
    }

    const requested_user_id = sanitizeUserId(req.query.user_id || "");
    if (!requested_user_id) {
        return res.status(200).json({ status: "no_signal", signal: 0, id: "" });
    }

    const queue = getOrCreateQueue(requested_user_id);

    if (queue.length > 0) {
        const signal_to_send = queue.shift(); // ✅ FIFO
        console.log("  Signal sent: " + signal_to_send.action + " | USER: " + requested_user_id + " | Remaining: " + queue.length);
        return res.status(200).json(buildSignalResponse(signal_to_send, queue.length));
    }

    return res.status(200).json({ status: "no_signal", signal: 0, id: "" });
});

// ==================== STATUS ENDPOINTS ====================

app.get("/health", (req, res) => {
    res.status(200).json({
        status: "healthy",
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
        pending_users: getPendingUsers().length,
        queue_summary: getQueueSummary(),
        windows_feed: windowsFeedStatus()
    });
});

app.get("/status", (req, res) => {
    const recentHistory = signal_history.slice(-10);
    res.status(200).json({
        status: "running",
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
        pending_users: getPendingUsers(),
        queue_summary: getQueueSummary(),
        signal_queue_by_user: signal_queue_by_user,
        recent_history: recentHistory,
        total_signals_processed: signal_history.length,
        windows_by_group: windowsByGroup,
        windows_feed_status: windowsFeedStatus(),
        server_version: "4.6-queue-sl-raw-windows"
    });
});

app.get("/", (req, res) => {
    const hasSSL = fs.existsSync(SSL_CERT_PATH) && fs.existsSync(SSL_KEY_PATH);
    res.status(200).json({
        status: "running",
        version: "4.6-queue-sl-raw-windows",
        protocol: hasSSL ? "HTTPS" : "HTTP",
        endpoints: {
            "GET /get_signal?token=TOKEN&user_id=user_Asheen": "Primary MT5 signal endpoint",
            "GET /signal?token=TOKEN&user_id=user_Asheen": "Alternative signal endpoint",
            "GET /get_windows?token=TOKEN&group=A|B": "EA polls this for live time-windows",
            "POST /webhook": "TradingView alerts (ALERT, WINDOWS_UPDATE, PING, GET_SIGNAL)",
            "GET /health": "Health check",
            "GET /status": "Detailed status"
        },
        tradingview_alert_format: {
            BUY:  { event: "ALERT", symbol: "XAUUSD", action: "BUY",  price: "{{open}}", sl_raw: "{{low}}",  timeframe: "{{interval}}", user_ids: ["user_Asheen3", "user_Asheen4"], token: "YOUR_TOKEN" },
            SELL: { event: "ALERT", symbol: "XAUUSD", action: "SELL", price: "{{open}}", sl_raw: "{{high}}", timeframe: "{{interval}}", user_ids: ["user_Asheen3", "user_Asheen4"], token: "YOUR_TOKEN" }
        },
        tradingview_windows_update_format: {
            event: "WINDOWS_UPDATE",
            group: "A",
            symbol: "XAUUSD",
            timeframe: "5",
            min_accuracy: "75%",
            windows: [{ start_h: 9, start_m: 30, end_h: 13, end_m: 30, winrate: 78.3 }],
            active_windows: "9:30-13:30 IST (78.3%)",
            user_ids: ["user_Tradingview7"],
            token: "YOUR_TOKEN"
        },
        pending_users: getPendingUsers(),
        queue_summary: getQueueSummary(),
        windows_feed: windowsFeedStatus(),
        timestamp: new Date().toISOString()
    });
});

// ==================== 404 HANDLER ====================
app.use((req, res) => {
    res.status(404).json({
        status: "not_found",
        message: req.method + " " + req.path + " not found",
        timestamp: new Date().toISOString()
    });
});

// ==================== HEARTBEAT ====================
setInterval(() => {
    const pending_users = getPendingUsers();
    const wStatus = windowsFeedStatus();
    console.log("[HEARTBEAT] " + new Date().toISOString() +
        " | Pending Users: " + pending_users.length +
        (pending_users.length ? " => " + JSON.stringify(getQueueSummary()) : "") +
        " | Windows A: " + wStatus.A.count + (wStatus.A.stale ? " (STALE)" : "") +
        " | Windows B: " + wStatus.B.count + (wStatus.B.stale ? " (STALE)" : ""));
}, 30000);

// ==================== ERROR HANDLING ====================
process.on('uncaughtException',  (err)    => { console.error("UNCAUGHT EXCEPTION: "  + err.message); });
process.on('unhandledRejection', (reason) => { console.error("UNHANDLED REJECTION: " + reason); });

// ==================== SERVER STARTUP ====================
function startServer() {
    const hasSSL = fs.existsSync(SSL_CERT_PATH) && fs.existsSync(SSL_KEY_PATH);

    if (hasSSL) {
        try {
            const options = {
                key:  fs.readFileSync(SSL_KEY_PATH),
                cert: fs.readFileSync(SSL_CERT_PATH)
            };
            https.createServer(options, app).listen(PORT, HOST, () => {
                printBanner("HTTPS");
            });
        } catch (err) {
            console.error("SSL Error: " + err.message);
            startHTTP();
        }
    } else {
        startHTTP();
    }
}

function startHTTP() {
    app.listen(PORT, HOST, () => {
        printBanner("HTTP");
    });
}

function printBanner(protocol) {
    const sep = "=========================================================================";
    console.log("\n" + sep);
    console.log("WEBHOOK SERVER v4.6 — QUEUE-BASED + SL_RAW + WINDOWS SUPPORT");
    console.log(sep);
    console.log("Protocol : " + protocol);
    console.log("Port     : " + PORT);
    console.log("");
    console.log("FIX v4.5:");
    console.log("  - Signal QUEUE per user — multiple alerts same second pe miss nahi honge");
    console.log("  - FIFO order mein signals deliver honge");
    console.log("  - Per-user unique signal IDs");
    console.log("");
    console.log("FIX v4.6 (NEW):");
    console.log("  - GET /get_windows?token=TOKEN&group=A|B endpoint added");
    console.log("  - POST /webhook now handles event:'WINDOWS_UPDATE' from Pine scripts");
    console.log("  - EA ka window poll ab actually kaam karega (pehle 404 milta tha)");
    console.log("");
    console.log("TradingView BUY alert  → sl_raw = {{low}}");
    console.log("TradingView SELL alert → sl_raw = {{high}}");
    console.log("EA calculates final SL using wickPercent + slBuffer inputs");
    console.log("");
    console.log("Token (first 25): " + SECRET_TOKEN.substring(0, 25) + "...");
    console.log(sep + "\n");
}

startServer();
