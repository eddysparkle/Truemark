/* TrueMark Auth UI — load after script.js or before, uses shared DOM */
(function () {
  const AUTH_BASE = "https://truemark-ai.edialeeghonghon.workers.dev";
  const TOKEN_KEY = "truemarkAuthToken";
  const USER_KEY = "truemarkAuthUser";

  function $(id) {
    return document.getElementById(id);
  }

  function getToken() {
    try {
      return localStorage.getItem(TOKEN_KEY) || "";
    } catch {
      return "";
    }
  }

  function getStoredUser() {
    try {
      return JSON.parse(localStorage.getItem(USER_KEY) || "null");
    } catch {
      return null;
    }
  }

  function saveSession(token, user) {
    localStorage.setItem(TOKEN_KEY, token || "");
    localStorage.setItem(USER_KEY, JSON.stringify(user || null));
  }

  function clearSession() {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
  }

  function initialFor(user) {
    if (!user) return "T";
    const base = (user.display_name || user.email || "T").trim();
    return (base.charAt(0) || "T").toUpperCase();
  }

  function updateProfileUI(user) {
    const icon = document.querySelector(".profile-icon");
    if (!icon) return;
    if (user) {
      icon.textContent = initialFor(user);
      icon.title = user.display_name || user.email || "Account";
      icon.setAttribute("aria-label", "Account menu");
      icon.dataset.signedIn = "1";
    } else {
      icon.textContent = "T";
      icon.title = "Sign in";
      icon.setAttribute("aria-label", "Sign in");
      icon.dataset.signedIn = "0";
    }
  }

  function openAuthModal(mode) {
    const modal = $("authModal");
    if (!modal) return;
    modal.classList.add("open");
    modal.setAttribute("aria-hidden", "false");
    setAuthMode(mode || "login");
  }

  function closeAuthModal() {
    const modal = $("authModal");
    if (!modal) return;
    modal.classList.remove("open");
    modal.setAttribute("aria-hidden", "true");
    const err = $("authError");
    if (err) err.textContent = "";
  }

  function setAuthMode(mode) {
    const title = $("authTitle");
    const submit = $("authSubmit");
    const switchBtn = $("authSwitch");
    const nameRow = $("authNameRow");
    if (!title || !submit) return;
    if (mode === "signup") {
      title.textContent = "Create account";
      submit.textContent = "Sign up";
      if (nameRow) nameRow.hidden = false;
      if (switchBtn) switchBtn.textContent = "Already have an account? Sign in";
      submit.dataset.mode = "signup";
    } else {
      title.textContent = "Sign in";
      submit.textContent = "Sign in";
      if (nameRow) nameRow.hidden = true;
      if (switchBtn) switchBtn.textContent = "Need an account? Sign up";
      submit.dataset.mode = "login";
    }
  }

  async function api(path, options) {
    const response = await fetch(AUTH_BASE + path, options);
    let data = {};
    try {
      data = await response.json();
    } catch {
      throw new Error("Invalid server response");
    }
    if (!response.ok || data.success === false) {
      throw new Error(data.error || data.message || "Request failed");
    }
    return data;
  }

  async function refreshMe() {
    const token = getToken();
    if (!token) {
      updateProfileUI(null);
      return null;
    }
    try {
      const data = await api("/auth/me", {
        method: "GET",
        headers: { Authorization: "Bearer " + token }
      });
      saveSession(token, data.user);
      updateProfileUI(data.user);
      return data.user;
    } catch {
      clearSession();
      updateProfileUI(null);
      return null;
    }
  }

  async function handleSubmit(event) {
    event.preventDefault();
    const err = $("authError");
    const email = ($("authEmail") || {}).value || "";
    const password = ($("authPassword") || {}).value || "";
    const name = ($("authName") || {}).value || "";
    const mode = ($("authSubmit") || {}).dataset.mode || "login";
    if (err) err.textContent = "";

    try {
      const data = await api(mode === "signup" ? "/auth/signup" : "/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: email.trim(),
          password: password,
          display_name: name.trim()
        })
      });
      saveSession(data.token, data.user);
      updateProfileUI(data.user);
      closeAuthModal();
      if (typeof showToast === "function") {
        showToast(mode === "signup" ? "Account created" : "Signed in");
      }
    } catch (error) {
      if (err) err.textContent = error.message || "Could not continue";
    }
  }

  async function handleLogout() {
    const token = getToken();
    try {
      if (token) {
        await api("/auth/logout", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer " + token
          },
          body: JSON.stringify({ token: token })
        });
      }
    } catch {
      /* ignore */
    }
    clearSession();
    updateProfileUI(null);
    closeAuthModal();
    if (typeof showToast === "function") showToast("Signed out");
  }

  function showAccountPanel() {
    const user = getStoredUser();
    const err = $("authError");
    if (user) {
      openAuthModal("login");
      setAuthMode("login");
      const title = $("authTitle");
      if (title) title.textContent = user.display_name || user.email || "Account";
      if (err) {
        err.textContent = "Signed in as " + (user.email || "");
      }
      const submit = $("authSubmit");
      if (submit) {
        submit.textContent = "Sign out";
        submit.dataset.mode = "logout";
      }
    } else {
      openAuthModal("login");
    }
  }

  document.addEventListener("DOMContentLoaded", function () {
    const form = $("authForm");
    const closeBtn = $("closeAuth");
    const switchBtn = $("authSwitch");
    const modal = $("authModal");
    const profile = document.querySelector(".profile-icon");

    if (form) form.addEventListener("submit", function (event) {
      const mode = ($("authSubmit") || {}).dataset.mode;
      if (mode === "logout") {
        event.preventDefault();
        handleLogout();
        return;
      }
      handleSubmit(event);
    });

    if (closeBtn) closeBtn.addEventListener("click", closeAuthModal);
    if (modal) {
      modal.addEventListener("click", function (event) {
        if (event.target === modal) closeAuthModal();
      });
    }
    if (switchBtn) {
      switchBtn.addEventListener("click", function () {
        const mode = ($("authSubmit") || {}).dataset.mode;
        if (mode === "logout") return;
        setAuthMode(mode === "signup" ? "login" : "signup");
        if ($("authError")) $("authError").textContent = "";
      });
    }
    if (profile) {
      profile.style.cursor = "pointer";
      profile.addEventListener("click", showAccountPanel);
    }

    updateProfileUI(getStoredUser());
    refreshMe();
  });
})();
