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

  // The hero demo card - live code, not a screenshot. Pure front-end state;
  // it never calls the server, so it is honest about what it is (there is
  // no fake "processing" delay dressed up as a real settlement).
  const demoBadge = document.getElementById("demoBadge");
  const demoAction = document.getElementById("demoAction");
  const demoResult = document.getElementById("demoResult");
  const demoCode = document.getElementById("demoCode");
  const demoReleaseBtn = document.getElementById("demoReleaseBtn");
  const demoResetBtn = document.getElementById("demoResetBtn");

  if (demoReleaseBtn) {
    demoReleaseBtn.addEventListener("click", () => {
      if (!demoCode.value.trim()) {
        demoCode.focus();
        return;
      }
      demoBadge.className = "badge badge-released";
      demoBadge.innerHTML = '<span class="dot" aria-hidden="true"></span>Released to the vendor';
      demoAction.hidden = true;
      demoResult.hidden = false;
    });
    demoResetBtn.addEventListener("click", () => {
      demoBadge.className = "badge badge-locked";
      demoBadge.innerHTML = '<span class="dot" aria-hidden="true"></span>Paid and held';
      demoCode.value = "";
      demoResult.hidden = true;
      demoAction.hidden = false;
    });
    demoCode.addEventListener("keydown", (e) => {
      if (e.key === "Enter") demoReleaseBtn.click();
    });
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

  // The dot field in the footer lights up around the pointer. All this
  // does is move a mask's centre - two custom properties, written once
  // per frame - so the dots themselves are never re-painted or re-laid
  // out. Pointer events only, so it costs a touch device nothing.
  const revealFooter = document.getElementById("revealFooter");
  const dotField = document.getElementById("dotField");
  if (revealFooter && dotField && !prefersReduced) {
    let pending = false;
    let lastX = 0;
    let lastY = 0;

    const paint = () => {
      dotField.style.setProperty("--mx", `${lastX}px`);
      dotField.style.setProperty("--my", `${lastY}px`);
      pending = false;
    };

    revealFooter.addEventListener(
      "pointermove",
      (e) => {
        if (e.pointerType === "touch") return;
        const box = revealFooter.getBoundingClientRect();
        lastX = e.clientX - box.left;
        lastY = e.clientY - box.top;
        dotField.classList.add("is-live");
        if (pending) return;
        pending = true;
        requestAnimationFrame(paint);
      },
      { passive: true },
    );

    revealFooter.addEventListener("pointerleave", () => {
      dotField.classList.remove("is-live");
    });
  }
  document.querySelectorAll('a[href^="#"]').forEach((link) => {
    link.addEventListener("click", (e) => {
      const target = document.querySelector(link.getAttribute("href"));
      if (!target) return;
      e.preventDefault();
      target.scrollIntoView({ behavior: prefersReduced ? "auto" : "smooth", block: "start" });
    });
  });
})();
