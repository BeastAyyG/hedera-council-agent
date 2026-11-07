// Shared bottom ticker. One place fills the ticker on every page that has
// one. Defensive by design: if the fetch fails or the markup is absent it
// leaves a static line and never throws. It never changes the page state.
(function () {
  var track = document.querySelector(".ticker-track");
  if (!track) return;
  var a = document.getElementById("tickA");
  var b = document.getElementById("tickB");
  if (!a || !b) return;
  var short = function (h, n) { return typeof h === "string" && h ? h.slice(0, n || 8).toUpperCase() : "N/A"; };
  function line(signed, refused, log, policyHash) {
    return "COUNCIL AGENT \u00b7 " + signed + " SIGNED \u00b7 " + refused + " REFUSED \u00b7 LOG " + log +
      " \u00b7 POLICY " + short(policyHash) + " \u00b7 ";
  }
  function fill(text) {
    var t = text + text + text;
    a.textContent = t;
    b.textContent = t;
  }
  fill("COUNCIL AGENT \u00b7 SIMULATED \u00b7 ");
  function get(url) {
    return fetch(url).then(function (r) { return r.json(); }).catch(function () { return {}; });
  }
  Promise.all([get("/proposals"), get("/audit/verify"), get("/policy")]).then(function (res) {
    var list = (res[0] && res[0].proposals) || (res[0] && res[0].data && res[0].data.proposals) || [];
    var signed = 0, refused = 0;
    list.forEach(function (p) {
      if (p.decision === "SIGNED") signed++;
      else if (p.decision && p.decision.indexOf("REFUSED") === 0) refused++;
    });
    var v = res[1] || {};
    var log = v.ok ? "VERIFIED, " + (v.checked || 0) + " ENTRIES" : "UNAVAILABLE";
    var pol = (res[2] && res[2].hash) || (res[2] && res[2].policy && res[2].policy.hash) || null;
    fill(line(String(signed).padStart(2, "0"), String(refused).padStart(2, "0"), log, pol));
  });
})();
