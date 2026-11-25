/* =========================================================
TRUEMARK 5.6 — AI PRODUCT RECOGNITION
Cloudflare Workers AI + Barcode Lookup

IMPORTANT:
Product recognition is NOT authenticity verification.
========================================================= */

document.addEventListener("DOMContentLoaded", () => {

const $ = id => document.getElementById(id);

const API_URL =
"https://truemark-ai.edialeeghonghon.workers.dev/recognize";

const HISTORY_KEY = "truemarkScanHistory";

const scanButton = $("scanButton");
const navScan = $("navScan");
const scannerModal = $("scannerModal");
const closeScanner = $("closeScanner");
const startCameraButton = $("startCamera");
const labelScanButton = $("labelScanButton");
const labelImageInput = $("labelImageInput");
const scannerStatus = $("scannerStatus");
const scanResult = $("scanResult");
const historyList = $("historyList");
const toast = $("toast");

let html5QrCode = null;
let cameraRunning = false;
let startingCamera = false;
let processingScan = false;

let lastSearchContext = null;
let lastFdaRecalls = []; // { query, products } for back-to-results


if (labelImageInput) {
labelImageInput.multiple = true;
labelImageInput.accept = "image/*";
}

/* =========================
GENERAL HELPERS
========================= */

function showToast(message) {
if (!toast) return;

toast.textContent = message;  
toast.classList.add("show");  

clearTimeout(showToast.timer);  

showToast.timer = setTimeout(() => {  
  toast.classList.remove("show");  
}, 3000);

}

function escapeHTML(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case '"': return "&quot;";
      case "'": return "&#39;";
      default: return ch;
    }
  });
}

const API_BASE = "https://truemark-ai.edialeeghonghon.workers.dev";

function getAuthToken() {
  try {
    return localStorage.getItem("truemarkAuthToken") || "";
  } catch {
    return "";
  }
}

function getHistory() {
  try {
    const data = JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function setLocalHistory(list) {
  localStorage.setItem(HISTORY_KEY, JSON.stringify((list || []).slice(0, 40)));
}

async function pushHistoryToCloud(identifier, name, method) {
  const token = getAuthToken();
  if (!token) return;
  try {
    await fetch(API_BASE + "/auth/history", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + token
      },
      body: JSON.stringify({
        identifier: identifier || "",
        product_name: name || "",
        method: method || "Scanned"
      })
    });
  } catch (error) {
    console.warn("Cloud history save failed:", error);
  }
}

async function fetchCloudHistory() {
  const token = getAuthToken();
  if (!token) return null;
  try {
    const response = await fetch(API_BASE + "/auth/history", {
      method: "GET",
      headers: { Authorization: "Bearer " + token }
    });
    const data = await response.json();
    if (!response.ok || !data.success) return null;
    return (data.history || []).map((row) => ({
      barcode: row.identifier || "",
      name: row.product_name || "Product scan",
      method: row.method || "Scanned",
      date: row.created_at
        ? new Date(row.created_at).toLocaleString()
        : "",
      cloud: true
    }));
  } catch (error) {
    console.warn("Cloud history load failed:", error);
    return null;
  }
}

function saveScan(identifier, name, method) {
  try {
    const history = getHistory();
    history.unshift({
      barcode: identifier || "No barcode",
      name: name || "Product scan",
      method: method || "Scanned",
      date: new Date().toLocaleString()
    });
    setLocalHistory(history);
    displayHistory();

const reportNavBtn = $("reportNavBtn");
if (reportNavBtn) {
  reportNavBtn.addEventListener("click", () => openReportForm({}));
}

    pushHistoryToCloud(identifier, name, method);
  } catch (error) {
    console.warn("History error:", error);
  }
}

function renderHistoryItems(history) {
  if (!historyList) return;
  if (!history.length) {
    historyList.innerHTML =
      '<div class="empty-state">' +
      '<span class="empty-icon">▦</span>' +
      "<h3>No scans yet</h3>" +
      "<p>Products you scan will appear here.</p>" +
      "</div>";
    return;
  }
  historyList.innerHTML = history
    .map((item) => {
      return (
        '<div class="history-item"><div><strong>' +
        escapeHTML(item.name) +
        "</strong><small>" +
        escapeHTML(item.method || "Scanned") +
        " · " +
        escapeHTML(item.barcode || "") +
        "</small><small>" +
        escapeHTML(item.date || "") +
        (item.cloud ? " · account" : "") +
        '</small></div><span class="history-badge">Scanned</span></div>'
      );
    })
    .join("");
}

function displayHistory() {
  if (!historyList) return;
  const local = getHistory();
  renderHistoryItems(local);
  fetchCloudHistory().then((cloud) => {
    if (!cloud || !cloud.length) return;
    // Prefer account history when signed in
    renderHistoryItems(cloud);
  });
}

function clearHistoryLocal() {
  try {
    localStorage.removeItem(HISTORY_KEY);
  } catch (error) {
    console.warn(error);
  }
}

async function clearAllHistory() {
  clearHistoryLocal();
  const token = getAuthToken();
  if (token) {
    try {
      await fetch(API_BASE + "/auth/history", {
        method: "DELETE",
        headers: { Authorization: "Bearer " + token }
      });
    } catch (error) {
      console.warn("Cloud history clear failed:", error);
    }
  }
  displayHistory();
  showToast("History cleared");
}

async function loadSafetyAlerts() {
  const panel = document.getElementById("alertsPanel");
  const card = document.getElementById("alerts");
  if (!panel) return;

  panel.hidden = false;
  panel.classList.remove("is-open");
  panel.innerHTML =
    '<div class="alerts-shell alerts-loading">' +
      '<div class="alerts-glow"></div>' +
      '<p class="alerts-loading-text">Fetching safety updates</p>' +
      '<div class="alerts-spinner"></div>' +
    "</div>";

  // trigger enter animation
  requestAnimationFrame(() => {
    panel.classList.add("is-open");
  });

  if (card) card.classList.add("is-active");

  try {
    const response = await fetch(API_BASE + "/alerts");
    const data = await response.json();
    if (!response.ok || !data.success) {
      throw new Error(data.error || "Could not load alerts");
    }

    const nafdac = data.nafdac_alerts || [];
    const fda = data.fda_recalls || data.recalls || [];

    let cardsHtml = "";
    let delay = 0;

    function addCard(item, kind) {
      delay += 1;
      const title = item.product_name || item.source || "Alert";
      const reason = item.reason || "";
      const meta = [item.classification, item.status, item.recall_date]
        .filter(Boolean)
        .join(" · ");
      const url = item.source_url || "";
      cardsHtml +=
        '<article class="alert-motion-card" style="--delay:' +
        delay +
        '">' +
        '<div class="alert-motion-top">' +
        '<span class="alert-pill alert-pill-' +
        escapeHTML(kind) +
        '">' +
        escapeHTML(kind === "nafdac" ? "NAFDAC" : "FDA") +
        "</span>" +
        "</div>" +
        "<h4>" +
        escapeHTML(String(title).slice(0, 140)) +
        "</h4>" +
        "<p>" +
        escapeHTML(String(reason).slice(0, 220)) +
        "</p>" +
        (meta
          ? "<small>" + escapeHTML(meta) + "</small>"
          : "") +
        (url
          ? '<a class="alert-motion-link" href="' +
            escapeHTML(url) +
            '" target="_blank" rel="noopener noreferrer">Open source</a>'
          : "") +
        "</article>";
    }

    nafdac.forEach((item) => addCard(item, "nafdac"));
    fda.slice(0, 6).forEach((item) => addCard(item, "fda"));

    panel.innerHTML =
      '<div class="alerts-shell is-ready">' +
        '<div class="alerts-glow"></div>' +
        '<div class="alerts-head">' +
          "<div>" +
            '<p class="alerts-kicker">Live safety desk</p>' +
            "<h3>Stay informed</h3>" +
            '<p class="alerts-note">Official guidance and enforcement samples. Not a complete global recall feed.</p>' +
          "</div>" +
          '<button type="button" id="closeAlertsPanel" class="alerts-close" aria-label="Close">×</button>' +
        "</div>" +
        '<div class="alerts-track">' +
          cardsHtml +
        "</div>" +
        '<div class="alerts-foot">' +
          '<a href="https://nafdac.gov.ng/" target="_blank" rel="noopener noreferrer">NAFDAC</a>' +
          '<a href="https://registration.nafdac.gov.ng/" target="_blank" rel="noopener noreferrer">NAPAMS</a>' +
          '<a href="https://www.fda.gov/safety/recalls-market-withdrawals-safety-alerts" target="_blank" rel="noopener noreferrer">FDA recalls</a>' +
        "</div>" +
      "</div>";

    requestAnimationFrame(() => {
      panel.classList.add("is-open");
      panel.querySelectorAll(".alert-motion-card").forEach((el) => {
        el.classList.add("in");
      });
    });

    const closeBtn = document.getElementById("closeAlertsPanel");
    if (closeBtn) {
      closeBtn.addEventListener("click", () => {
        panel.classList.remove("is-open");
        if (card) card.classList.remove("is-active");
        setTimeout(() => {
          panel.hidden = true;
          panel.innerHTML = "";
        }, 320);
      });
    }

    panel.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (error) {
    panel.innerHTML =
      '<div class="alerts-shell is-ready">' +
        "<h3>Could not load alerts</h3>" +
        "<p>" +
        escapeHTML(error.message || "Network error") +
        "</p>" +
        '<div class="alerts-foot">' +
          '<a href="https://nafdac.gov.ng/" target="_blank" rel="noopener noreferrer">Open NAFDAC</a>' +
          '<a href="https://www.fda.gov/safety/recalls-market-withdrawals-safety-alerts" target="_blank" rel="noopener noreferrer">FDA recalls</a>' +
        "</div>" +
        '<button type="button" id="closeAlertsPanel" class="scan-again-button">Close</button>' +
      "</div>";
    panel.classList.add("is-open");
    const closeBtn = document.getElementById("closeAlertsPanel");
    if (closeBtn) {
      closeBtn.addEventListener("click", () => {
        panel.hidden = true;
        if (card) card.classList.remove("is-active");
      });
    }
  }
}


/* =========================
SCANNER MODAL
========================= */

function openScanner() {
if (!scannerModal) {
console.error("TrueMark: scannerModal element not found.");
return;
}

processingScan = false;  

if (scanResult) {  
  scanResult.hidden = true;  
  scanResult.innerHTML = "";  
}  

if (startCameraButton) {  
  startCameraButton.hidden = false;  
  startCameraButton.disabled = false;  
  startCameraButton.textContent = "Scan barcode";  
}  

if (scannerStatus) {  
  scannerStatus.textContent =  
    "Choose a scanning method to begin.";  
}  

scannerModal.classList.add("open");  
scannerModal.setAttribute("aria-hidden", "false");

}

async function startCamera() {
if (cameraRunning || startingCamera || processingScan) return;

if (  
  typeof Html5Qrcode === "undefined" ||  
  typeof Html5QrcodeSupportedFormats === "undefined"  
) {  
  if (scannerStatus) {  
    scannerStatus.textContent =  
      "Barcode scanner did not load. Reload the page.";  
  }  
  return;  
}  

if (!startCameraButton || !scannerStatus || !$("reader")) {  
  showToast("Scanner elements are missing from the page.");  
  return;  
}  

startingCamera = true;  

startCameraButton.disabled = true;  
startCameraButton.textContent = "Starting camera...";  

scannerStatus.textContent =  
  "Requesting camera permission...";  

try {  
  $("reader").innerHTML = "";  

  html5QrCode = new Html5Qrcode("reader");  

  const formats = [  
    Html5QrcodeSupportedFormats.EAN_13,  
    Html5QrcodeSupportedFormats.EAN_8,  
    Html5QrcodeSupportedFormats.UPC_A,  
    Html5QrcodeSupportedFormats.UPC_E,  
    Html5QrcodeSupportedFormats.CODE_128,  
    Html5QrcodeSupportedFormats.CODE_39,  
    Html5QrcodeSupportedFormats.ITF,  
    Html5QrcodeSupportedFormats.QR_CODE  
  ];  

  await html5QrCode.start(  
    { facingMode: "environment" },  
    {  
      fps: 10,  
      qrbox: {  
        width: 250,  
        height: 150  
      },  
      formatsToSupport: formats  
    },  
    onScanSuccess,  
    () => {}  
  );  

  cameraRunning = true;  

  startCameraButton.hidden = true;  

  scannerStatus.textContent =  
    "Camera active. Position a barcode inside the frame.";  

} catch (error) {  
  console.error("Camera error:", error);  

  scannerStatus.textContent =  
    "Unable to access camera. Check browser permissions.";  

  startCameraButton.hidden = false;  
  startCameraButton.textContent = "Try camera again";  

} finally {  
  startingCamera = false;  
  startCameraButton.disabled = false;  
}

}

async function stopCamera() {
if (html5QrCode && cameraRunning) {
try {
await html5QrCode.stop();
} catch (error) {
console.warn("Camera stop:", error);
}
}

cameraRunning = false;  
html5QrCode = null;  

if ($("reader")) {  
  $("reader").innerHTML = "";  
}

}

async function onScanSuccess(decodedText) {
if (!cameraRunning || processingScan) return;

processingScan = true;  
cameraRunning = false;  

if (scannerStatus) {  
  scannerStatus.textContent =  
    "Barcode detected. Looking up product information...";  
}  

try {  
  if (html5QrCode && html5QrCode.isScanning) {  
    await html5QrCode.stop();  
  }  
} catch (error) {  
  console.warn(error);  
}  

html5QrCode = null;  

await lookupProduct(decodedText);

}

/* =========================
BARCODE LOOKUP
========================= */

async function lookupProduct(barcode) {
  const WORKER_URL =
    "https://truemark-ai.edialeeghonghon.workers.dev/verify/barcode";

  if (scannerStatus) {
    scannerStatus.textContent = "Checking TrueMark product catalogues...";
  }

  try {
    const response = await fetch(WORKER_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ barcode: String(barcode).trim() })
    });

    let data;
    try {
      data = await response.json();
    } catch {
      throw new Error("The TrueMark server returned an invalid response.");
    }

    // Unknown barcode — helpful result, not an error
    if (
      data.status === "not_found" ||
      data.status === "ORANGE" ||
      (!data.product && !data.primary_match && !(data.matches && data.matches.length))
    ) {
      showProductNotFound(
        barcode,
        data.message ||
          "TrueMark could not find this barcode in the connected public catalogues.",
        {
          barcode_analysis: data.barcode_analysis || {},
          sources_checked: data.sources_checked || [],
          gs1_digital_link: data.gs1_digital_link || null,
          next_steps: data.next_steps || []
        }
      );
      saveScan(barcode, "Not yet identified", "TrueMark Worker");
      return;
    }

    if (!response.ok && data.success === false) {
      throw new Error(data.message || data.error || `Lookup failed (${response.status}).`);
    }

    const match =
      data.product ||
      data.primary_match?.product ||
      data.matches?.[0]?.product ||
      {};

    const product = {
      product_name: match.name || match.product_name || "",
      brands: match.brand || match.brands || "",
      categories: match.category || match.categories || "",
      quantity: match.quantity || match.strength_or_size || "",
      countries: match.country_of_origin || match.countries || "",
      manufacturing_places: match.manufacturer || match.manufacturing_places || "",
      image_url: match.image_url || match.image_front_url || ""
    };

    displayProduct(product, barcode, data.sources || []);
    saveScan(
      barcode,
      product.product_name || product.brands || "Product identified",
      "TrueMark Worker"
    );
    showToast("Product information retrieved.");
  } catch (error) {
    console.error("TrueMark barcode lookup:", error);
    showProductUnavailable(barcode, error.message || "network error");
    saveScan(barcode, "Catalogue check incomplete", "TrueMark Worker");
  }
}

