import { renderMap } from "./map.js";

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const rupee = (n) => `₹${n}`;
const hhmm = (h) => `${String(h).padStart(2, "0")}:00`;

const LS = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { localStorage.setItem(k, JSON.stringify(v)); },
};

const state = {
  meta: null,
  origin: "isbt",
  dest: "chhotashimla",
  vehicle: "4W",
  hour: 10,
  offset: 20,
  prediction: null,
  selectedId: null,
  focusNode: null,
  spaces: LS.get("smartpark.spaces", []),
  bookings: LS.get("smartpark.bookings", []),
  lastRaw: null,
  lastBooking: null,
};

/* ---------------- tabs ---------------- */
$$("#tabs .tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    $$("#tabs .tab").forEach((b) => b.classList.toggle("is-active", b === btn));
    $$(".panel").forEach((p) => p.classList.toggle("is-active", p.id === `panel-${btn.dataset.tab}`));
  });
});

/* ---------------- helpers ---------------- */
function bookedCounts() {
  const map = {};
  for (const b of state.bookings) {
    if (b.status !== "active") continue;
    map[b.zoneId] = (map[b.zoneId] || 0) + 1;
  }
  return map;
}

function zoneName(id) {
  const z = state.meta?.zones.find((x) => x.id === id);
  return z ? z.name : id;
}

/* ---------------- prediction ---------------- */
async function predict() {
  const btn = $("#predictBtn");
  btn.disabled = true;
  btn.textContent = "Computing in C++…";
  try {
    const res = await fetch("/api/predict", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        query: { origin: state.origin, destination: state.dest, vehicle: state.vehicle, hour: state.hour, offset: state.offset },
        spaces: state.spaces,
        booked: bookedCounts(),
      }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    state.prediction = data;
    state.lastRaw = data;
    if (!data.results.some((r) => r.id === state.selectedId)) state.selectedId = data.results[0]?.id || null;
    renderAll();
  } catch (e) {
    $("#results").innerHTML = `<div class="card"><div class="card-head"><span class="tag">Engine error</span></div>
      <p style="padding:16px">${esc(e.message)}</p></div>`;
  } finally {
    btn.disabled = false;
    btn.textContent = "Predict best parking";
  }
}

function renderAll() {
  const d = state.prediction;
  if (!d) return;
  $("#trafficLabel").textContent = `${d.traffic.label}`;
  $("#trafficBar").style.width = `${Math.round(d.traffic.factor * 100)}%`;
  renderMap($("#map"), state.meta, {
    prediction: d,
    selectedId: state.selectedId,
    focusNode: state.focusNode,
    onSelect: (id) => {
      const all = d.all || d.results;
      if (!all.some((r) => r.id === id)) return;
      state.selectedId = id;
      renderAll();
    },
    onFocus: (nodeId) => {
      state.focusNode = nodeId;
      renderAll();
    },
  });
  renderResults();
  renderRaw();
}

function timelineMarkup(r) {
  const max = Math.max(1, r.capacity);
  return `<div class="timeline">
    <div class="micro">Predicted free slots · next 60 minutes</div>
    <div class="bars">
      ${r.timeline.map((t) => {
        const pct = Math.max(3, Math.round((t.free / max) * 100));
        return `<div class="col ${t.free <= max * 0.12 ? "low" : ""}">
          <b>${t.free}</b>
          <i style="height:${pct}%"></i>
          <em>${t.min === 0 ? "now" : "+" + t.min}</em>
        </div>`;
      }).join("")}
    </div>
  </div>`;
}

function routeMarkup(r) {
  const stops = r.route.stops.map((s) => `<span>${esc(s.name)}</span>`).join('<span class="arrow">→</span>');
  return `<div class="route-steps">
    <div class="micro">Route · ${r.route.km} km · ${r.route.minutes} min drive</div>
    <div class="stops">${stops}</div>
    <ul class="roads">${r.route.roads.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>
  </div>`;
}

