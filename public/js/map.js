const NS = "http://www.w3.org/2000/svg";
const W = 1000, H = 670, PAD = 76;
const B = { latMin: 31.0870, latMax: 31.1150, lngMin: 77.1180, lngMax: 77.1965 };

const INK = "#0d0d0d";
const PAPER = "#ffffff";
const MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
const SANS = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif";

function project(lat, lng) {
  const x = PAD + ((lng - B.lngMin) / (B.lngMax - B.lngMin)) * (W - 2 * PAD);
  const y = PAD + ((B.latMax - lat) / (B.latMax - B.latMin)) * (H - 2 * PAD);
  return { x, y };
}

function el(name, attrs = {}, text) {
  const n = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (text !== undefined) n.textContent = text;
  return n;
}

function txt(x, y, str, o = {}) {
  return el("text", {
    x, y,
    "text-anchor": o.anchor || "middle",
    "font-family": o.sans ? SANS : MONO,
    "font-size": o.size || 10,
    "letter-spacing": o.ls ?? (o.sans ? "0" : "0.1em"),
    "font-weight": o.weight || 400,
    fill: o.fill || INK,
    ...(o.halo ? { stroke: PAPER, "stroke-width": 3, "paint-order": "stroke", "stroke-linejoin": "round" } : {}),
    ...(o.class ? { class: o.class } : {}),
    ...(o.opacity ? { opacity: o.opacity } : {}),
  }, str);
}

const clip = (s, n) => (!s ? "" : s.length > n ? s.slice(0, n - 1) + "…" : s);

// short forms keep the map labels clear of each other in the crowded areas
const MAP_NAME = { isbt: "ISBT" };