function addScanAgainButton(
action = resetScanner,
label = "Scan another product"
) {
const button = $("scanAgain");

if (button) {  
  button.addEventListener("click", action);  
  button.textContent = label;  
}

}

function showProductNotFound(barcode, message, meta = {}) {
  if (!scanResult) return;

  const analysis = meta.barcode_analysis || {};
  const sources = Array.isArray(meta.sources_checked) ? meta.sources_checked : [];
  const gs1 = meta.gs1_digital_link || null;
  const next = Array.isArray(meta.next_steps) ? meta.next_steps : [];

  const sourcesHtml = sources.length
    ? "<ul class=\"compact-steps\">" +
      sources
        .map(
          (s) =>
            "<li>" +
            escapeHTML(s.name || s.key || "Source") +
            (s.status ? " · " + escapeHTML(s.status) : "") +
            "</li>"
        )
        .join("") +
      "</ul>"
    : "<p class=\"buy-note\">Open Facts family, UPCitemdb, TrueMark index, GS1 probe.</p>";

  const formatLine = analysis.format
    ? "<p><strong>Format:</strong> " +
      escapeHTML(analysis.format) +
      (analysis.check_digit_ok === true
        ? " · check digit OK"
        : analysis.check_digit_ok === false
        ? " · check digit failed"
        : "") +
      "</p>"
    : "";

  const gs1Html = gs1
    ? "<p class=\"buy-note\"><strong>GS1 Digital Link:</strong> " +
      escapeHTML(gs1.note || (gs1.resolved ? "Resolver returned a target." : "No registered link.")) +
      (gs1.final_url
        ? ' <a href="' +
          escapeHTML(gs1.final_url) +
          '" target="_blank" rel="noopener noreferrer">Open link</a>'
        : "") +
      "</p>"
    : "";

  scanResult.innerHTML =
    "<h3>Product not yet identified</h3>" +
    "<p>Barcode: <strong>" +
    escapeHTML(barcode) +
    "</strong></p>" +
    formatLine +
    classificationBadgeHtml({
      classification: "unverified",
      classification_meaning:
        "No reliable catalogue match yet. This is not proof the product is fake or unregistered."
    }) +
    '<div class="auth-card">' +
    '<p class="auth-card-title">What TrueMark checked</p>' +
    sourcesHtml +
    gs1Html +
    '<p class="auth-card-lead">' +
    escapeHTML(
      message ||
        "No match in connected catalogues. Missing catalogue data never means counterfeit by itself."
    ) +
    "</p>" +
    '<p class="auth-next-label">Continue verification</p>' +
    '<ul class="auth-steps compact-steps">' +
    "<li>Photograph the label — extract name, brand, NAFDAC, batch, expiry</li>" +
    "<li>Search by the name printed on the pack</li>" +
    "<li>Enter a NAFDAC number if present</li>" +
    "<li>Optionally submit this barcode for TrueMark review (user-submitted, not verified)</li>" +
    "</ul>" +
    '<div class="auth-actions">' +
    '<button id="notFoundLabelBtn" class="scan-again-button" type="button">Photograph product label</button>' +
    '<button id="notFoundSearchBtn" class="scan-again-button" type="button">Search by product name</button>' +
    '<button id="notFoundNafdacBtn" class="scan-again-button" type="button">Enter NAFDAC number</button>' +
    '<button id="notFoundSubmitBtn" class="chip-btn" type="button">Submit product for review</button>' +
    "</div>" +
    '<p class="buy-note">A catalogue match later would still only identify a product record — not prove this physical item is genuine.</p>' +
    "</div>" +
    '<button id="scanAgain" class="scan-again-button" type="button">Scan another product</button>';

  scanResult.hidden = false;

  if (scannerStatus) {
    scannerStatus.textContent =
      "No catalogue match yet — continue with label, name, or NAFDAC.";
  }

  const labelBtn = $("notFoundLabelBtn");
  if (labelBtn) {
    labelBtn.addEventListener("click", () => {
      if (labelImageInput) labelImageInput.click();
    });
  }

  const searchBtn = $("notFoundSearchBtn");
  if (searchBtn) {
    searchBtn.addEventListener("click", () => {
      closeScanner();
      const input = $("searchInput") || document.querySelector('input[type="search"], #productSearch, .search-input input');
      if (input) {
        input.focus();
        showToast("Type the product name from the pack");
      }
    });
  }

  const nafdacBtn = $("notFoundNafdacBtn");
  if (nafdacBtn) {
    nafdacBtn.addEventListener("click", () => {
      const manual = $("manualNafdacInput");
      if (manual) {
        manual.focus();
        showToast("Enter the NAFDAC number from the pack");
      } else {
        openReportForm({ barcode: barcode, concern: "Need NAFDAC verification guidance" });
      }
    });
  }

  const submitBtn = $("notFoundSubmitBtn");
  if (submitBtn) {
    submitBtn.addEventListener("click", () => openProductSubmitForm(barcode));
  }

  addScanAgainButton();
}

async function submitProductToTrueMark(payload) {
  const response = await fetch(
    "https://truemark-ai.edialeeghonghon.workers.dev/products/submit",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    }
  );
  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error("Submit service returned an invalid response.");
  }
  if (!response.ok || !data.success) {
    throw new Error(data.error || data.message || "Submit failed.");
  }
  return data;
}

function openProductSubmitForm(barcode) {
  openScanner();
  if (!scanResult) return;
  scanResult.hidden = false;
  scanResult.innerHTML =
    '<button id="backToResults" class="back-link-btn" type="button">← Back</button>' +
    "<h3>Submit product for review</h3>" +
    '<p class="buy-note">User-submitted entries help grow TrueMark coverage. They are <strong>not</strong> independently verified and are labelled as user-submitted.</p>' +
    '<form id="productSubmitForm" class="report-form">' +
    '<label>Barcode<input name="barcode" value="' +
    escapeHTML(barcode || "") +
    '" readonly></label>' +
    '<label>Product name<input name="product_name" required placeholder="As printed on pack"></label>' +
    '<label>Brand<input name="brand" placeholder="Brand if known"></label>' +
    '<label>NAFDAC number<input name="nafdac_number" placeholder="If printed"></label>' +
    '<label>Category<input name="category" placeholder="Medicine, food, beauty…"></label>' +
    '<label>Notes<textarea name="notes" rows="3" placeholder="Pack details, seller, anything useful"></textarea></label>' +
    '<button type="submit" class="scan-again-button">Submit to TrueMark</button>' +
    "</form>";

  const back = $("backToResults");
  if (back) {
    back.addEventListener("click", () => {
      showProductNotFound(barcode, "", {});
    });
  }

  const form = $("productSubmitForm");
  if (form) {
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const fd = new FormData(form);
      const payload = Object.fromEntries(fd.entries());
      try {
        showToast("Submitting…");
        const data = await submitProductToTrueMark(payload);
        scanResult.innerHTML =
          "<h3>Submitted for review</h3>" +
          classificationBadgeHtml({
            classification: "unverified",
            classification_meaning:
              "User-submitted. Not independently verified. Not an authenticity result."
          }) +
          "<p>" +
          escapeHTML(data.message || "Thank you.") +
          "</p>" +
          '<button id="scanAgain" class="scan-again-button" type="button">Done</button>';
        addScanAgainButton();
        saveScan(barcode, payload.product_name || "User submitted", "User submitted");
        showToast("Product submitted");
      } catch (error) {
        showToast(error.message || "Submit failed");
      }
    });
  }
}

