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

// ---------- helpers ----------
class Bad extends Error {} // a mistake the person can fix; shown to them as-is
const h = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(e =>
  e instanceof Bad ? res.status(400).json({ error: e.message }) : (console.error(e), res.status(500).json({ error: "Something went wrong" })));
const clean = (s, n) => String(s || "").trim().slice(0, n);
const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const same = (a, b) => { a = Buffer.from(String(a || "")); b = Buffer.from(String(b || "")); return b.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b); };
const store = slug => db.collection("stores").doc(slug);
const STATUSES = ["New", "Packed", "In transit", "Delivered", "Cancelled"];
const METHODS = ["UPI", "Cash", "Card", "Bank", "COD"];

// ---------- email (Resend) ----------
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
  res.json({ name: s.data().name, products: ps.docs.map(d => { const x = d.data(); return { id: d.id, name: x.name, price: x.price, image: x.image, description: x.description || "", qty: x.qty == null ? null : x.qty }; }) });
}));

app.post("/api/store/:slug/orders", rateLimit({ windowMs: 10 * 60 * 1000, limit: 20 }), h(async (req, res) => {
  const ref = store(req.params.slug), s = await ref.get();
  if (!s.exists) return res.status(404).json({ error: "Store not found" });
  const b = req.body || {};
  const cust = { name: clean(b.name, 80), phone: clean(b.phone, 20), address: clean(b.address, 300) };
  if (!cust.name || !/^[0-9+\-\s]{8,15}$/.test(cust.phone) || cust.address.length < 8) throw new Bad("Please fill in your name, phone number and full address.");
  if (!Array.isArray(b.items) || !b.items.length || b.items.length > 50) throw new Bad("Your cart is empty.");
  const want = {};
  for (const it of b.items) {
    const q = Math.floor(Number(it.qty)), id = String(it.id);
    if (!(q >= 1 && q <= 20) || !/^[A-Za-z0-9]{1,40}$/.test(id)) throw new Bad("Invalid item in your cart.");
    want[id] = (want[id] || 0) + q;
  }
  const number = "ORD-" + Date.now().toString(36).toUpperCase() + crypto.randomBytes(2).toString("hex").toUpperCase();
  const order = await db.runTransaction(async t => {
    const ids = Object.keys(want);
    const snaps = await Promise.all(ids.map(id => t.get(ref.collection("products").doc(id))));
    const lines = []; let total = 0, cost = 0;
    snaps.forEach((p, i) => {
      if (!p.exists || !p.data().active) throw new Bad("An item in your cart is no longer available.");
      const d = p.data(), q = want[ids[i]];
      if (d.qty != null && d.qty < q) throw new Bad(d.qty > 0 ? `Only ${d.qty} left of ${d.name}.` : `${d.name} is out of stock.`);
      lines.push({ id: p.id, name: d.name, price: d.price, cost: d.cost || 0, qty: q });
      total += d.price * q; cost += (d.cost || 0) * q; // prices always come from the database
    });
    snaps.forEach((p, i) => { if (p.data().qty != null) t.update(p.ref, { qty: p.data().qty - want[ids[i]] }); });
    const o = { number, ...cust, lines, total, cost, status: "New", paid: 0, payments: [] };
    t.set(ref.collection("orders").doc(number), { ...o, createdAt: stamp() });
    return o;
  });
  await sendOrderEmail(s.data(), order).catch(console.error); // finish before replying (Vercel pauses after a reply)
  res.json({ number, total: order.total });
}));

// ---------- you (platform owner): create stores ----------
const owner = (req, res, next) => same(req.get("x-key"), process.env.ADMIN_PASSWORD) ? next() : res.status(401).json({ error: "Wrong password" });

app.get("/api/admin/stores", owner, h(async (req, res) => {
  const all = await db.collection("stores").get();
  res.json(all.docs.map(d => ({ slug: d.id, name: d.data().name, ownerEmail: d.data().ownerEmail, adminKey: d.data().adminKey })));
}));

