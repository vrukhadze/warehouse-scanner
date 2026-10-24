const test = require("node:test");
const assert = require("node:assert/strict");
const RcvOutbox = require("../rcv-outbox.js");

function memStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    key: (i) => [...m.keys()][i] ?? null,
    get length() { return m.size; },
    _m: m,
  };
}
function mk(storage, rid = "r1", uid = "7", k = undefined, now = undefined) {
  let t = 1000, n = 0;
  return RcvOutbox.open({
    storage, rid, uid, k,
    now: now || (() => (t += 1)),
    rand: (len) => String(++n).padStart(len, "0"),
  });
}
const K = "e60ab38c20969be628225f6eb3e10df5";
// ერთი პაკეტის გაგზავნა: nextPacket → (Worker ok) → ack
function sendOne(o, init = "init") {
  const p = o.nextPacket(init);
  assert.ok(p);
  assert.equal(o.ack(p.cid), true);
  return p;
}

test("addScan persists before returning", () => {
  const s = memStorage();
  const ev = mk(s).addScan("A5AW501200");
  assert.equal(ev.t, "scan");
  assert.equal(ev.code, "A5AW501200");
  assert.equal(ev.id.length, 16);
  assert.deepEqual(mk(s).items(), [{ code: "A5AW501200", qty: 1 }]);
});

test("same code twice aggregates and moves to top", () => {
  const o = mk(memStorage());
  o.addScan("A"); o.addScan("B"); o.addScan("A");
  assert.deepEqual(o.items(), [{ code: "A", qty: 2 }, { code: "B", qty: 1 }]);
});

test("undoLast removes a pending scan", () => {
  const o = mk(memStorage());
  o.addScan("A"); o.addScan("A");
  o.undoLast();
  assert.deepEqual(o.items(), [{ code: "A", qty: 1 }]);
  assert.equal(o.pendingCount(), 1);
});

test("outboxes are per rid and uid", () => {
  const s = memStorage();
  mk(s, "r1", "7").addScan("A");
  assert.ok(s.getItem("rcv_outbox_v2:r1:7"));
  assert.deepEqual(mk(s, "r2", "7").items(), []);
  assert.deepEqual(mk(s, "r1", "8").items(), []);
});

test("corrupt storage starts empty", () => {
  const s = memStorage();
  s.setItem("rcv_outbox_v2:r1:7", "{");
  assert.deepEqual(mk(s).items(), []);
});

test("clearAll empties storage", () => {
  const s = memStorage();
  const o = mk(s);
  o.addScan("A");
  o.clearAll();
  assert.deepEqual(mk(s).items(), []);
  assert.deepEqual(o.items(), []);
});

test("failed write throws and adds nothing", () => {
  const s = memStorage();
  const o = mk(s);
  o.addScan("A");
  s.setItem = () => { const e = new Error("full"); e.name = "QuotaExceededError"; throw e; };
  assert.throws(() => o.addScan("B"), /full/);
  assert.deepEqual(o.items(), [{ code: "A", qty: 1 }]);
  assert.equal(o.pendingCount(), 1);
});

test("removeOne drops the last pending scan of that code only", () => {
  const o = mk(memStorage());
  o.addScan("A"); o.addScan("B"); o.addScan("A");
  o.removeOne("A");
  assert.deepEqual(o.items(), [{ code: "B", qty: 1 }, { code: "A", qty: 1 }]);
  assert.equal(o.pendingCount(), 2);
});

test("removeOne of a sent scan becomes an undo event", () => {
  const s = memStorage();
  const key = "rcv_outbox_v2:r1:7";
  s.setItem(key, JSON.stringify({
    v: 2, rid: "r1", uid: "7", pending: [], inflight: [],
    sent: [{ cid: "c1", events: [{ id: "s1", t: "scan", code: "A", ts: 1 }, { id: "s2", t: "scan", code: "B", ts: 2 }] }],
  }));
  const o = mk(s);
  const ev = o.removeOne("A");
  assert.equal(ev.t, "undo");
  assert.equal(ev.target, "s1");
  assert.deepEqual(o.items(), [{ code: "B", qty: 1 }]);
  assert.deepEqual(JSON.parse(s.getItem(key)).pending, [ev]);
});