function showProductUnavailable(barcode, reason) {
  if (!scanResult) return;

  scanResult.innerHTML = `
    <h3>Catalogue check could not be completed</h3>
    <p>Barcode: <strong>${escapeHTML(barcode)}</strong></p>
    <div class="verification-warning">
      <strong>Try a label photo</strong>
      <p>
        TrueMark could not finish the catalogue lookup${
          reason ? " (" + escapeHTML(reason) + ")" : ""
        }.
      </p>
      <p>
        Photograph the label to extract visible product details
        and any regulatory number on the pack.
      </p>
    </div>
    <button id="scanAgain" class="scan-again-button" type="button">
      Photograph product label
    </button>
  `;

  scanResult.hidden = false;

  if (scannerStatus) {
    scannerStatus.textContent =
      "Catalogue check incomplete. Label photo recommended.";
  }

  addScanAgainButton(() => {
    if (labelImageInput) labelImageInput.click();
  }, "Photograph product label");
}


function classificationBadgeHtml(data) {
  const key = (data && (data.classification || data.status)) || "unverified";
  const map = {
    authenticated: { label: "Authenticated", cls: "badge-auth" },
    regulatory_verified: { label: "Regulatory verified", cls: "badge-reg" },
    information_matched: { label: "Information matched", cls: "badge-info" },
    catalogue_match: { label: "Information matched", cls: "badge-info" },
    caution: { label: "Caution", cls: "badge-caution" },
    needs_check: { label: "Caution", cls: "badge-caution" },
    high_risk: { label: "High risk", cls: "badge-risk" },
    unverified: { label: "Unverified", cls: "badge-unverified" },
    not_found: { label: "Unverified", cls: "badge-unverified" }
  };
  const item = map[String(key).toLowerCase()] || map.unverified;
  const meaning = (data && data.classification_meaning) || "";
  return (
    '<div class="v-badge-row">' +
      '<span class="v-badge ' + item.cls + '">' + escapeHTML(item.label) + "</span>" +
      (meaning
        ? '<p class="v-badge-meaning">' + escapeHTML(meaning) + "</p>"
        : "") +
    "</div>"
  );
}

async function submitProductReport(payload) {
  const response = await fetch(
    "https://truemark-ai.edialeeghonghon.workers.dev/reports",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    }
  );
  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error("Report service returned an invalid response.");
  }
  if (!response.ok || !data.success) {
    throw new Error(data.error || data.message || "Report could not be submitted.");
  }
  return data;
}

function openReportForm(prefill = {}) {
  openScanner();
  if (!scanResult) return;
  scanResult.hidden = false;
  scanResult.innerHTML =
    '<button id="backToResults" class="back-link-btn" type="button">← Back</button>' +
    "<h3>Report a suspicious product</h3>" +
    '<p class="buy-note">Reports help TrueMark prioritise checks. They are not public accusations. Use NAFDAC official channels for urgent safety issues.</p>' +
    '<form id="reportForm" class="report-form">' +
      '<label>Product name<input name="product_name" required value="' +
        escapeHTML(prefill.product_name || "") +
      '"></label>' +
      '<label>Brand<input name="brand" value="' +
        escapeHTML(prefill.brand || "") +
      '"></label>' +
      '<label>Barcode<input name="barcode" value="' +
        escapeHTML(prefill.barcode || "") +
      '"></label>' +
      '<label>NAFDAC / registration no.<input name="registration_number" value="' +
        escapeHTML(prefill.registration_number || prefill.nafdac_number || "") +
      '"></label>' +
      '<label>Batch / lot<input name="batch_number" value="' +
        escapeHTML(prefill.batch_number || "") +
      '"></label>' +
      '<label>Where purchased<input name="purchase_location" placeholder="Market, pharmacy, Jumia seller…" value="' +
        escapeHTML(prefill.purchase_location || "") +
      '"></label>' +
      '<label>What is wrong<textarea name="concern" required rows="4" placeholder="Describe the issue (seal, smell, missing NAFDAC, mismatch…)"></textarea></label>' +
      '<button type="submit" class="scan-again-button">Submit report</button>' +
    "</form>";

  const back = document.getElementById("backToResults");
  if (back) {
    back.addEventListener("click", () => {
      if (lastSearchContext && lastSearchContext.products && lastSearchContext.products.length) {
        backToSearchResults();
      } else {
        scanResult.hidden = true;
      }
    });
  }

  const form = document.getElementById("reportForm");
  if (form) {
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const fd = new FormData(form);
      const payload = Object.fromEntries(fd.entries());
      try {
        showToast("Submitting report…");
        const data = await submitProductReport(payload);
        scanResult.innerHTML =
          "<h3>Report received</h3>" +
          "<p>Reference: <strong>" +
          escapeHTML(data.report_id || "") +
          "</strong></p>" +
          "<p>" +
          escapeHTML(data.message || "Thank you.") +
          "</p>" +
          '<button id="scanAgain" class="scan-again-button" type="button">Done</button>';
        addScanAgainButton();
        showToast("Report submitted");
      } catch (error) {
        showToast(error.message || "Report failed");
      }
    });
  }
}




function assessPackRiskClient(product) {
  const flags = [];
  let level = "none";
  const expiryRaw = String(product.expiry_date || "").trim();
  const mfgRaw = String(product.manufacturing_date || "").trim();
  const batchRaw = String(product.batch_number || "").trim();

  function parseDate(raw) {
    if (!raw) return null;
    let m = raw.match(/^(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})$/);
    if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
    m = raw.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/);
    if (m) {
      let y = +m[3];
      if (y < 100) y += 2000;
      return new Date(y, +m[2] - 1, +m[1]);
    }
    const t = Date.parse(raw);
    return Number.isNaN(t) ? null : new Date(t);
  }

  const expiry = parseDate(expiryRaw);
  const mfg = parseDate(mfgRaw);
  const now = new Date();

  if (expiryRaw && !expiry) {
    flags.push({ code: "expiry_unparsed", message: "Expiry text could not be parsed. Confirm on the pack." });
    level = "caution";
  }
  if (expiry) {
    const daysLeft = Math.floor((expiry - now) / 86400000);
    if (daysLeft < 0) {
      flags.push({ code: "expired", message: "Expiry appears to be in the past. Do not use expired medicines." });
      level = "high_risk";
    } else if (daysLeft <= 90) {
      flags.push({ code: "expiring_soon", message: "Expiry appears within about 90 days. Confirm on the pack." });
      if (level !== "high_risk") level = "caution";
    }
  }
  if (mfg && expiry && mfg > expiry) {
    flags.push({ code: "mfg_after_expiry", message: "Manufacturing date appears after expiry — confirm both on the pack." });
    level = "high_risk";
  }
  if (!batchRaw && (expiryRaw || mfgRaw)) {
    flags.push({ code: "batch_missing", message: "No batch/lot was read. Check the physical pack." });
    if (level === "none") level = "caution";
  }

  return {
    level,
    flags,
    disclaimer: "Risk flags use extracted text only. OCR can misread. Confirm on the pack."
  };
}

function packRiskHtml(packRisk) {
  if (!packRisk || !packRisk.level || packRisk.level === "none") {
    return "";
  }
  const level = packRisk.level;
  const cls =
    level === "high_risk"
      ? "risk-panel risk-high"
      : "risk-panel risk-caution";
  const title =
    level === "high_risk" ? "High-risk pack signals" : "Caution — check the pack";
  const flags = Array.isArray(packRisk.flags) ? packRisk.flags : [];
  const items = flags
    .map(
      (f) =>
        "<li><strong>" +
        escapeHTML(f.code || "") +
        ":</strong> " +
        escapeHTML(f.message || "") +
        "</li>"
    )
    .join("");
  return (
    '<div class="' +
    cls +
    '">' +
    "<p class=\"risk-title\">" +
    escapeHTML(title) +
    "</p>" +
    (items ? "<ul class=\"compact-steps\">" + items + "</ul>" : "") +
    '<p class="buy-note">' +
    escapeHTML(
      packRisk.disclaimer ||
        "Confirm dates and batch on the physical pack. OCR can misread."
    ) +
    "</p></div>"
  );
}

function fdaRecallsHtml(recalls, query) {
  if (!Array.isArray(recalls) || !recalls.length) return "";
  const rows = recalls
    .slice(0, 4)
    .map((r) => {
      return (
        '<div class="recall-row">' +
        "<strong>" +
        escapeHTML((r.product_name || "").slice(0, 120)) +
        "</strong>" +
        "<small>" +
        escapeHTML(
          [r.classification, r.status, r.recall_date, r.recalling_firm]
            .filter(Boolean)
            .join(" · ")
        ) +
        "</small>" +
        "<p>" +
        escapeHTML((r.reason || "").slice(0, 180)) +
        "</p>" +
        (r.code_info
          ? "<small>Code/batch info: " +
            escapeHTML(String(r.code_info).slice(0, 120)) +
            "</small>"
          : "") +
        "</div>"
      );
    })
    .join("");
  return (
    '<div class="fda-recall-panel">' +
    '<p class="risk-title">Related US FDA enforcement records</p>' +
    '<p class="buy-note">Matches are keyword-based from openFDA for “' +
    escapeHTML(query || "") +
    '”. A US recall does not automatically apply to a Nigerian pack or every batch.</p>' +
    rows +
    '<p class="buy-note"><a href="https://open.fda.gov/apis/drug/enforcement/" target="_blank" rel="noopener noreferrer">openFDA drug enforcement</a></p>' +
    "</div>"
  );
}


