// rcv-outbox — მიღების სკანების რიგი localStorage-ში (ჩაწერა წკაპამდე) და Worker-ზე გაგზავნა პაკეტებად.
// pending (მოვლენები) → inflight (ერთი პაკეტი {cid, events}, უცვლელი სანამ Worker არ მიიღებს) →
// sent (Worker-მა მიიღო) → counted (ბოტმა დაითვალა; მოვლენები რჩება, რომ გაუქმებამ სკანის id იპოვოს).
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.RcvOutbox = factory();
})(typeof self !== "undefined" ? self : this, function () {
  var PREFIX = "rcv_outbox_v2:";
  var MAX_EVENTS = 200;   // Worker-ის ზღვარი 64 KB: ~70 სიმბოლო მოვლენაზე + init_data
  var STALE_MS = 14 * 24 * 3600 * 1000;   // სხვა მიღების სინქრონიზებული რიგი ამაზე ძველი → იშლება
  function keyOf(rid, uid) { return PREFIX + rid + ":" + uid; }

  function emptyState(rid, uid) {
    return { v: 2, rid: rid, uid: uid, pending: [], inflight: [], sent: [], counted: [] };
  }

  function isPacket(p) { return !!p && typeof p.cid === "string" && Array.isArray(p.events); }

  function load(storage, key, rid, uid) {
    try {
      var raw = storage.getItem(key);
      if (!raw) return emptyState(rid, uid);
      var s = JSON.parse(raw);
      if (!s || typeof s !== "object") return emptyState(rid, uid);
      ["pending", "counted"].forEach(function (k) {
        if (!Array.isArray(s[k])) s[k] = [];
      });
      ["inflight", "sent"].forEach(function (k) {
        s[k] = Array.isArray(s[k]) ? s[k].filter(isPacket) : [];
      });
      s.v = 2; s.rid = rid; s.uid = uid;
      return s;
    } catch (e) {
      return emptyState(rid, uid);
    }
  }

  function flat(packets) {
    var out = [];
    packets.forEach(function (p) { out.push.apply(out, p.events); });
    return out;
  }

  function toSet(list) {
    var set = Object.create(null);
    (Array.isArray(list) ? list : []).forEach(function (x) { set[x] = true; });
    return set;
  }

  // სხვა მიღებების რიგები იმავე მომხმარებლისთვის (გახსნისას მათი დარჩენილიც იგზავნება)
  function staleRids(storage, uid, exceptRid) {
    var out = [], suffix = ":" + uid;
    for (var i = 0; i < storage.length; i++) {
      var key = storage.key(i);
      if (!key || key.indexOf(PREFIX) !== 0 || key.slice(-suffix.length) !== suffix) continue;
      var rid = key.slice(PREFIX.length, key.length - suffix.length);
      if (rid && rid.indexOf(":") === -1 && rid !== String(exceptRid)) out.push(rid);
    }
    return out;
  }

  // გაუგზავნელი არაფერია (pending — გაუქმების მოვლენაც — და inflight ცარიელია) → წაშლა მონაცემს არ კარგავს
  function synced(s) { return !s.pending.length && !s.inflight.length; }

  // სხვა მიღებების სინქრონიზებული რიგები, რომელთა ბოლო მოვლენა 14 დღეზე ძველია → storage-იდან იშლება.
  // გაუგზავნელიანი და წაუკითხავი (დაზიანებული) რიგი არასდროს იშლება. → წაშლილი rid-ები
  function pruneStale(storage, uid, exceptRid, nowMs) {
    var out = [];
    staleRids(storage, uid, exceptRid).forEach(function (rid) {
      var key = keyOf(rid, uid);
      try { JSON.parse(storage.getItem(key)); } catch (e) { return; }
      var s = load(storage, key, rid, uid);
      var newest = 0;
      s.counted.concat(flat(s.sent)).forEach(function (e) { if (e.ts > newest) newest = e.ts; });
      if (!synced(s) || nowMs - newest <= STALE_MS) return;
      try { storage.removeItem(key); out.push(rid); } catch (e) { /* შემდეგ გახსნაზე */ }
    });
    return out;
  }

  function open(opts) {
    var storage = opts.storage, rid = opts.rid, uid = opts.uid;
    var now = opts.now, rand = opts.rand;
    var key = keyOf(rid, uid);
    var state = load(storage, key, rid, uid);
    // k (წევრის გასაღები) მეხსიერებაში; storage-ში შემდეგ ცვლილებასთან ერთად იწერება
    if (opts.k) state.k = String(opts.k);

    // ცვლილება: ჯერ ასლზე, ჩაწერა წარმატებულია -> მხოლოდ მაშინ state-ში
    function commit(mutate) {
      var next = JSON.parse(JSON.stringify(state));
      var result = mutate(next);
      storage.setItem(key, JSON.stringify(next));
      state = next;
      return result;
    }

    // ყველა მოვლენა ქრონოლოგიურად (ts-ით; ბოტმა პაკეტები შეიძლება სხვა რიგით დაითვალოს)
    function events(st) {
      return [].concat(st.counted, flat(st.sent), flat(st.inflight), st.pending)
        .sort(function (a, b) { return a.ts - b.ts; });
    }

    function undoneSet(list) {
      var undone = Object.create(null);
      list.forEach(function (e) { if (e.t === "undo") undone[e.target] = true; });
      return undone;
    }

    function liveScans(st) {
      var all = events(st), undone = undoneSet(all);
      return all.filter(function (e) { return e.t === "scan" && !undone[e.id]; });
    }

    // scans → [{code, qty}], ბოლო კოდი პირველი. where (id → counted/saved) → სტრიქონს state ემატება —
    // ყველაზე „ახალი": local (ჯერ არ გაიგზავნა) > saved (Worker-შია) > counted (ბოტმა დაითვალა).
    // marks ([{code, state}] — გაუქმებები) სტრიქონის state-ს ასევე აახლებს, თუ ეს კოდი ჯერ კიდევ ჩანს
    function aggregate(scans, where, marks) {
      var rank = { counted: 0, saved: 1, local: 2 };
      var qty = {}, last = {}, st = {};
      scans.forEach(function (e, i) {
        qty[e.code] = (qty[e.code] || 0) + 1;
        last[e.code] = i;
        var w = (where && where[e.id]) || "local";
        if (!st[e.code] || rank[w] > rank[st[e.code]]) st[e.code] = w;
      });
      (marks || []).forEach(function (m) {
        if (st[m.code] && rank[m.state] > rank[st[m.code]]) st[m.code] = m.state;
      });
      return Object.keys(qty)
        .sort(function (a, b) { return last[b] - last[a]; })
        .map(function (c) {
          var row = { code: c, qty: qty[c] };
          if (where) row.state = st[c];
          return row;
        });
    }

    function whereMap() {
      var where = Object.create(null);
      state.counted.forEach(function (e) { where[e.id] = "counted"; });
      flat(state.sent).forEach(function (e) { where[e.id] = "saved"; });
      return where;
    }

    // გაუქმება თავისი სკანის კოდის სტრიქონს თავის მდგომარეობას აძლევს: გაუგზავნელი გაუქმება → ⏳ (არა ✓)
    function undoMarks(where) {
      var all = events(state), codeOf = Object.create(null), out = [];
      all.forEach(function (e) { if (e.t === "scan") codeOf[e.id] = e.code; });
      all.forEach(function (e) {
        if (e.t === "undo" && codeOf[e.target] !== undefined) {
          out.push({ code: codeOf[e.target], state: where[e.id] || "local" });
        }
      });
      return out;
    }

    function pendingScans(st) { return st.pending.filter(function (e) { return e.t === "scan"; }); }

    // ჯერ გასაგზავნი ცვლილებები (R22): pending + inflight-ის ცოცხალი სკანები და გაუქმებები. სკანი და მისი
    // გაუქმება, ორივე ჯერ გაუგზავნელი, ერთმანეთს აბათილებს (0). ეს რიცხვია ბანერიც, hbDue-ც და hb-ის pending-იც
    function pendingCount() {
      var unsent = flat(state.inflight).concat(state.pending);
      var undone = undoneSet(events(state)), mine = Object.create(null);
      unsent.forEach(function (e) { if (e.t === "scan") mine[e.id] = true; });
      return unsent.filter(function (e) {
        if (e.t === "scan") return !undone[e.id];
        return e.t === "undo" && !mine[e.target];
      }).length;
    }

    // pending სკანი იშლება; გაგზავნილზე/გზაშიყოფილზე/დათვლილზე undo-მოვლენა ემატება
    function removeScan(target) {
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
    }

    return {
      addScan: function (code) {
        var ev = { id: rand(16), t: "scan", code: String(code), ts: now() };
        commit(function (st) { st.pending.push(ev); });
        return ev;
      },
      undoLast: function () {
        var live = liveScans(state);
        return live.length ? removeScan(live[live.length - 1]) : null;
      },
      removeOne: function (code) {
        code = String(code);
        var live = liveScans(state).filter(function (e) { return e.code === code; });
        return live.length ? removeScan(live[live.length - 1]) : null;
      },
      items: function () { return aggregate(liveScans(state)); },
      rows: function () {
        var where = whereMap();
        return aggregate(liveScans(state), where, undoMarks(where));
      },
      pendingCount: pendingCount,
      // ფაზა A-ს ძველი გაგზავნა (k-ს გარეშე): მხოლოდ ის, რაც პაკეტად ჯერ არ წასულა — თორემ ორჯერ ჩაითვლება
      legacyItems: function () { return aggregate(pendingScans(state)); },
      // ძველი გაგზავნის შემდეგ: pending სკანები იშლება; პაკეტები და გაუქმების მოვლენები რჩება
      clearAll: function () {
        var rest = state.pending.filter(function (e) { return e.t !== "scan"; });
        if (!rest.length && !state.inflight.length && !state.sent.length && !state.counted.length) {
          try { storage.removeItem(key); } catch (e) { /* ignore */ }
          state = emptyState(rid, uid);
          return;
        }
        try {
          commit(function (st) { st.pending = rest; });
        } catch (e) {
          state.pending = rest;   // როგორც removeItem-ის ჩავარდნისას — მეხსიერებაში მაინც
        }
      },

      // გასაგზავნი პაკეტი: ჯერ არსებული inflight (იგივე cid და მოვლენები), მერე pending-იდან ახალი.
      // init_data ყოველ ცდაზე ახალია და პაკეტში არ ინახება. k-ს გარეშე → null (ვერ გაიგზავნება).
      nextPacket: function (initData) {
        if (!state.k) return null;
        var p = state.inflight[0];
        if (!p) {
          if (!state.pending.length) return null;
          p = { cid: now().toString(36).padStart(9, "0") + rand(8), events: state.pending.slice(0, MAX_EVENTS) };
          commit(function (st) {
            st.inflight = [p];
            st.pending = st.pending.slice(p.events.length);
          });
        }
        return {
          cid: p.cid, rid: rid, uid: uid, k: state.k, v: 2,
          init_data: String(initData || ""), events: JSON.parse(JSON.stringify(p.events)),
        };
      },
      // Worker-მა მიიღო → sent. სხვა cid (მაგ. უკვე დათვლილი) → false
      ack: function (cid) {
        var p = state.inflight[0];
        if (!p || p.cid !== cid) return false;
        commit(function (st) { st.sent.push(st.inflight.shift()); });
        return true;
      },
      // ბოტის done_cids → ეს პაკეტები დათვლილია (sent-იდან, ან inflight-იდან, თუ Worker-ის პასუხი დაიკარგა)
      reconcile: function (doneCids) {
        var done = toSet(doneCids);
        var hit = function (p) { return done[p.cid] === true; };
        if (!state.sent.some(hit) && !state.inflight.some(hit)) return 0;
        var n = 0;
        commit(function (st) {
          ["sent", "inflight"].forEach(function (k) {
            st[k] = st[k].filter(function (p) {
              if (!hit(p)) return true;
              st.counted.push.apply(st.counted, p.events);
              n++;
              return false;
            });
          });
        });
        return n;
      },
      // „შენახულია": ბოტის დათვლილი + Worker-ში მყოფი, ჯერ დაუთვლელი (სკანი +1, გაუქმება −1 —
      // გაუქმების სკანი ყოველთვის ადრინდელ, უკვე მიღებულ პაკეტშია). status null → მხოლოდ Worker-ის მიღებული.
      savedCount: function (status) {
        var n = status ? Number(status.saved) : 0;
        if (!isFinite(n)) n = 0;
        var done = toSet(status && status.done_cids);
        state.sent.forEach(function (p) {
          if (done[p.cid] === true) return;
          p.events.forEach(function (e) {
            if (e.t === "scan") n += 1;
            else if (e.t === "undo") n -= 1;
          });
        });
        return n;
      },
      // heartbeat მხოლოდ ცვლილებისას: გაუგზავნელის რიცხვი (pendingCount — გაუქმებებიც), თუ Worker-ს სხვა აქვს; თორემ null
      hbDue: function () {
        var n = pendingCount();
        var last = typeof state.lastHb === "number" ? state.lastHb : 0;
        return state.k && n !== last ? n : null;
      },
      hbSent: function (n) {
        commit(function (st) { st.lastHb = n; });
      },
      k: function () { return state.k || null; },
      // დახურული მიღება: გაუგზავნელი არაფერია → რიგი storage-იდან იშლება (sent/counted ბოტს აქვს). → true | false
      prune: function () {
        if (!synced(state)) return false;
        storage.removeItem(key);
        state = emptyState(rid, uid);
        return true;
      },
    };
  }

  return { open: open, staleRids: staleRids, pruneStale: pruneStale };
});