test("removeOne of an unknown code returns null", () => {
  const o = mk(memStorage());
  o.addScan("A");
  assert.equal(o.removeOne("Z"), null);
  assert.deepEqual(o.items(), [{ code: "A", qty: 1 }]);
});

test("removeOne persists across reopen", () => {
  const s = memStorage();
  const o = mk(s);
  o.addScan("A"); o.addScan("A");
  o.removeOne("A");
  assert.deepEqual(mk(s).items(), [{ code: "A", qty: 1 }]);
});

test("failed write in removeOne throws and changes nothing", () => {
  const s = memStorage();
  const o = mk(s);
  o.addScan("A"); o.addScan("A");
  s.setItem = () => { throw new Error("full"); };
  assert.throws(() => o.removeOne("A"), /full/);
  assert.deepEqual(o.items(), [{ code: "A", qty: 2 }]);
  assert.equal(o.pendingCount(), 2);
});

// ---- Task 8: Worker-ზე გაგზავნა ----

test("nextPacket keeps the same cid and events until ack", () => {
  const o = mk(memStorage(), "r1", "7", K);
  o.addScan("A"); o.addScan("B");
  const p1 = o.nextPacket("init-1");
  assert.equal(p1.v, 2);
  assert.equal(p1.rid, "r1");
  assert.equal(p1.uid, "7");
  assert.equal(p1.k, K);
  assert.equal(p1.init_data, "init-1");
  assert.deepEqual(p1.events.map((e) => e.code), ["A", "B"]);
  o.addScan("C");
  const p2 = o.nextPacket("init-2");
  assert.equal(p2.cid, p1.cid);
  assert.deepEqual(p2.events, p1.events);
  assert.equal(p2.init_data, "init-2");   // init_data ყოველ ცდაზე ახალი
  assert.equal(o.pendingCount(), 3);      // inflight ჯერ არ მიუღია Worker-ს
  assert.equal(o.ack("other"), false);    // სხვა cid-ის ack არაფერს ცვლის
  assert.equal(o.ack(p1.cid), true);
  assert.equal(o.pendingCount(), 1);
  const p3 = o.nextPacket("init-3");
  assert.notEqual(p3.cid, p1.cid);
  assert.deepEqual(p3.events.map((e) => e.code), ["C"]);
  o.ack(p3.cid);
  assert.equal(o.nextPacket("init-4"), null);
});

test("retry after reload resends the same packet", () => {
  const s = memStorage();
  const o = mk(s, "r1", "7", K);
  o.addScan("A");
  const p1 = o.nextPacket("init-1");
  const again = mk(s, "r1", "7");   // ხელახლა გახსნა, k-ს გარეშე
  const p2 = again.nextPacket("init-2");
  assert.equal(p2.cid, p1.cid);
  assert.deepEqual(p2.events, p1.events);
  assert.equal(p2.k, K);
  assert.equal(p2.init_data, "init-2");
});

test("reconcile drops counted packets", () => {
  const s = memStorage();
  const o = mk(s, "r1", "7", K);
  o.addScan("A");
  const p1 = sendOne(o);
  o.addScan("B");
  const p2 = sendOne(o);
  assert.equal(o.reconcile([p1.cid]), 1);
  const st = JSON.parse(s.getItem("rcv_outbox_v2:r1:7"));
  assert.deepEqual(st.sent.map((p) => p.cid), [p2.cid]);
  assert.equal(o.reconcile([p1.cid]), 0);   // უკვე დათვლილი — ჩაწერის გარეშე
  // დათვლილი სკანი სიაში რჩება (გაუქმებისთვის საჭიროა მისი id)
  assert.deepEqual(o.rows(), [{ code: "B", qty: 1, state: "saved" }, { code: "A", qty: 1, state: "counted" }]);
  assert.equal(o.savedCount({ saved: 1, done_cids: [p1.cid] }), 2);
});