function renderResults() {
  const d = state.prediction;
  const all = d.all || d.results;
  const best = all.find((r) => r.id === state.selectedId) || all[0];
  if (!best) {
    $("#results").innerHTML = `<div class="empty">No parking supports this vehicle type.</div>`;
    return;
  }
  const rank = all.findIndex((r) => r.id === best.id) + 1;
  const isBest = rank === 1;
  const offsetLabel = d.offset === 0 ? "right now" : `in ${d.offset} min`;

  $("#results").innerHTML = `
    <article class="card">
      <div class="card-head">
        <span class="tag">${isBest ? "Best match" : `Option ${rank} of ${all.length}`}</span>
        <span class="score">score ${best.score} / 100</span>
      </div>
      <h3>${esc(best.name)}${best.community ? '<span class="badge">Community</span>' : ""}</h3>
      <p class="sub">${best.capacity} slots · ${rupee(best.price)}/hr ·
        ${[best.covered && "Covered", best.cctv && "CCTV", best.guard && "Guard", best.ev && "EV"].filter(Boolean).join(" · ") || "Open lot"}
        · ${best.confidence}% confidence</p>

      <div class="metrics">
        <div><span>Free ${offsetLabel}</span><strong>${best.predicted}</strong><small>predicted slots</small></div>
        <div><span>Free now</span><strong>${best.freeNow}</strong><small>live estimate</small></div>
        <div><span>Drive</span><strong>${best.etaMin}<small style="font-size:11px"> min</small></strong><small>${best.km} km</small></div>
        <div><span>Walk to dest.</span><strong>${best.walkMin}<small style="font-size:11px"> min</small></strong><small>${esc(d.destination.name)}</small></div>
      </div>

      ${timelineMarkup(best)}
      ${routeMarkup(best)}

      <div class="actions">
        <button class="btn primary" data-book="${esc(best.id)}">
          ${best.predicted < 1 ? "Join waitlist / book last slot" : "Book a slot here"}
        </button>
        <p class="form-msg" id="bookMsg">${state.lastBooking && state.lastBooking.zoneId === best.id
          ? `Booked · code ${state.lastBooking.code} · ${rupee(state.lastBooking.amount)}`
          : ""}</p>
      </div>
    </article>

    <div class="alt-wrap">
      <div class="card-head"><span class="tag">Other lots ranked by score</span>
        <span class="score">${d.results.length} of ${all.length}</span></div>
      ${d.results.map((r, i) => `
        <div class="alt ${r.id === best.id ? "is-on" : ""}" data-select="${esc(r.id)}">
          <div>
            <div class="nm">${esc(r.name)}${r.community ? '<span class="badge">Community</span>' : ""}</div>
            <div class="meta">${r.etaMin} min drive · ${r.km} km · ${r.walkMin} min walk ·
              ${rupee(r.price)}/hr · ${r.capacity} slots</div>
          </div>
          <div class="sc"><span class="free">${r.predicted}</span>
            <small>${i === 0 ? "BEST" : "FREE " + (d.offset ? "+" + d.offset : "NOW")}</small></div>
        </div>`).join("")}
    </div>`;

  $$("[data-book]").forEach((b) => b.addEventListener("click", () => book(b.dataset.book)));
  $$("[data-select]").forEach((row) => row.addEventListener("click", () => {
    state.selectedId = row.dataset.select;
    renderAll();
  }));
}

function renderRaw() {
  const out = $("#rawOutput");
  if (out && state.lastRaw) out.textContent = JSON.stringify(state.lastRaw, null, 2).slice(0, 4000);
}

/* ---------------- booking ---------------- */
function book(zoneId) {
  const r = (state.prediction?.all || state.prediction?.results || []).find((x) => x.id === zoneId);
  if (!r) return;
  const start = new Date(Date.now() + state.offset * 60000);
  const code = "PK" + Math.random().toString(36).slice(2, 7).toUpperCase();
  const booking = {
    id: "bk-" + Date.now(),
    code,
    zoneId,
    zoneName: r.name,
    vehicle: state.vehicle,
    start: start.toISOString(),
    minutes: 60,
    amount: r.price,
    status: "active",
  };
  state.bookings.push(booking);
  state.lastBooking = booking;
  LS.set("smartpark.bookings", state.bookings);
  $("#bookingCount").textContent = state.bookings.filter((b) => b.status === "active").length;
  renderBookings();
  predict();
}