function displayProduct(product, barcode, sources = [], options = {}) {
  const isManufacturer = !!(options && options.manufacturerRegistered);

  if (!scanResult) return;
  const fromSearch = !!(options && options.fromSearch);


  const fields = [
    ["Product", product.product_name],
    ["Brand", product.brands],
    ["Category", product.categories],
    ["Quantity", product.quantity],
    ["Countries listed", product.countries],
    ["Manufacturing location", product.manufacturing_places],
    ["Barcode", barcode]
  ];

  const image = product.image_url || "";
  const buyQuery = (
    product.product_name ||
    product.brands ||
    barcode ||
    "product"
  ).toString().trim();

  const sourceNames = Array.isArray(sources) && sources.length
    ? sources.map((s) => (s && s.name) || "Catalogue").filter(Boolean).join(", ")
    : "Public catalogue";

  let fieldsHtml = "";
  fields.forEach(function (pair) {
    fieldsHtml +=
      "<p><strong>" +
      escapeHTML(pair[0]) +
      ":</strong> " +
      escapeHTML(pair[1] || "Not provided") +
      "</p>";
  });

  const imageHtml = image
    ? '<img src="' +
      escapeHTML(image) +
      '" alt="Product reference" style="width:140px;max-height:150px;object-fit:contain;margin:15px auto;display:block;">'
    : "";

  scanResult.innerHTML =
    '<span class="result-check">✓</span>' +
    "<h3>Product information found</h3>" +
    classificationBadgeHtml({ classification: "information_matched", classification_meaning: "Product information matches a catalogue or index record. The physical item is not authenticated." }) +
    imageHtml +
    '<div class="product-details">' +
    fieldsHtml +
    "</div>" +
    '<div class="auth-card">' +
      '<p class="auth-card-title">Authenticity not confirmed</p>' +
      '<p class="auth-card-lead">' +
      (isManufacturer
        ? 'This record was registered by a TrueMark Business manufacturer. Catalogue information only — not NAFDAC verification and not proof the physical item is genuine.'
        : 'This database record helps identify a product type. It does not authenticate the physical item in your hand.') +
      '</p>' +
      '<p class="auth-next-label">Next checks</p>' +
      '<ul class="auth-steps compact-steps">' +
        "<li>Match name, brand and strength on the pack</li>" +
        "<li>Verify any NAFDAC number on NAPAMS / Greenbook</li>" +
        "<li>Use MAS scratch SMS if the pack has one</li>" +
        "<li>Buy only from sellers you trust</li>" +
      "</ul>" +
      '<div class="auth-actions">' +
        '<a class="scan-again-button" href="https://registration.nafdac.gov.ng/" target="_blank" rel="noopener noreferrer">Open NAPAMS</a>' +
        '<a class="scan-again-button" href="https://greenbook.nafdac.gov.ng/" target="_blank" rel="noopener noreferrer">Open Greenbook</a>' +
      "</div>" +
      '<div class="buy-card">' +
        '<p class="buy-card-title">Find where to buy</p>' +
        '<div class="auth-actions">' +
          '<a class="scan-again-button" href="https://www.google.com/search?q=' +
            encodeURIComponent(buyQuery + " buy Nigeria") +
            '" target="_blank" rel="noopener noreferrer">Find sellers on Google</a>' +
          '<a class="scan-again-button" href="https://www.jumia.com.ng/catalog/?q=' +
            encodeURIComponent(buyQuery) +
            '" target="_blank" rel="noopener noreferrer">Search on Jumia</a>' +
          '<a class="scan-again-button" href="https://www.konga.com/search?search=' +
            encodeURIComponent(buyQuery) +
            '" target="_blank" rel="noopener noreferrer">Search on Konga</a>' +
        "</div>" +
        '<p class="buy-note">TrueMark does not sell products. These links open store <strong>search results</strong> for this product name. They may not be the exact same SKU, brand variant, or seller. Always check the listing and the physical pack before paying.</p>' +
      "</div>" +
    "</div>" +
    '<p class="result-note">Source: ' +
    escapeHTML(sourceNames) +
    ". Coverage may be incomplete.</p>" +
    (fromSearch || (lastSearchContext && lastSearchContext.products && lastSearchContext.products.length)
      ? '<button id="backToResults" class="back-link-btn" type="button">← Back to search results</button>'
      : "") +
    '<button id="reportProductBtn" class="chip-btn chip-btn-danger" type="button">Report suspicious product</button>' +
    '<button id="scanAgain" class="scan-again-button" type="button">Scan another product</button>';

  scanResult.hidden = false;

  if (scannerStatus) {
    scannerStatus.textContent = "Product information retrieved.";
  }

  const reportBtn = document.getElementById("reportProductBtn");
  if (reportBtn) {
    reportBtn.addEventListener("click", () => {
      openReportForm({
        product_name: product.product_name || "",
        brand: product.brands || "",
        barcode: barcode || ""
      });
    });
  }

  const backBtn = document.getElementById("backToResults");
  if (backBtn) {
    backBtn.addEventListener("click", () => backToSearchResults());
  }

  addScanAgainButton();
}

/* =========================
IMAGE PREPARATION
========================= */

async function prepareImage(file) {
if (typeof createImageBitmap !== "function") {
throw new Error(
"Your browser cannot prepare this image. Try another browser."
);
}

const bitmap = await createImageBitmap(file);  

const maxSide = 1400;  

const scale = Math.min(  
  1,  
  maxSide / Math.max(bitmap.width, bitmap.height)  
);  

const canvas = document.createElement("canvas");  

canvas.width = Math.max(1, Math.round(bitmap.width * scale));  
canvas.height = Math.max(1, Math.round(bitmap.height * scale));  

const ctx = canvas.getContext("2d");  

if (!ctx) {  
  bitmap.close();  
  throw new Error("Could not prepare the selected image.");  
}  

ctx.drawImage(  
  bitmap,  
  0,  
  0,  
  canvas.width,  
  canvas.height  
);  

bitmap.close();  

const blob = await new Promise((resolve, reject) => {  
  canvas.toBlob(  
    result => {  
      if (result) resolve(result);  
      else reject(new Error("Could not prepare image."));  
    },  
    "image/jpeg",  
    0.82  
  );  
});  

return new Promise((resolve, reject) => {  
  const reader = new FileReader();  

  reader.onload = () => resolve(reader.result);  

  reader.onerror = () => {  
    reject(new Error("Could not read the selected image."));  
  };  

  reader.readAsDataURL(blob);  
});

}

/* =========================
CLOUDFLARE AI
========================= */

async function recognizeWithAI(file, index, total) {

if (scannerStatus) {  
  scannerStatus.textContent =  
    `Preparing photo ${index} of ${total}...`;  
}  

const image = await prepareImage(file);  

if (scannerStatus) {  
  scannerStatus.textContent =  
    `AI is analysing photo ${index} of ${total}...`;  
}  

const response = await fetch(API_URL, {  
  method: "POST",  
  headers: {  
    "Content-Type": "application/json"  
  },  
  body: JSON.stringify({ image })  
});  

let data;  

try {  
  data = await response.json();  
} catch {  
  throw new Error(  
    "The AI server returned an invalid response."  
  );  
}  

if (!response.ok || !data.success) {  
  throw new Error(  
    data.detail ||  
    data.error ||  
    `AI request failed (${response.status}).`  
  );  
}  

if (!data.product || typeof data.product !== "object") {  
  throw new Error(  
    "The AI did not return product information."  
  );  
}  

return data.product;

}

/* =========================
COMBINE MULTIPLE RESULTS
========================= */

function combineResults(results) {
const combined = {
product_name: null,
brand: null,
category: null,
manufacturer: null,
distributor: null,
ingredients: [],
strength_or_size: null,
batch_number: null,
manufacturing_date: null,
expiry_date: null,
country_of_origin: null,
confidence: "low",
uncertain_fields: [],
additional_observations: [],
recognition_status: "needs_review",
nafdac_number: null,
authenticity_status: "not_verified"
  

};

const fields = [  
  "product_name",  
  "brand",  
  "category",  
  "manufacturer",  
  "distributor",  
  "strength_or_size",  
  "batch_number",  
  "manufacturing_date",  
  "expiry_date",  
  "country_of_origin", 
  "nafdac_number"
];  

results.forEach(product => {  
  fields.forEach(field => {  
    if (  
      !combined[field] &&  
      product[field] &&  
      typeof product[field] === "string"  
    ) {  
      combined[field] = product[field];  
    }  
  });  

  if (Array.isArray(product.ingredients)) {  
    combined.ingredients.push(...product.ingredients);  
  }  

  if (Array.isArray(product.uncertain_fields)) {  
    combined.uncertain_fields.push(  
      ...product.uncertain_fields  
    );  
  }  

  if (Array.isArray(product.additional_observations)) {  
    combined.additional_observations.push(  
      ...product.additional_observations  
    );  
  }  

  if (product.confidence === "high") {  
    combined.confidence = "high";  
  } else if (  
    product.confidence === "medium" &&  
    combined.confidence !== "high"  
  ) {  
    combined.confidence = "medium";  
  }  
});  

combined.ingredients = [  
  ...new Set(combined.ingredients.filter(Boolean))  
];  

combined.uncertain_fields = [  
  ...new Set(combined.uncertain_fields.filter(Boolean))  
];  

combined.additional_observations = [  
  ...new Set(combined.additional_observations.filter(Boolean))  
];  

if (combined.product_name || combined.brand) {  
  combined.recognition_status = "identified";  
}  

combined.authenticity_status = "not_verified";  

return combined;

}

/* =========================
DISPLAY AI RESULTS
========================= */