test("reconcile settles an inflight packet the bot already counted", () => {
  const o = mk(memStorage(), "r1", "7", K);
  o.addScan("A");
  const p = o.nextPacket("init");   // Worker-მა მიიღო, პასუხი დაიკარგა
  assert.equal(o.reconcile([p.cid]), 1);
  assert.equal(o.nextPacket("init"), null);
  assert.equal(o.ack(p.cid), false);
  assert.equal(o.pendingCount(), 0);
});

test("savedCount adds sent but uncounted scans", () => {
  const o = mk(memStorage(), "r1", "7", K);
  o.addScan("A"); o.addScan("B");
  const p1 = sendOne(o);
  o.addScan("C");
  sendOne(o);
  o.addScan("D");            // pending — Worker-ს ჯერ არ აქვს
  o.nextPacket("init");      // inflight — ჯერ არ მიუღია
  assert.equal(o.savedCount(null), 3);   // სტატუსამდე: მხოლოდ Worker-ის მიღებული
  assert.equal(o.savedCount({ saved: 5, done_cids: [p1.cid] }), 6);
  assert.equal(o.savedCount({ saved: 2.5, done_cids: [] }), 5.5);
});

test("undo of a sent scan becomes an undo event", () => {
  const o = mk(memStorage(), "r1", "7", K);
  const a = o.addScan("A");
  const p1 = sendOne(o);
  const u = o.undoLast();
  assert.equal(u.t, "undo");
  assert.equal(u.target, a.id);
  assert.deepEqual(o.items(), []);
  const p2 = o.nextPacket("init");
  assert.deepEqual(p2.events, [u]);
  o.ack(p2.cid);
  assert.equal(o.savedCount(null), 0);
  // დათვლილი სკანის გაუქმება: ბოტის saved-ს აკლდება, სანამ ბოტი გაუქმებას დაითვლის
  const b = o.addScan("B");
  const p3 = sendOne(o);
  o.reconcile([p1.cid, p2.cid, p3.cid]);
  const u2 = o.removeOne("B");
  assert.equal(u2.target, b.id);
  sendOne(o);
  assert.equal(o.savedCount({ saved: 1, done_cids: [p1.cid, p2.cid, p3.cid] }), 0);
  assert.deepEqual(o.items(), []);
});

test("cid sorts by time", () => {
  // now()-ის გამოძახებები: addScan (ts), nextPacket (cid) — cid-ები 35 ("z"), 36 ("10"), 13-ნიშნა დრო
  const times = [34, 35, 35, 36, 36, 1761300000000];
  const o = mk(memStorage(), "r1", "7", K, () => times.shift());
  const cids = [];
  for (let i = 0; i < 3; i++) {
    o.addScan("A" + i);        // addScan-ის ts იყენებს now()-ს
    const p = o.nextPacket("init");
    o.ack(p.cid);
    cids.push(p.cid);
  }
  cids.forEach((c) => assert.match(c, /^[0-9a-z]{9}[0-9a-f]{8}$/));
  assert.deepEqual([...cids].sort(), cids);
});

test("a packet holds at most 200 events", () => {
  const o = mk(memStorage(), "r1", "7", K);
  for (let i = 0; i < 250; i++) o.addScan("A");
  const p1 = sendOne(o);
  assert.equal(p1.events.length, 200);
  const p2 = sendOne(o);
  assert.equal(p2.events.length, 50);
  assert.equal(o.pendingCount(), 0);
});

test("k is stored per rid", () => {
  const s = memStorage();
  mk(s, "r1", "7", K).addScan("A");
  assert.equal(mk(s, "r1", "7").nextPacket("init").k, K);
  const other = mk(s, "r2", "7");
  other.addScan("B");
  assert.equal(other.nextPacket("init"), null);
});

test("stale outbox without k is not flushed", () => {
  const s = memStorage();
  mk(s, "r0", "7").addScan("A");          // ფაზა A-ს რიგი — k არ ჰქონდა
  mk(s, "r9", "7", K).addScan("B");       // სხვა მიღება, k-ით
  mk(s, "r1", "7", K).addScan("C");       // მიმდინარე
  mk(s, "r5", "17", K).addScan("D");      // სხვა მომხმარებელი
  assert.deepEqual(RcvOutbox.staleRids(s, "7", "r1").sort(), ["r0", "r9"]);
  assert.equal(mk(s, "r0", "7").nextPacket("init"), null);
  assert.equal(mk(s, "r9", "7").nextPacket("init").k, K);
});