export function renderMap(svg, meta, opts = {}) {
  const {
    prediction = null,
    selectedId = null,
    focusNode = null,
    onSelect = () => {},
    onFocus = () => {},
  } = opts;

  svg.innerHTML = "";

  /* ---------------- defs ---------------- */
  const defs = el("defs");
  defs.appendChild(el("filter", {
    id: "cardShadow", x: "-30%", y: "-30%", width: "160%", height: "160%",
  })).appendChild(el("feDropShadow", {
    dx: 0, dy: 3, stdDeviation: 5, "flood-color": INK, "flood-opacity": 0.16,
  }));
  const arrow = el("marker", {
    id: "routeArrow", viewBox: "0 0 10 10", refX: 9, refY: 5,
    markerWidth: 5, markerHeight: 5, orient: "auto-start-reverse",
  });
  arrow.appendChild(el("path", { d: "M 0 0 L 10 5 L 0 10 z", fill: INK }));
  defs.appendChild(arrow);
  svg.appendChild(defs);

  /* ---------------- paper ---------------- */
  svg.appendChild(el("rect", { x: 0, y: 0, width: W, height: H, fill: PAPER }));

  const contour = el("g", { opacity: 0.9 });
  for (let i = 0; i < 10; i++) {
    const y = 40 + i * 76;
    contour.appendChild(el("path", {
      d: `M -60 ${y} C 170 ${y - 54}, 330 ${y + 58}, 520 ${y + 4} S 840 ${y - 62}, ${W + 60} ${y + 20}`,
      fill: "none",
      stroke: i % 2 ? "#f2f2f2" : "#eaeaea",
      "stroke-width": i % 2 ? 1 : 1.2,
    }));
  }
  svg.appendChild(contour);

  for (let x = PAD; x <= W - PAD; x += 94)
    svg.appendChild(el("line", { x1: x, y1: 24, x2: x, y2: H - 24, stroke: "#f7f7f7", "stroke-width": 1 }));
  for (let y = 40; y <= H - 40; y += 94)
    svg.appendChild(el("line", { x1: 24, y1: y, x2: W - 24, y2: y, stroke: "#f7f7f7", "stroke-width": 1 }));

  /* ---------------- data ---------------- */
  const nodeById = new Map(meta.nodes.map((n) => [n.id, n]));
  const pos = (id) => {
    const n = nodeById.get(id);
    return n ? project(n.lat, n.lng) : { x: W / 2, y: H / 2 };
  };

  const predList = prediction ? prediction.all || prediction.results || [] : [];
  const predById = new Map(predList.map((r) => [r.id, r]));

  const lots = meta.zones.map((z) => {
    const r = predById.get(z.id);
    return {
      id: z.id, name: z.name, node: z.node, capacity: z.capacity, price: z.price,
      community: !!z.community, predicted: r ? r.predicted : null,
      score: r ? r.score : null, walkMin: r ? r.walkMin : null,
    };
  });
  // spaces listed by users are not in META yet — they arrive with the prediction
  const known = new Set(lots.map((l) => l.id));
  for (const r of predList) {
    if (known.has(r.id)) continue;
    lots.push({
      id: r.id, name: r.name, node: r.node, capacity: r.capacity, price: r.price,
      community: true, predicted: r.predicted, score: r.score, walkMin: r.walkMin,
    });
  }

  // when a prediction exists, only lots that accept the chosen vehicle are shown
  const visibleLots = prediction ? lots.filter((l) => predById.has(l.id)) : lots;

  const lotsByNode = new Map();
  for (const l of visibleLots) {
    if (!lotsByNode.has(l.node)) lotsByNode.set(l.node, []);
    lotsByNode.get(l.node).push(l);
  }
  for (const list of lotsByNode.values()) {
    list.sort((a, b) => (b.predicted ?? -1) - (a.predicted ?? -1));
  }

  /* ---------------- roads ---------------- */
  const roads = el("g");
  svg.appendChild(roads);
  const byBusy = (b) => (b > 0.65 ? 0.30 : b > 0.45 ? 0.21 : 0.13);
  for (const e of meta.edges) {
    const a = pos(e.a), b = pos(e.b);
    roads.appendChild(el("line", {
      x1: a.x, y1: a.y, x2: b.x, y2: b.y,
      stroke: "#f4f4f4", "stroke-width": 8, "stroke-linecap": "round",
    }));
    roads.appendChild(el("line", {
      x1: a.x, y1: a.y, x2: b.x, y2: b.y,
      stroke: INK, "stroke-width": 1.3 + e.busy * 2.6, "stroke-linecap": "round",
      opacity: byBusy(e.busy),
    }));
  }

  /* ---------------- chosen route ---------------- */
  const pool = prediction ? predList : [];
  const chosen = pool.find((r) => r.id === selectedId) || pool[0] || null;

  if (chosen && chosen.route && chosen.route.stops.length > 1) {
    const pts = chosen.route.stops.map((s) => {
      const p = project(s.lat, s.lng);
      return `${p.x},${p.y}`;
    }).join(" ");
    const g = el("g");
    g.appendChild(el("polyline", {
      points: pts, fill: "none", stroke: PAPER, "stroke-width": 8,
      "stroke-linecap": "round", "stroke-linejoin": "round",
    }));
    g.appendChild(el("polyline", {
      points: pts, fill: "none", stroke: INK, "stroke-width": 3.2,
      "stroke-linecap": "round", "stroke-linejoin": "round",
      "marker-end": "url(#routeArrow)", class: "route-line",
    }));
    chosen.route.stops.slice(1, -1).forEach((s) => {
      const p = project(s.lat, s.lng);
      g.appendChild(el("circle", { cx: p.x, cy: p.y, r: 2.8, fill: PAPER, stroke: INK, "stroke-width": 1.4 }));
    });
    svg.appendChild(g);
  }

  /* ---------------- origin & destination ---------------- */
  if (prediction) {
    const o = project(prediction.origin.lat, prediction.origin.lng);
    const d = project(prediction.destination.lat, prediction.destination.lng);

    const go = el("g");
    go.appendChild(el("circle", { cx: o.x, cy: o.y, r: 11, fill: PAPER, stroke: INK, "stroke-width": 1.4 }));
    go.appendChild(el("circle", { cx: o.x, cy: o.y, r: 4.5, fill: INK }));
    go.appendChild(txt(o.x, o.y + 27, "YOU", { size: 8.5, ls: "0.16em", halo: true }));
    svg.appendChild(go);

    const gd = el("g");
    gd.appendChild(el("rect", {
      x: d.x - 11, y: d.y - 11, width: 22, height: 22,
      fill: PAPER, stroke: INK, "stroke-width": 1.6, transform: `rotate(45 ${d.x} ${d.y})`,
    }));
    gd.appendChild(el("rect", {
      x: d.x - 4, y: d.y - 4, width: 8, height: 8, fill: INK,
      transform: `rotate(45 ${d.x} ${d.y})`,
    }));
    gd.appendChild(txt(d.x, d.y + 29, "DESTINATION", { size: 8, ls: "0.14em", halo: true }));
    svg.appendChild(gd);
  }

  /* ---------------- node points + labels ---------------- */
  const gNodes = el("g");
  svg.appendChild(gNodes);
  for (const n of meta.nodes) {
    const p = project(n.lat, n.lng);
    gNodes.appendChild(el("circle", { cx: p.x, cy: p.y, r: 3.4, fill: INK }));
  }

  /* ---------------- lot markers (stacked per location) ---------------- */
  const BW = 54, BH = 32, LIFT = 34;
  const gMarks = el("g");
  svg.appendChild(gMarks);

  const overlap = (a, b) => {
    const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
    const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
    return w > 0 && h > 0 ? w * h : 0;
  };

  // badges claim space first, then each name label picks the least crowded side
  const badgeBoxes = [];
  for (const n of meta.nodes) {
    if (!(lotsByNode.get(n.id) || []).length) continue;
    const p = project(n.lat, n.lng);
    badgeBoxes.push({ x: p.x - BW / 2 - 4, y: p.y - LIFT - BH / 2 - 12, w: BW + 16, h: BH + 18 });
  }

  // keep the YOU / DESTINATION markers clear of location labels
  if (prediction) {
    for (const pt of [prediction.origin, prediction.destination]) {
      const p = project(pt.lat, pt.lng);
      badgeBoxes.push({ x: p.x - 14, y: p.y - 12, w: 28, h: 44 });
    }
  }

  const labelPlan = new Map();
  const ordered = [...meta.nodes].sort((a, b) => {
    const pa = project(a.lat, a.lng), pb = project(b.lat, b.lng);
    return pa.y - pb.y || pa.x - pb.x;
  });
  for (const n of ordered) {
    if (!(lotsByNode.get(n.id) || []).length) continue;
    const p = project(n.lat, n.lng);
    const cy = p.y - LIFT;
    const name = clip((MAP_NAME[n.id] || n.name).toUpperCase(), 17);
    const w = Math.max(34, name.length * 6.2);
    const cands = [
      { x: p.x - w / 2, y: cy - BH / 2 - 22, w, h: 11, anchor: "middle", bx: p.x, by: cy - BH / 2 - 12 },
      { x: p.x + BW / 2 + 8, y: cy - 6, w, h: 11, anchor: "start", bx: p.x + BW / 2 + 8, by: cy + 3.5 },
      { x: p.x - BW / 2 - 8 - w, y: cy - 6, w, h: 11, anchor: "end", bx: p.x - BW / 2 - 8, by: cy + 3.5 },
      { x: p.x + BW / 2 + 6, y: cy - 24, w, h: 11, anchor: "start", bx: p.x + BW / 2 + 6, by: cy - 14 },
      { x: p.x - BW / 2 - 6 - w, y: cy - 24, w, h: 11, anchor: "end", bx: p.x - BW / 2 - 6, by: cy - 14 },
      { x: p.x + BW / 2 + 6, y: cy + 16, w, h: 11, anchor: "start", bx: p.x + BW / 2 + 6, by: cy + 26 },
      { x: p.x - BW / 2 - 6 - w, y: cy + 16, w, h: 11, anchor: "end", bx: p.x - BW / 2 - 6, by: cy + 26 },
    ];
    let best = cands[0], bestScore = Infinity;
    for (const c of cands) {
      let score = 0;
      for (const b of badgeBoxes) score += overlap(c, b) * (b.kind === "label" ? 1 : 3);
      if (c.x < 8 || c.x + c.w > W - 8 || c.y < 8 || c.y + c.h > H - 8) score += 5000;
      if (score < bestScore) { bestScore = score; best = c; }
    }
    badgeBoxes.push({ ...best, kind: "label" });
    labelPlan.set(n.id, { ...best, text: name });
  }

  const drawCard = (node, p, list) => {
    const w = 276, rowH = 40, headH = 30;
    const h = headH + list.length * rowH + 6;
    let x = p.x + 44;
    if (x + w > W - 12) x = p.x - 44 - w;
    x = Math.max(12, Math.min(x, W - w - 12));
    let y = p.y - LIFT - h / 2;
    y = Math.max(12, Math.min(y, H - h - 12));

    const g = el("g", { class: "lot-card", filter: "url(#cardShadow)" });
    g.addEventListener("click", (ev) => ev.stopPropagation());

    const edgeX = x > p.x ? x : x + w;
    g.appendChild(el("line", {
      x1: p.x, y1: p.y - LIFT, x2: edgeX, y2: y + headH / 2,
      stroke: INK, "stroke-width": 1, "stroke-dasharray": "3 3", opacity: 0.45,
    }));

    g.appendChild(el("rect", { x, y, width: w, height: h, fill: PAPER, stroke: INK, "stroke-width": 1.4 }));
    g.appendChild(el("rect", { x, y, width: w, height: headH, fill: INK }));

    g.appendChild(txt(x + 12, y + 19, clip(node.name.toUpperCase(), 22), {
      anchor: "start", size: 9, ls: "0.14em", fill: PAPER, weight: 600,
    }));
    g.appendChild(txt(x + w - 12, y + 19, `${list.length} ${list.length === 1 ? "OPTION" : "OPTIONS"}`, {
      anchor: "end", size: 8.5, ls: "0.14em", fill: PAPER,
    }));

    list.forEach((l, i) => {
      const ry = y + headH + i * rowH;
      const on = selectedId ? l.id === selectedId : false;
      const fg = on ? PAPER : INK;
      const soft = on ? "#c9c9c9" : "#8c8c8c";

      const row = el("g", { class: "lot-row" + (on ? " is-on" : "") });
      row.appendChild(el("rect", { x, y: ry, width: w, height: rowH, class: "hit", fill: PAPER }));
      if (!on) row.appendChild(el("line", {
        x1: x + 12, y1: ry + rowH, x2: x + w - 12, y2: ry + rowH,
        stroke: "#ececec", "stroke-width": 1,
      }));

      row.appendChild(txt(x + 16, ry + 13, "FREE", { anchor: "start", size: 7.5, ls: "0.16em", fill: soft }));
      row.appendChild(txt(x + 16, ry + 31, l.predicted === null ? "–" : String(l.predicted), {
        anchor: "start", size: 17, weight: 600, ls: "0.02em", fill: fg,
      }));

      const short = l.name.toLowerCase().startsWith(node.name.toLowerCase())
        ? l.name.slice(node.name.length).trim() || l.name
        : l.name;
      row.appendChild(txt(x + 54, ry + 18, clip(short, 18), {
        anchor: "start", sans: true, size: 11.5, weight: 600, fill: fg,
      }));
      row.appendChild(txt(x + 54, ry + 31, `₹${l.price}/hr · ${l.capacity} slots${l.community ? " · yours" : ""}`, {
        anchor: "start", size: 8.5, fill: soft,
      }));

      row.appendChild(txt(x + w - 14, ry + 18, l.score === null ? "" : `score ${l.score}`, {
        anchor: "end", size: 9.5, fill: fg,
      }));
      row.appendChild(txt(x + w - 14, ry + 31, l.walkMin === null ? "" : `${l.walkMin} min walk`, {
        anchor: "end", size: 8.5, fill: soft,
      }));

      row.addEventListener("click", (ev) => {
        ev.stopPropagation();
        onSelect(l.id);
      });
      g.appendChild(row);
    });

    // bottom rule under the last row
    g.appendChild(el("line", {
      x1: x, y1: y + h - 6, x2: x + w, y2: y + h - 6, stroke: "#ececec", "stroke-width": 1,
    }));

    svg.appendChild(g);
  };

  for (const n of meta.nodes) {
    const list = lotsByNode.get(n.id) || [];
    if (!list.length) continue;

    const p = project(n.lat, n.lng);
    const cx = p.x, cy = p.y - LIFT;
    const isFocus = focusNode === n.id;
    const total = list.reduce((sum, l) => sum + (l.predicted ?? 0), 0);
    const known = list.some((l) => l.predicted !== null);

    const g = el("g", { class: "zone-mark" + (isFocus ? " is-focus" : "") });
    g.appendChild(el("title", {}, `${n.name} — ${list.length} option${list.length > 1 ? "s" : ""} · ${known ? total + " free predicted" : "no prediction"}`));

    for (let i = Math.min(list.length - 1, 2); i >= 1; i--) {
      g.appendChild(el("rect", {
        x: cx - BW / 2 + i * 4, y: cy - BH / 2 - i * 4, width: BW, height: BH,
        rx: 4, fill: PAPER, stroke: "#dedede", "stroke-width": 1,
      }));
    }

    g.appendChild(el("line", {
      x1: p.x, y1: cy + BH / 2, x2: p.x, y2: p.y - 5,
      stroke: INK, "stroke-width": 1, "stroke-dasharray": "2 3", opacity: 0.55,
    }));

    g.appendChild(el("rect", {
      x: cx - BW / 2, y: cy - BH / 2, width: BW, height: BH, rx: 4,
      class: "face", fill: PAPER, stroke: INK, "stroke-width": 1.6,
    }));
    g.appendChild(txt(cx, cy + 6, known ? String(total) : "–", {
      size: 15, weight: 600, ls: "0.02em", class: "val",
    }));

    if (list.length > 1) {
      g.appendChild(el("rect", { x: cx + 17, y: cy - 29, width: 24, height: 14, rx: 2, fill: INK }));
      g.appendChild(txt(cx + 29, cy - 18.5, `${list.length}`, { size: 8.5, fill: PAPER, weight: 600, ls: "0.02em" }));
    }

    const plan = labelPlan.get(n.id);
    g.appendChild(txt(plan.bx, plan.by, plan.text, {
      anchor: plan.anchor, size: 9, ls: "0.13em", weight: 600, halo: true,
    }));

    g.addEventListener("click", (ev) => {
      ev.stopPropagation();
      onFocus(isFocus ? null : n.id);
    });
    gMarks.appendChild(g);

    if (isFocus) drawCard(n, p, list);
  }

  /* ---------------- compass + scale ---------------- */
  const compass = el("g");
  compass.appendChild(el("line", { x1: W - 46, y1: 54, x2: W - 46, y2: 30, stroke: INK, "stroke-width": 1.2 }));
  compass.appendChild(el("path", { d: `M ${W - 46} 26 L ${W - 50} 38 L ${W - 46} 35 L ${W - 42} 38 Z`, fill: INK }));
  compass.appendChild(txt(W - 46, 68, "N", { size: 8.5, ls: "0.1em" }));
  svg.appendChild(compass);

  svg.appendChild(el("line", { x1: PAD, y1: H - 24, x2: PAD + 74, y2: H - 24, stroke: INK, "stroke-width": 1.6 }));
  svg.appendChild(el("line", { x1: PAD, y1: H - 29, x2: PAD, y2: H - 19, stroke: INK, "stroke-width": 1.2 }));
  svg.appendChild(el("line", { x1: PAD + 74, y1: H - 29, x2: PAD + 74, y2: H - 19, stroke: INK, "stroke-width": 1.2 }));
  svg.appendChild(txt(PAD + 37, H - 30, "2 KM", { size: 8.5, ls: "0.12em" }));

  // click on empty map closes the options card
  svg.onclick = () => onFocus(null);
}
