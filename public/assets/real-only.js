// Real-only mode (REAL_ONLY=1) client hook. Fetches /health once per page:
//   - realOnly: hides every [data-demo-only] element and marks the document,
//   - setupRequired: prepends a setup banner naming the missing credentials
//     and where to get each one.
// Default mode (REAL_ONLY unset) does nothing: /health reports realOnly
// false and setupRequired null, so no element is hidden and no banner shows.
// The banner text comes from the server payload, never from this file.
(function () {
  const STYLE = [
    ".setup-required{margin:0;padding:14px 18px;background:#e23b28;color:#fff;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;line-height:1.5}",
    ".setup-required-head{margin:0 0 6px;font-weight:700;text-transform:uppercase;letter-spacing:.04em}",
    ".setup-required-list{margin:0;padding-left:18px}",
    ".setup-required-list li{margin:2px 0}",
    ".setup-required-list b{color:#fff}",
  ].join("\n");
  async function main() {
    let health;
    try {
      const res = await fetch("/health");
      health = await res.json();
    } catch {
      return;
    }
    window.__realOnly = Boolean(health.realOnly);
    if (!health.realOnly) return;
    document.documentElement.classList.add("real-only");
    for (const el of document.querySelectorAll("[data-demo-only]")) el.hidden = true;
    const missing = health.setupRequired && Array.isArray(health.setupRequired.missing) ? health.setupRequired.missing : [];
    if (!missing.length) return;
    const style = document.createElement("style");
    style.textContent = STYLE;
    document.head.append(style);
    const banner = document.createElement("div");
    banner.id = "setup-required";
    banner.setAttribute("role", "alert");
    banner.className = "setup-required";
    const head = document.createElement("p");
    head.className = "setup-required-head";
    head.textContent = "Setup required: this server runs in real-only mode and cannot act until these credentials are set.";
    banner.append(head);
    const list = document.createElement("ul");
    list.className = "setup-required-list";
    for (const item of missing) {
      const li = document.createElement("li");
      const key = document.createElement("b");
      key.textContent = item.key;
      li.append(key, document.createTextNode(`: ${item.where}`));
      list.append(li);
    }
    banner.append(list);
    document.body.prepend(banner);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", main);
  else main();
})();