app.post("/api/admin/stores", owner, h(async (req, res) => {
  const slug = clean(req.body.slug, 40).toLowerCase(), name = clean(req.body.name, 60);
  if (!/^[a-z0-9-]{3,40}$/.test(slug) || !name) throw new Bad("Use a name and a link word of 3+ letters, numbers or dashes.");
  if ((await store(slug).get()).exists) throw new Bad("That link word is taken.");
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
const sub = (req, name) => store(req.params.slug).collection(name);
const num = (v, d) => (v === "" || v == null ? d : Number(v));
const prod = b => ({
  name: clean(b.name, 100), description: clean(b.description, 300), price: Number(b.price), cost: num(b.cost, 0),
  qty: num(b.qty, 0), lowAt: num(b.lowAt, 5), expiry: /^\d{4}-\d{2}-\d{2}$/.test(b.expiry || "") ? b.expiry : "",
  supplier: clean(b.supplier, 80), image: clean(b.image, 500), active: b.active !== false,
});
const bad = p => !p.name || ![p.price, p.cost, p.qty, p.lowAt].every(Number.isFinite) || p.price < 0 || p.cost < 0 || p.qty < 0 || !Number.isInteger(p.qty);
const badMsg = "Enter a name, a selling price and a whole-number quantity.";

app.get(m + "/products", auth, h(async (req, res) => {
  const s = await sub(req, "products").orderBy("createdAt", "desc").get();
  res.json(s.docs.map(d => ({ id: d.id, ...d.data(), createdAt: undefined })));
}));
app.post(m + "/products", auth, h(async (req, res) => {
  const p = prod(req.body); if (bad(p)) throw new Bad(badMsg);
  await sub(req, "products").add({ ...p, createdAt: stamp() }); res.json({ ok: true });
}));
app.put(m + "/products/:id", auth, h(async (req, res) => {
  const p = prod(req.body); if (bad(p)) throw new Bad(badMsg);
  await sub(req, "products").doc(req.params.id).update(p); res.json({ ok: true });
}));
app.delete(m + "/products/:id", auth, h(async (req, res) => { await sub(req, "products").doc(req.params.id).delete(); res.json({ ok: true }); }));

app.get(m + "/suppliers", auth, h(async (req, res) => {
  const s = await sub(req, "suppliers").orderBy("createdAt", "desc").get();
  res.json(s.docs.map(d => ({ id: d.id, name: d.data().name, phone: d.data().phone, note: d.data().note })));
}));
app.post(m + "/suppliers", auth, h(async (req, res) => {
  const name = clean(req.body.name, 80); if (!name) throw new Bad("Enter the supplier’s name.");
  await sub(req, "suppliers").add({ name, phone: clean(req.body.phone, 20), note: clean(req.body.note, 200), createdAt: stamp() }); res.json({ ok: true });
}));
app.delete(m + "/suppliers/:id", auth, h(async (req, res) => { await sub(req, "suppliers").doc(req.params.id).delete(); res.json({ ok: true }); }));

app.get(m + "/orders", auth, h(async (req, res) => {
  const s = await sub(req, "orders").orderBy("createdAt", "desc").limit(500).get();
  res.json(s.docs.map(d => { const x = d.data(); return { ...x, createdAt: x.createdAt ? x.createdAt.toDate().toISOString() : null, paid: x.paid || 0, payments: x.payments || [] }; }));
}));
app.patch(m + "/orders/:number", auth, h(async (req, res) => {
  const st = req.body.status;
  if (!STATUSES.includes(st)) throw new Bad("Bad status");
  const oref = sub(req, "orders").doc(req.params.number);
  await db.runTransaction(async t => {
    const o = await t.get(oref);
    if (!o.exists) throw new Bad("Order not found");
    const d = o.data();
    if (d.status === "Cancelled") throw new Bad("A cancelled order can’t be changed.");
    if (st === "Cancelled") { // put the items back into stock
      const ls = (d.lines || []).filter(l => l.id);
      const ps = await Promise.all(ls.map(l => t.get(sub(req, "products").doc(l.id))));
      ps.forEach((p, i) => { if (p.exists && p.data().qty != null) t.update(p.ref, { qty: p.data().qty + ls[i].qty }); });
    }
    t.update(oref, { status: st });
  });
  res.json({ ok: true });
}));
app.post(m + "/orders/:number/payments", auth, h(async (req, res) => {
  const amount = Number(req.body.amount), method = req.body.method;
  if (!(amount > 0) || !METHODS.includes(method)) throw new Bad("Enter an amount and a payment method.");
  const oref = sub(req, "orders").doc(req.params.number), o = await oref.get();
  if (!o.exists) throw new Bad("Order not found");
  const d = o.data(), left = d.total - (d.paid || 0);
  if (amount > left + 0.01) throw new Bad("That is more than the amount still due (₹" + left + ").");
  await oref.update({ paid: (d.paid || 0) + amount, payments: admin.firestore.FieldValue.arrayUnion({ amount, method, at: new Date().toISOString() }) });
  res.json({ ok: true });
}));

// ---------- pages ----------
const page = f => (req, res) => res.sendFile(path.join(__dirname, "public", f));
app.get("/s/:slug", page("store.html"));
app.get("/admin", page("admin.html"));
app.get("/manage", page("manage.html"));
app.get("/", (req, res) => res.redirect("/admin"));

module.exports = app; // Vercel uses this export
if (require.main === module) app.listen(process.env.PORT || 3000, () => console.log("Meri Dukaan is running")); // for running on your own computer
