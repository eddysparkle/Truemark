/* TrueMark side drawer / hamburger menu */
(function () {
  const API = "https://truemark-ai.edialeeghonghon.workers.dev";
  const TOKEN_KEY = "truemark_auth_token";
  const USER_KEY = "truemark_auth_user";

  function $(id) {
    return document.getElementById(id);
  }

  function openDrawer() {
    const drawer = $("sideDrawer");
    const backdrop = $("drawerBackdrop");
    const toggle = $("menuToggle");
    if (!drawer) return;
    drawer.classList.add("open");
    drawer.setAttribute("aria-hidden", "false");
    if (backdrop) {
      backdrop.hidden = false;
      backdrop.classList.add("open");
    }
    if (toggle) toggle.setAttribute("aria-expanded", "true");
    document.body.classList.add("drawer-open");
    refreshDrawerAccount();
  }

  function closeDrawer() {
    const drawer = $("sideDrawer");
    const backdrop = $("drawerBackdrop");
    const toggle = $("menuToggle");
    if (!drawer) return;
    drawer.classList.remove("open");
    drawer.setAttribute("aria-hidden", "true");
    if (backdrop) {
      backdrop.classList.remove("open");
      backdrop.hidden = true;
    }
    if (toggle) toggle.setAttribute("aria-expanded", "false");
    document.body.classList.remove("drawer-open");
  }

  async function refreshDrawerAccount() {
    const emailEl = $("drawerUserEmail");
    const adminSection = $("drawerAdminSection");
    const token = localStorage.getItem(TOKEN_KEY);
    let user = null;
    try {
      user = JSON.parse(localStorage.getItem(USER_KEY) || "null");
    } catch (_) {}

    if (emailEl) {
      emailEl.textContent = user && user.email ? user.email : "Not signed in";
    }

    if (adminSection) {
      adminSection.hidden = true;
    }

    if (!token) return;

    try {
      const res = await fetch(API + "/admin/session", {
        headers: { Authorization: "Bearer " + token }
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.is_admin && adminSection) {
        adminSection.hidden = false;
      }
      if (data.user && data.user.email && emailEl) {
        emailEl.textContent = data.user.email;
      }
    } catch (_) {}
  }

  function goNav(target) {
    closeDrawer();
    if (!target) return;
    const btn = document.querySelector('.nav-item[data-target="' + target + '"]');
    if (btn) {
      btn.click();
      return;
    }
    const el = document.getElementById(target);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  document.addEventListener("DOMContentLoaded", () => {
    const toggle = $("menuToggle");
    const closeBtn = $("drawerClose");
    const backdrop = $("drawerBackdrop");
    const signIn = $("drawerSignIn");
    const scan = $("drawerScan");

    if (toggle) toggle.addEventListener("click", openDrawer);
    if (closeBtn) closeBtn.addEventListener("click", closeDrawer);
    if (backdrop) backdrop.addEventListener("click", closeDrawer);

    document.querySelectorAll("[data-drawer-nav]").forEach((el) => {
      el.addEventListener("click", (e) => {
        e.preventDefault();
        goNav(el.getAttribute("data-drawer-nav"));
      });
    });

    // In-page anchors for mission etc.
    document.querySelectorAll('.drawer-link[href^="#"]').forEach((el) => {
      if (el.hasAttribute("data-drawer-nav")) return;
      el.addEventListener("click", () => {
        closeDrawer();
      });
    });

    if (scan) {
      scan.addEventListener("click", () => {
        closeDrawer();
        const navScan = $("navScan") || $("scanButton");
        if (navScan) navScan.click();
      });
    }

    if (signIn) {
      signIn.addEventListener("click", () => {
        closeDrawer();
        const profile = $("profileIcon");
        if (profile) profile.click();
      });
    }

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closeDrawer();
    });

    refreshDrawerAccount();
    window.trueMarkRefreshDrawer = refreshDrawerAccount;
  });
})();