function cancelBooking(id) {
  const b = state.bookings.find((x) => x.id === id);
  if (!b) return;
  b.status = "cancelled";
  LS.set("smartpark.bookings", state.bookings);
  $("#bookingCount").textContent = state.bookings.filter((x) => x.status === "active").length;
  renderBookings();
  predict();
}

function renderBookings() {
  const list = $("#bookingList");
  const active = state.bookings.filter((b) => b.status === "active");
  $("#bookingCount").textContent = active.length;

  list.innerHTML = state.bookings.length
    ? [...state.bookings].reverse().map((b) => `
      <div class="item">
        <div class="top">
          <strong>${esc(b.zoneName)}</strong>
          <span class="code">${esc(b.code)}</span>
        </div>
        <div class="meta">${new Date(b.start).toLocaleString()} · ${b.minutes} min ·
          ${b.vehicle} · ${rupee(b.amount)} ${b.status === "cancelled" ? "· cancelled" : ""}</div>
        ${b.status === "active" ? `<div class="actions-row">
            <button class="btn small ghost" data-cancel="${esc(b.id)}">Cancel</button>
          </div>` : ""}
      </div>`).join("")
    : `<div class="empty">No bookings yet. Predict a lot and book a slot.</div>`;

  const ledger = bookedCounts();
  const ids = Object.keys(ledger);
  $("#ledger").innerHTML = ids.length
    ? ids.map((id) => `<div class="item"><div class="top">
        <strong>${esc(zoneName(id))}</strong><span class="code">${ledger[id]}</span></div>
        <div class="meta">slot${ledger[id] > 1 ? "s" : ""} held by you</div></div>`).join("")
    : `<div class="empty">Nothing held.</div>`;

  $$("[data-cancel]").forEach((btn) => btn.addEventListener("click", () => cancelBooking(btn.dataset.cancel)));
}

/* ---------------- space listing ---------------- */
function renderMySpaces() {
  const box = $("#mySpaces");
  box.innerHTML = state.spaces.length
    ? state.spaces.map((s) => `
      <div class="item">
        <div class="top"><strong>${esc(s.name)}</strong><span class="code">${s.capacity}</span></div>
        <div class="meta">${esc(s.nodeName)} · ${rupee(s.price)}/hr · ${s.vehicles.join(", ")}<br>
          ${[s.covered && "covered", s.cctv && "CCTV", s.guard && "guard", s.ev && "EV"].filter(Boolean).join(" · ") || "basic"}
          ${s.from && s.to ? ` · ${s.from}–${s.to}` : ""}<br>
          ${esc(s.owner)}${s.phone ? " · " + esc(s.phone) : ""}</div>
        ${s.notes ? `<div class="meta">“${esc(s.notes)}”</div>` : ""}
        <div class="actions-row"><button class="btn small ghost" data-del="${esc(s.id)}">Remove</button></div>
      </div>`).join("")
    : `<div class="empty">No spaces listed yet.</div>`;

  $$("[data-del]").forEach((btn) => btn.addEventListener("click", () => {
    state.spaces = state.spaces.filter((s) => s.id !== btn.dataset.del);
    LS.set("smartpark.spaces", state.spaces);
    renderMySpaces();
    predict();
  }));
}