function renderAIResult(product, photoCount, errors = []) {
  if (!scanResult) return;

  const ingredients = Array.isArray(product.ingredients)
    ? product.ingredients.join(", ")
    : (product.ingredients || "");

  const nafdac = String(product.nafdac_number || "").trim();
  const confidence = String(product.confidence || "low").toLowerCase();

  const fields = [
    ["Product name", product.product_name],
    ["Brand", product.brand],
    ["Category", product.category],
    ["Manufacturer", product.manufacturer],
    ["Distributor", product.distributor],
    ["Strength / size", product.strength_or_size],
    ["Ingredients", ingredients],
    ["NAFDAC number", nafdac],
    ["Batch / lot number", product.batch_number],
    ["Manufacturing date", product.manufacturing_date],
    ["Expiry date", product.expiry_date],
    ["Country of origin", product.country_of_origin]
  ];

  const hasInformation = fields.some(([, value]) => value);

  const nafdacBlock = nafdac
    ? `
      <div class="verification-warning" style="border-left:4px solid #0b6e4f;margin-top:12px;">
        <strong>NAFDAC number read from pack</strong>
        <p style="font-size:1.15rem;font-weight:700;letter-spacing:0.02em;">
          ${escapeHTML(nafdac)}
        </p>
        <p>
          This number was read from the label. It is <strong>not</strong> live proof
          that this physical item is genuine. Counterfeiters sometimes copy real numbers.
        </p>
        <p><strong>Verify on official NAFDAC channels:</strong></p>
        <p style="display:flex;flex-direction:column;gap:8px;">
          <a
            href="https://registration.nafdac.gov.ng/"
            target="_blank"
            rel="noopener noreferrer"
            class="scan-again-button"
            style="text-align:center;text-decoration:none;"
          >
            Verify on NAPAMS (official)
          </a>
          <a
            href="https://greenbook.nafdac.gov.ng/"
            target="_blank"
            rel="noopener noreferrer"
            class="scan-again-button"
            style="text-align:center;text-decoration:none;"
          >
            Check NAFDAC Greenbook (medicines)
          </a>
        </p>
        <p style="font-size:0.9rem;">
          On NAPAMS: use <em>Verify Product</em> and enter the number exactly as printed
          (often without spaces). On Greenbook: search the number or product name and
          compare name, strength and manufacturer with the pack.
        </p>
      </div>
    `
    : `
      <div class="verification-warning">
        <strong>No NAFDAC number detected</strong>
        <p>
          If a NAFDAC registration number is printed on the pack, take a clearer photo
          of that area, or enter it manually in the field above, then use the official
          links after saving.
        </p>
        <p style="display:flex;flex-direction:column;gap:8px;">
          <a
            href="https://registration.nafdac.gov.ng/"
            target="_blank"
            rel="noopener noreferrer"
            class="scan-again-button"
            style="text-align:center;text-decoration:none;"
          >
            Open NAPAMS Verify Product
          </a>
          <a
            href="https://greenbook.nafdac.gov.ng/"
            target="_blank"
            rel="noopener noreferrer"
            class="scan-again-button"
            style="text-align:center;text-decoration:none;"
          >
            Open NAFDAC Greenbook
          </a>
        </p>
      </div>
    `;

  scanResult.innerHTML = `
    <h3>TrueMark AI recognition results</h3>

    <p>
    Analysed ${photoCount} photo${photoCount === 1 ? "" : "s"}.
    </p>

    <p>
      <strong>AI confidence:</strong>
      ${escapeHTML(confidence)}
      ${confidence === "low" ? " — please review every field against the pack." : ""}
    </p>

    <div class="tm4-fields">
      ${fields.map(([label, value], index) => `
        <label class="tm4-field">
          <span>${label}</span>
          <input
            type="text"
            data-field="${index}"
            value="${escapeHTML(value || "")}"
            placeholder="Not identified — correct if needed"
          >
        </label>
      `).join("")}
    </div>

${nafdacBlock}

    ${nafdac ? `
      <button id="checkNafdacBtn" class="scan-again-button" type="button">
        Check this NAFDAC number
      </button>
    ` : ""}

    ${!hasInformation ? `
    
      <div class="verification-warning">
        <strong>Limited information extracted</strong>
        <p>
          Try clearer photos with good lighting, focusing on the brand panel
          and any NAFDAC / batch / expiry text.
        </p>
      </div>
    ` : ""}

    ${packRiskHtml(product.pack_risk || assessPackRiskClient(product))}

    <div class="verification-warning">
      <strong>Authenticity not verified</strong>
      <p>
        AI recognition identifies visible product information.
        It does not establish whether this physical item is genuine,
        counterfeit, safe or approved by a regulator.
      </p>
      <p>
        Always confirm name, NAFDAC number, batch and expiry on the physical packaging,
        and use official NAFDAC channels for registration checks.
      </p>
    </div>

    <button
      id="saveCorrections"
      class="scan-again-button"
      type="button"
    >
      Save corrected details
    </button>

    <button
      id="scanAgain"
      class="scan-again-button"
      type="button"
    >
      Scan another product
    </button>
  `;

  scanResult.hidden = false;

  if (scannerStatus) {
    scannerStatus.textContent =
      "AI analysis complete. Review fields, then verify any NAFDAC number on official channels.";
  }

  const saveButton = $("saveCorrections");
const checkNafdacBtn = $("checkNafdacBtn");
  if (checkNafdacBtn && nafdac) {
    checkNafdacBtn.addEventListener("click", () => {
      runNafdacCheckAndShow(nafdac);
    });
  }


// Optional: automatically prepare NAFDAC check when number was read
// if (nafdac) runNafdacCheckAndShow(nafdac);


  
  if (saveButton) {
    saveButton.addEventListener("click", () => {
      const values = [
        ...scanResult.querySelectorAll("[data-field]")
      ].map((input) => input.value.trim());

      const corrected = {
        product_name: values[0] || "",
        brand: values[1] || "",
        category: values[2] || "",
        manufacturer: values[3] || "",
        distributor: values[4] || "",
        strength_or_size: values[5] || "",
        ingredients: values[6] || "",
        nafdac_number: values[7] || "",
        batch_number: values[8] || "",
        manufacturing_date: values[9] || "",
        expiry_date: values[10] || "",
        country_of_origin: values[11] || "",
        confidence: product.confidence || "low"
      };

      const label =
        corrected.product_name ||
        corrected.brand ||
        corrected.nafdac_number ||
        "Label scan saved";

      saveScan(
        corrected.nafdac_number || "AI label scan",
        label,
        "TrueMark AI"
      );

      showToast("Corrected details saved. Verify NAFDAC on official channels if present.");
    });
  }

  addScanAgainButton();
}



  
/* =========================
MULTI-PHOTO AI SCANNING
========================= */

async function handleLabelPhoto(event) {
const files = Array.from(event.target.files || [])
.filter(file => file.type.startsWith("image/"))
.slice(0, 4);

if (!files.length) {  
  showToast("Choose one or more product photos.");  
  event.target.value = "";  
  return;  
}  

await stopCamera();  

processingScan = true;  

if (labelScanButton) {  
  labelScanButton.disabled = true;  
}  

if (startCameraButton) {  
  startCameraButton.disabled = true;  
}  

if (scanResult) {  
  scanResult.hidden = false;  

  scanResult.innerHTML = `  
    <h3>Connecting to TrueMark AI...</h3>  
    <p>Please keep this page open while your photos are analysed.</p>  
  `;  
}  

const results = [];  
const errors = [];  

try {  
  for (let i = 0; i < files.length; i++) {  
    try {  
      const result = await recognizeWithAI(  
        files[i],  
        i + 1,  
        files.length  
      );  

      results.push(result);  

    } catch (error) {  
      console.error(`Photo ${i + 1} error:`, error);  

      errors.push(  
        `Photo ${i + 1}: ${error.message}`  
      );  
    }  
  }  

  if (!results.length) {  
    throw new Error(  
      errors.join(" | ") ||  
      "TrueMark AI could not analyse these photos."  
    );  
  }  

  const product = combineResults(results);  

  renderAIResult(product, files.length, errors);  

  showToast("TrueMark AI analysis finished.");  

} catch (error) {  
  console.error("AI recognition error:", error);  

  if (scanResult) {  
    scanResult.innerHTML = `  
      <h3>AI recognition unsuccessful</h3>  

      <p>${escapeHTML(error.message)}</p>  

      <p>  
        Check your internet connection and try again.  
      </p>  

      <button  
        id="scanAgain"  
        class="scan-again-button"  
        type="button"  
      >  
        Choose photos again  
      </button>  
    `;  

    scanResult.hidden = false;  
  }  

  if (scannerStatus) {  
    scannerStatus.textContent =  
      "TrueMark AI could not complete recognition.";  
  }  

  addScanAgainButton(  
    () => {  
      if (labelImageInput) {  
        labelImageInput.click();  
      }  
    },  
    "Choose photos again"  
  );  

} finally {  
  if (labelScanButton) {  
    labelScanButton.disabled = false;  
  }  

  if (startCameraButton) {  
    startCameraButton.disabled = false;  
  }  

  if (labelImageInput) {  
    labelImageInput.value = "";  
  }  

  processingScan = false;  
}

}

/* =========================
RESET AND CLOSE
========================= */

async function resetScanner() {
await stopCamera();

processingScan = false;  

if (scanResult) {  
  scanResult.hidden = true;  
  scanResult.innerHTML = "";  
}  

if (startCameraButton) {  
  startCameraButton.hidden = false;  
  startCameraButton.disabled = false;  
  startCameraButton.textContent = "Scan barcode";  
}  

if (scannerStatus) {  
  scannerStatus.textContent =  
    "Choose a scanning method to begin.";  
}

}

async function closeScannerModal() {
if (startingCamera || processingScan) {
showToast("Please wait for the current operation to finish.");
return;
}

await stopCamera();  

if (scannerModal) {  
  scannerModal.classList.remove("open");  
  scannerModal.setAttribute("aria-hidden", "true");  
}

}

/* =========================
EVENT LISTENERS
========================= */

if (scanButton) {
scanButton.addEventListener("click", openScanner);
}

if (navScan) {
navScan.addEventListener("click", openScanner);
}

if (startCameraButton) {
startCameraButton.addEventListener("click", startCamera);
}

if (labelScanButton) {
labelScanButton.addEventListener("click", () => {
if (
!startingCamera &&
!processingScan &&
labelImageInput
) {
labelImageInput.click();
}
});
}

if (labelImageInput) {
labelImageInput.addEventListener(
"change",
handleLabelPhoto
);
}

if (closeScanner) {
closeScanner.addEventListener(
"click",
closeScannerModal
);
}

if (scannerModal) {
scannerModal.addEventListener("click", event => {
if (event.target === scannerModal) {
closeScannerModal();
}
});
}

document.querySelectorAll(".category-card").forEach(card => {
  card.addEventListener("click", () => {
    document.querySelectorAll(".category-card").forEach(item => {
      item.classList.remove("selected");
    });

    card.classList.add("selected");

    const category = card.dataset.category || "Product";

    openScanner();

    if (scannerStatus) {
      scannerStatus.textContent =
        category === "Health"
          ? "Health & medicines — scan the barcode or photograph the label (look for NAFDAC number)."
          : category === "Beauty" || category === "Personal Care"
          ? `${category} — scan the barcode or photograph the label (brand, batch, NAFDAC if shown).`
          : `${category} — scan the barcode, or photograph the label if there is no barcode.`;
    }

    showToast(`${category}: ready to scan`);
  });
});


