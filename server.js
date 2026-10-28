const express = require("express");
const rateLimit = require("express-rate-limit");
const admin = require("firebase-admin");
const crypto = require("crypto");
const path = require("path");

if (!process.env.FIREBASE_SERVICE_ACCOUNT) { console.error("Missing FIREBASE_SERVICE_ACCOUNT"); process.exit(1); }
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
const db = admin.firestore();
const stamp = () => admin.firestore.FieldValue.serverTimestamp();

const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "100kb" }));
app.use(express.static(path.join(__dirname, "public")));

// ---------- small helpers ----------
const h = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(e => { console.error(e); res.status(500).json({ error: "Something went wrong" }); });
const clean = (s, n) => String(s || "").trim().slice(0, n);
const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const same = (a, b) => { a = Buffer.from(String(a || "")); b = Buffer.from(String(b || "")); return b.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b); };
const store = slug => db.collection("stores").doc(slug);

// ---------- email (Resend, sent over HTTPS) ----------
async function sendOrderEmail(shop, o) {
  if (!process.env.RESEND_API_KEY) return;
  const to = [...new Set([process.env.ADMIN_EMAIL, shop.ownerEmail].filter(Boolean))];
  const html = `<h2>New order ${esc(o.number)}</h2><p><b>Store:</b> ${esc(shop.name)}</p>
    <p><b>Customer:</b> ${esc(o.name)}<br><b>Phone:</b> ${esc(o.phone)}<br><b>Address:</b> ${esc(o.address)}</p>
    <p>${o.lines.map(l => `${l.qty} × ${esc(l.name)} — ₹${l.price * l.qty}`).join("<br>")}</p><p><b>Total: ₹${o.total}</b></p>`;
  await Promise.allSettled(to.map(async addr => {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: "Bearer " + process.env.RESEND_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ from: process.env.FROM_EMAIL || "Orders <onboarding@resend.dev>", to: [addr], subject: `New order ${o.number} – ${shop.name}`, html }),
    });
    if (!r.ok) console.error("Email failed for", addr, await r.text());
  }));
}

// ---------- public: shop page data + placing orders ----------
app.get("/api/store/:slug", h(async (req, res) => {
  const s = await store(req.params.slug).get();
  if (!s.exists) return res.status(404).json({ error: "Store not found" });
  const ps = await store(req.params.slug).collection("products").where("active", "==", true).get();
  res.json({ name: s.data().name, products: ps.docs.map(d => ({ id: d.id, name: d.data().name, price: d.data().price, image: d.data().image })) });
}));

app.post("/api/store/:slug/orders", rateLimit({ windowMs: 10 * 60 * 1000, limit: 20 }), h(async (req, res) => {
  const ref = store(req.params.slug), s = await ref.get();
  if (!s.exists) return res.status(404).json({ error: "Store not found" });
  const b = req.body || {};
  const cust = { name: clean(b.name, 80), phone: clean(b.phone, 20), address: clean(b.address, 300) };
  if (!cust.name || !/^[0-9+\-\s]{8,15}$/.test(cust.phone) || cust.address.length < 8)
    return res.status(400).json({ error: "Please fill in your name, phone number and full address." });
  if (!Array.isArray(b.items) || !b.items.length || b.items.length > 50) return res.status(400).json({ error: "Your cart is empty." });
  const lines = []; let total = 0;
  for (const it of b.items) {
    const qty = Math.floor(Number(it.qty));
    if (!(qty >= 1 && qty <= 20)) return res.status(400).json({ error: "Invalid quantity." });
    const p = await ref.collection("products").doc(String(it.id)).get();
    if (!p.exists || !p.data().active) return res.status(400).json({ error: "An item in your cart is no longer available." });
    lines.push({ name: p.data().name, price: p.data().price, qty }); total += p.data().price * qty; // price always comes from the database
  }
  const number = "ORD-" + Date.now().toString(36).toUpperCase() + crypto.randomBytes(2).toString("hex").toUpperCase();
  const order = { number, ...cust, lines, total, status: "New" };
  await ref.collection("orders").doc(number).set({ ...order, createdAt: stamp() });
  await sendOrderEmail(s.data(), order).catch(console.error); // finish the email before replying (Vercel pauses the server after a reply)
  res.json({ number, total });
}));

