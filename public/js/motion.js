// Scroll reveals and the FAQ disclosure. Vanilla, no dependency, and inert
// entirely under prefers-reduced-motion (the CSS handles that half; this file
// just adds/removes a class and never blocks anything if it fails to run).
(() => {
  "use strict";

  const revealables = document.querySelectorAll("[data-reveal], [data-reveal-group]");
  if ("IntersectionObserver" in window && revealables.length) {
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            entry.target.classList.add("is-visible");
            io.unobserve(entry.target);
          }
        }
      },
      { threshold: 0.15, rootMargin: "0px 0px -40px 0px" },
    );
    revealables.forEach((el) => io.observe(el));
  } else {
    revealables.forEach((el) => el.classList.add("is-visible"));
  }

  // Count the stat numbers up once, the first time they're seen.
  const stats = document.querySelectorAll("[data-count-to]");
  if ("IntersectionObserver" in window && stats.length) {
    const countIo = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          countIo.unobserve(entry.target);
          const el = entry.target;
          const to = Number.parseFloat(el.dataset.countTo);
          const suffix = el.dataset.countSuffix ?? "";
          const decimals = el.dataset.countDecimals ? Number.parseInt(el.dataset.countDecimals, 10) : 0;
          if (!Number.isFinite(to)) return;
          const start = performance.now();
          const duration = 900;
          const step = (now) => {
            const t = Math.min(1, (now - start) / duration);
            const eased = 1 - Math.pow(1 - t, 3);
            el.textContent = (to * eased).toFixed(decimals) + suffix;
            if (t < 1) requestAnimationFrame(step);
          };
          requestAnimationFrame(step);
        }
      },
      { threshold: 0.4 },
    );
    stats.forEach((el) => countIo.observe(el));
  }

  // The nav collapses into a floating island once the page has scrolled past
  // its own height, and reverts the moment it's back at the top. rAF-batched
  // so the scroll handler never runs more than once per frame.
  const nav = document.getElementById("siteNav");
  if (nav) {
    const THRESHOLD = 24;
    let ticking = false;
    const apply = () => {
      nav.classList.toggle("is-scrolled", window.scrollY > THRESHOLD);
      ticking = false;
    };
    window.addEventListener(
      "scroll",
      () => {
        if (ticking) return;
        ticking = true;
        requestAnimationFrame(apply);
      },
      { passive: true },
    );
    apply();
  }

  // Smooth scroll for the in-page nav, without fighting reduced-motion users.
  const prefersReduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  document.querySelectorAll('a[href^="#"]').forEach((link) => {
    link.addEventListener("click", (e) => {
      const target = document.querySelector(link.getAttribute("href"));
      if (!target) return;
      e.preventDefault();
      target.scrollIntoView({ behavior: prefersReduced ? "auto" : "smooth", block: "start" });
    });
  });
})();
