const NS = "http://www.w3.org/2000/svg";
const W = 1000, H = 720, PAD = 70;
const B = { latMin: 31.0700, latMax: 31.1225, lngMin: 77.1100, lngMax: 77.2020 };

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

export function renderMap(svg, meta, opts = {}) {
  const { prediction = null, selectedId = null, onSelect = () => {} } = opts;
  svg.innerHTML = "";

  const defs = el("defs");
  svg.appendChild(defs);

  // paper + topographic hint
  svg.appendChild(el("rect", { x: 0, y: 0, width: W, height: H, fill: "#ffffff" }));
  for (let i = 0; i < 7; i++) {
    svg.appendChild(el("path", {
      d: `M ${-120 + i * 40} ${120 + i * 46} Q ${300 + i * 30} ${10 + i * 34} ${760 + i * 26} ${190 + i * 40} T ${W + 120} ${330 + i * 34}`,
      fill: "none", stroke: "#f0f0f0", "stroke-width": 1,
    }));
  }
  // faint grid
  for (let x = PAD; x <= W - PAD; x += 76)
    svg.appendChild(el("line", { x1: x, y1: PAD - 30, x2: x, y2: H - PAD + 30, stroke: "#f4f4f4", "stroke-width": 1 }));
  for (let y = PAD; y <= H - PAD; y += 76)
    svg.appendChild(el("line", { x1: PAD - 30, y1: y, x2: W - PAD + 30, y2: y, stroke: "#f4f4f4", "stroke-width": 1 }));

  const nodeById = new Map(meta.nodes.map((n) => [n.id, n]));
  const pos = (id) => {
    const n = nodeById.get(id);
    return n ? project(n.lat, n.lng) : { x: W / 2, y: H / 2 };
  };

  // ---- roads ----
  const roads = el("g");
  svg.appendChild(roads);
  for (const e of meta.edges) {
    const a = pos(e.a), b = pos(e.b);
    roads.appendChild(el("line", {
      x1: a.x, y1: a.y, x2: b.x, y2: b.y,
      stroke: e.busy > 0.65 ? "#bdbdbd" : e.busy > 0.45 ? "#d4d4d4" : "#e2e2e2",
      "stroke-width": 2 + e.busy * 4,
      "stroke-linecap": "round",
    }));
  }

  // ---- best route ----
  const chosen = prediction
    ? prediction.results.find((r) => r.id === selectedId) || prediction.results[0]
    : null;

  if (chosen && chosen.route && chosen.route.stops.length > 1) {
    const pts = chosen.route.stops.map((s) => {
      const p = project(s.lat, s.lng);
      return `${p.x},${p.y}`;
    }).join(" ");
    const g = el("g");
    g.appendChild(el("polyline", {
      points: pts, fill: "none", stroke: "#0d0d0d", "stroke-width": 7,
      "stroke-linecap": "round", "stroke-linejoin": "round", opacity: 0.14,
    }));
    g.appendChild(el("polyline", {
      points: pts, fill: "none", stroke: "#0d0d0d", "stroke-width": 3.2,
      "stroke-linecap": "round", "stroke-linejoin": "round",
      "stroke-dasharray": "10 7", class: "route-line",
    }));
    svg.appendChild(g);
  }

  // ---- nodes ----
  const gNodes = el("g");
  svg.appendChild(gNodes);
  for (const n of meta.nodes) {
    const p = project(n.lat, n.lng);
    gNodes.appendChild(el("circle", { cx: p.x, cy: p.y, r: 2.6, fill: "#0d0d0d" }));
    gNodes.appendChild(el("text", {
      x: p.x, y: p.y - 26, "text-anchor": "middle",
      "font-family": "ui-monospace, Menlo, monospace", "font-size": 10.5,
      "letter-spacing": "0.12em", fill: "#0d0d0d",
    }, n.name.toUpperCase()));
  }

  // ---- parking lots ----
  const gZones = el("g");
  svg.appendChild(gZones);
  const predById = new Map();
  if (prediction) for (const r of prediction.results) predById.set(r.id, r);

  for (const z of meta.zones) {
    const p = pos(z.node);
    const r = predById.get(z.id);
    const isOn = selectedId ? z.id === selectedId : r === (chosen || undefined);
    const label = r ? String(r.predicted) : "–";

    const g = el("g", { class: "zone", style: "cursor:pointer" });
    g.appendChild(el("title", {}, `${z.name} — ${z.capacity} slots · ₹${z.price}/hr`));
    g.appendChild(el("rect", {
      x: p.x - 23, y: p.y - 13, width: 46, height: 26,
      fill: isOn ? "#0d0d0d" : "#ffffff",
      stroke: "#0d0d0d", "stroke-width": isOn ? 2 : 1.2,
    }));
    g.appendChild(el("text", {
      x: p.x, y: p.y + 5, "text-anchor": "middle",
      "font-family": "ui-monospace, Menlo, monospace", "font-size": 13,
      "font-weight": 600, fill: isOn ? "#ffffff" : "#0d0d0d",
    }, label));
    if (z.community) {
      g.appendChild(el("text", {
        x: p.x, y: p.y + 30, "text-anchor": "middle", "font-size": 9,
        "font-family": "ui-monospace, Menlo, monospace", fill: "#0d0d0d",
      }, "YOURS"));
    }
    g.addEventListener("click", () => onSelect(z.id));
    gZones.appendChild(g);
  }

  // ---- origin / destination markers ----
  if (prediction) {
    const o = project(prediction.origin.lat, prediction.origin.lng);
    const d = project(prediction.destination.lat, prediction.destination.lng);

    const gd = el("g");
    gd.appendChild(el("rect", { x: d.x - 13, y: d.y - 13, width: 26, height: 26, fill: "none", stroke: "#0d0d0d", "stroke-width": 2 }));
    gd.appendChild(el("rect", { x: d.x - 5, y: d.y - 5, width: 10, height: 10, fill: "#0d0d0d", transform: `rotate(45 ${d.x} ${d.y})` }));
    gd.appendChild(el("text", {
      x: d.x, y: d.y + 40, "text-anchor": "middle", "font-size": 9.5,
      "letter-spacing": "0.1em", "font-family": "ui-monospace, Menlo, monospace", fill: "#0d0d0d",
    }, "DESTINATION"));
    svg.appendChild(gd);

    const go = el("g");
    go.appendChild(el("circle", { cx: o.x, cy: o.y, r: 13, fill: "none", stroke: "#0d0d0d", "stroke-width": 1.4 }));
    go.appendChild(el("circle", { cx: o.x, cy: o.y, r: 6, fill: "#0d0d0d" }));
    go.appendChild(el("text", {
      x: o.x, y: o.y + 38, "text-anchor": "middle", "font-size": 9.5,
      "letter-spacing": "0.1em", "font-family": "ui-monospace, Menlo, monospace", fill: "#0d0d0d",
    }, "YOU ARE HERE"));
    svg.appendChild(go);
  }

  // scale bar
  svg.appendChild(el("line", { x1: W - PAD - 80, y1: H - 22, x2: W - PAD, y2: H - 22, stroke: "#0d0d0d", "stroke-width": 1.5 }));
  svg.appendChild(el("text", {
    x: W - PAD - 40, y: H - 28, "text-anchor": "middle", "font-size": 9.5,
    "font-family": "ui-monospace, Menlo, monospace", fill: "#0d0d0d",
  }, "2 KM"));
}