$("#spaceForm").addEventListener("submit", (ev) => {
  ev.preventDefault();
  const f = ev.target;
  const msg = $("#spaceMsg");
  const nodeId = f.node.value;
  const nodeName = state.meta.nodes.find((n) => n.id === nodeId)?.name || nodeId;
  const vehicles = [...$("#spaceVehicles").querySelectorAll("input:checked")].map((c) => c.value);
  const owner = f.owner.value.trim();
  const name = f.name.value.trim();
  const phone = f.phone.value.trim();

  const fail = (t) => { msg.className = "form-msg err"; msg.textContent = t; };
  if (!owner) return fail("Owner name is required.");
  if (!/^\d{10}$/.test(phone)) return fail("Enter a 10-digit phone number.");
  if (!name) return fail("Give the space a name.");
  if (!vehicles.length) return fail("Select at least one vehicle type.");

  const space = {
    id: "u-" + Date.now(),
    name,
    node: nodeId,
    nodeName,
    capacity: Math.max(1, Number(f.capacity.value) || 1),
    price: Math.max(0, Number(f.price.value) || 0),
    vehicles,
    covered: f.covered.checked,
    cctv: f.cctv.checked,
    guard: f.guard.checked,
    ev: f.ev.checked,
    from: f.from.value,
    to: f.to.value,
    notes: f.notes.value.trim(),
    owner,
    phone,
    popularity: 0.85,
  };
  state.spaces.push(space);
  LS.set("smartpark.spaces", state.spaces);
  f.reset();
  f.capacity.value = 2;
  f.price.value = 20;
  f.from.value = "07:00";
  f.to.value = "21:00";
  $$("#spaceVehicles input").forEach((c) => (c.checked = true));
  msg.className = "form-msg ok";
  msg.textContent = `“${name}” published in ${nodeName} — it is now visible to drivers booking that area.`;
  renderMySpaces();
  predict();
});

/* ---------------- controls ---------------- */
function fillSelects() {
  const nodes = [...state.meta.nodes].sort((a, b) => a.name.localeCompare(b.name));
  $("#origin").innerHTML = nodes.map((n) => `<option value="${n.id}">${esc(n.name)}</option>`).join("");
  $("#dest").innerHTML = nodes.map((n) => `<option value="${n.id}">${esc(n.name)}</option>`).join("");
  $("#spaceNode").innerHTML = nodes.map((n) => `<option value="${n.id}">${esc(n.name)}</option>`).join("");
  $("#origin").value = state.origin;
  $("#dest").value = state.dest;
  $("#spaceNode").value = "sanjauli";
}

$("#origin").addEventListener("change", (e) => { state.origin = e.target.value; predict(); });
$("#dest").addEventListener("change", (e) => { state.dest = e.target.value; predict(); });
$("#offset").addEventListener("change", (e) => { state.offset = Number(e.target.value); predict(); });
$("#predictBtn").addEventListener("click", predict);

$("#hour").addEventListener("input", (e) => {
  state.hour = Number(e.target.value);
  $("#hourOut").textContent = hhmm(state.hour);
});
$("#hour").addEventListener("change", () => predict());

$$("#vehicle button").forEach((b) => b.addEventListener("click", () => {
  $$("#vehicle button").forEach((x) => x.classList.toggle("is-on", x === b));
  state.vehicle = b.dataset.v;
  predict();
}));

/* ---------------- init ---------------- */
async function init() {
  const now = new Date();
  state.hour = now.getHours();
  const slider = $("#hour");
  slider.value = String(state.hour);
  $("#hourOut").textContent = hhmm(state.hour);

  try {
    const meta = await (await fetch("/api/meta")).json();
    if (meta.error) throw new Error(meta.error);
    state.meta = meta;
    $("#engineStatus").classList.add("ok");
    $("#engineLabel").textContent = `C++ engine online · ${meta.zones.length} lots · ${meta.nodes.length} localities`;
  } catch (e) {
    $("#engineStatus").classList.add("bad");
    $("#engineLabel").textContent = "C++ engine offline — start the Node server";
    $("#results").innerHTML = `<div class="card"><div class="card-head"><span class="tag">Engine offline</span></div>
      <p style="padding:16px">Run <code>npm start</code> (it compiles the C++ engine and serves this page).</p></div>`;
    return;
  }

  fillSelects();
  renderMySpaces();
  renderBookings();
  await predict();
}

init();
