// Scroll companion: the council courier walks a ground strip as the page scrolls and names the section it is passing.
// Presentation only. It reads scroll position, section titles and the journey's recorded decision; it claims nothing.
import { agentMarkup } from "/assets/council-scene.js";

const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

export function mountCompanion({ decisionHost, sections = ".doc-section[id]" } = {}) {
  if (document.querySelector(".sc-ground")) return () => {};
  const ground = document.createElement("div");
  ground.className = "sc-ground council-pet-scope";
  ground.setAttribute("aria-hidden", "true");
  ground.innerHTML = `<div class="sc-line"><i class="sc-fill"></i></div><button class="sc-pet council-pet" type="button" tabindex="-1" data-pose="idle" data-facing="right"><span class="sc-bubble"></span><span class="sc-z">z z</span>${agentMarkup()}</button>`;
  document.body.append(ground);
  document.body.classList.add("sc-on");
  const pet = ground.querySelector(".sc-pet");
  const fill = ground.querySelector(".sc-fill");
  const bubble = ground.querySelector(".sc-bubble");

  let lastY = scrollY, idleTimer = 0, sleepTimer = 0, bubbleTimer = 0, flashTimer = 0, raf = 0, current = "";
  const say = (text, ms = 1700) => {
    if (!text) return;
    bubble.textContent = text;
    pet.classList.add("sc-talk");
    clearTimeout(bubbleTimer);
    bubbleTimer = setTimeout(() => pet.classList.remove("sc-talk"), ms);
  };
  const setPose = (pose) => { pet.dataset.pose = pose; };

  const nodes = [...document.querySelectorAll(sections)];
  const titleOf = (node) => node.querySelector(".doc-section-title")?.textContent?.trim() || node.getAttribute("aria-label") || "";
  const place = () => {
    raf = 0;
    const max = Math.max(1, document.documentElement.scrollHeight - innerHeight);
    const progress = Math.min(1, Math.max(0, scrollY / max));
    const travel = Math.max(0, ground.clientWidth - 56);
    pet.style.transform = `translateX(${(progress * travel).toFixed(1)}px)`;
    fill.style.transform = `scaleX(${progress.toFixed(4)})`;
    const x = progress * travel;
    pet.dataset.edge = x < 70 ? "left" : x > travel - 70 ? "right" : "";
    const dy = scrollY - lastY;
    if (Math.abs(dy) > 1) {
      pet.dataset.facing = dy > 0 ? "right" : "left";
      if (!flashTimer) setPose(reduced() ? "idle" : "walk");
      clearTimeout(idleTimer); clearTimeout(sleepTimer);
      pet.classList.remove("sc-sleep");
      idleTimer = setTimeout(() => { if (!flashTimer) setPose("idle"); }, 160);
      sleepTimer = setTimeout(() => pet.classList.add("sc-sleep"), 7000);
    }
    lastY = scrollY;
    const probe = innerHeight * 0.4;
    const hit = progress > 0.985 ? nodes[nodes.length - 1] : nodes.filter((node) => node.getBoundingClientRect().top < probe).pop();
    const label = hit ? titleOf(hit) : "";
    if (label && label !== current) { current = label; say(label); }
    if (!hit) current = "";
  };
  const onScroll = () => { if (!raf) raf = requestAnimationFrame(place); };
  addEventListener("scroll", onScroll, { passive: true });
  addEventListener("resize", onScroll);
  place();
  sleepTimer = setTimeout(() => pet.classList.add("sc-sleep"), 7000);

  const flash = (pose, text) => {
    clearTimeout(flashTimer);
    pet.classList.remove("sc-sleep");
    setPose(pose);
    say(text, 2400);
    flashTimer = setTimeout(() => { flashTimer = 0; setPose("idle"); }, reduced() ? 600 : 2400);
  };
  let stopWatching = () => {};
  if (decisionHost) {
    let seen = decisionHost.dataset.decision || "";
    const observer = new MutationObserver(() => {
      const next = decisionHost.dataset.decision || "";
      if (next === seen) return;
      seen = next;
      if (next === "SIGNED") flash("signed", "Signed");
      else if (next === "REFUSED") flash("refused", "Refused");
      else if (next === "CANCELLED") flash("refused", "Cancelled");
      else if (next === "PENDING_CHALLENGE") flash("wait", "Waiting");
      else if (next === "PENDING_VOTE") flash("wait", "Council vote");
    });
    observer.observe(decisionHost, { attributes: true, attributeFilter: ["data-decision"] });
    stopWatching = () => observer.disconnect();
  }

  pet.addEventListener("click", () => flash("signed", current || "Here"));
  pet.tabIndex = -1;

  // Section heads draw their rule once, when first scrolled into view.
  const heads = [...document.querySelectorAll(".doc-section-head")];
  heads.forEach((head) => head.classList.add("sc-head"));
  const io = new IntersectionObserver((entries) => entries.forEach((entry) => {
    if (entry.isIntersecting) { entry.target.classList.add("sc-in"); io.unobserve(entry.target); }
  }), { threshold: 0.6 });
  heads.forEach((head) => io.observe(head));

  return () => {
    removeEventListener("scroll", onScroll); removeEventListener("resize", onScroll);
    io.disconnect(); stopWatching(); ground.remove(); document.body.classList.remove("sc-on");
  };
}