/* Starter Nigerian index — expand over time. Confirm NAFDAC numbers on the physical pack. */
const NIGERIAN_STARTER_INDEX = [
  { product_name: "Lonart Tablets 20mg/120mg", brand: "Lonart", category: "Health & medicines", barcode: "", nafdac_number: "04-8969", strength_or_size: "20mg/120mg", notes: "Artemether/Lumefantrine. Confirm number on pack.", source: "TrueMark starter index" },
  { product_name: "Lonart DS Tablets 80mg/480mg", brand: "Lonart", category: "Health & medicines", barcode: "", nafdac_number: "04-9927", strength_or_size: "80mg/480mg", notes: "Double-strength Lonart. Confirm on pack.", source: "TrueMark starter index" },
  { product_name: "Lonart Suspension 20/120", brand: "Lonart", category: "Health & medicines", barcode: "", nafdac_number: "04-8970", strength_or_size: "20mg/120mg suspension", notes: "Paediatric suspension. Confirm on pack.", source: "TrueMark starter index" },
  { product_name: "Coartem Tablets 20mg/120mg", brand: "Coartem", category: "Health & medicines", barcode: "", nafdac_number: "04-3275", strength_or_size: "20mg/120mg", notes: "Antimalarial. Confirm on Greenbook.", source: "TrueMark starter index" },
  { product_name: "P-Alaxin Tablets", brand: "P-Alaxin", category: "Health & medicines", barcode: "", nafdac_number: "", strength_or_size: "", notes: "Use NAFDAC number on pack for official check.", source: "TrueMark starter index" },
  { product_name: "Amatem Forte", brand: "Amatem", category: "Health & medicines", barcode: "", nafdac_number: "A4-3489", strength_or_size: "", notes: "Antimalarial. Confirm on pack.", source: "TrueMark starter index" },
  { product_name: "Lumartem Tablets 20mg/120mg", brand: "Lumartem", category: "Health & medicines", barcode: "", nafdac_number: "A4-4845", strength_or_size: "20mg/120mg", notes: "Antimalarial. Confirm on pack.", source: "TrueMark starter index" },
  { product_name: "Nixoderm Ointment", brand: "Nixoderm", category: "Health & medicines", barcode: "", nafdac_number: "04-3294", strength_or_size: "15g", notes: "Skin ointment. Confirm on pack.", source: "TrueMark starter index" },
  { product_name: "Minoxidil Topical Solution 2%", brand: "Minoxidil", category: "Health & medicines", barcode: "", nafdac_number: "", strength_or_size: "2%", notes: "Hair regrowth. Confirm brand and NAFDAC on pack.", source: "TrueMark starter index" },
  { product_name: "Minoxidil Topical Solution 5%", brand: "Minoxidil", category: "Health & medicines", barcode: "", nafdac_number: "", strength_or_size: "5%", notes: "Hair regrowth. Confirm brand and NAFDAC on pack.", source: "TrueMark starter index" },
  { product_name: "Paracetamol 500mg Tablets", brand: "Paracetamol", category: "Health & medicines", barcode: "", nafdac_number: "", strength_or_size: "500mg", notes: "Common analgesic. Prefer NAFDAC number on pack.", source: "TrueMark starter index" },
  { product_name: "Emzor Paracetamol", brand: "Emzor", category: "Health & medicines", barcode: "", nafdac_number: "", strength_or_size: "500mg", notes: "Confirm NAFDAC on pack.", source: "TrueMark starter index" },
  { product_name: "Panadol Extra", brand: "Panadol", category: "Health & medicines", barcode: "", nafdac_number: "", strength_or_size: "", notes: "Confirm NAFDAC on pack.", source: "TrueMark starter index" },
  { product_name: "Amoxil Capsules", brand: "Amoxil", category: "Health & medicines", barcode: "", nafdac_number: "", strength_or_size: "", notes: "Antibiotic. Confirm NAFDAC on pack.", source: "TrueMark starter index" },
  { product_name: "Ampiclox Capsules", brand: "Ampiclox", category: "Health & medicines", barcode: "", nafdac_number: "", strength_or_size: "", notes: "Confirm NAFDAC on pack.", source: "TrueMark starter index" },
  { product_name: "Flagyl Tablets", brand: "Flagyl", category: "Health & medicines", barcode: "", nafdac_number: "", strength_or_size: "", notes: "Confirm NAFDAC on pack.", source: "TrueMark starter index" },
  { product_name: "ORS Sachet", brand: "ORS", category: "Health & medicines", barcode: "", nafdac_number: "", strength_or_size: "", notes: "Oral rehydration. Confirm brand and NAFDAC on pack.", source: "TrueMark starter index" },
  { product_name: "Postinor-2", brand: "Postinor", category: "Health & medicines", barcode: "", nafdac_number: "", strength_or_size: "", notes: "Emergency contraception. Confirm NAFDAC on pack.", source: "TrueMark starter index" },
  { product_name: "Fansidar Tablets", brand: "Fansidar", category: "Health & medicines", barcode: "", nafdac_number: "", strength_or_size: "", notes: "Confirm NAFDAC on pack.", source: "TrueMark starter index" },
  { product_name: "Vitamin C 1000mg", brand: "Vitamin C", category: "Health & medicines", barcode: "", nafdac_number: "", strength_or_size: "1000mg", notes: "Confirm brand and NAFDAC on pack.", source: "TrueMark starter index" },
  { product_name: "Blood Tonic", brand: "Blood Tonic", category: "Health & medicines", barcode: "", nafdac_number: "", strength_or_size: "", notes: "Many brands exist. Confirm NAFDAC on pack.", source: "TrueMark starter index" },
  { product_name: "Robb Inhalant", brand: "Robb", category: "Personal care", barcode: "", nafdac_number: "", strength_or_size: "", notes: "Confirm NAFDAC on pack.", source: "TrueMark starter index" },
  { product_name: "Aboniki Balm", brand: "Aboniki", category: "Personal care", barcode: "", nafdac_number: "", strength_or_size: "", notes: "Confirm NAFDAC on pack.", source: "TrueMark starter index" },
  { product_name: "Delta Soap", brand: "Delta", category: "Personal care", barcode: "", nafdac_number: "", strength_or_size: "", notes: "Confirm NAFDAC on pack if medicated claims.", source: "TrueMark starter index" },
  { product_name: "Dettol Antiseptic", brand: "Dettol", category: "Personal care", barcode: "", nafdac_number: "", strength_or_size: "", notes: "Confirm pack details.", source: "TrueMark starter index" },
  { product_name: "Pure Water Sachet", brand: "Pure Water", category: "Drinks & beverages", barcode: "", nafdac_number: "", strength_or_size: "50cl", notes: "Look for NAFDAC number on sachet. Confirm producer.", source: "TrueMark starter index" },
  { product_name: "Indomie Instant Noodles", brand: "Indomie", category: "Food & groceries", barcode: "", nafdac_number: "", strength_or_size: "", notes: "Common pack. Confirm batch/expiry on pack.", source: "TrueMark starter index" },
  { product_name: "Peak Milk", brand: "Peak", category: "Food & groceries", barcode: "", nafdac_number: "", strength_or_size: "", notes: "Confirm pack details.", source: "TrueMark starter index" },
  { product_name: "Three Crowns Milk", brand: "Three Crowns", category: "Food & groceries", barcode: "", nafdac_number: "", strength_or_size: "", notes: "Confirm pack details.", source: "TrueMark starter index" },
  { product_name: "Cowbell Milk", brand: "Cowbell", category: "Food & groceries", barcode: "", nafdac_number: "", strength_or_size: "", notes: "Confirm pack details.", source: "TrueMark starter index" },
  { product_name: "Golden Penny Spaghetti", brand: "Golden Penny", category: "Food & groceries", barcode: "", nafdac_number: "", strength_or_size: "", notes: "Confirm pack details.", source: "TrueMark starter index" },
  { product_name: "Dangote Sugar", brand: "Dangote", category: "Food & groceries", barcode: "", nafdac_number: "", strength_or_size: "", notes: "Confirm pack details.", source: "TrueMark starter index" },
  { product_name: "Coca-Cola", brand: "Coca-Cola", category: "Drinks & beverages", barcode: "", nafdac_number: "", strength_or_size: "", notes: "Confirm pack details.", source: "TrueMark starter index" },
  { product_name: "Fanta", brand: "Fanta", category: "Drinks & beverages", barcode: "", nafdac_number: "", strength_or_size: "", notes: "Confirm pack details.", source: "TrueMark starter index" },
  { product_name: "Pepsi", brand: "Pepsi", category: "Drinks & beverages", barcode: "", nafdac_number: "", strength_or_size: "", notes: "Confirm pack details.", source: "TrueMark starter index" },
  { product_name: "Maltina", brand: "Maltina", category: "Drinks & beverages", barcode: "", nafdac_number: "", strength_or_size: "", notes: "Confirm pack details.", source: "TrueMark starter index" },
  { product_name: "Amstel Malta", brand: "Amstel Malta", category: "Drinks & beverages", barcode: "", nafdac_number: "", strength_or_size: "", notes: "Confirm pack details.", source: "TrueMark starter index" },
  { product_name: "Eva Water", brand: "Eva", category: "Drinks & beverages", barcode: "", nafdac_number: "", strength_or_size: "", notes: "Confirm NAFDAC on pack.", source: "TrueMark starter index" },
  { product_name: "Aquafina", brand: "Aquafina", category: "Drinks & beverages", barcode: "", nafdac_number: "", strength_or_size: "", notes: "Confirm pack details.", source: "TrueMark starter index" },
  { product_name: "Closeup Toothpaste", brand: "Closeup", category: "Personal care", barcode: "", nafdac_number: "", strength_or_size: "", notes: "Confirm pack details.", source: "TrueMark starter index" },
  { product_name: "Oral-B Toothpaste", brand: "Oral-B", category: "Personal care", barcode: "", nafdac_number: "", strength_or_size: "", notes: "Confirm pack details.", source: "TrueMark starter index" },
  { product_name: "Nivea Cream", brand: "Nivea", category: "Beauty & cosmetics", barcode: "", nafdac_number: "", strength_or_size: "", notes: "Confirm NAFDAC on pack where shown.", source: "TrueMark starter index" },
  { product_name: "Dove Soap", brand: "Dove", category: "Personal care", barcode: "", nafdac_number: "", strength_or_size: "", notes: "Confirm pack details.", source: "TrueMark starter index" },
  { product_name: "Lux Soap", brand: "Lux", category: "Personal care", barcode: "", nafdac_number: "", strength_or_size: "", notes: "Confirm pack details.", source: "TrueMark starter index" },
  { product_name: "Always Sanitary Pad", brand: "Always", category: "Personal care", barcode: "", nafdac_number: "", strength_or_size: "", notes: "Confirm pack details.", source: "TrueMark starter index" },
  { product_name: "Pampers Diapers", brand: "Pampers", category: "Baby & children", barcode: "", nafdac_number: "", strength_or_size: "", notes: "Confirm pack details.", source: "TrueMark starter index" },
  { product_name: "Hypo Bleach", brand: "Hypo", category: "Household products", barcode: "", nafdac_number: "", strength_or_size: "", notes: "Confirm pack details.", source: "TrueMark starter index" },
  { product_name: "Morning Fresh Dishwashing Liquid", brand: "Morning Fresh", category: "Household products", barcode: "", nafdac_number: "", strength_or_size: "", notes: "Confirm pack details.", source: "TrueMark starter index" },
  { product_name: "Omo Detergent", brand: "Omo", category: "Household products", barcode: "", nafdac_number: "", strength_or_size: "", notes: "Confirm pack details.", source: "TrueMark starter index" },
  { product_name: "Ariel Detergent", brand: "Ariel", category: "Household products", barcode: "", nafdac_number: "", strength_or_size: "", notes: "Confirm pack details.", source: "TrueMark starter index" }
];



