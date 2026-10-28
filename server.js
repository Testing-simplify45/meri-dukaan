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
app.use((req, res, next) => (req.method === "POST" && /\/photos$/.test(req.path) ? big : small)(req, res, next));
app.use(express.static(path.join(__dirname, "public")));

// ---------- helpers ----------
class Bad extends Error {} // a mistake the person can fix; shown to them as-is
const h = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(e =>
  e instanceof Bad ? res.status(400).json({ error: e.message }) : (console.error(e), res.status(500).json({ error: "Something went wrong" })));
const clean = (s, n) => String(s || "").trim().slice(0, n);
const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const same = (a, b) => { a = Buffer.from(String(a || "")); b = Buffer.from(String(b || "")); return b.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b); };
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
app.get("/api/store/:slug", h(async (req, res) => {
  const s = await store(req.params.slug).get();
  if (!s.exists) return res.status(404).json({ error: "Store not found" });
  const [ps, tg] = await Promise.all([sub(req, "products").where("active", "==", true).get(), sub(req, "tags").orderBy("pos").get()]);
  res.json({
    name: s.data().name, tags: tg.docs.map(d => d.data().name),
    products: ps.docs.map(d => {
      const x = d.data(), photos = (x.photos || []).map(i => `/api/photo/${req.params.slug}/${i}`);
      return { id: d.id, name: x.name, price: x.price, description: x.description || "", qty: x.qty == null ? null : x.qty, tags: x.tags || [], photos: photos.length ? photos : (x.image ? [x.image] : []) };
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
  const number = "ORD-" + Date.now().toString(36).toUpperCase() + crypto.randomBytes(2).toString("hex").toUpperCase();
  const order = await db.runTransaction(async t => {
    const ids = Object.keys(want);
    const snaps = await Promise.all(ids.map(id => t.get(ref.collection("products").doc(id))));
    const lines = []; let total = 0, cost = 0;
    snaps.forEach((p, i) => {
      if (!p.exists || !p.data().active) throw new Bad("An item in your cart is no longer available.");
      const d = p.data(), q = want[ids[i]];
      if (d.qty != null && d.qty < q) throw new Bad(d.qty > 0 ? `Only ${d.qty} left of ${d.name}.` : `${d.name} is out of stock.`);
      lines.push({ id: p.id, name: d.name, price: d.price, cost: d.cost || 0, qty: q, photo: (d.photos || [])[0] || "" });
      total += d.price * q; cost += (d.cost || 0) * q; // prices always come from the database
    });
    snaps.forEach((p, i) => { if (p.data().qty != null) t.update(p.ref, { qty: p.data().qty - want[ids[i]] }); });
    const o = { number, ...cust, lines, total, cost, status: "New", paid: 0, payments: [], seen: false };
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
  if (k && (same(k, s.data().adminKey) || same(k, process.env.ADMIN_PASSWORD))) { req.who = { role: "owner", name: "Owner", perms: { ...ALL, orderView: STATUSES } }; return next(); }
  const p = verify(req.get("x-token"));
  if (p && p.slug === req.params.slug) {
    const u = await sub(req, "users").doc(p.uid).get();
    if (u.exists && u.data().active) { req.who = { role: "staff", name: u.data().name, perms: cleanPerms(u.data().perms) }; return next(); }
  }
  res.status(401).json({ error: "Please log in again." });
});
const can = (req, p) => req.who.role === "owner" || !!req.who.perms[p];
const need = (...ps) => (req, res, next) => ps.some(p => can(req, p)) ? next() : res.status(403).json({ error: "You don’t have permission to do that." });
const ownerOnly = (req, res, next) => req.who.role === "owner" ? next() : res.status(403).json({ error: "Only the owner can do that." });

app.get(m + "/me", auth, (req, res) => res.json({ role: req.who.role, name: req.who.name, perms: req.who.perms }));

// ----- products: each field is only changed if this person is allowed to change it -----
async function fields(req, b) {
  const u = {};
  if (can(req, "add")) {
    if (b.name !== undefined) { u.name = clean(b.name, 100); if (!u.name) throw new Bad("Enter a product name."); }
    if (b.description !== undefined) u.description = clean(b.description, 300);
    if (b.supplier !== undefined) u.supplier = clean(b.supplier, 80);
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
const checkLive = d => { if (d.active && !(d.price > 0)) throw new Bad("Set a selling price before making a product live."); };

app.get(m + "/products", auth, h(async (req, res) => {
  const s = await sub(req, "products").orderBy("createdAt", "desc").get();
  res.json(s.docs.map(d => { const x = { id: d.id, ...d.data(), createdAt: undefined }; if (!can(req, "cost")) delete x.cost; return x; }));
}));
app.post(m + "/products", auth, need("add"), h(async (req, res) => {
  const u = await fields(req, req.body);
  if (!u.name) throw new Bad("Enter a product name.");
  const doc = { description: "", supplier: "", cost: 0, qty: 0, lowAt: 5, expiry: "", tags: [], photos: [], price: 0, active: false, ...u, createdAt: stamp() };
  checkLive(doc);
  const r = await sub(req, "products").add(doc); res.json({ id: r.id });
}));
app.put(m + "/products/:id", auth, need("add", "stock", "cost", "tags"), h(async (req, res) => {
  const ref = sub(req, "products").doc(req.params.id), ex = await ref.get();
  if (!ex.exists) throw new Bad("Product not found.");
  const u = await fields(req, req.body);
  checkLive({ ...ex.data(), ...u });
  if (Object.keys(u).length) await ref.update(u);
  res.json({ ok: true });
}));
app.delete(m + "/products/:id", auth, ownerOnly, h(async (req, res) => {
  const ref = sub(req, "products").doc(req.params.id), ex = await ref.get();
  await Promise.all((ex.exists ? ex.data().photos || [] : []).map(i => sub(req, "photos").doc(i).delete()));
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
      ps.forEach((p, i) => { if (p.exists && p.data().qty != null) t.update(p.ref, { qty: p.data().qty + ls[i].qty }); });
    }
    t.update(oref, { status: st, seen: true });
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
    lines, total: d.total, paid: d.paid || 0, due: Math.max(0, d.total - (d.paid || 0)), methods: (d.payments || []).map(p => p.method), status: d.status });
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
