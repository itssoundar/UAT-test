// server.js — StickyCap bridge.
//
// No login, no accounts. This is meant to be deployed to a free host
// (Render, Railway, etc. — see the README for browser-only steps) so it
// runs continuously without needing anything open on your own computer.
// It does exactly one job: hold the most recent capture(s) from the
// Chrome extension until the Figma plugin comes and picks them up. Set
// STICKYCAP_SECRET as an environment variable on your host once deployed —
// see checkSecret() below for why.
//
// Why this exists at all, instead of the extension talking straight to
// Figma: Figma's REST API cannot create or edit canvas nodes (confirmed by
// Figma staff directly) — only the Plugin API can, and it only runs
// inside Figma. So something has to sit in the middle and hand the
// capture off.

const express = require("express");
const app = express();

app.use(express.json({ limit: "15mb" })); // screenshots as base64 need headroom
app.use((req, res, next) => {
  // Loosen CORS since the extension's background context and Figma's
  // plugin sandbox both need to reach this freely.
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Content-Type, X-StickyCap-Secret");
  res.header("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

const PORT = process.env.PORT || 4000;

// Once this is hosted on the internet (rather than localhost), anyone who
// finds the URL could otherwise post fake captures or read yours. Set
// STICKYCAP_SECRET as an environment variable on your hosting provider and
// put the same value in extension/config.js and figma-plugin/code.js — a
// simple shared password, not full auth, but enough for a personal tool
// with no accounts. If left unset, the check is skipped (fine for local
// use on localhost, not recommended once deployed publicly).
const SECRET = process.env.STICKYCAP_SECRET || "";

function checkSecret(req, res, next) {
  if (!SECRET) return next(); // no secret configured — open mode
  if (req.header("x-stickycap-secret") !== SECRET) {
    return res.status(401).json({ error: "Missing or incorrect X-StickyCap-Secret header." });
  }
  next();
}

// A single in-memory queue, now tagged per "room" so multiple independent
// users (or plugin instances) sharing this one bridge don't get each
// other's captures. A room is just an opaque string both sides agree on —
// no accounts, no server-side validation of who owns what.
let queue = [];

// Rooms are capped so an idle/misconfigured client can't grow this forever.
const MAX_QUEUE_PER_ROOM = 200;

app.get("/", (_req, res) => res.send("StickyCap bridge is running."));

// Extension → bridge
app.post("/captures", checkSecret, (req, res) => {
  const { imageBase64, shapes, metadata, room } = req.body || {};
  if (!imageBase64) return res.status(400).json({ error: "imageBase64 is required." });

  const roomId = (room || "default").trim() || "default";

  const entry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    room: roomId,
    imageBase64,
    shapes: shapes || [],
    metadata: metadata || {},
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
  res.status(201).json({ ok: true, id: entry.id, room: roomId });
});

// Figma plugin → bridge (polls this). Requires ?room=xyz — without it,
// nothing matches, since "no room specified" should never silently mean
// "give me everything."
app.get("/captures/pending", checkSecret, (req, res) => {
  const roomId = (req.query.room || "default").trim() || "default";
  res.json(queue.filter((c) => c.room === roomId));
});

app.delete("/captures/:id", checkSecret, (req, res) => {
  const before = queue.length;
  queue = queue.filter((c) => c.id !== req.params.id);
  res.json({ ok: true, removed: before !== queue.length });
});

app.listen(PORT, () => {
  console.log(`StickyCap bridge listening on :${PORT}`);
});
