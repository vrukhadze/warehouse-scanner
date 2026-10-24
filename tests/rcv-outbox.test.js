const test = require("node:test");
const assert = require("node:assert/strict");
const RcvOutbox = require("../rcv-outbox.js");

function memStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    _m: m,
  };
}
function mk(storage, rid = "r1", uid = "7") {
  let t = 1000, n = 0;
  return RcvOutbox.open({
    storage, rid, uid,
    now: () => (t += 1),
    rand: (len) => String(++n).padStart(len, "0"),
  });
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
    sent: [{ id: "s1", t: "scan", code: "A", ts: 1 }, { id: "s2", t: "scan", code: "B", ts: 2 }],
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
