const LABELS = ["Claim", "Check", "World ID", "Receipt"];

export function decisionModel(record) {
  const decision = record ? record.lastOutcome?.decision ?? "UNSUBMITTED" : "EMPTY";
  const hasOutcome = Boolean(record?.lastOutcome);
  const matches = record?.check?.matches === true;
  const signed = decision === "SIGNED";
  const pending = decision === "PENDING_CHALLENGE";
  const refused = decision === "REFUSED";
  const cancelled = decision === "CANCELLED";
  const blocked = refused && matches && record.large && Boolean(record.lastOutcome.worldGateReason);
  const approved = matches && record?.large && (signed || pending || Boolean(record.approval));
  const gate = !record ? ["wait", "No proposal"] : !matches ? ["skip", "Not reached"]
    : !record.large ? ["skip", "Not required"] : blocked ? ["fail", "Blocked"]
    : approved ? ["pass", "Approved"] : ["wait", "Approval needed"];
  const states = [
    [record ? "pass" : "wait", record ? "Proposal received" : "No proposal"],
    [record ? (matches ? "pass" : "fail") : "wait", record ? (matches ? "Fields agree" : "Fields differ") : "Not checked"],
    gate,
    [signed ? "pass" : refused || cancelled ? "fail" : "wait", signed ? "Signed" : refused ? "Not signed" : cancelled ? "Cancelled" : pending ? "Challenge window" : "Not signed yet"],
  ];
  return {
    decision, hasOutcome,
    stop: signed || pending || cancelled ? 3 : refused ? (blocked ? 2 : 1) : record ? 1 : 0,
    pose: signed ? "signed" : refused || cancelled ? "refused" : pending ? "wait" : "idle",
    title: signed ? "Checked. Signed. Filed." : refused ? "Stopped. No signature." : cancelled ? "Cancelled. No execution." : pending ? "Checks passed. Still waiting." : record ? "Ready for the agent." : "A proposal starts the journey.",
    caption: hasOutcome ? "Recorded decision · illustrated replay" : record ? "Proposal preview · not submitted" : "Submit a proposal to see its decision",
    stages: states.map(([state, note], index) => ({ label: LABELS[index], state, note })),
  };
}

export function transferModel(proposal) {
  const { description: described, transfer: actual } = proposal;
  const maximum = Math.max(described.amountTinybars, actual.amountTinybars, 1);
  const side = (value) => {
    const tinybars = BigInt(value.amountTinybars);
    const whole = (tinybars / 100000000n).toLocaleString("en-US");
    const fraction = (tinybars % 100000000n).toString().padStart(8, "0").replace(/0+$/, "");
    return {
      amount: `${whole}${fraction ? `.${fraction}` : ""} ${value.token}`,
      payee: value.payee,
      coins: value.amountTinybars > 0 ? Math.max(1, Math.round(value.amountTinybars / maximum * 12)) : 0,
    };
  };
  return {
    described: side(described), actual: side(actual),
    amountMatch: described.amountTinybars === actual.amountTinybars,
    payeeMatch: described.payee === actual.payee,
    tokenMatch: described.token === actual.token,
  };
}

export function agentMarkup() {
  return `<svg viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false" shape-rendering="crispEdges">
    <ellipse cx="24" cy="44" rx="15" ry="2" fill="currentColor" opacity=".12"/>
    <g class="pet-body"><path d="M13 8h20v4h4v17h-4v9H13v-9H9V12h4z" fill="var(--pet-ink,#111110)"/>
      <path d="M13 5h19v4h6v5H10V9h3z" fill="var(--pet-red,#e23b28)"/>
      <path d="M14 16h18v11H14z" fill="var(--pet-paper,#f2efe7)"/>
      <g class="pet-eyes" fill="var(--pet-ink,#111110)"><path d="M17 19h3v4h-3zM26 19h3v4h-3z"/></g>
      <path d="M17 29h14v9H17z" fill="var(--pet-red,#e23b28)"/><path d="M23 30h3v3h-3z" fill="var(--pet-paper,#f2efe7)"/>
      <g class="pet-parcel"><path d="M31 27h12v11H31z" fill="var(--pet-paper,#f2efe7)" stroke="var(--pet-ink,#111110)" stroke-width="2"/><path d="M36 28h3v9h-3z" fill="var(--pet-red,#e23b28)"/></g>
      <g class="pet-flag"><path d="M39 12h2v24h-2z" fill="var(--pet-ink,#111110)"/><path d="M41 12h7v9h-7z" fill="currentColor"/></g>
    </g><path class="pet-leg-left" d="M14 37h7v6H11v-3h3z" fill="var(--pet-ink,#111110)"/>
    <path class="pet-leg-right" d="M27 37h7v3h3v3H27z" fill="var(--pet-ink,#111110)"/>
  </svg>`;
}