test("rows mark counted, saved and not yet sent scans", () => {
  const o = mk(memStorage(), "r1", "7", K);
  o.addScan("A");
  const p1 = sendOne(o);
  o.reconcile([p1.cid]);
  o.addScan("B");
  sendOne(o);
  o.addScan("C");
  o.addScan("A");
  assert.deepEqual(o.rows(), [
    { code: "A", qty: 2, state: "local" },
    { code: "C", qty: 1, state: "local" },
    { code: "B", qty: 1, state: "saved" },
  ]);
});

test("heartbeat is due only when the pending count changes", () => {
  const s = memStorage();
  const o = mk(s, "r1", "7", K);
  assert.equal(o.hbDue(), null);   // ცარიელი = Worker-ისთვის უცნობი = 0
  o.addScan("A"); o.addScan("B");
  assert.equal(o.hbDue(), 2);
  o.hbSent(2);
  assert.equal(o.hbDue(), null);
  assert.equal(mk(s, "r1", "7").hbDue(), null);   // რესტარტს უძლებს
  sendOne(o);
  assert.equal(o.hbDue(), 0);
  o.hbSent(0);
  assert.equal(o.hbDue(), null);
});

test("legacy send covers only scans not yet sent as packets", () => {
  const s = memStorage();
  const o = mk(s, "r1", "7", K);
  o.addScan("A");
  sendOne(o);                 // Worker-ზე უკვე
  o.addScan("B");
  o.nextPacket("init");       // inflight
  o.addScan("C");
  const u = o.removeOne("A"); // გაუქმება pending-ში
  // იგივე მიღება ფაზა A-ს ძველი ღილაკით (k-ს გარეშე): ძველი გაგზავნა მხოლოდ C-ს აგზავნის
  const legacy = mk(s, "r1", "7");
  assert.deepEqual(legacy.legacyItems(), [{ code: "C", qty: 1 }]);
  legacy.clearAll();
  const after = mk(s, "r1", "7");
  assert.deepEqual(after.legacyItems(), []);
  const p = after.nextPacket("init");          // inflight არ დაიკარგა
  assert.deepEqual(p.events.map((e) => e.code), ["B"]);
  after.ack(p.cid);
  assert.deepEqual(after.nextPacket("init").events, [u]);   // გაუქმებაც
});

// ---- fix round 1: დასრულებული მიღების გასუფთავება (R15) ----

const DAY = 24 * 3600 * 1000;
const T0 = 1761300000000;
function mkAt(storage, rid, uid, k, ts) { return mk(storage, rid, uid, k, () => ts); }

test("closed receipt with nothing unsent is pruned", () => {
  const s = memStorage();
  const o = mk(s, "r1", "7", K);
  o.addScan("A");
  const p = sendOne(o);
  o.reconcile([p.cid]);
  o.addScan("B");
  sendOne(o);                // sent, ჯერ დაუთვლელი (ობოლიც შეიძლება იყოს) — ბოტს აქვს
  assert.equal(o.prune(), true);
  assert.equal(s.getItem("rcv_outbox_v2:r1:7"), null);
  assert.deepEqual(o.items(), []);
  assert.deepEqual(mk(s, "r1", "7").items(), []);
});

test("closed receipt with pending is kept", () => {
  const s = memStorage();
  const o = mk(s, "r1", "7", K);
  o.addScan("A");
  assert.equal(o.prune(), false);            // pending
  o.nextPacket("init");
  assert.equal(o.prune(), false);            // inflight
  assert.deepEqual(mk(s, "r1", "7").items(), [{ code: "A", qty: 1 }]);
  const u = mk(s, "r2", "7", K);
  u.addScan("B");
  sendOne(u);
  u.undoLast();                              // მხოლოდ გაუქმების მოვლენა pending-ში — ისიც გაუგზავნელია
  assert.equal(u.prune(), false);
  assert.ok(s.getItem("rcv_outbox_v2:r2:7"));
});

