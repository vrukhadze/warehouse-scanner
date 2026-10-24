// rcv-outbox — მიღების სკანების რიგი localStorage-ში (ჩაწერა წკაპამდე).
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.RcvOutbox = factory();
})(typeof self !== "undefined" ? self : this, function () {
  function keyOf(rid, uid) { return "rcv_outbox_v2:" + rid + ":" + uid; }

  function emptyState(rid, uid) {
    return { v: 2, rid: rid, uid: uid, pending: [], inflight: [], sent: [] };
  }

  function load(storage, key, rid, uid) {
    try {
      var raw = storage.getItem(key);
      if (!raw) return emptyState(rid, uid);
      var s = JSON.parse(raw);
      if (!s || typeof s !== "object") return emptyState(rid, uid);
      ["pending", "inflight", "sent"].forEach(function (k) {
        if (!Array.isArray(s[k])) s[k] = [];
      });
      s.v = 2; s.rid = rid; s.uid = uid;
      return s;
    } catch (e) {
      return emptyState(rid, uid);
    }
  }

  function open(opts) {
    var storage = opts.storage, rid = opts.rid, uid = opts.uid;
    var now = opts.now, rand = opts.rand;
    var key = keyOf(rid, uid);
    var state = load(storage, key, rid, uid);

    // ცვლილება: ჯერ ასლზე, ჩაწერა წარმატებულია -> მხოლოდ მაშინ state-ში
    function commit(mutate) {
      var next = JSON.parse(JSON.stringify(state));
      var result = mutate(next);
      storage.setItem(key, JSON.stringify(next));
      state = next;
      return result;
    }

    // ქრონოლოგიური თანმიმდევრობა: sent, inflight, pending
    function all() { return [].concat(state.sent, state.inflight, state.pending); }

    function liveScans(st) {
      var events = [].concat(st.sent, st.inflight, st.pending);
      var undone = {};
      events.forEach(function (e) { if (e.t === "undo") undone[e.target] = true; });
      return events.filter(function (e) { return e.t === "scan" && !undone[e.id]; });
    }

    function aggregate() {
      var qty = {}, last = {};
      liveScans(state).forEach(function (e, i) {
        qty[e.code] = (qty[e.code] || 0) + 1;
        last[e.code] = i;
      });
      return Object.keys(qty)
        .sort(function (a, b) { return last[b] - last[a]; })
        .map(function (c) { return { code: c, qty: qty[c] }; });
    }

    return {
      addScan: function (code) {
        var ev = { id: rand(16), t: "scan", code: String(code), ts: now() };
        commit(function (st) { st.pending.push(ev); });
        return ev;
      },
      undoLast: function () {
        var live = liveScans(state);
        if (!live.length) return null;
        var target = live[live.length - 1];
        var inPending = state.pending.some(function (e) { return e.id === target.id; });
        if (inPending) {
          commit(function (st) {
            st.pending = st.pending.filter(function (e) { return e.id !== target.id; });
          });
          return target;
        }
        var undo = { id: rand(16), t: "undo", target: target.id, ts: now() };
        commit(function (st) { st.pending.push(undo); });
        return undo;
      },
      items: aggregate,
      pendingCount: function () {
        var undone = {};
        all().forEach(function (e) { if (e.t === "undo") undone[e.target] = true; });
        return [].concat(state.inflight, state.pending).filter(function (e) {
          return e.t === "scan" && !undone[e.id];
        }).length;
      },
      legacyItems: aggregate,
      clearAll: function () {
        try { storage.removeItem(key); } catch (e) { /* ignore */ }
        state = emptyState(rid, uid);
      },
    };
  }

  return { open: open };
});
