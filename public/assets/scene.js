// Isometric pixel scenery, drawn in code (SVG). Written fresh for this
// project. Pure functions that return SVG elements, no server calls,
// so the visual layer can be restyled or animated freely.
//
//   island({ cx, cy, cols, rows, seed, accent })  dark isometric slab with small buildings
//   pixelIsland({ cx, cy, seed })                 green top, brown base, water ring (report)
//   bridge(a, b)                                  curved bridge between two points + packet dot
//   sky({ width })                                sun and pixel clouds

const NS = "http://www.w3.org/2000/svg";

export function el(tag, attrs = {}, kids = []) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  for (const k of kids) e.append(k);
  return e;
}

function rng(seed) {
  let a = seed >>> 0 || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashSeed(s) {
  let h = 2166136261;
  for (const c of String(s)) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return h >>> 0;
}

const diamond = (x, y, w, h) => `${x},${y - h / 2} ${x + w / 2},${y} ${x},${y + h / 2} ${x - w / 2},${y}`;

function cube(x, y, w, h, z, top, left, right) {
  // x,y is the centre of the top face's base diamond; z is the cube height
  return el("g", {}, [
    el("polygon", { points: `${x - w / 2},${y} ${x},${y + h / 2} ${x},${y + h / 2 - z} ${x - w / 2},${y - z}`, fill: left }),
    el("polygon", { points: `${x + w / 2},${y} ${x},${y + h / 2} ${x},${y + h / 2 - z} ${x + w / 2},${y - z}`, fill: right }),
    el("polygon", { points: diamond(x, y - z, w, h), fill: top }),
  ]);
}

export function island({ cx, cy, cols = 8, rows = 6, seed = 1, accent = "#df3d2a" }) {
  const r = rng(seed);
  const tw = 12, th = 6;
  const g = el("g", { class: "island-body" });
  const shades = ["#101010", "#181818", "#212121", "#2b2b2b"];
  const cells = [];
  for (let i = 0; i < cols; i++) {
    for (let j = 0; j < rows; j++) {
      // ellipse mask so the slab reads as an island, with ragged edges
      const nx = (i - (cols - 1) / 2) / (cols / 2), ny = (j - (rows - 1) / 2) / (rows / 2);
      if (nx * nx + ny * ny > 0.95 + (r() - 0.5) * 0.3) continue;
      cells.push([i, j]);
    }
  }
  cells.sort((a, b) => a[0] + a[1] - (b[0] + b[1]));
  const pos = ([i, j]) => [cx + (i - j) * (tw / 2), cy + (i + j) * (th / 2) - ((cols + rows) * th) / 4];
  for (const c of cells) {
    const [x, y] = pos(c);
    g.append(cube(x, y, tw, th, 4 + Math.floor(r() * 3), shades[Math.floor(r() * shades.length)], "#050505", "#0c0c0c"));
  }
  const palette = ["#ffffff", "#3f9b45", accent, "#ffffff", "#3f9b45"];
  const n = Math.max(3, Math.floor(cells.length / 9));
  for (let k = 0; k < n; k++) {
    const c = cells[Math.floor(r() * cells.length)];
    const [x, y] = pos(c);
    const col = k === 0 ? accent : palette[Math.floor(r() * palette.length)];
    g.append(cube(x, y - 6, 5, 2.5, 3 + Math.floor(r() * 5), col, "#bfbab0", "#9d988d"));
  }
  return g;
}

export function pixelIsland({ cx, cy, seed = 7 }) {
  const r = rng(seed);
  const tw = 14, th = 7, cols = 9, rows = 7;
  const g = el("g", { class: "pixel-island" });
  const pos = (i, j) => [cx + (i - j) * (tw / 2), cy + (i + j) * (th / 2) - ((cols + rows) * th) / 4];
  const all = [];
  for (let i = -1; i <= cols; i++) for (let j = -1; j <= rows; j++) all.push([i, j]);
  all.sort((a, b) => a[0] + a[1] - (b[0] + b[1]));
  for (const [i, j] of all) {
    const nx = (i - (cols - 1) / 2) / (cols / 2 + 0.6), ny = (j - (rows - 1) / 2) / (rows / 2 + 0.6);
    const d = nx * nx + ny * ny;
    if (d > 1.15) continue;
    const [x, y] = pos(i, j);
    if (d > 0.82) {
      g.append(el("polygon", { points: diamond(x, y + 3, tw, th), fill: r() > 0.5 ? "#6fb0d6" : "#82bddf" }));
    } else {
      const grass = ["#4c9a3f", "#56a548", "#448b38"][Math.floor(r() * 3)];
      g.append(cube(x, y, tw, th, 7, grass, "#7a5230", "#5f3f24"));
    }
  }
  for (let k = 0; k < 7; k++) {
    const i = 2 + Math.floor(r() * (cols - 4)), j = 2 + Math.floor(r() * (rows - 4));
    const [x, y] = pos(i, j);
    g.append(cube(x, y - 7, 5, 2.5, 6, "#2f7a2c", "#235c21", "#1c4a1a"));
  }
  const [bx, by] = pos(4, 3);
  g.append(cube(bx, by - 7, 9, 4.5, 9, "#ffffff", "#d8d4c9", "#b7b2a6"), cube(bx, by - 16, 9, 4.5, 3, "#df3d2a", "#b6301f", "#8f2618"));
  return g;
}

export function bridge(a, b, { id = "" } = {}) {
  const mx = (a[0] + b[0]) / 2, my = Math.min(a[1], b[1]) - 46;
  const d = `M ${a[0]} ${a[1]} Q ${mx} ${my} ${b[0]} ${b[1]}`;
  const path = el("path", { d, class: "bridge", "data-link": id });
  const t = 0.5;
  const px = (1 - t) * (1 - t) * a[0] + 2 * (1 - t) * t * mx + t * t * b[0];
  const py = (1 - t) * (1 - t) * a[1] + 2 * (1 - t) * t * my + t * t * b[1];
  return el("g", {}, [path, el("rect", { class: "packet", x: px - 2, y: py - 2, width: 4, height: 4 })]);
}

export function sky({ width = 800 } = {}) {
  const g = el("g", { class: "sky" });
  g.append(el("circle", { cx: width * 0.46, cy: 70, r: 9, fill: "#f2b233" }), el("circle", { cx: width * 0.46, cy: 70, r: 14, fill: "#f2b233", opacity: 0.18 }));
  for (const [x, y, w] of [[120, 76, 30], [330, 60, 26], [610, 96, 34]]) {
    g.append(el("rect", { x, y, width: w, height: 5, fill: "#d9d4c6" }), el("rect", { x: x + 5, y: y - 4, width: w - 12, height: 5, fill: "#d9d4c6" }));
  }
  return g;
}