test("old synced outbox of another rid is pruned on open", () => {
  const s = memStorage();
  const old = mkAt(s, "r0", "7", K, T0);
  old.addScan("A");
  sendOne(old);
  const cur = mkAt(s, "r1", "7", K, T0);     // მიმდინარე მიღება — არასდროს
  cur.addScan("B");
  sendOne(cur);
  const other = mkAt(s, "r0", "8", K, T0);   // სხვა მომხმარებელი
  other.addScan("C");
  sendOne(other);
  assert.deepEqual(RcvOutbox.pruneStale(s, "7", "r1", T0 + 15 * DAY), ["r0"]);
  assert.equal(s.getItem("rcv_outbox_v2:r0:7"), null);
  assert.ok(s.getItem("rcv_outbox_v2:r1:7"));
  assert.ok(s.getItem("rcv_outbox_v2:r0:8"));
});

test("recent or unsent outbox of another rid is kept", () => {
  const s = memStorage();
  const recent = mkAt(s, "r2", "7", K, T0 + 10 * DAY);
  recent.addScan("A");
  sendOne(recent);                                    // სინქრონიზებული, მაგრამ ახალი
  mkAt(s, "r3", "7", undefined, T0).addScan("B");     // ძველი, pending (k-ს გარეშე)
  const inflight = mkAt(s, "r4", "7", K, T0);
  inflight.addScan("C");
  inflight.nextPacket("init");                        // ძველი, inflight
  s.setItem("rcv_outbox_v2:r5:7", "{");               // წაუკითხავი — არ ვშლით
  assert.deepEqual(RcvOutbox.pruneStale(s, "7", "r1", T0 + 15 * DAY), []);
  ["r2", "r3", "r4", "r5"].forEach((rid) => assert.ok(s.getItem(`rcv_outbox_v2:${rid}:7`), rid));
  assert.equal(mk(s, "r4", "7").k(), K);
});

// ---- final fix: გაუგზავნელი გაუქმებაც „ჯერ არ გაიგზავნა"-ა (R22) ----

test("removeOne of a counted scan shows as unsent until acked", () => {
  const o = mk(memStorage(), "r1", "7", K);
  o.addScan("A"); o.addScan("A");
  const p1 = sendOne(o);
  o.reconcile([p1.cid]);
  o.hbSent(0);
  assert.deepEqual(o.rows(), [{ code: "A", qty: 2, state: "counted" }]);
  const u = o.removeOne("A");          // ტელეფონი ხაზგარეშეა — გაუქმება pending-შია
  assert.equal(u.t, "undo");
  assert.equal(o.pendingCount(), 1);
  assert.equal(o.hbDue(), 1);
  assert.deepEqual(o.rows(), [{ code: "A", qty: 1, state: "local" }]);   // ⏳, არა ✓
  o.hbSent(1);
  const p2 = sendOne(o);
  assert.equal(o.pendingCount(), 0);
  assert.equal(o.hbDue(), 0);
  assert.deepEqual(o.rows(), [{ code: "A", qty: 1, state: "saved" }]);   // Worker-ზეა, ბოტს ჯერ არ დაუთვლია
  o.reconcile([p1.cid, p2.cid]);
  assert.deepEqual(o.rows(), [{ code: "A", qty: 1, state: "counted" }]);
});

test("an undo of an inflight scan stays unsent until it is sent (R29)", () => {
  const o = mk(memStorage(), "r1", "7", K);
  o.addScan("A");
  o.nextPacket("init");                // A — inflight (Worker-ს შეიძლება უკვე აქვს, ack დაიკარგა)
  const u = o.undoLast();              // გაუქმება — pending
  assert.equal(u.t, "undo");
  assert.equal(o.pendingCount(), 1);
  assert.notEqual(o.hbDue(), null);
  assert.deepEqual(o.rows(), []);
  o.addScan("B");
  assert.equal(o.pendingCount(), 2);
});
