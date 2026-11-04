const express = require("express");
const rateLimit = require("express-rate-limit");
const admin = require("firebase-admin");
const crypto = require("crypto");
const path = require("path");

if (!process.env.FIREBASE_SERVICE_ACCOUNT) { console.error("Missing FIREBASE_SERVICE_ACCOUNT"); process.exit(1); }
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
const db = admin.firestore();
const FV = admin.firestore.FieldValue;
const stamp = () => FV.serverTimestamp();

const app = express();
app.set("trust proxy", 1);
const small = express.json({ limit: "100kb" }), big = express.json({ limit: "1mb" }); // photos are bigger than normal requests
app.use((req, res, next) => (req.method === "POST" && /\/(photos?|products-import)$/.test(req.path) ? big : small)(req, res, next));
app.use(express.static(path.join(__dirname, "public")));

// ---------- helpers ----------
class Bad extends Error {} // a mistake the person can fix; shown to them as-is
const h = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(e =>
  e instanceof Bad ? res.status(400).json({ error: e.message }) : (console.error(e), res.status(500).json({ error: "Something went wrong" })));
const clean = (s, n) => String(s || "").trim().slice(0, n);
const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const same = (a, b) => { a = Buffer.from(String(a || "")); b = Buffer.from(String(b || "")); return b.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b); };
const lname = d => { const o = [d.o1, d.o2].filter(Boolean); return o.length && !o.every(v => d.name.toLowerCase().includes(String(v).toLowerCase())) ? `${d.name} (${o.join(", ")})` : d.name; };
const prefixOf = name => { const w = String(name || "").replace(/[^A-Za-z0-9 ]/g, "").trim().split(/\s+/).filter(Boolean); const p = (w.length > 1 ? w.slice(0, 3).map(x => x[0]).join("") : (w[0] || "").slice(0, 2)).toUpperCase(); return p.length >= 2 ? p : "OR"; };
const RATES = [0, 5, 12, 18, 28], PAY_METHODS = ["UPI", "Cash", "Card", "Bank"]; // GST rates and the ways a counter sale can be paid
const stockEntry = (req, p, delta, after, reason, note) => ({ product: p.id, name: p.name || "", sku: p.sku || "", delta, after, reason, note: note || "", by: (req.who && req.who.name) || "Customer", at: stamp() });
const istToday = () => new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10); // today's date in India, so an item stops selling at Indian midnight
const isExpired = d => !!d.expiry && d.expiry < istToday(); // the expiry date itself is still the last day it can be sold
const num = (v, d) => (v === "" || v == null ? d : Number(v));
const store = slug => db.collection("stores").doc(slug);
const sub = (req, name) => store(req.params.slug).collection(name);
const STATUSES = ["New", "Packed", "In transit", "Delivered", "Cancelled"];
const METHODS = ["UPI", "Cash", "Card", "Bank", "COD"];
const ALL = { add: true, stock: true, cost: true, tags: true, orders: true }; // things a staff member can be allowed to do
const cleanPerms = b => ({
  ...Object.fromEntries(Object.keys(ALL).map(k => [k, !!(b && b[k])])),
  orderView: b && Array.isArray(b.orderView) ? STATUSES.filter(s => b.orderView.includes(s)) : ["New", "Packed"], // by default staff only see new and to-dispatch orders
});

// ---------- logins: staff get a signed token, the owner uses the store key ----------
const secret = () => process.env.SESSION_SECRET || process.env.ADMIN_PASSWORD || "";
const mac = b => crypto.createHmac("sha256", secret()).update(b).digest("base64url");
const sign = p => { const b = Buffer.from(JSON.stringify(p)).toString("base64url"); return b + "." + mac(b); };
const verify = t => {
  const [b, sig] = String(t || "").split(".");
  if (!b || !sig || !secret() || !same(sig, mac(b))) return null;
  try { const p = JSON.parse(Buffer.from(b, "base64url").toString()); return p.exp > Date.now() ? p : null; } catch (e) { return null; }
};
const invSig = (slug, number) => mac("invoice:" + slug + ":" + number).slice(0, 24); // makes each invoice link impossible to guess
const hash = (pw, salt = crypto.randomBytes(16).toString("hex")) => salt + ":" + crypto.scryptSync(pw, salt, 32).toString("hex");
const check = (pw, stored) => same(hash(pw, String(stored).split(":")[0]), stored);

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

// ---------- public: shop page data, photos, placing orders ----------
const when = d => { const c = d.data().createdAt; return c ? c.toDate().getTime() : 0; };
app.get("/api/store/:slug", h(async (req, res) => {
  const s = await store(req.params.slug).get();
  if (!s.exists) return res.status(404).json({ error: "Store not found" });
  const [ps, tg] = await Promise.all([sub(req, "products").where("active", "==", true).get(), sub(req, "tags").orderBy("pos").get()]);
  res.json({
    name: s.data().name, tags: tg.docs.map(d => d.data().name),
    products: ps.docs.filter(d => !isExpired(d.data())).sort((a, b) => when(a) - when(b)).map(d => {
      const x = d.data(), photos = (x.photos || []).map(i => `/api/photo/${req.params.slug}/${i}`);
      return { id: d.id, name: x.name, price: x.price, description: x.description || "", qty: x.qty == null ? null : x.qty, tags: x.tags || [], group: x.mergeUnder || d.id, kind: x.kind || "general", o1: x.o1 || "", o2: x.o2 || "", photos: photos.length ? photos : (x.image ? [x.image] : []) };
    }),
  });
}));