const ICONS = [
  '<path d="M21 10h22v32H21z" fill="var(--pet-paper)" stroke="currentColor" stroke-width="2"/><path d="M26 18h12M26 24h12M26 30h7" stroke="currentColor" stroke-width="2"/><path d="M36 34h10v9H36z" fill="var(--pet-red)"/>',
  '<path d="M17 17h29v5H17zM29 12h5v33h-5zM15 42h34v5H15z" fill="currentColor"/><path d="M14 25h15l-4 9h-7zM35 25h15l-4 9h-7z" fill="var(--pet-paper)" stroke="currentColor" stroke-width="2"/><path d="M17 20v6M46 20v6" stroke="currentColor" stroke-width="2"/>',
  '<path d="M15 10h7v35h-7zM42 10h7v35h-7zM15 8h34v7H15z" fill="currentColor"/><path class="cj-gate-bar" d="M22 26h20v5H22z" fill="var(--pet-red)"/><path d="M27 14h10v8H27z" fill="var(--pet-paper)"/><path d="M30 16h4v4h-4z" fill="var(--pet-red)"/>',
  '<path d="M18 12h27v29H18z" fill="var(--pet-paper)" stroke="currentColor" stroke-width="2"/><path d="M24 19h14M24 24h14" stroke="currentColor" stroke-width="2"/><path d="M13 39h38v9H13zM17 48h30v5H17z" fill="currentColor"/><path class="cj-receipt-mark" d="M25 30l4 4 9-8" fill="none" stroke="currentColor" stroke-width="3"/>',
];
const stationIcon = (index) => `<svg viewBox="0 0 64 64" aria-hidden="true" focusable="false" shape-rendering="crispEdges"><path d="M3 49l29-9 29 9-29 12z" fill="var(--pet-hair)"/><path d="M3 49v5l29 10V59z" fill="var(--pet-ink)" opacity=".17"/><path d="M32 59l29-10v5L32 64z" fill="var(--pet-red)" opacity=".2"/>${ICONS[index]}</svg>`;
const element = (tag, className, text) => {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

export function renderTransfer(host, proposal) {
  const model = transferModel(proposal);
  host.classList.add("council-transfer");
  const fields = [!model.amountMatch && "Amount", !model.payeeMatch && "destination", !model.tokenMatch && "token"].filter(Boolean);
  host.dataset.match = String(fields.length === 0);
  const heading = element("div", "ct-heading", fields.length ? `${fields.join(" + ")} differ` : "Same amount. Same destination.");
  const sides = element("div", "ct-sides");
  [model.described, model.actual].forEach((value, index) => {
    const side = element("div", "ct-side");
    side.dataset.side = index ? "actual" : "described";
    const art = element("div", "ct-art");
    art.setAttribute("aria-hidden", "true");
    const stack = element("div", "ct-coins");
    for (let coin = 0; coin < value.coins; coin++) {
      const layer = element("i", "ct-coin");
      layer.style.setProperty("--coin", coin);
      if (index && !model.amountMatch && coin >= model.described.coins) layer.classList.add("ct-extra");
      stack.append(layer);
    }
    const route = element("span", "ct-route");
    route.dataset.broken = String(index === 1 && !model.payeeMatch);
    const island = element("div", "ct-island");
    island.dataset.other = String(index === 1 && !model.payeeMatch);
    island.innerHTML = stationIcon(index && !model.payeeMatch ? 2 : 0);
    art.append(stack, route, island);
    side.append(element("span", "ct-label", index ? "Actual transfer" : "Described"), art,
      element("strong", "ct-amount", value.amount), element("span", "ct-payee", `To ${value.payee}`));
    sides.append(side);
  });
  host.replaceChildren(heading, sides, element("p", "ct-note", "Coin stacks show relative size. Exact amounts and destinations shown below each stack."));
}

export function mountJourney(host) {
  host.classList.add("council-journey");
  host.innerHTML = `<div class="cj-heading"><span class="cj-caption"></span><button class="cj-replay" type="button">Replay journey <span aria-hidden="true">↻</span></button></div><div class="cj-field"><div class="cj-road"></div><div class="cj-travel"><div class="cj-courier council-pet" data-pose="idle">${agentMarkup()}</div></div><div class="cj-stations"></div></div><div class="cj-ending"><strong class="cj-title"></strong><span class="cj-activity" role="status"></span></div>`;
  const caption = host.querySelector(".cj-caption");
  const courier = host.querySelector(".cj-courier");
  const stations = host.querySelector(".cj-stations");
  const title = host.querySelector(".cj-title");
  const activity = host.querySelector(".cj-activity");
  const replay = host.querySelector(".cj-replay");
  const media = matchMedia("(prefers-reduced-motion: reduce)");
  let model = decisionModel(null), key = "", animation = null, observer = null, generation = 0, destroyed = false;
  let activityState = "idle";
  const position = (index) => `${index / 3 * 100}%`;
  const finish = () => {
    courier.style.left = position(model.stop);
    courier.dataset.pose = activityState === "idle" ? model.pose : activityState === "denied" ? "refused" : activityState === "working" ? "working" : "wait";
    [...stations.children].forEach((node, index) => node.classList.toggle("is-reached", index <= model.stop));
    host.dataset.moving = "false";
  };
  const cancel = () => {
    generation++;
    observer?.disconnect(); observer = null;
    animation?.cancel(); animation = null;
    finish();
  };
  const play = () => {
    cancel();
    if (destroyed || !model.hasOutcome || media.matches || document.hidden || activityState !== "idle") return;
    const ticket = generation;
    const frames = [{ left: "0%", offset: 0 }];
    for (let step = 1; step <= model.stop; step++) {
      frames.push({ left: position(step), offset: (step - 0.25) / model.stop });
      frames.push({ left: position(step), offset: step / model.stop });
    }
    courier.dataset.pose = "walk";
    host.dataset.moving = "true";
    animation = courier.animate(frames, { duration: Math.max(800, model.stop * 760), easing: "ease-in-out", fill: "none" });
    animation.onfinish = () => { if (ticket === generation) { animation = null; finish(); } };
  };
  const update = (record, { animate = true } = {}) => {
    if (destroyed) return;
    const nextKey = JSON.stringify(record);
    if (nextKey === key) { setActivity("idle"); return; }
    key = nextKey;
    cancel();
    activityState = "idle";
    model = decisionModel(record);
    host.dataset.decision = model.decision;
    caption.textContent = model.caption;
    title.textContent = model.title;
    activity.textContent = "";
    replay.disabled = !model.hasOutcome;
    stations.replaceChildren(...model.stages.map((stage, index) => {
      const node = element("div", "cj-station");
      node.dataset.state = stage.state;
      node.innerHTML = stationIcon(index);
      node.append(element("b", "cj-label", stage.label), element("span", "cj-note", stage.note));
      return node;
    }));
    finish();
    if (animate && model.hasOutcome && !media.matches) {
      observer = new IntersectionObserver((entries) => {
        if (entries.some((entry) => entry.isIntersecting)) play();
      }, { threshold: 0.2 });
      observer.observe(host);
    }
  };
  const setActivity = (state) => {
    if (destroyed) return;
    activityState = state;
    cancel();
    replay.disabled = state !== "idle" || !model.hasOutcome;
    const messages = {
      working: "Request in progress · no stage telemetry", waiting: "Waiting for World ID",
      approved: "Approval received · decision unchanged", denied: "Approval denied · decision unchanged", idle: "",
    };
    activity.textContent = messages[state] ?? "";
    if (state !== "idle") courier.dataset.pose = state === "denied" ? "refused" : state === "working" ? "working" : "wait";
  };
  const settle = () => { if (media.matches || document.hidden) cancel(); };
  replay.addEventListener("click", play);
  media.addEventListener("change", settle);
  document.addEventListener("visibilitychange", settle);
  update(null, { animate: false });
  return {
    update, replay: play, setActivity,
    destroy() {
      cancel(); destroyed = true;
      replay.removeEventListener("click", play);
      media.removeEventListener("change", settle);
      document.removeEventListener("visibilitychange", settle);
    },
  };
}