function searchStarterIndex(query) {
  const q = String(query || "").toLowerCase().trim();
  if (q.length < 2) return [];
  return NIGERIAN_STARTER_INDEX.filter((item) => {
    const hay = [
      item.product_name,
      item.brand,
      item.category,
      item.nafdac_number,
      item.notes
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return hay.includes(q) || q.split(/\s+/).every((part) => hay.includes(part));
  }).map((item) => ({
    product_name: item.product_name,
    brand: item.brand || "",
    category: item.category || "",
    barcode: item.barcode || "",
    nafdac_number: item.nafdac_number || "",
    strength_or_size: item.strength_or_size || "",
    notes: item.notes || "",
    source: item.source || "TrueMark starter index"
  }));
}


const SEARCH_URL =
  "https://truemark-ai.edialeeghonghon.workers.dev/products/search";

function looksLikeBarcode(value) {
  const v = String(value || "").replace(/\s+/g, "");
  return /^\d{8,14}$/.test(v);
}

function looksLikeNafdac(value) {
  const v = String(value || "")
    .toUpperCase()
    .replace(/\s+/g, "")
    .replace(/NAFDAC(REG)?\.?(NO|NUMBER)?[:.]?/g, "");
  return /^(?:[A-Z]\d{1,2}-)?\d{2,6}(?:-\d{1,6})?[A-Z]?$/.test(v);
}

async function fetchFdaRecallsClient(query) {
  try {
    const response = await fetch(
      "https://truemark-ai.edialeeghonghon.workers.dev/recalls?q=" +
        encodeURIComponent(query)
    );
    const data = await response.json();
    const list = data.fda_recalls || data.recalls || data.results || [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

async function searchProductsByName(query) {
  const q = String(query || "").trim();
  if (!q) return [];

  const results = [];

  // 0) Local starter Nigerian index (medicines & common items)
  searchStarterIndex(q).forEach((item) => {
    results.push(item);
  });

  function pushItem(item, source) {
    const product_name = item.product_name || item.generic_name || item.name || "";
    if (!product_name) return;
    results.push({
      product_name: product_name,
      brand: item.brands || item.brand || "",
      category: item.categories || item.category || "",
      barcode: item.code || item.barcode || "",
      image_url:
        item.image_front_small_url ||
        item.image_url ||
        item.image_front_url ||
        "",
      nafdac_number: item.nafdac_number || "",
      source: source
    });
  }

  async function searchOpenFacts(baseUrl, sourceName) {
    try {
      const url =
        baseUrl +
        "/cgi/search.pl?search_terms=" +
        encodeURIComponent(q) +
        "&search_simple=1&action=process&json=1&page_size=10";

      const response = await fetch(url);
      const responseText = await response.text();

      let data;
      try {
        data = JSON.parse(responseText);
      } catch {
        console.warn(sourceName + " returned non-JSON");
        return;
      }

      const list = Array.isArray(data.products) ? data.products : [];
      list.forEach((item) => pushItem(item, sourceName));
    } catch (error) {
      console.warn(sourceName + " search failed:", error);
    }
  }

  // 1) TrueMark Worker / D1
  try {
    const response = await fetch(
      SEARCH_URL + "?q=" + encodeURIComponent(q),
      { method: "GET" }
    );
    const data = await response.json();
    lastFdaRecalls = Array.isArray(data.fda_recalls) ? data.fda_recalls : [];
    const list = Array.isArray(data.products)
      ? data.products
      : Array.isArray(data.results)
      ? data.results
      : [];

    list.forEach((item) => {
      results.push({
        product_name: item.name || item.product_name || "",
        brand: item.brand || item.brands || "",
        category: item.category || item.categories || "",
        barcode: item.barcode || item.code || "",
        image_url: item.image_url || item.image_front_url || "",
        nafdac_number: item.nafdac_number || item.registration_number || "",
        source: "TrueMark index"
      });
    });
  } catch (error) {
    console.warn("TrueMark name search:", error);
  }

  // 2) Open Beauty Facts
  await searchOpenFacts(
    "https://world.openbeautyfacts.org",
    "Open Beauty Facts"
  );

  // 3) Open Food Facts
  await searchOpenFacts(
    "https://world.openfoodfacts.org",
    "Open Food Facts"
  );

  // 4) Open Products Facts
  await searchOpenFacts(
    "https://world.openproductsfacts.org",
    "Open Products Facts"
  );

  const seen = new Set();
  const unique = [];
  results.forEach((item) => {
    const key = (
      (item.barcode || "") +
      "|" +
      String(item.product_name || "").toLowerCase() +
      "|" +
      String(item.nafdac_number || "")
    ).trim();
    if (!item.product_name || seen.has(key)) return;
    seen.add(key);
    unique.push(item);
  });

  if (!lastFdaRecalls.length && /(minoxidil|lonart|tablet|drug|capsule|ointment)/i.test(q)) {
    lastFdaRecalls = await fetchFdaRecallsClient(q);
  }

  return unique.slice(0, 20);
}



function isMinoxidilQuery(q) {
  return /minoxidil|rogaine|regaine|kirkland.*hair|hair\s*regrowth/i.test(String(q || ""));
}

function minoxidilGuideHtml() {
  return (
    '<div class="minox-guide">' +
      '<p class="minox-guide-title">Minoxidil buyer checklist</p>' +
      '<p class="minox-guide-lead">Catalogue gaps are common. Use the pack and official checks — not the listing photo alone.</p>' +
      '<ul class="compact-steps">' +
        '<li><strong>Before paying on Jumia:</strong> prefer pharmacies / official stores; read recent reviews mentioning NAFDAC and seal.</li>' +
        '<li><strong>On arrival:</strong> sealed bottle, clear label, batch + expiry, NAFDAC number printed (not stickered over).</li>' +
        '<li><strong>Strength:</strong> 2% or 5% must match what you ordered; solution vs foam.</li>' +
        '<li><strong>Verify NAFDAC:</strong> enter the number in TrueMark or NAPAMS / Greenbook before first use.</li>' +
        '<li><strong>MAS:</strong> if a scratch panel exists, SMS the code via the official NAFDAC MAS channel on the pack.</li>' +
        '<li><strong>Red flags:</strong> no NAFDAC, broken seal, wrong spelling, watery smell vs known genuine, price far below market.</li>' +
      '</ul>' +
      '<div class="search-buy-row" style="padding-left:0;margin-top:8px;">' +
        '<a class="buy-chip" href="https://registration.nafdac.gov.ng/" target="_blank" rel="noopener noreferrer">Open NAPAMS</a>' +
        '<a class="buy-chip" href="https://greenbook.nafdac.gov.ng/" target="_blank" rel="noopener noreferrer">Open Greenbook</a>' +
        '<a class="buy-chip buy-chip-muted" href="https://www.jumia.com.ng/catalog/?q=minoxidil%205%25" target="_blank" rel="noopener noreferrer">Jumia 5%</a>' +
      '</div>' +
      '<p class="buy-note">TrueMark cannot prove a Jumia listing is genuine from a photo. Only the physical pack + official NAFDAC/MAS checks can support a safer decision.</p>' +
    '</div>'
  );
}

function backToSearchResults() {
  if (lastSearchContext && lastSearchContext.products && lastSearchContext.products.length) {
    showNameSearchResults(lastSearchContext.query, lastSearchContext.products);
    if (scannerStatus) {
      scannerStatus.textContent = "Back to search results.";
    }
    return;
  }
  if (scanResult) {
    scanResult.hidden = true;
    scanResult.innerHTML = "";
  }
  if (scannerStatus) {
    scannerStatus.textContent = "Choose barcode scanning or label photo.";
  }
}

function showNameSearchResults(query, products) {
  if (!scanResult) return;

  lastSearchContext = {
    query: String(query || ""),
    products: Array.isArray(products) ? products.slice() : []
  };

  openScanner();

  if (!products.length) {
    scanResult.innerHTML =
      "<h3>No catalogue match for this name</h3>" +
      "<p>Search: <strong>" + escapeHTML(query) + "</strong></p>" +
      '<div class="auth-card">' +
        '<p class="auth-card-title">This does not mean the product is fake</p>' +
        '<p class="auth-card-lead">TrueMark could not find this name in the starter index or public catalogues. Nigerian medicines are often missing from global catalogues.</p>' +
        (isMinoxidilQuery(query) ? minoxidilGuideHtml() : "") +
    fdaRecallsHtml(lastFdaRecalls, query) +
        '<p class="auth-next-label">Best next steps</p>' +
        '<ul class="auth-steps compact-steps">' +
          "<li>Enter the NAFDAC number from the pack</li>" +
          "<li>Check registration on Greenbook or NAPAMS</li>" +
          "<li>Scan barcode or photograph the label</li>" +
        "</ul>" +
        '<div class="auth-actions">' +
          '<a class="scan-again-button" href="https://greenbook.nafdac.gov.ng/" target="_blank" rel="noopener noreferrer">Open NAFDAC Greenbook</a>' +
          '<a class="scan-again-button" href="https://registration.nafdac.gov.ng/" target="_blank" rel="noopener noreferrer">Open NAPAMS</a>' +
          '<button id="scanAgain" class="scan-again-button" type="button">Photograph product label</button>' +
        "</div>" +
        '<div class="buy-card">' +
          '<p class="buy-card-title">Find where to buy</p>' +
          '<div class="auth-actions">' +
            '<a class="scan-again-button" href="https://www.google.com/search?q=' +
              encodeURIComponent(query + " buy Nigeria") +
              '" target="_blank" rel="noopener noreferrer">Find sellers on Google</a>' +
            '<a class="scan-again-button" href="https://www.jumia.com.ng/catalog/?q=' +
              encodeURIComponent(query) +
              '" target="_blank" rel="noopener noreferrer">Search on Jumia</a>' +
            '<a class="scan-again-button" href="https://www.konga.com/search?search=' +
              encodeURIComponent(query) +
              '" target="_blank" rel="noopener noreferrer">Search on Konga</a>' +
          "</div>" +
          '<p class="buy-note">TrueMark does not sell products. External links are for finding sellers only.</p>' +
        "</div>" +
      "</div>";

    scanResult.hidden = false;
    if (scannerStatus) {
      scannerStatus.textContent =
        "No name match. Label photo, NAFDAC check, or external sellers are next steps.";
    }
    addScanAgainButton(() => {
      if (labelImageInput) labelImageInput.click();
    }, "Photograph product label");
    saveScan(query, "No name match found", "Name search");
    return;
  }

  const cards = products
    .map((item, index) => {
      const title = item.product_name || "Unnamed product";
      const meta = [item.brand, item.category, item.nafdac_number, item.barcode]
        .filter(Boolean)
        .join(" · ");
      const buyQ = encodeURIComponent(title + (item.brand ? " " + item.brand : ""));
      const img = item.image_url
        ? '<img src="' +
          escapeHTML(item.image_url) +
          '" alt="" class="result-thumb">'
        : '<div class="result-thumb result-thumb-empty">✓</div>';
      return (
        '<div class="history-item name-search-result search-result-card" data-search-index="' +
        index +
        '">' +
        '<button type="button" class="search-result-main" data-search-index="' +
        index +
        '">' +
        '<div class="search-result-row">' +
        img +
        '<div class="search-result-text"><strong>' +
        escapeHTML(title) +
        '</strong><small>' +
        escapeHTML(meta || item.source || "Catalogue match") +
        '</small></div></div></button>' +
        '<div class="search-buy-row">' +
        '<a class="buy-chip" href="https://www.jumia.com.ng/catalog/?q=' +
        buyQ +
        '" target="_blank" rel="noopener noreferrer">Buy on Jumia</a>' +
        '<a class="buy-chip" href="https://www.konga.com/search?search=' +
        buyQ +
        '" target="_blank" rel="noopener noreferrer">Buy on Konga</a>' +
        '<a class="buy-chip buy-chip-muted" href="https://www.google.com/search?q=' +
        buyQ +
        encodeURIComponent(" buy Nigeria") +
        '" target="_blank" rel="noopener noreferrer">Google</a>' +
        '</div></div>'
      );
    })
    .join("");

  scanResult.innerHTML =
    "<h3>Search results</h3>" +
    "<p>Showing catalogue matches for <strong>" +
    escapeHTML(query) +
    "</strong>. This is not a full list of every product in Nigeria.</p>" +
    '<div class="history-list" style="max-height:50vh;overflow:auto;">' +
    cards +
    "</div>" +
    (isMinoxidilQuery(query) ? minoxidilGuideHtml() : "") +
    '<div class="auth-card">' +
      '<p class="auth-card-title">Authenticity not confirmed</p>' +
      '<p class="auth-card-lead">A catalogue name match helps identify a product record. It does not prove a physical item is genuine.</p>' +
      '<p class="auth-next-label">Next checks</p>' +
      '<ul class="auth-steps compact-steps">' +
        "<li>Match name, strength and manufacturer on the pack</li>" +
        "<li>Verify NAFDAC number on NAPAMS / Greenbook</li>" +
        "<li>Use MAS scratch SMS if present</li>" +
        "<li>Skip packs with no number or suspicious packaging</li>" +
      "</ul>" +
      '<div class="auth-actions">' +
        '<a class="scan-again-button" href="https://registration.nafdac.gov.ng/" target="_blank" rel="noopener noreferrer">Open NAPAMS</a>' +
        '<a class="scan-again-button" href="https://greenbook.nafdac.gov.ng/" target="_blank" rel="noopener noreferrer">Open Greenbook</a>' +
      "</div>" +
      '<div class="buy-card">' +
        '<p class="buy-card-title">Find where to buy</p>' +
        '<div class="auth-actions">' +
          '<a class="scan-again-button" href="https://www.google.com/search?q=' +
            encodeURIComponent(query + " buy Nigeria") +
            '" target="_blank" rel="noopener noreferrer">Find sellers on Google</a>' +
          '<a class="scan-again-button" href="https://www.jumia.com.ng/catalog/?q=' +
            encodeURIComponent(query) +
            '" target="_blank" rel="noopener noreferrer">Search on Jumia</a>' +
          '<a class="scan-again-button" href="https://www.konga.com/search?search=' +
            encodeURIComponent(query) +
            '" target="_blank" rel="noopener noreferrer">Search on Konga</a>' +
        "</div>" +
        '<p class="buy-note">TrueMark does not sell products. External links are for finding sellers only. Check the pack and NAFDAC details before paying.</p>' +
      "</div>" +
    "</div>" +
    '<button id="scanAgain" class="scan-again-button" type="button">Scan a product instead</button>';

  scanResult.hidden = false;

  if (scannerStatus) {
    scannerStatus.textContent =
      products.length + " catalogue match(es) found.";
  }

  scanResult.querySelectorAll(".search-result-main").forEach((btn) => {
    btn.addEventListener("click", () => {
      const index = Number(btn.getAttribute("data-search-index"));
      const item = products[index];
      if (!item) return;

      // Always show the catalogue / manufacturer record we already found.
      // Do NOT re-run barcode lookup first — a bad/unknown GTIN would wipe a valid name match.
      const sources = [{
        name: item.source || item.source_label || "Catalogue",
        record_type: item.record_type || item.confidence || ""
      }];
      if (item.confidence === "manufacturer_registered" || item.record_type === "manufacturer_registered") {
        sources[0].name = "Manufacturer registered";
      }

      displayProduct(
        {
          product_name: item.product_name || item.name || "",
          brands: item.brand || item.brands || "",
          categories: item.category || item.categories || "",
          quantity: item.strength_or_size || item.quantity || "",
          countries: item.country_of_origin || "",
          manufacturing_places: item.manufacturer || "",
          image_url: item.image_url || "",
          nafdac_number: item.nafdac_number || "",
          confidence: item.confidence || "",
          record_type: item.record_type || ""
        },
        item.barcode || query,
        sources,
        {
          fromSearch: true,
          manufacturerRegistered:
            item.confidence === "manufacturer_registered" ||
            item.record_type === "manufacturer_registered"
        }
      );
      saveScan(
        item.barcode || query,
        item.product_name || item.name || "Name search match",
        sources[0].name
      );
    });
  });

  addScanAgainButton();
  saveScan(query, products[0].product_name || "Name search", "Name search");
}

async function handleProductSearch(query) {
  const q = String(query || "").trim();
  if (!q) {
    showToast("Enter a product name, barcode, or NAFDAC number.");
    return;
  }

  if (looksLikeBarcode(q)) {
    openScanner();
    await lookupProduct(q.replace(/\s+/g, ""));
    return;
  }

  if (looksLikeNafdac(q)) {
    openScanner();
    await runNafdacCheckAndShow(q);
    return;
  }

  if (scannerStatus) {
    scannerStatus.textContent = "Searching product catalogues...";
  }
  showToast("Searching catalogues...");

  openScanner();
  if (scanResult) {
    scanResult.hidden = false;
    scanResult.innerHTML =
      "<h3>Searching...</h3><p>" + escapeHTML(q) + "</p>";
  }

  try {
    const products = await searchProductsByName(q);
    showNameSearchResults(q, products);
  } catch (error) {
    console.error("Name search error:", error);
    if (scanResult) {
      scanResult.innerHTML =
        "<h3>Search could not be completed</h3>" +
        "<p>" +
        escapeHTML(error.message || "Network error") +
        "</p>" +
        "<p>Try scanning a barcode or photographing the label.</p>" +
        '<button id="scanAgain" class="scan-again-button" type="button">Scan a product</button>';
      scanResult.hidden = false;
      addScanAgainButton();
    }
  }
}

const searchForm = $("searchForm");

if (searchForm) {
  searchForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const input = $("productSearch");
    const query = input ? input.value.trim() : "";
    handleProductSearch(query);
  });
}

document.querySelectorAll(".nav-item[data-target]").forEach(button => {
button.addEventListener("click", () => {
const target = $(button.dataset.target);

if (target) {  
    target.scrollIntoView({  
      behavior: "smooth",  
      block: "start"  
    });  
  }  

  document.querySelectorAll(".nav-item").forEach(item => {  
    item.classList.remove("active");  
  });  

  button.classList.add("active");  
});

});

const viewHistory = $("viewHistory");
if (viewHistory) {
  viewHistory.addEventListener("click", () => {
    const section = $("history");
    if (section) section.scrollIntoView({ behavior: "smooth" });
  });
}

const clearHistoryBtn = $("clearHistory");
if (clearHistoryBtn) {
  clearHistoryBtn.addEventListener("click", () => {
    if (confirm("Clear recent activity on this device" + (getAuthToken() ? " and your account history?" : "?"))) {
      clearAllHistory();
    }
  });
}

const alertsCard = $("alerts");
if (alertsCard) {
  alertsCard.style.cursor = "pointer";
  alertsCard.addEventListener("click", () => {
    loadSafetyAlerts();
  });
}









const NAFDAC_VERIFY_URL =
  "https://truemark-ai.edialeeghonghon.workers.dev/verify/nafdac";

async function verifyNafdacOnTrueMark(nafdacNumber) {
  const response = await fetch(NAFDAC_VERIFY_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      nafdac_number: String(nafdacNumber || "").trim()
    })
  });

  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error("Invalid response from TrueMark NAFDAC check.");
  }

  if (!response.ok || data.success === false) {
    throw new Error(data.error || data.message || "NAFDAC check failed.");
  }

  return data;
}