app.get("/api/photo/:slug/:id", h(async (req, res) => {
  const d = await sub(req, "photos").doc(req.params.id).get();
  if (!d.exists) return res.status(404).end();
  res.set({ "Content-Type": d.data().type, "Cache-Control": "public, max-age=31536000, immutable" });
  res.send(d.data().data);
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
  const order = await db.runTransaction(async t => {
    const ids = Object.keys(want);
    const snaps = await Promise.all(ids.map(id => t.get(ref.collection("products").doc(id))));
    const st = await t.get(ref), seq = (st.data().orderSeq || 1000) + 1, number = prefixOf(st.data().name) + "-" + seq;
    const lines = []; let total = 0, cost = 0;
    snaps.forEach((p, i) => {
      if (!p.exists || !p.data().active) throw new Bad("An item in your cart is no longer available.");
      const d = p.data(), q = want[ids[i]];
      if (isExpired(d)) throw new Bad(`${lname(d)} is no longer available. Please remove it from your cart.`);
      if (d.qty != null && d.qty < q) throw new Bad(d.qty > 0 ? `Only ${d.qty} left of ${d.name}.` : `${d.name} is out of stock.`);
      lines.push({ id: p.id, name: lname(d), price: d.price, cost: d.cost || 0, qty: q, photo: (d.photos || [])[0] || "" });
      total += d.price * q; cost += (d.cost || 0) * q; // prices always come from the database
    });
    snaps.forEach((p, i) => { if (p.data().qty != null) { const q = want[ids[i]], after = p.data().qty - q; t.update(p.ref, { qty: after }); t.set(sub(req, "stockLog").doc(), stockEntry(req, { id: p.id, name: p.data().name, sku: p.data().sku }, -q, after, "Order " + number)); } });
    const o = { number, ...cust, lines, total, cost, status: "New", paid: 0, payments: [], seen: false, channel: "online" }; // channel "store" is for orders you enter yourself
    t.update(ref, { orderSeq: seq });
    t.set(ref.collection("orders").doc(number), { ...o, createdAt: stamp() });
    return o;
  });
  await sendOrderEmail(s.data(), order).catch(console.error); // finish before replying (Vercel pauses after a reply)
  res.json({ number: order.number, total: order.total });
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

// ---------- store manager: owner (store key) or staff (token) ----------
const m = "/api/manage/:slug";
app.post(m + "/login", rateLimit({ windowMs: 10 * 60 * 1000, limit: 30 }), h(async (req, res) => {
  const wrong = new Bad("Wrong username or password.");
  if (!(await store(req.params.slug).get()).exists) throw wrong;
  const u = await sub(req, "users").doc(clean(req.body.user, 30).toLowerCase()).get();
  if (!u.exists || !u.data().active || !check(String(req.body.password || ""), u.data().hash)) throw wrong;
  res.json({ token: sign({ slug: req.params.slug, uid: u.id, exp: Date.now() + 30 * 864e5 }) });
}));

const auth = h(async (req, res, next) => {
  const s = await store(req.params.slug).get();
  if (!s.exists) return res.status(401).json({ error: "Wrong key" });
  const k = req.get("x-key");
  if (k && (same(k, s.data().adminKey) || same(k, process.env.ADMIN_PASSWORD))) { req.who = { role: "owner", name: (s.data().profile || {}).name || "Owner", perms: { ...ALL, orderView: STATUSES }, viaStoreKey: same(k, s.data().adminKey) }; return next(); }
  const p = verify(req.get("x-token"));
  if (p && p.slug === req.params.slug) {
    const u = await sub(req, "users").doc(p.uid).get();
    if (u.exists && u.data().active) { req.who = { role: "staff", name: u.data().name, perms: cleanPerms(u.data().perms), uid: u.id, profile: u.data().profile || {}, email: "" }; return next(); }
  }
  res.status(401).json({ error: "Please log in again." });
});
const can = (req, p) => req.who.role === "owner" || !!req.who.perms[p];
const need = (...ps) => (req, res, next) => ps.some(p => can(req, p)) ? next() : res.status(403).json({ error: "You don’t have permission to do that." });
const ownerOnly = (req, res, next) => req.who.role === "owner" ? next() : res.status(403).json({ error: "Only the owner can do that." });

const photoUrl = (req, id) => id ? `/api/photo/${req.params.slug}/${id}` : "";
app.get(m + "/me", auth, h(async (req, res) => {
  const out = { role: req.who.role, name: req.who.name, perms: req.who.perms };
  if (req.who.role === "owner") {
    const d = (await store(req.params.slug).get()).data(), p = d.profile || {};
    Object.assign(out, { profile: { name: p.name || "", email: d.ownerEmail || "", phone: p.phone || "", photo: photoUrl(req, p.photo) }, business: { name: d.name, address: (d.business || {}).address || "", gstin: (d.business || {}).gstin || "", phone: (d.business || {}).phone || "", gstDefault: (d.business || {}).gstDefault || 0 } });
  } else { const p = req.who.profile; Object.assign(out, { profile: { name: req.who.name, email: p.email || "", phone: p.phone || "", photo: photoUrl(req, p.photo) } }); }
  res.json(out);
}));

// ----- account: your own name, email, phone and photo; password or store key -----
app.put(m + "/account", auth, h(async (req, res) => {
  const name = clean(req.body.name, 60), email = clean(req.body.email, 120), phone = clean(req.body.phone, 20);
  if (!name) throw new Bad("Enter your name.");
  if (email && !/^\S+@\S+\.\S+$/.test(email)) throw new Bad("That email doesn’t look right.");
  if (phone && !/^[0-9+\-\s]{8,15}$/.test(phone)) throw new Bad("Enter a valid phone number.");
  if (req.who.role === "owner") { const ref = store(req.params.slug), d = (await ref.get()).data(); await ref.update({ profile: { ...(d.profile || {}), name, phone }, ownerEmail: email }); }
  else { const ref = sub(req, "users").doc(req.who.uid), d = (await ref.get()).data(); await ref.update({ name, profile: { ...(d.profile || {}), email, phone } }); }
  res.json({ ok: true });
}));
app.post(m + "/account/photo", auth, h(async (req, res) => {
  const mt = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(req.body.data || ""));
  if (!mt) throw new Bad("Please choose a photo.");
  const buf = Buffer.from(mt[2], "base64"); if (buf.length > 300 * 1024) throw new Bad("That photo is too large.");
  const id = crypto.randomBytes(8).toString("hex"), owner = req.who.role === "owner";
  const ref = owner ? store(req.params.slug) : sub(req, "users").doc(req.who.uid), d = (await ref.get()).data(), old = (d.profile || {}).photo;
  await sub(req, "photos").doc(id).set({ type: mt[1], data: buf, createdAt: stamp() });
  await ref.update({ profile: { ...(d.profile || {}), photo: id } });
  if (old) await sub(req, "photos").doc(old).delete();
  res.json({ photo: photoUrl(req, id) });
}));
app.post(m + "/account/password", auth, h(async (req, res) => {
  if (req.who.role === "owner") throw new Bad("Owners use “Make a new store key” instead.");
  const ref = sub(req, "users").doc(req.who.uid), d = (await ref.get()).data(), next = String(req.body.next || "");
  if (!check(String(req.body.current || ""), d.hash)) throw new Bad("Your current password is not right.");
  if (next.length < 6) throw new Bad("The new password must be at least 6 characters.");
  await ref.update({ hash: hash(next) }); res.json({ ok: true });
}));
app.post(m + "/account/new-key", auth, ownerOnly, h(async (req, res) => {
  const key = crypto.randomBytes(12).toString("hex"); await store(req.params.slug).update({ adminKey: key });
  res.json({ key, viaStoreKey: !!req.who.viaStoreKey }); // the old store key stops working straight away
}));
app.put(m + "/business", auth, ownerOnly, h(async (req, res) => {
  const b = req.body, name = clean(b.name, 60), gstDefault = Number(b.gstDefault || 0), gstin = clean(b.gstin, 15).toUpperCase();
  if (!name) throw new Bad("Enter your business name.");
  if (!RATES.includes(gstDefault)) throw new Bad("Pick a GST rate from the list.");
  if (gstin && !/^[0-9A-Z]{15}$/.test(gstin)) throw new Bad("A GSTIN has 15 letters and numbers.");
  await store(req.params.slug).update({ name, business: { address: clean(b.address, 200), gstin, phone: clean(b.phone, 20), gstDefault } });
  res.json({ ok: true });
}));

// ----- New invoice: the owner bills a counter sale or a phone order -----
const draftOf = b => ({
  name: clean(b.name, 80), phone: clean(b.phone, 20), mode: b.mode === "online" ? "online" : "store", address: clean(b.address, 300),
  lines: (Array.isArray(b.lines) ? b.lines : []).slice(0, 50).map(l => ({ id: String(l.id || "").slice(0, 40), qty: Math.floor(Number(l.qty) || 0) })),
  discount: Math.max(0, Number(b.discount) || 0), gst: RATES.includes(Number(b.gst)) ? Number(b.gst) : 0, notes: clean(b.notes, 200),
  pay: { status: ["paid", "partial", "unpaid"].includes((b.pay || {}).status) ? b.pay.status : "unpaid", method: PAY_METHODS.includes((b.pay || {}).method) ? b.pay.method : "UPI", amount: Math.max(0, Number((b.pay || {}).amount) || 0) },
});
app.post(m + "/invoices", auth, ownerOnly, h(async (req, res) => {
  const b = draftOf(req.body), ref = store(req.params.slug);
  if (b.phone && !/^[0-9+\-\s]{8,15}$/.test(b.phone)) throw new Bad("Enter a valid phone number.");
  if (b.mode === "online" && (!b.phone || b.address.length < 8)) throw new Bad("For an online order, add the phone number and full delivery address.");
  const want = new Map();
  for (const l of b.lines) { if (!/^[A-Za-z0-9]{1,40}$/.test(l.id) || !(l.qty >= 1 && l.qty <= 999)) throw new Bad("Check the products and quantities."); want.set(l.id, (want.get(l.id) || 0) + l.qty); }
  if (!want.size) throw new Bad("Add at least one product.");
  const order = await db.runTransaction(async t => {
    const ids = [...want.keys()], snaps = await Promise.all(ids.map(id => t.get(ref.collection("products").doc(id)))), st = await t.get(ref);
    const lines = []; let subtotal = 0, cost = 0;
    snaps.forEach((p, i) => {
      if (!p.exists) throw new Bad("A product on this invoice no longer exists.");
      const d = p.data(), q = want.get(ids[i]);
      if (d.qty != null && d.qty < q) throw new Bad(d.qty > 0 ? `Only ${d.qty} left of ${d.name}.` : `${d.name} is out of stock.`);
      lines.push({ id: p.id, name: lname(d), price: d.price, cost: d.cost || 0, qty: q, photo: (d.photos || [])[0] || "" });
      subtotal += d.price * q; cost += (d.cost || 0) * q;
    });
    if (b.discount > subtotal) throw new Bad("The discount can’t be more than the subtotal.");
    const taxable = subtotal - b.discount, gst = Math.round(taxable * b.gst / 100), total = taxable + gst;
    let paid = 0, payments = [];
    if (b.pay.status === "paid") paid = total; else if (b.pay.status === "partial") { if (!(b.pay.amount > 0 && b.pay.amount < total)) throw new Bad("For a part payment, enter an amount below the total."); paid = b.pay.amount; }
    if (paid > 0) payments = [{ amount: paid, method: b.pay.method, at: new Date().toISOString() }];
    const seq = (st.data().orderSeq || 1000) + 1, number = prefixOf(st.data().name) + "-" + seq;
    snaps.forEach((p, i) => { if (p.data().qty != null) { const q = want.get(ids[i]), after = p.data().qty - q; t.update(p.ref, { qty: after }); t.set(sub(req, "stockLog").doc(), stockEntry(req, { id: p.id, name: p.data().name, sku: p.data().sku }, -q, after, "Invoice " + number)); } });
    t.update(ref, { orderSeq: seq });
    const o = { number, name: b.name || (b.mode === "store" ? "Walk-in customer" : ""), phone: b.phone, address: b.mode === "online" ? b.address : "", lines, subtotal, discount: b.discount, gstRate: b.gst, gst, total, cost, notes: b.notes,
      status: b.mode === "store" ? "Delivered" : "Packed", paid, payments, seen: true, channel: b.mode }; // a counter sale is already handed over; an online one is ready to dispatch
    t.set(ref.collection("orders").doc(number), { ...o, createdAt: stamp() });
    return o;
  });
  res.json({ number: order.number, total: order.total, invKey: invSig(req.params.slug, order.number) });
}));
// ----- edit an invoice (owner): customer, products, discount, GST, notes. Stock follows the change. Payments are changed with Record payment. -----
app.put(m + "/invoices/:number", auth, ownerOnly, h(async (req, res) => {
  const b = draftOf(req.body), ref = sub(req, "orders").doc(req.params.number);
  if (b.phone && !/^[0-9+\-\s]{8,15}$/.test(b.phone)) throw new Bad("Enter a valid phone number.");
  if (b.mode === "online" && (!b.phone || b.address.length < 8)) throw new Bad("For an online order, add the phone number and full delivery address.");
  const want = new Map();
  for (const l of b.lines) { if (!/^[A-Za-z0-9]{1,40}$/.test(l.id) || !(l.qty >= 1 && l.qty <= 999)) throw new Bad("Check the products and quantities."); want.set(l.id, (want.get(l.id) || 0) + l.qty); }
  if (!want.size) throw new Bad("Keep at least one product on the invoice.");
  const out = await db.runTransaction(async t => {
    const o = await t.get(ref); if (!o.exists) throw new Bad("Invoice not found.");
    const d = o.data(); if (d.status === "Cancelled") throw new Bad("A cancelled invoice can’t be edited.");
    const prior = new Map((d.lines || []).filter(l => l.id).map(l => [l.id, l])), ids = [...new Set([...prior.keys(), ...want.keys()])];
    const need2 = ids.filter(id => !prior.has(id) || (prior.get(id).qty || 0) !== (want.get(id) || 0));
    const snaps = new Map(await Promise.all(need2.map(async id => [id, await t.get(sub(req, "products").doc(id))])));
    const lines = []; let subtotal = 0, cost = 0;
    for (const id of want.keys()) {
      const q = want.get(id), pl = prior.get(id), p = snaps.get(id);
      if (!pl && (!p || !p.exists)) throw new Bad("A product on this invoice no longer exists.");
      const line = pl ? { ...pl, qty: q } : { id, name: lname(p.data()), price: p.data().price, cost: p.data().cost || 0, qty: q, photo: (p.data().photos || [])[0] || "" };
      if (!(line.price >= 0)) throw new Bad("A product has no selling price.");
      lines.push(line); subtotal += line.price * q; cost += (line.cost || 0) * q;
    }
    if (b.discount > subtotal) throw new Bad("The discount can’t be more than the subtotal.");
    const taxable = subtotal - b.discount, gst = Math.round(taxable * b.gst / 100), total = taxable + gst;
    if (total < (d.paid || 0)) throw new Bad(`₹${d.paid} is already paid, which is more than the new total of ₹${total}. Set the payment to Unpaid first, then edit.`);
    for (const id of need2) { // stock moves by the difference
      const p = snaps.get(id), diff = (prior.has(id) ? prior.get(id).qty || 0 : 0) - (want.get(id) || 0);
      if (!p || !p.exists || p.data().qty == null || !diff) continue;
      if (diff < 0 && p.data().qty < -diff) throw new Bad(`Only ${p.data().qty} more of ${p.data().name} in stock.`);
      const after = p.data().qty + diff; t.update(p.ref, { qty: after });
      t.set(sub(req, "stockLog").doc(), stockEntry(req, { id: p.id, name: p.data().name, sku: p.data().sku }, diff, after, "Invoice " + req.params.number + " edited"));
    }
    t.update(ref, { name: b.name || (b.mode === "store" ? "Walk-in customer" : d.name || ""), phone: b.phone, address: b.mode === "online" ? b.address : "", channel: b.mode, lines, subtotal, discount: b.discount, gstRate: b.gst, gst, total, cost, notes: b.notes, editedAt: stamp(), seen: true });
    return { number: req.params.number, total };
  });
  res.json({ number: out.number, total: out.total, invKey: invSig(req.params.slug, out.number) });
}));
// a cancelled order that was already paid: record that the money went back
app.post(m + "/orders/:number/refund", auth, ownerOnly, h(async (req, res) => {
  const ref = sub(req, "orders").doc(req.params.number), o = await ref.get();
  if (!o.exists) throw new Bad("Order not found.");
  const d = o.data(); if (d.status !== "Cancelled") throw new Bad("Only a cancelled order can be refunded.");
  const left = (d.paid || 0) - (d.refunded || 0); if (!(left > 0)) throw new Bad("Nothing left to refund.");
  const method = METHODS.includes(req.body.method) ? req.body.method : "Cash";
  await ref.update({ refunded: (d.paid || 0), refundedAt: stamp(), refundMethod: method }); res.json({ ok: true });
}));

app.get(m + "/drafts", auth, ownerOnly, h(async (req, res) => {
  const s = await sub(req, "drafts").orderBy("savedAt", "desc").get();
  res.json(s.docs.map(d => ({ id: d.id, ...d.data().data, savedAt: d.data().savedAt ? d.data().savedAt.toDate().toISOString() : null })));
}));
app.post(m + "/drafts", auth, ownerOnly, h(async (req, res) => {
  const ref = req.body.id && /^[A-Za-z0-9]{1,40}$/.test(String(req.body.id)) ? sub(req, "drafts").doc(String(req.body.id)) : sub(req, "drafts").doc();
  await ref.set({ data: draftOf(req.body), savedAt: stamp() }); res.json({ id: ref.id });
}));
app.delete(m + "/drafts/:id", auth, ownerOnly, h(async (req, res) => { await sub(req, "drafts").doc(req.params.id).delete(); res.json({ ok: true }); }));

// ----- products: each field is only changed if this person is allowed to change it -----
async function fields(req, b) {
  const u = {};
  if (can(req, "add")) {
    if (b.name !== undefined) { u.name = clean(b.name, 100); if (!u.name) throw new Bad("Enter a product name."); }
    if (b.description !== undefined) u.description = clean(b.description, 300);
    if (b.supplier !== undefined) u.supplier = clean(b.supplier, 80);
    if (b.sku !== undefined) u.sku = clean(b.sku, 24).toUpperCase();
    if (b.mergeUnder !== undefined) u.mergeUnder = clean(b.mergeUnder, 40); // checked in checkMerge()
    if (b.kind !== undefined) u.kind = b.kind === "food" ? "food" : "general"; // colour+size, or flavour+weight
    if (b.o1 !== undefined) u.o1 = clean(b.o1, 40); // colour or flavour
    if (b.o2 !== undefined) u.o2 = clean(b.o2, 40); // size or weight
  }
  if (can(req, "stock")) {
    if (b.qty !== undefined && b.qty !== "") { const q = Number(b.qty); if (!Number.isInteger(q) || q < 0) throw new Bad("Quantity must be a whole number."); u.qty = q; }
    if (b.lowAt !== undefined && b.lowAt !== "") { const l = Number(b.lowAt); if (!(l >= 0)) throw new Bad("Enter a valid low-stock number."); u.lowAt = l; }
    if (b.expiry !== undefined) u.expiry = /^\d{4}-\d{2}-\d{2}$/.test(b.expiry) ? b.expiry : "";
  }
  if (can(req, "cost") && b.cost !== undefined && b.cost !== "") { const c = Number(b.cost); if (!(c >= 0)) throw new Bad("Enter a valid purchase price."); u.cost = c; }
  if (can(req, "tags") && Array.isArray(b.tags)) {
    const known = (await sub(req, "tags").get()).docs.map(d => d.data().name);
    u.tags = [...new Set(b.tags.map(t => clean(t, 30)).filter(t => known.includes(t)))];
  }
  if (req.who.role === "owner") { // only the owner sets the selling price and decides what is live
    if (b.price !== undefined && b.price !== "") { const p = Number(b.price); if (!Number.isFinite(p) || p < 0) throw new Bad("Enter a valid selling price."); u.price = p; }
    if (b.active !== undefined) u.active = !!b.active;
  }
  return u;
}
// "Merge under": a product can sit under one main product. The main one can't itself be merged under another.
async function checkMerge(req, selfId, target) {
  if (!target) return;
  if (!/^[A-Za-z0-9]{1,40}$/.test(target) || target === selfId) throw new Bad("Choose a different product to merge under.");
  const t = await sub(req, "products").doc(target).get();
  if (!t.exists) throw new Bad("That product no longer exists.");
  if (t.data().mergeUnder) throw new Bad("That product is itself merged under another one. Choose the main product.");
  if (selfId && (await sub(req, "products").where("mergeUnder", "==", selfId).get()).docs.length)
    throw new Bad("Other products are merged under this one, so it can’t be merged under another.");
}
// A product may only go live when the basics are filled in. Checked when it goes live, so older live products can still be edited.
const missingOf = d => { const m = []; if (!d.name) m.push("name"); if (!(d.price > 0)) m.push("selling price"); if (d.cost == null || d.cost === "") m.push("purchase price"); if (d.qty == null) m.push("quantity"); if (!(d.photos || []).length) m.push("a photo"); return m; };
const checkLive = (d, was) => { if (d.active && !(was && was.active)) { const m = missingOf(d); if (m.length) throw new Bad("Before it goes live, add: " + m.join(", ") + "."); } };

app.get(m + "/products", auth, h(async (req, res) => {
  const s = await sub(req, "products").orderBy("createdAt", "desc").get();
  res.json(s.docs.map(d => { const x = { id: d.id, ...d.data(), createdAt: undefined }; if (!can(req, "cost")) delete x.cost; return x; }));
}));
app.post(m + "/products", auth, need("add"), h(async (req, res) => {
  const u = await fields(req, req.body);
  if (!u.name) throw new Bad("Enter a product name.");
  await checkMerge(req, null, u.mergeUnder);
  if (!u.sku) { // no code typed: make the next one, SKU-0001, SKU-0002 ...
    const n = await db.runTransaction(async t => { const st = await t.get(store(req.params.slug)), k = (st.data().skuSeq || 0) + 1; t.update(st.ref, { skuSeq: k }); return k; });
    u.sku = "SKU-" + String(n).padStart(4, "0");
  }
  const doc = { description: "", supplier: "", cost: 0, qty: 0, lowAt: 5, expiry: "", tags: [], photos: [], price: 0, active: false, ...u, createdAt: stamp() };
  checkLive(doc);
  const r = await sub(req, "products").add(doc);
  if (doc.qty > 0) await sub(req, "stockLog").add(stockEntry(req, { id: r.id, name: doc.name, sku: doc.sku }, doc.qty, doc.qty, "Opening stock"));
  res.json({ id: r.id });
}));
app.put(m + "/products/:id", auth, need("add", "stock", "cost", "tags"), h(async (req, res) => {
  const ref = sub(req, "products").doc(req.params.id), ex = await ref.get();
  if (!ex.exists) throw new Bad("Product not found.");
  const u = await fields(req, req.body);
  await checkMerge(req, req.params.id, u.mergeUnder);
  checkLive({ ...ex.data(), ...u }, ex.data());
  // Stock is changed against the latest number, never overwritten with an old copy:
  //  qtyDelta  = "+10 received" / "-2 damaged", added to whatever stock is now
  //  qty       = an exact recount; if expectedQty is sent and stock has moved since, nothing is saved
  const delta = req.body.qtyDelta !== undefined && req.body.qtyDelta !== "" && can(req, "stock") ? Number(req.body.qtyDelta) : undefined;
  if (delta !== undefined && !Number.isInteger(delta)) throw new Bad("Enter a whole number.");
  const exp = req.body.expectedQty === undefined || req.body.expectedQty === "" ? undefined : (req.body.expectedQty === null ? null : Number(req.body.expectedQty));
  if (u.qty !== undefined || delta !== undefined) {
    await db.runTransaction(async t => {
      const cur = await t.get(ref), now = cur.data().qty == null ? null : cur.data().qty;
      if (exp !== undefined && exp !== now && !(exp === 0 && now == null)) throw new Bad(`Stock changed from ${exp == null ? "not tracked" : exp} to ${now == null ? "not tracked" : now} while you were editing. Please check the new number and try again.`);
      const base = now == null ? 0 : now, after = delta !== undefined ? base + delta : u.qty;
      if (after < 0) throw new Bad(`That would take stock below zero (there are ${base} now).`);
      const upd = { ...u, qty: after }; t.update(ref, upd);
      if (after !== base) t.set(sub(req, "stockLog").doc(), stockEntry(req, { id: ex.id, name: u.name || ex.data().name, sku: u.sku || ex.data().sku }, after - base, after, clean(req.body.stockReason, 40) || (delta !== undefined ? "Stock changed" : "Counted again"), clean(req.body.stockNote, 100)));
    });
  } else if (Object.keys(u).length) await ref.update(u);
  res.json({ ok: true });
}));
app.delete(m + "/products/:id", auth, ownerOnly, h(async (req, res) => {
  const ref = sub(req, "products").doc(req.params.id), ex = await ref.get();
  await Promise.all((ex.exists ? ex.data().photos || [] : []).map(i => sub(req, "photos").doc(i).delete()));
  const kids = await sub(req, "products").where("mergeUnder", "==", req.params.id).get(); // they become normal listings again
  await Promise.all(kids.docs.map(d => d.ref.update({ mergeUnder: "" })));
  await ref.delete(); res.json({ ok: true });
}));

// ----- photos (kept in Firestore, so no paid storage is needed) -----
app.post(m + "/products/:id/photos", auth, need("add"), h(async (req, res) => {
  const ref = sub(req, "products").doc(req.params.id), p = await ref.get();
  if (!p.exists) throw new Bad("Product not found.");
  if ((p.data().photos || []).length >= 5) throw new Bad("You can add up to 5 photos per product.");
  const mt = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(req.body.data || ""));
  if (!mt) throw new Bad("Please choose a photo.");
  const buf = Buffer.from(mt[2], "base64");
  if (buf.length > 500 * 1024) throw new Bad("That photo is too large.");
  const id = crypto.randomBytes(8).toString("hex");
  await sub(req, "photos").doc(id).set({ type: mt[1], data: buf, createdAt: stamp() });
  await ref.update({ photos: FV.arrayUnion(id) });
  res.json({ id });
}));
app.delete(m + "/products/:id/photos/:pid", auth, need("add"), h(async (req, res) => {
  await sub(req, "products").doc(req.params.id).update({ photos: FV.arrayRemove(req.params.pid) });
  await sub(req, "photos").doc(req.params.pid).delete(); res.json({ ok: true });
}));

// ----- tags: the owner makes them, staff can use them -----
app.get(m + "/tags", auth, h(async (req, res) => {
  const s = await sub(req, "tags").orderBy("pos").get(); res.json(s.docs.map(d => ({ id: d.id, name: d.data().name })));
}));
app.post(m + "/tags", auth, ownerOnly, h(async (req, res) => {
  const name = clean(req.body.name, 30); if (!name) throw new Bad("Enter a tag name.");
  const all = (await sub(req, "tags").get()).docs;
  if (all.some(d => d.data().name.toLowerCase() === name.toLowerCase())) throw new Bad("That tag already exists.");
  await sub(req, "tags").add({ name, pos: Math.max(Date.now(), ...all.map(d => d.data().pos || 0)) + 1 }); res.json({ ok: true });
}));
app.delete(m + "/tags/:id", auth, ownerOnly, h(async (req, res) => {
  const t = await sub(req, "tags").doc(req.params.id).get(); if (!t.exists) return res.json({ ok: true });
  const ps = await sub(req, "products").where("tags", "array-contains", t.data().name).get();
  await Promise.all(ps.docs.map(d => d.ref.update({ tags: FV.arrayRemove(t.data().name) })));
  await t.ref.delete(); res.json({ ok: true });
}));
app.post(m + "/tags/:id/move", auth, ownerOnly, h(async (req, res) => {
  const all = (await sub(req, "tags").orderBy("pos").get()).docs, i = all.findIndex(d => d.id === req.params.id), j = req.body.dir === "up" ? i - 1 : i + 1;
  if (i < 0 || j < 0 || j >= all.length) return res.json({ ok: true });
  const pi = all[i].data().pos, pj = all[j].data().pos; // read both first, then swap
  await Promise.all([all[i].ref.update({ pos: pj }), all[j].ref.update({ pos: pi })]); res.json({ ok: true });
}));

// ----- Products: import from a file (owner only) -----
// The page reads the file and sends the rows here. "dryRun" only checks them (the preview); otherwise they are saved.
const normDate = v => {
  v = String(v || "").trim(); if (!v) return "";
  let y, mo, d, m;
  if ((m = v.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))) [y, mo, d] = [m[1], m[2], m[3]];
  else if ((m = v.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/))) [d, mo, y] = [m[1], m[2], m[3]];
  else return null;
  const dt = new Date(Date.UTC(+y, +mo - 1, +d));
  if (dt.getUTCFullYear() != +y || dt.getUTCMonth() != +mo - 1 || dt.getUTCDate() != +d) return null;
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
};
const cell = (v, n) => { let t = String(v == null ? "" : v).trim().slice(0, n); if (/^'[=+\-@]/.test(t)) t = t.slice(1); return t; };
const numCell = v => { const t = String(v == null ? "" : v).replace(/[₹,\s]/g, ""); if (t === "") return { blank: true }; const n = Number(t); return Number.isFinite(n) && n >= 0 ? { n } : { bad: true }; };
const IMPORT_MAX = 500;
app.post(m + "/products-import", auth, ownerOnly, h(async (req, res) => {
  const rows = Array.isArray(req.body.rows) ? req.body.rows : [], update = !!req.body.update, dry = !!req.body.dryRun;
  if (!rows.length) throw new Bad("The file has no rows.");
  if (rows.length > IMPORT_MAX) throw new Bad(`The file has ${rows.length} rows. Please import ${IMPORT_MAX} or fewer at a time.`);
  const existing = (await sub(req, "products").get()).docs, bySku = new Map(), byName = new Map();
  existing.forEach(d => { const x = d.data(); if (x.sku) bySku.set(x.sku.toUpperCase(), d); if (x.name && !byName.has(x.name.toLowerCase())) byName.set(x.name.toLowerCase(), d); });
  const known = (await sub(req, "tags").get()).docs, tagNames = new Map(known.map(d => [d.data().name.toLowerCase(), d.data().name]));
  const seenSku = new Set(), out = [], work = [];
  rows.forEach((r, i) => {
    const line = i + 2, note = [], res1 = { line, name: cell(r.name, 100), status: "new", note: "", missing: [] };
    out.push(res1);
    if (!res1.name) { res1.status = "error"; res1.note = "No name, so this row was skipped."; return; }
    const sku = cell(r.sku, 24).toUpperCase(), d = {};
    if (sku && seenSku.has(sku)) { res1.status = "skip"; res1.note = `Code ${sku} appears twice in the file.`; return; }
    if (sku) seenSku.add(sku);
    const ex = sku ? bySku.get(sku) : null;
    if (ex && !update) { res1.status = "skip"; res1.note = `Code ${sku} already exists.`; return; }
    if (ex) res1.status = "update";
    if (sku) d.sku = sku;
    if (cell(r.description, 300)) d.description = cell(r.description, 300);
    if (cell(r.supplier, 80)) d.supplier = cell(r.supplier, 80);
    if (cell(r.o1, 40)) d.o1 = cell(r.o1, 40);
    if (cell(r.o2, 40)) d.o2 = cell(r.o2, 40);
    for (const [k, label, whole] of [["price", "selling price"], ["cost", "purchase price"], ["qty", "quantity", 1], ["lowAt", "low-stock alert", 1]]) {
      const c = numCell(r[k]); if (c.bad || (whole && c.n != null && !Number.isInteger(c.n))) { note.push(`${label} “${cell(r[k], 20)}” isn’t a valid number, left blank`); continue; }
      if (!c.blank) d[k] = c.n;
    }
    const ex1 = cell(r.expiry, 20);
    if (ex1) { const e = normDate(ex1); if (e) d.expiry = e; else note.push(`expiry “${ex1}” isn’t a date (use 2026-12-31 or 31/12/2026), left blank`); }
    d.tagNames = cell(r.category, 200).split(/[|;]/).map(x => x.trim()).filter(Boolean).slice(0, 10);
    d.mergeRef = cell(r.mergedUnder, 100);
    d.wantLive = /^(yes|y|true|1|live)$/i.test(cell(r.live, 10));
    d.name = res1.name;
    work.push({ res: res1, d, ex, note });
  });
  // work out what each product will look like, and what is still missing
  const newTags = new Set();
  work.forEach(w => {
    w.d.tagNames = w.d.tagNames.map(t => { const k = tagNames.get(t.toLowerCase()); if (k) return k; newTags.add(t.slice(0, 30)); tagNames.set(t.toLowerCase(), t.slice(0, 30)); return t.slice(0, 30); });
    const merged = { photos: [], ...(w.ex ? w.ex.data() : { cost: null, qty: null, price: 0 }), ...Object.fromEntries(Object.entries(w.d).filter(([k]) => ["name", "price", "cost", "qty"].includes(k))) };
    w.after = merged; w.res.missing = missingOf(merged);
    w.res.note = w.note.join("; ");
    if (w.d.wantLive && w.res.missing.length) w.res.note += (w.res.note ? "; " : "") + "kept as a draft, still needs " + w.res.missing.join(", ");
    if (!w.res.missing.length) w.res.missing = [];
  });
  const sum = { created: out.filter(o => o.status == "new").length, updated: out.filter(o => o.status == "update").length, skipped: out.filter(o => o.status == "skip" || o.status == "error").length, needDetails: work.filter(w => w.res.missing.length).length, newTags: [...newTags] };
  if (dry) return res.json({ ...sum, rows: out, dryRun: true });
  // ---- save ----
  const ref = store(req.params.slug), ops = [];
  const taken = new Set(bySku.keys()); work.forEach(w => { if (w.d.sku) taken.add(w.d.sku); });
  let seq = (await ref.get()).data().skuSeq || 0;
  const tagColl = sub(req, "tags"), maxPos = Math.max(Date.now(), ...known.map(d => d.data().pos || 0));
  [...newTags].forEach((n, i) => ops.push(b => b.set(tagColl.doc(), { name: n, pos: maxPos + i + 1 })));
  const ids = new Map(); // sku/name -> product id, for "merged under"
  existing.forEach(d => { const x = d.data(); if (x.sku) ids.set(x.sku.toUpperCase(), d.id); });
  work.forEach(w => {
    const { d, ex } = w, docRef = ex ? ex.ref : sub(req, "products").doc(); w.id = docRef.id;
    if (!ex && !d.sku) { do { seq++; d.sku = "SKU-" + String(seq).padStart(4, "0"); } while (taken.has(d.sku)); taken.add(d.sku); }
    if (d.sku) ids.set(d.sku.toUpperCase(), docRef.id);
    const clone = { ...d }; delete clone.tagNames; delete clone.mergeRef; delete clone.wantLive;
    if (ex) {
      const u = { ...clone }; delete u.sku; delete u.name;
      if (d.name) u.name = d.name;
      if (d.tagNames.length) u.tags = [...new Set([...(ex.data().tags || []), ...d.tagNames])];
      if (d.wantLive && !w.res.missing.length) u.active = true;
      ops.push(b => b.update(docRef, u));
      if (u.qty !== undefined && u.qty !== (ex.data().qty == null ? 0 : ex.data().qty)) { const was = ex.data().qty == null ? 0 : ex.data().qty; ops.push(b => b.set(sub(req, "stockLog").doc(), stockEntry(req, { id: docRef.id, name: d.name, sku: ex.data().sku }, u.qty - was, u.qty, "Imported"))); }
    } else {
      const doc = { description: "", supplier: "", cost: null, qty: null, lowAt: 5, expiry: "", tags: d.tagNames, photos: [], price: 0, active: false, mergeUnder: "", kind: "general", ...clone, createdAt: stamp(), imported: true };
      doc.active = !!(d.wantLive && !w.res.missing.length);
      ops.push(b => b.set(docRef, doc));
      if (doc.qty > 0) ops.push(b => b.set(sub(req, "stockLog").doc(), stockEntry(req, { id: docRef.id, name: d.name, sku: doc.sku }, doc.qty, doc.qty, "Imported")));
    }
  });
  // merged under: by product code or by name, among the saved products and this file
  const nameToId = new Map(); existing.forEach(d => { const k = (d.data().name || "").toLowerCase(); if (k && !nameToId.has(k)) nameToId.set(k, d.id); }); work.forEach(w => { const k = w.d.name.toLowerCase(); if (!nameToId.has(k)) nameToId.set(k, w.id); });
  const parentOf = new Map(existing.map(d => [d.id, d.data().mergeUnder || ""])); const kidsOf = new Set(existing.map(d => d.data().mergeUnder).filter(Boolean));
  work.forEach(w => {
    if (!w.d.mergeRef) return;
    const tid = ids.get(w.d.mergeRef.toUpperCase()) || nameToId.get(w.d.mergeRef.toLowerCase());
    if (!tid || tid === w.id || parentOf.get(tid) || kidsOf.has(w.id)) { w.res.note += (w.res.note ? "; " : "") + `couldn’t merge under “${w.d.mergeRef}”`; return; }
    parentOf.set(w.id, tid); kidsOf.add(tid);
    ops.push(b => b.update(sub(req, "products").doc(w.id), { mergeUnder: tid }));
  });
  if (seq !== (await ref.get()).data().skuSeq) await ref.update({ skuSeq: seq });
  for (let i = 0; i < ops.length; i += 400) { const b = db.batch(); ops.slice(i, i + 400).forEach(f => f(b)); await b.commit(); }
  res.json({ ...sum, rows: out });
}));

// ----- Purchases: stock bought from a supplier (owner only) -----
const purchaseOf = (b, today) => ({
  supplier: clean(b.supplier, 80), billNo: clean(b.billNo, 40), date: /^\d{4}-\d{2}-\d{2}$/.test(b.date || "") ? b.date : today,
  lines: (Array.isArray(b.lines) ? b.lines : []).slice(0, 100).map(l => ({ id: /^[A-Za-z0-9]{1,40}$/.test(String(l.id || "")) ? String(l.id) : "", name: clean(l.name, 100), qty: Math.floor(Number(l.qty) || 0), cost: Math.max(0, Number(l.cost) || 0) })),
  discount: Math.max(0, Number(b.discount) || 0), gst: RATES.includes(Number(b.gst)) ? Number(b.gst) : 0, notes: clean(b.notes, 200), updateCost: b.updateCost !== false,
  pay: { status: ["paid", "partial", "unpaid"].includes((b.pay || {}).status) ? b.pay.status : "unpaid", method: PAY_METHODS.includes((b.pay || {}).method) ? b.pay.method : "UPI", amount: Math.max(0, Number((b.pay || {}).amount) || 0) },
});
const todayStr = () => new Date().toISOString().slice(0, 10);
const puView = d => { const x = d.data(); return { ...x, createdAt: x.createdAt ? x.createdAt.toDate().toISOString() : null }; };
app.get(m + "/purchases", auth, ownerOnly, h(async (req, res) => {
  const s = await sub(req, "purchases").orderBy("createdAt", "desc").limit(300).get(); res.json(s.docs.map(puView));
}));
app.post(m + "/purchases", auth, ownerOnly, h(async (req, res) => {
  const b = purchaseOf(req.body, todayStr()), ref = store(req.params.slug);
  if (!b.supplier) throw new Bad("Choose the supplier.");
  if (!b.lines.length) throw new Bad("Add at least one product.");
  const want = new Map(); // one entry per product (id) or per new product (name)
  for (const l of b.lines) {
    if (!l.id && !l.name) throw new Bad("Every line needs a product.");
    if (!(l.qty >= 1 && l.qty <= 99999)) throw new Bad("Check the quantities.");
  }
  const all = (await sub(req, "products").get()).docs, byName = new Map(all.map(d => [String(d.data().name).toLowerCase(), d.id]));
  for (const l of b.lines) {
    const id = l.id || byName.get(l.name.toLowerCase()) || "", key = id || "new:" + l.name.toLowerCase(), w = want.get(key);
    if (w) { w.cost = (w.cost * w.qty + l.cost * l.qty) / (w.qty + l.qty); w.qty += l.qty; } else want.set(key, { id, name: l.name, qty: l.qty, cost: l.cost });
  }
  const items = [...want.values()];
  const out = await db.runTransaction(async t => {
    const st = await t.get(ref), snaps = await Promise.all(items.map(it => it.id ? t.get(sub(req, "products").doc(it.id)) : null));
    const lines = []; let subtotal = 0, seqSku = st.data().skuSeq || 0, taken = new Set(all.map(d => String(d.data().sku || "").toUpperCase()));
    const writes = [];
    items.forEach((it, i) => {
      const p = snaps[i];
      if (it.id && !p.exists) throw new Bad("A product on this purchase no longer exists.");
      subtotal += it.qty * it.cost;
      if (p) {
        const d = p.data(), after = (d.qty == null ? 0 : d.qty) + it.qty, u = { qty: after }; if (b.updateCost) u.cost = Math.round(it.cost * 100) / 100;
        writes.push(() => t.update(p.ref, u));
        lines.push({ id: p.id, name: d.name, sku: d.sku || "", qty: it.qty, cost: it.cost, isNew: false }); it.pid = p.id; it.after = after; it.sku = d.sku; it.pname = d.name;
      } else {
        do { seqSku++; it.sku = "SKU-" + String(seqSku).padStart(4, "0"); } while (taken.has(it.sku)); taken.add(it.sku);
        const nref = sub(req, "products").doc(); it.pid = nref.id; it.after = it.qty; it.pname = it.name;
        writes.push(() => t.set(nref, { name: it.name, description: "", supplier: b.supplier, sku: it.sku, cost: Math.round(it.cost * 100) / 100, qty: it.qty, lowAt: 5, expiry: "", tags: [], photos: [], price: 0, active: false, mergeUnder: "", kind: "general", createdAt: stamp(), imported: true }));
        lines.push({ id: nref.id, name: it.name, sku: it.sku, qty: it.qty, cost: it.cost, isNew: true });
      }
    });
    if (b.discount > subtotal) throw new Bad("The discount can’t be more than the subtotal.");
    const taxable = subtotal - b.discount, gst = Math.round(taxable * b.gst / 100), total = taxable + gst;
    let paid = 0, payments = [];
    if (b.pay.status === "paid") paid = total; else if (b.pay.status === "partial") { if (!(b.pay.amount > 0 && b.pay.amount < total)) throw new Bad("For a part payment, enter an amount below the total."); paid = b.pay.amount; }
    if (paid > 0) payments = [{ amount: paid, method: b.pay.method, at: new Date().toISOString() }];
    const seq = (st.data().purSeq || 1000) + 1, number = "PU-" + seq;
    writes.forEach(w => w());
    items.forEach(it => t.set(sub(req, "stockLog").doc(), stockEntry(req, { id: it.pid, name: it.pname, sku: it.sku }, it.qty, it.after, "Purchase " + number)));
    t.update(ref, { purSeq: seq, skuSeq: seqSku });
    const p = { number, supplier: b.supplier, billNo: b.billNo, date: b.date, lines, subtotal, discount: b.discount, gstRate: b.gst, gst, total, notes: b.notes, paid, payments, createdBy: req.who.name };
    t.set(sub(req, "purchases").doc(number), { ...p, createdAt: stamp() });
    return p;
  });
  res.json({ number: out.number, total: out.total, newProducts: out.lines.filter(l => l.isNew).length });
}));
app.post(m + "/purchases/:number/payments", auth, ownerOnly, h(async (req, res) => {
  const amount = Number(req.body.amount), method = req.body.method;
  if (!(amount > 0) || !METHODS.includes(method)) throw new Bad("Enter an amount and a payment method.");
  const pref = sub(req, "purchases").doc(req.params.number), p = await pref.get();
  if (!p.exists) throw new Bad("Purchase not found.");
  const d = p.data(), left = d.total - (d.paid || 0);
  if (amount > left + 0.01) throw new Bad("That is more than the amount still owed (₹" + left + ").");
  await pref.update({ paid: (d.paid || 0) + amount, payments: FV.arrayUnion({ amount, method, at: new Date().toISOString() }) });
  res.json({ ok: true });
}));
// delete a purchase: choose whether the stock it added is taken off again. A copy is kept in "trash".
app.delete(m + "/purchases/:number", auth, ownerOnly, h(async (req, res) => {
  const pref = sub(req, "purchases").doc(req.params.number), reverse = req.query.reverse === "1";
  await db.runTransaction(async t => {
    const p = await t.get(pref); if (!p.exists) throw new Bad("Purchase not found.");
    const d = p.data(), ls = reverse ? (d.lines || []).filter(l => l.id) : [];
    const ps = await Promise.all(ls.map(l => t.get(sub(req, "products").doc(l.id))));
    ps.forEach((x, i) => { if (x.exists && x.data().qty != null) { const take = Math.min(ls[i].qty, x.data().qty), after = x.data().qty - take; t.update(x.ref, { qty: after }); t.set(sub(req, "stockLog").doc(), stockEntry(req, { id: x.id, name: x.data().name, sku: x.data().sku }, -take, after, "Purchase " + req.params.number + " deleted")); } });
    t.set(sub(req, "trash").doc(req.params.number), { ...d, kind: "purchase", deletedAt: stamp(), deletedBy: req.who.name, stockReversed: reverse });
    t.delete(pref);
  });
  res.json({ ok: true });
}));
// purchase drafts are saved with the other drafts
app.post(m + "/purchase-drafts", auth, ownerOnly, h(async (req, res) => {
  const ref = req.body.id && /^[A-Za-z0-9]{1,40}$/.test(String(req.body.id)) ? sub(req, "drafts").doc(String(req.body.id)) : sub(req, "drafts").doc();
  await ref.set({ data: { ...purchaseOf(req.body, todayStr()), kind: "purchase" }, savedAt: stamp() }); res.json({ id: ref.id });
}));

// ----- suppliers -----
app.get(m + "/suppliers", auth, h(async (req, res) => {
  const s = await sub(req, "suppliers").orderBy("createdAt", "desc").get();
  res.json(s.docs.map(d => ({ id: d.id, name: d.data().name, phone: d.data().phone, note: d.data().note })));
}));
app.post(m + "/suppliers", auth, ownerOnly, h(async (req, res) => {
  const name = clean(req.body.name, 80); if (!name) throw new Bad("Enter the supplier’s name.");
  await sub(req, "suppliers").add({ name, phone: clean(req.body.phone, 20), note: clean(req.body.note, 200), createdAt: stamp() }); res.json({ ok: true });
}));
app.delete(m + "/suppliers/:id", auth, ownerOnly, h(async (req, res) => { await sub(req, "suppliers").doc(req.params.id).delete(); res.json({ ok: true }); }));

// ----- staff accounts (owner only) -----
app.get(m + "/users", auth, ownerOnly, h(async (req, res) => {
  const s = await sub(req, "users").get();
  res.json(s.docs.map(d => ({ username: d.id, name: d.data().name, active: d.data().active, perms: cleanPerms(d.data().perms) })));
}));
app.post(m + "/users", auth, ownerOnly, h(async (req, res) => {
  const user = clean(req.body.username, 30).toLowerCase(), name = clean(req.body.name, 60), pw = String(req.body.password || "");
  if (!/^[a-z0-9._-]{3,30}$/.test(user) || !name) throw new Bad("Enter a name and a username of 3+ letters or numbers.");
  if (pw.length < 6) throw new Bad("The password must be at least 6 characters.");
  if ((await sub(req, "users").doc(user).get()).exists) throw new Bad("That username is taken.");
  await sub(req, "users").doc(user).set({ name, hash: hash(pw), perms: cleanPerms(req.body.perms), active: true, createdAt: stamp() }); res.json({ ok: true });
}));
app.patch(m + "/users/:id", auth, ownerOnly, h(async (req, res) => {
  const u = {}, b = req.body;
  if (b.active !== undefined) u.active = !!b.active;
  if (b.perms) u.perms = cleanPerms(b.perms);
  if (b.password !== undefined) { if (String(b.password).length < 6) throw new Bad("The password must be at least 6 characters."); u.hash = hash(String(b.password)); }
  await sub(req, "users").doc(req.params.id).update(u); res.json({ ok: true });
}));
app.delete(m + "/users/:id", auth, ownerOnly, h(async (req, res) => { await sub(req, "users").doc(req.params.id).delete(); res.json({ ok: true }); }));

// ----- orders -----
app.get(m + "/orders", auth, need("orders"), h(async (req, res) => {
  const s = await sub(req, "orders").orderBy("createdAt", "desc").limit(500).get();
  const rows = s.docs.map(d => { const x = d.data(); return { ...x, createdAt: x.createdAt ? x.createdAt.toDate().toISOString() : null, paid: x.paid || 0, payments: x.payments || [], seen: x.seen !== false }; });
  if (req.who.role === "owner") return res.json(rows.map(o => ({ ...o, invKey: invSig(req.params.slug, o.number) })));
  res.json(rows.filter(o => req.who.perms.orderView.includes(o.status)).map(o => ({
    number: o.number, name: o.name, phone: o.phone, address: o.address, status: o.status, createdAt: o.createdAt, seen: o.seen,
    lines: (o.lines || []).map(l => ({ id: l.id, name: l.name, qty: l.qty, photo: l.photo || "" })),
  })));
}));
// Adjust quantities on a new order before confirmation; reconcile stock and totals atomically.
app.put(m + "/orders/:number/items", auth, ownerOnly, h(async (req, res) => {
  const input = req.body && req.body.lines;
  if (!Array.isArray(input) || !input.length || input.length > 50) throw new Bad("Keep at least one item on the order.");
  const wanted = new Map();
  for (const line of input) {
    const id = String(line.id || ""), qty = Number(line.qty);
    if (!/^[A-Za-z0-9]{1,40}$/.test(id) || !Number.isInteger(qty) || qty < 1 || qty > 20 || wanted.has(id)) throw new Bad("One or more quantities are invalid.");
    wanted.set(id, qty);
  }
  const ref = sub(req, "orders").doc(req.params.number);
  await db.runTransaction(async t => {
    const orderSnap = await t.get(ref);
    if (!orderSnap.exists) throw new Bad("Order not found.");
    const order = orderSnap.data();
    if (order.status !== "New") throw new Bad("Only new orders can be edited.");
    if ((order.paid || 0) > 0) throw new Bad("This order already has a payment recorded. Set its payment to Unpaid first, then change the quantities.");
    const prior = order.lines || [];
    if ([...wanted.keys()].some(id => !prior.some(line => line.id === id))) throw new Bad("You can only change quantities for items already on this order.");
    const products = await Promise.all(prior.filter(l => l.id).map(l => t.get(sub(req, "products").doc(l.id))));
    const pmap = new Map(products.map(p => [p.id, p]));
    const updated = prior.filter(line => wanted.has(line.id)).map(line => ({ ...line, qty: wanted.get(line.id) }));
    // stock moves by the difference. An item taken off the order goes back into stock in full; a bigger quantity needs enough stock.
    for (const line of prior) {
      const p = pmap.get(line.id), diff = Number(line.qty || 0) - (wanted.get(line.id) || 0);
      if (!p || !p.exists || p.data().qty == null || !diff) continue;
      if (diff < 0 && p.data().qty < -diff) throw new Bad(`Only ${p.data().qty} more of ${line.name} in stock.`);
      const after = Number(p.data().qty) + diff; t.update(p.ref, { qty: after });
      t.set(sub(req, "stockLog").doc(), stockEntry(req, { id: p.id, name: p.data().name, sku: p.data().sku }, diff, after, "Order " + req.params.number + " edited"));
    }
    t.update(ref, { lines: updated, total: updated.reduce((n, l) => n + Number(l.price || 0) * l.qty, 0), cost: updated.reduce((n, l) => n + Number(l.cost || 0) * l.qty, 0), seen: true });
  });
  res.json({ ok: true });
}));
app.post(m + "/orders/:number/seen", auth, need("orders"), h(async (req, res) => {
  const ref = sub(req, "orders").doc(req.params.number), o = await ref.get();
  if (!o.exists || (req.who.role !== "owner" && !req.who.perms.orderView.includes(o.data().status))) throw new Bad("Order not found.");
  await ref.update({ seen: true }); res.json({ ok: true });
}));
app.patch(m + "/orders/:number", auth, need("orders"), h(async (req, res) => {
  const st = req.body.status, isOwner = req.who.role === "owner";
  if (!STATUSES.includes(st)) throw new Bad("Bad status");
  if (!isOwner && st === "Cancelled") throw new Bad("Only the owner can cancel an order.");
  const oref = sub(req, "orders").doc(req.params.number);
  await db.runTransaction(async t => {
    const o = await t.get(oref);
    if (!o.exists) throw new Bad("Order not found");
    const d = o.data();
    if (!isOwner && !req.who.perms.orderView.includes(d.status)) throw new Bad("You can’t change that order.");
    if (d.status === "Cancelled") throw new Bad("A cancelled order can’t be changed.");
    if (st === "Cancelled") { // put the items back into stock
      const ls = (d.lines || []).filter(l => l.id);
      const ps = await Promise.all(ls.map(l => t.get(sub(req, "products").doc(l.id))));
      ps.forEach((p, i) => { if (p.exists && p.data().qty != null) { const after = p.data().qty + ls[i].qty; t.update(p.ref, { qty: after }); t.set(sub(req, "stockLog").doc(), stockEntry(req, { id: p.id, name: p.data().name, sku: p.data().sku }, ls[i].qty, after, "Order " + req.params.number + " cancelled")); } });
    }
    t.update(oref, st === "Cancelled" ? { status: st, seen: true, cancelledAt: stamp() } : { status: st, seen: true });
  });
  res.json({ ok: true });
}));
app.get(m + "/stock-log", auth, need("stock"), h(async (req, res) => {
  const s = await sub(req, "stockLog").orderBy("at", "desc").limit(300).get();
  res.json(s.docs.map(d => { const x = d.data(); return { id: d.id, ...x, at: x.at ? x.at.toDate().toISOString() : null }; }));
}));
// delete an order or invoice made by mistake (owner only). A copy is kept in "trash" so nothing is lost for good.
app.delete(m + "/orders/:number", auth, ownerOnly, h(async (req, res) => {
  const oref = sub(req, "orders").doc(req.params.number), restock = req.query.restock !== "0";
  await db.runTransaction(async t => {
    const o = await t.get(oref);
    if (!o.exists) throw new Bad("Order not found.");
    const d = o.data(), back = restock && d.status !== "Cancelled", ls = back ? (d.lines || []).filter(l => l.id) : [];
    const ps = await Promise.all(ls.map(l => t.get(sub(req, "products").doc(l.id))));
    ps.forEach((p, i) => { if (p.exists && p.data().qty != null) { const after = p.data().qty + ls[i].qty; t.update(p.ref, { qty: after }); t.set(sub(req, "stockLog").doc(), stockEntry(req, { id: p.id, name: p.data().name, sku: p.data().sku }, ls[i].qty, after, "Order " + req.params.number + " deleted")); } });
    t.set(sub(req, "trash").doc(req.params.number), { ...d, deletedAt: stamp(), deletedBy: req.who.name, stockReturned: back });
    t.delete(oref);
  });
  res.json({ ok: true });
}));
// payment dropdown: mark an order unpaid, or fully paid by one method (owner only)
app.put(m + "/orders/:number/payment", auth, ownerOnly, h(async (req, res) => {
  const oref = sub(req, "orders").doc(req.params.number), o = await oref.get();
  if (!o.exists) throw new Bad("Order not found");
  if (req.body.mode === "unpaid") await oref.update({ paid: 0, payments: [], seen: true });
  else {
    if (!METHODS.includes(req.body.method)) throw new Bad("Choose how it was paid.");
    await oref.update({ paid: o.data().total, payments: [{ amount: o.data().total, method: req.body.method, at: new Date().toISOString() }], seen: true });
  }
  res.json({ ok: true });
}));
app.post(m + "/orders/:number/payments", auth, ownerOnly, h(async (req, res) => {
  const amount = Number(req.body.amount), method = req.body.method;
  if (!(amount > 0) || !METHODS.includes(method)) throw new Bad("Enter an amount and a payment method.");
  const oref = sub(req, "orders").doc(req.params.number), o = await oref.get();
  if (!o.exists) throw new Bad("Order not found");
  const d = o.data(), left = d.total - (d.paid || 0);
  if (amount > left + 0.01) throw new Bad("That is more than the amount still due (₹" + left + ").");
  await oref.update({ paid: (d.paid || 0) + amount, seen: true, payments: FV.arrayUnion({ amount, method, at: new Date().toISOString() }) });
  res.json({ ok: true });
}));

// ---------- invoice: created from the order, opened with a private link ----------
app.get("/api/invoice/:slug/:number", h(async (req, res) => {
  const nf = () => res.status(404).json({ error: "Invoice not found" });
  if (!same(req.query.k, invSig(req.params.slug, req.params.number))) return nf();
  const [s, o] = await Promise.all([store(req.params.slug).get(), sub(req, "orders").doc(req.params.number).get()]);
  if (!s.exists || !o.exists) return nf();
  const d = o.data();
  const lines = await Promise.all((d.lines || []).map(async l => {
    let ph = l.photo; if (!ph && l.id) { const p = await sub(req, "products").doc(l.id).get(); ph = p.exists ? (p.data().photos || [])[0] : ""; }
    return { name: l.name, qty: l.qty, price: l.price, amount: l.price * l.qty, photo: ph ? `/api/photo/${req.params.slug}/${ph}` : "" };
  }));
  res.json({ store: s.data().name, number: d.number, date: d.createdAt ? d.createdAt.toDate().toISOString() : null, name: d.name, phone: d.phone, address: d.address,
    lines, subtotal: d.subtotal == null ? d.total : d.subtotal, discount: d.discount || 0, gstRate: d.gstRate || 0, gst: d.gst || 0, notes: d.notes || "", channel: d.channel || "online",
    business: { address: (s.data().business || {}).address || "", gstin: (s.data().business || {}).gstin || "", phone: (s.data().business || {}).phone || "" },
    total: d.total, paid: d.paid || 0, due: d.status === "Cancelled" ? 0 : Math.max(0, d.total - (d.paid || 0)), methods: (d.payments || []).map(p => p.method), status: d.status,
    cancelledAt: d.cancelledAt && d.cancelledAt.toDate ? d.cancelledAt.toDate().toISOString() : null, refunded: d.refunded || 0, refundDue: d.status === "Cancelled" ? Math.max(0, (d.paid || 0) - (d.refunded || 0)) : 0 });
}));

// ---------- pages ----------
const page = f => (req, res) => res.sendFile(path.join(__dirname, "public", f));
app.get("/s/:slug", page("store.html"));
app.get("/admin", page("admin.html"));
app.get("/manage", page("manage.html"));
app.get("/invoice/:slug/:number", page("invoice.html"));
app.get("/", (req, res) => res.redirect("/admin"));

module.exports = app; // Vercel uses this export
if (require.main === module) app.listen(process.env.PORT || 3000, () => console.log("Meri Dukaan is running")); // for running on your own computer