// ---------- you (platform owner): create stores ----------
const owner = (req, res, next) => same(req.get("x-key"), process.env.ADMIN_PASSWORD) ? next() : res.status(401).json({ error: "Wrong password" });

app.get("/api/admin/stores", owner, h(async (req, res) => {
  const all = await db.collection("stores").get();
  res.json(all.docs.map(d => ({ slug: d.id, name: d.data().name, ownerEmail: d.data().ownerEmail, adminKey: d.data().adminKey })));
}));

app.post("/api/admin/stores", owner, h(async (req, res) => {
  const slug = clean(req.body.slug, 40).toLowerCase(), name = clean(req.body.name, 60);
  if (!/^[a-z0-9-]{3,40}$/.test(slug) || !name) return res.status(400).json({ error: "Use a name and a link word of 3+ letters, numbers or dashes." });
  if ((await store(slug).get()).exists) return res.status(400).json({ error: "That link word is taken." });
  await store(slug).set({ name, ownerEmail: clean(req.body.ownerEmail, 120), adminKey: crypto.randomBytes(12).toString("hex"), createdAt: stamp() });
  res.json({ ok: true });
}));

// ---------- store manager (store key or your password) ----------
const auth = h(async (req, res, next) => {
  const s = await store(req.params.slug).get();
  const k = req.get("x-key");
  if (!s.exists || !(same(k, s.data().adminKey) || same(k, process.env.ADMIN_PASSWORD))) return res.status(401).json({ error: "Wrong key" });
  next();
});
const m = "/api/manage/:slug";
const prod = b => ({ name: clean(b.name, 100), price: Number(b.price), image: clean(b.image, 500), active: b.active !== false });
const bad = p => !p.name || !Number.isFinite(p.price) || p.price < 0;
const col = req => store(req.params.slug).collection("products");

app.get(m + "/products", auth, h(async (req, res) => {
  const s = await col(req).orderBy("createdAt", "desc").get();
  res.json(s.docs.map(d => ({ id: d.id, name: d.data().name, price: d.data().price, image: d.data().image, active: d.data().active })));
}));
app.post(m + "/products", auth, h(async (req, res) => {
  const p = prod(req.body); if (bad(p)) return res.status(400).json({ error: "Enter a name and a price." });
  await col(req).add({ ...p, createdAt: stamp() }); res.json({ ok: true });
}));
app.put(m + "/products/:id", auth, h(async (req, res) => {
  const p = prod(req.body); if (bad(p)) return res.status(400).json({ error: "Enter a name and a price." });
  await col(req).doc(req.params.id).update(p); res.json({ ok: true });
}));
app.delete(m + "/products/:id", auth, h(async (req, res) => { await col(req).doc(req.params.id).delete(); res.json({ ok: true }); }));

app.get(m + "/orders", auth, h(async (req, res) => {
  const s = await store(req.params.slug).collection("orders").orderBy("createdAt", "desc").limit(100).get();
  res.json(s.docs.map(d => ({ ...d.data(), createdAt: d.data().createdAt ? d.data().createdAt.toDate().toISOString() : null })));
}));
app.patch(m + "/orders/:number", auth, h(async (req, res) => {
  if (!["New", "Packed", "Delivered", "Cancelled"].includes(req.body.status)) return res.status(400).json({ error: "Bad status" });
  await store(req.params.slug).collection("orders").doc(req.params.number).update({ status: req.body.status }); res.json({ ok: true });
}));

// ---------- pages ----------
app.get("/s/:slug", (req, res) => res.sendFile(path.join(__dirname, "public", "store.html")));
app.get("/admin", (req, res) => res.sendFile(path.join(__dirname, "public", "admin.html")));
app.get("/", (req, res) => res.redirect("/admin"));

module.exports = app; // Vercel uses this export
if (require.main === module) app.listen(process.env.PORT || 3000, () => console.log("Meri Dukaan is running")); // for running on your own computer
