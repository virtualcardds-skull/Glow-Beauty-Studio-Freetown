// Glow Beauty Studio: booking API (Vercel serverless function)
// Needs: a Redis database connected in Vercel (Upstash) and an ADMIN_PIN environment variable.
const crypto = require("crypto");

const URL_ = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const PIN = process.env.ADMIN_PIN || "";
const STATUSES = ["Pending", "Confirmed", "Reminder sent", "Completed", "Cancelled"];

async function redis(...cmd) {
  const r = await fetch(URL_, {
    method: "POST",
    headers: { Authorization: "Bearer " + TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify(cmd),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error);
  return j.result;
}

const same = (a, b) => {
  const x = Buffer.from(String(a || "")), y = Buffer.from(String(b || ""));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
const clean = (v, n) => String(v == null ? "" : v).trim().slice(0, n);
const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v);
const isTime = (v) => /^\d{2}:\d{2}$/.test(v);

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (!URL_ || !TOKEN) return res.status(503).json({ error: "The booking database is not connected yet." });

  const ip = String(req.headers["x-forwarded-for"] || "x").split(",")[0].trim();
  const isAdmin = !!PIN && same(req.headers["x-admin-pin"], PIN);

  try {
    // Admin-only methods: block repeated wrong PINs
    if (req.method !== "POST" && !isAdmin) {
      const k = "pin:" + ip;
      const n = await redis("INCR", k);
      if (n === 1) await redis("EXPIRE", k, 600);
      if (n > 10) return res.status(429).json({ error: "Too many attempts. Try again in 10 minutes." });
      return res.status(401).json({ error: "Wrong PIN." });
    }

    if (req.method === "GET") {
      const flat = await redis("HGETALL", "bookings");
      const vals = Array.isArray(flat) ? flat.filter((_, i) => i % 2 === 1) : Object.values(flat || {});
      const bookings = vals.map((v) => { try { return JSON.parse(v); } catch (e) { return null; } }).filter(Boolean);
      return res.status(200).json({ bookings });
    }

    if (req.method === "POST") {
      let b = req.body;
      if (typeof b === "string") { try { b = JSON.parse(b); } catch (e) { b = {}; } }
      b = b && typeof b === "object" ? b : {};
      if (b.website) return res.status(201).json({ ok: true }); // spam trap

      const name = clean(b.name, 80), phone = clean(b.phone, 30), svc = clean(b.svc, 80);
      const occ = clean(b.occ, 30) || "Other", date = clean(b.date, 10), time = clean(b.time, 5);
      const price = Number(b.price);
      if (!name || !svc || !isDate(date) || !isTime(time) || !(price > 0 && price < 1e8))
        return res.status(400).json({ error: "Please complete every field." });
      if (!isAdmin) {
        if (phone.replace(/\D/g, "").length < 7) return res.status(400).json({ error: "Please add your WhatsApp number." });
        if (date < "2026-12-01" || date > "2026-12-31") return res.status(400).json({ error: "Please choose a date in December 2026." });
        const k = "rl:" + ip;
        const n = await redis("INCR", k);
        if (n === 1) await redis("EXPIRE", k, 3600);
        if (n > 8) return res.status(429).json({ error: "Too many requests. Please try again later." });
      }
      const today = new Date().toISOString().slice(0, 10);
      const made = isAdmin && isDate(clean(b.made, 10)) ? clean(b.made, 10) : today;
      const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

      const got = await redis("SET", "slot:" + date + "|" + time, id, "NX"); // one client per slot
      if (got !== "OK") return res.status(409).json({ error: "That time is already booked. Please choose another time." });

      const booking = { id, name, phone, svc, price, occ, date, time, made, status: "Pending" };
      await redis("HSET", "bookings", id, JSON.stringify(booking));
      return res.status(201).json({ ok: true, id });
    }

    if (req.method === "PATCH") {
      let b = req.body;
      if (typeof b === "string") { try { b = JSON.parse(b); } catch (e) { b = {}; } }
      const id = clean(b && b.id, 40), status = clean(b && b.status, 30);
      if (!id || !STATUSES.includes(status)) return res.status(400).json({ error: "Bad request." });
      const cur = await redis("HGET", "bookings", id);
      if (!cur) return res.status(404).json({ error: "Booking not found." });
      const bk = JSON.parse(cur), slot = "slot:" + bk.date + "|" + bk.time;
      if (status === "Cancelled" && bk.status !== "Cancelled") await redis("DEL", slot);
      if (status !== "Cancelled" && bk.status === "Cancelled") {
        const got = await redis("SET", slot, id, "NX");
        if (got !== "OK") return res.status(409).json({ error: "Another client has taken that time." });
      }
      bk.status = status;
      await redis("HSET", "bookings", id, JSON.stringify(bk));
      return res.status(200).json({ ok: true });
    }

    if (req.method === "DELETE") {
      const id = clean(req.query && req.query.id, 40);
      if (!id) return res.status(400).json({ error: "Bad request." });
      const cur = await redis("HGET", "bookings", id);
      if (cur) {
        const bk = JSON.parse(cur);
        if (bk.status !== "Cancelled") await redis("DEL", "slot:" + bk.date + "|" + bk.time);
        await redis("HDEL", "bookings", id);
      }
      return res.status(200).json({ ok: true });
    }

    res.setHeader("Allow", "GET, POST, PATCH, DELETE");
    return res.status(405).json({ error: "Method not allowed." });
  } catch (e) {
    return res.status(500).json({ error: "Server error. Please try again." });
  }
};
