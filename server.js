// server.js — StickyCap bridge.
//
// No login, no accounts, and no shared password. The room code is the key:
// a capture can only be read by someone who knows its room code, so codes
// must be long enough not to be guessed (6–10 letters/numbers; the apps
// generate 8). On top of that the server limits how fast any one address
// can call it and how much it will hold in memory, so a stranger can't
// flood it.
//
// It does exactly one job: hold the most recent capture(s) from the Chrome
// extension until the Figma plugin comes and picks them up.
//
// Why this exists at all, instead of the extension talking straight to
// Figma: Figma's REST API cannot create or edit canvas nodes (confirmed by
// Figma staff directly) — only the Plugin API can, and it only runs
// inside Figma. So something has to sit in the middle and hand the
// capture off.
//
// Old clients still send an X-StickyCap-Secret header. It is ignored, so
// deploy this server first and update the plugin/extension afterwards.

const express = require("express");
const app = express();

// Render (and most hosts) sit behind a proxy; this makes req.ip the real
// caller instead of the proxy, which the rate limiter below depends on.
app.set("trust proxy", 1);

const PORT = process.env.PORT || 4000;

app.use((req, res, next) => {
 // Loosen CORS since the extension's background context and Figma's
 // plugin sandbox both need to reach this freely.
 res.header("Access-Control-Allow-Origin", "*");
 res.header("Access-Control-Allow-Headers", "Content-Type, X-StickyCap-Secret");
 res.header("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
 if (req.method === "OPTIONS") return res.sendStatus(200);
 next();
});

// ---------- Rate limiting (per caller address, in memory) ----------
const buckets = new Map(); // "name:ip" -> { start, count }

function rateLimit(name, max, windowMs, applies) {
 return (req, res, next) => {
   if (applies && !applies(req)) return next();
   const key = name + ":" + req.ip;
   const now = Date.now();
   let b = buckets.get(key);
   if (!b || now - b.start >= windowMs) {
     b = { start: now, count: 0 };
     buckets.set(key, b);
   }
   b.count++;
   if (b.count > max) {
     res.set("Retry-After", String(Math.ceil((b.start + windowMs - now) / 1000)));
     return res.status(429).json({ error: "rate_limited" });
   }
   next();
 };
}

// Everything: a plugin polls 12 times a minute, so 600 leaves room for a
// whole office behind one address. Uploads are the heavy part, so they get
// a much tighter limit and are checked BEFORE the body is parsed.
app.use(rateLimit("all", 600, 60 * 1000));
app.use(rateLimit("upload", 30, 60 * 1000, (req) => req.method === "POST"));

app.use(express.json({ limit: "15mb" })); // screenshots as base64 need headroom

// ---------- Room codes ----------
// 6–10 letters, numbers, "-" or "_". Short codes like "1234" are refused
// because without a shared password the code is the only protection.
const ROOM_RE = /^[A-Za-z0-9_-]{6,10}$/;

function validRoom(raw) {
 const room = String(raw || "").trim();
 if (!ROOM_RE.test(room) || room.toLowerCase() === "default") return null;
 return room;
}

function badRoom(res) {
 return res.status(400).json({
   error: "invalid_room",
   message: "Room code must be 6 to 10 letters or numbers."
 });
}

// ---------- The queue ----------
let queue = [];

// Rooms are capped so an idle/misconfigured client can't grow this forever.
const MAX_QUEUE_PER_ROOM = 200;

// Hard ceiling on everything held in memory at once (characters of base64).
// Render's free plan has 512MB in total, so stay well under it.
const MAX_TOTAL_CHARS = 200 * 1024 * 1024;

// Captures nobody picks up are dropped after this long. The queue lives in
// memory only, so a host restart (e.g. Render's free tier waking from
// sleep) also clears it — this just stops stale entries piling up between.
const CAPTURE_TTL_MS = 24 * 60 * 60 * 1000;

// A plugin counts as "watching" a room if it polled within this window.
// It polls every 5s, so this tolerates a few slow or missed polls.
const PLUGIN_ONLINE_WINDOW_MS = 20 * 1000;

// room -> timestamp of the Figma plugin's most recent poll for it.
const lastPollByRoom = new Map();

function isPluginOnline(roomId) {
 const last = lastPollByRoom.get(roomId);
 return !!last && Date.now() - last < PLUGIN_ONLINE_WINDOW_MS;
}

function queuedChars() {
 let n = 0;
 for (const c of queue) n += c.imageBase64.length;
 return n;
}

setInterval(() => {
 const cutoff = Date.now() - CAPTURE_TTL_MS;
 queue = queue.filter((c) => Date.parse(c.createdAt) >= cutoff);
 for (const [room, ts] of lastPollByRoom) {
   if (ts < cutoff) lastPollByRoom.delete(room);
 }
 const staleBefore = Date.now() - 2 * 60 * 1000;
 for (const [key, b] of buckets) {
   if (b.start < staleBefore) buckets.delete(key);
 }
}, 10 * 60 * 1000).unref();

app.get("/", (_req, res) => res.send("StickyCap bridge is running."));

// Extension → bridge
app.post("/captures", (req, res) => {
 const { imageBase64, shapes, metadata, room } = req.body || {};
 if (typeof imageBase64 !== "string" || !imageBase64) {
   return res.status(400).json({ error: "imageBase64 is required." });
 }

 const roomId = validRoom(room);
 if (!roomId) return badRoom(res);

 if (queuedChars() + imageBase64.length > MAX_TOTAL_CHARS) {
   return res.status(503).json({ error: "server_full", message: "The bridge is full right now. Try again shortly." });
 }

 const entry = {
   id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
   room: roomId,
   imageBase64,
   shapes: Array.isArray(shapes) ? shapes : [],
   metadata: metadata && typeof metadata === "object" ? metadata : {},
   createdAt: new Date().toISOString()
 };
 queue.push(entry);

 // Trim oldest entries in this room if it's grown past the cap.
 const roomEntries = queue.filter((c) => c.room === roomId);
 if (roomEntries.length > MAX_QUEUE_PER_ROOM) {
   const toDrop = roomEntries.length - MAX_QUEUE_PER_ROOM;
   const dropIds = new Set(roomEntries.slice(0, toDrop).map((c) => c.id));
   queue = queue.filter((c) => !dropIds.has(c.id));
 }

 console.log(`Received capture ${entry.id} for room "${roomId}" (${roomEntries.length} pending in room)`);
 res.status(201).json({ ok: true, id: entry.id, room: roomId, pluginOnline: isPluginOnline(roomId) });
});

// Figma plugin → bridge (polls this). Only ever returns the one room asked
// for — a missing or invalid ?room= is refused, never "give me everything."
// Each poll also marks the room as watched, which is how the extension can
// tell "bridge is up" apart from "Figma is actually open."
app.get("/captures/pending", (req, res) => {
 const roomId = validRoom(req.query.room);
 if (!roomId) return badRoom(res);
 lastPollByRoom.set(roomId, Date.now());
 res.json(queue.filter((c) => c.room === roomId));
});

// Extension → bridge: is a Figma plugin currently watching this room?
app.get("/rooms/:room/status", (req, res) => {
 const roomId = validRoom(req.params.room);
 if (!roomId) return badRoom(res);
 res.json({
   room: roomId,
   pluginOnline: isPluginOnline(roomId),
   pending: queue.filter((c) => c.room === roomId).length
 });
});

// Scoped to the room as well as the id, so a client can only clear
// captures from the room it's actually in.
app.delete("/captures/:id", (req, res) => {
 const roomId = validRoom(req.query.room);
 if (!roomId) return badRoom(res);
 const before = queue.length;
 queue = queue.filter((c) => !(c.id === req.params.id && c.room === roomId));
 res.json({ ok: true, removed: before !== queue.length });
});

// Always answer in JSON (e.g. a capture over the 15MB limit) instead of
// Express's default HTML error page.
app.use((err, _req, res, _next) => {
 const status = err.status || err.statusCode || 500;
 res.status(status).json({ error: status === 413 ? "too_large" : "server_error" });
});

app.listen(PORT, () => {
 console.log(`StickyCap bridge listening on :${PORT}`);
});