async function runNafdacCheckAndShow(nafdacNumber) {
  if (!scanResult) return;

  scanResult.innerHTML = `
    <h3>Checking NAFDAC number…</h3>
    <p>${escapeHTML(String(nafdacNumber || ""))}</p>
  `;
  scanResult.hidden = false;

  try {
    const data = await verifyNafdacOnTrueMark(nafdacNumber);
    renderNafdacCheckResult(data);
    saveScan(
      data.nafdac_number || nafdacNumber,
      data.title || "NAFDAC check",
      "TrueMark NAFDAC"
    );
  } catch (error) {
    scanResult.innerHTML = `
      <h3>NAFDAC check could not be completed</h3>
      <p>${escapeHTML(error.message || "Network error")}</p>
      <p>
        You can still verify manually on
        <a href="https://registration.nafdac.gov.ng/" target="_blank" rel="noopener noreferrer">NAPAMS</a>
        or
        <a href="https://greenbook.nafdac.gov.ng/" target="_blank" rel="noopener noreferrer">Greenbook</a>.
      </p>
      <button id="scanAgain" class="scan-again-button" type="button">Scan another product</button>
    `;
    addScanAgainButton();
  }
}

function renderNafdacCheckResult(data) {
  if (!scanResult) return;

  const number = data.nafdac_number || "";
  const steps = Array.isArray(data.how_to_check) ? data.how_to_check : [];
  const napams = (data.official_links && data.official_links.napams)
    ? data.official_links.napams
    : "https://registration.nafdac.gov.ng/";
  const greenbook = (data.official_links && data.official_links.greenbook)
    ? data.official_links.greenbook
    : "https://greenbook.nafdac.gov.ng/";

  let stepsHtml = "";
  for (let i = 0; i < steps.length; i++) {
    stepsHtml += "<li>" + escapeHTML(steps[i]) + "</li>";
  }

  scanResult.innerHTML =
    "<h3>" + escapeHTML(data.title || "NAFDAC check") + "</h3>" +
    "<p><strong>Status:</strong> " + escapeHTML(data.status || "official_check_required") + "</p>" +
    '<div class="verification-warning" style="border-left:4px solid #0b6e4f;">' +
      "<strong>NAFDAC number</strong>" +
      '<p style="font-size:1.25rem;font-weight:700;">' + escapeHTML(number) + "</p>" +
      "<p>" + escapeHTML(data.message || "") + "</p>" +
    "</div>" +
    '<div class="product-details">' +
      "<strong>How to complete the official check</strong>" +
      "<ol>" + stepsHtml + "</ol>" +
    "</div>" +
    '<p style="display:flex;flex-direction:column;gap:8px;">' +
      '<button id="copyNafdacBtn" class="scan-again-button" type="button">Copy NAFDAC number</button>' +
      '<a class="scan-again-button" style="text-align:center;text-decoration:none;" href="' + escapeHTML(napams) + '" target="_blank" rel="noopener noreferrer">Open NAPAMS Verify Product</a>' +
      '<a class="scan-again-button" style="text-align:center;text-decoration:none;" href="' + escapeHTML(greenbook) + '" target="_blank" rel="noopener noreferrer">Open NAFDAC Greenbook</a>' +
    "</p>" +
    '<div class="verification-warning">' +
      "<strong>Registration is not authenticity</strong>" +
      "<p>" + escapeHTML(data.disclaimer || "A registration record does not prove this physical item is genuine.") + "</p>" +
    "</div>" +
    '<button id="scanAgain" class="scan-again-button" type="button">Scan another product</button>';

  scanResult.hidden = false;

  const copyBtn = $("copyNafdacBtn");
  if (copyBtn) {
    copyBtn.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(number);
        showToast("NAFDAC number copied");
      } catch {
        showToast("Copy failed — select the number manually");
      }
    });
  }

  addScanAgainButton();

  if (scannerStatus) {
    scannerStatus.textContent =
      "NAFDAC number ready. Complete the official check on NAFDAC portals.";
  }
}

  


const manualNafdacBtn = $("manualNafdacBtn");
const manualNafdacInput = $("manualNafdacInput");

if (manualNafdacBtn && manualNafdacInput) {
  manualNafdacBtn.addEventListener("click", () => {
    const value = manualNafdacInput.value.trim();
    if (!value) {
      showToast("Enter a NAFDAC number first");
      return;
    }
    openScanner();
    runNafdacCheckAndShow(value);
  });
}

/* =========================
INITIALISE TRUEMARK
========================= */
displayHistory();

console.log("TrueMark 2.0 barcode intelligence initialised.");

});
