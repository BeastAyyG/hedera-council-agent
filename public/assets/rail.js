// Shared page chrome: top meta row (menu + status columns) and the bottom
// ticker. One place to change navigation for every page.

const links = [
  ["/", "Atlas"],
  ["/console.html", "Console"],
  ["/console.html#join", "Join council"],
];

function node(tag, text, cls) {
  const e = document.createElement(tag);
  if (text !== undefined) e.textContent = text;
  if (cls) e.className = cls;
  return e;
}

// el: a <header class="top">. meta: [{ label, value, dot?: "red"|"green"|"ink", end?: true }]
export function mountRail(el, current, meta = []) {
  const menu = node("div", undefined, "col");
  menu.append(node("span", "Menu", "label"));
  const nav = node("nav");
  for (const [href, text] of links) {
    const a = node("a", text);
    a.href = href;
    if (href === current) a.setAttribute("aria-current", "page");
    nav.append(a);
  }
  const rows = [...meta];
  const first = rows.find((m) => m.report);
  if (first) { const a = node("a", "Report"); a.href = first.report; nav.append(a); }
  menu.append(nav);
  const cols = rows.filter((m) => !m.report).map((m) => {
    const c = node("div", undefined, m.end ? "col end" : "col");
    c.append(node("span", m.label, "label"));
    const v = node("div", undefined, "val");
    if (m.dot) v.append(node("i", undefined, `dot ${m.dot === "red" ? "" : m.dot}`));
    v.append(document.createTextNode(m.value));
    c.append(v);
    return c;
  });
  el.replaceChildren(menu, ...cols);
}

export function mountTicker(el, items) {
  const text = items.filter(Boolean).join("  ·  ").toUpperCase();
  const run = node("span", `${text}  ·  ${text}  ·  `, "run");
  el.replaceChildren(run);
}
