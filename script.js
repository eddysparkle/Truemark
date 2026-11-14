/* =========================================================
TRUEMARK 5.5 — AI PRODUCT RECOGNITION
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

function getHistory() {
try {
const data = JSON.parse(
localStorage.getItem(HISTORY_KEY) || "[]"
);

return Array.isArray(data) ? data : [];  

} catch {  
  return [];  
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

  localStorage.setItem(  
    HISTORY_KEY,  
    JSON.stringify(history.slice(0, 30))  
  );  

  displayHistory();  

} catch (error) {  
  console.warn("History error:", error);  
}

}

function displayHistory() {
if (!historyList) return;

const history = getHistory();  

if (!history.length) {  
  historyList.innerHTML = `  
    <div class="empty-state">  
      <span class="empty-icon">▦</span>  
      <h3>No scans yet</h3>  
      <p>Products you scan will appear here.</p>  
    </div>  
  `;  
  return;  
}  

historyList.innerHTML = history.map(item => `  
  <div class="history-item">  
    <div>  
      <strong>${escapeHTML(item.name)}</strong>  
      <small>  
        ${escapeHTML(item.method || "Scanned")}  
        · ${escapeHTML(item.barcode)}  
      </small>  
      <small>${escapeHTML(item.date)}</small>  
    </div>  
    <span class="history-badge">Scanned</span>  
  </div>  
`).join("");

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
          "TrueMark could not find this barcode in the connected public catalogues."
      );
      saveScan(barcode, "No catalogue match found", "TrueMark Worker");
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

function showProductNotFound(barcode, message) {
  if (!scanResult) return;

  scanResult.innerHTML = `
    <h3>No catalogue match found</h3>
    <p>Barcode: <strong>${escapeHTML(barcode)}</strong></p>
    <div class="verification-warning">
      <strong>This does not mean the product is fake</strong>
      <p>
        ${escapeHTML(
          message ||
            "TrueMark could not find this barcode in the connected public catalogues."
        )}
      </p>
      <p>
        Next step: photograph the product label so we can extract the name,
        brand and any registration number on the pack.
      </p>
    </div>
    <button id="scanAgain" class="scan-again-button" type="button">
      Photograph product label
    </button>
  `;

  scanResult.hidden = false;

  if (scannerStatus) {
    scannerStatus.textContent =
      "No catalogue match. Label photo is the best next step.";
  }

  addScanAgainButton(() => {
    if (labelImageInput) labelImageInput.click();
  }, "Photograph product label");
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

function displayProduct(product, barcode, sources = []) {
if (!scanResult) return;

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

scanResult.innerHTML = `  
  <span class="result-check">✓</span>  
  <h3>Product information found</h3>  

  ${image ? `  
    <img  
      src="${escapeHTML(image)}"  
      alt="Product reference"  
      style="width:140px;max-height:150px;object-fit:contain;margin:15px auto;display:block;"  
    >  
  ` : ""}  

  <div class="product-details">  
    ${fields.map(([label, value]) => `  
      <p>  
        <strong>${label}:</strong>  
        ${escapeHTML(value || "Not provided")}  
      </p>  
    `).join("")}  
  </div>  

  <div class="verification-warning">  
    <strong>Authenticity not confirmed</strong>  
    <p>  
      This database record helps identify a product type.  
      It does not authenticate the physical item.  
    </p>  
  </div>  

  <p class="result-note">  
    Source: Open Food Facts, a community-contributed database.  
    Coverage and entries may be incomplete.  
  </p>  

  <button id="scanAgain"  
    class="scan-again-button" type="button">  
    Scan another product  
  </button>  
`;  

scanResult.hidden = false;  

if (scannerStatus) {  
  scannerStatus.textContent =  
    "Product information retrieved.";  
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
  {
    product_name: "Lonart Tablets 20mg/120mg",
    brand: "Lonart",
    category: "Health & medicines",
    barcode: "",
    nafdac_number: "04-8969",
    strength_or_size: "20mg/120mg",
    notes: "Artemether/Lumefantrine antimalarial. Confirm number on pack.",
    source: "TrueMark starter index"
  },
  {
    product_name: "Lonart DS Tablets 80mg/480mg",
    brand: "Lonart",
    category: "Health & medicines",
    barcode: "",
    nafdac_number: "04-9927",
    strength_or_size: "80mg/480mg",
    notes: "Double-strength Lonart. Confirm number on pack.",
    source: "TrueMark starter index"
  },
  {
    product_name: "Lonart Suspension 20/120",
    brand: "Lonart",
    category: "Health & medicines",
    barcode: "",
    nafdac_number: "04-8970",
    strength_or_size: "20mg/120mg suspension",
    notes: "Paediatric suspension. Confirm number on pack.",
    source: "TrueMark starter index"
  },
  {
    product_name: "Coartem Tablets 20mg/120mg",
    brand: "Coartem",
    category: "Health & medicines",
    barcode: "",
    nafdac_number: "04-3275",
    strength_or_size: "20mg/120mg",
    notes: "Artemether/Lumefantrine. Confirm status on Greenbook.",
    source: "TrueMark starter index"
  },
  {
    product_name: "P-Alaxin Tablets",
    brand: "P-Alaxin",
    category: "Health & medicines",
    barcode: "",
    nafdac_number: "",
    strength_or_size: "",
    notes: "Antimalarial. Use NAFDAC number on pack for official check.",
    source: "TrueMark starter index"
  },
  {
    product_name: "Amatem Forte",
    brand: "Amatem",
    category: "Health & medicines",
    barcode: "",
    nafdac_number: "A4-3489",
    strength_or_size: "",
    notes: "Antimalarial. Confirm number on pack.",
    source: "TrueMark starter index"
  },
  {
    product_name: "Lumartem Tablets 20mg/120mg",
    brand: "Lumartem",
    category: "Health & medicines",
    barcode: "",
    nafdac_number: "A4-4845",
    strength_or_size: "20mg/120mg",
    notes: "Antimalarial. Confirm number on pack.",
    source: "TrueMark starter index"
  },
  {
    product_name: "Nixoderm Ointment",
    brand: "Nixoderm",
    category: "Health & medicines",
    barcode: "",
    nafdac_number: "04-3294",
    strength_or_size: "15g",
    notes: "Skin ointment. Confirm number on pack.",
    source: "TrueMark starter index"
  },
  {
    product_name: "Minoxidil Topical Solution 2%",
    brand: "",
    category: "Health & medicines",
    barcode: "",
    nafdac_number: "",
    strength_or_size: "2%",
    notes: "Hair regrowth. Confirm brand and NAFDAC on pack.",
    source: "TrueMark starter index"
  },
  {
    product_name: "Minoxidil Topical Solution 5%",
    brand: "",
    category: "Health & medicines",
    barcode: "",
    nafdac_number: "",
    strength_or_size: "5%",
    notes: "Hair regrowth. Confirm brand and NAFDAC on pack.",
    source: "TrueMark starter index"
  }
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
      item.strength_or_size,
      item.notes
    ]
      .join(" ")
      .toLowerCase();
    return hay.indexOf(q) !== -1;
  }).map((item) => ({
    product_name: item.product_name,
    brand: item.brand,
    category: item.category,
    barcode: item.barcode || "",
    image_url: "",
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

  return unique.slice(0, 20);
}

function showNameSearchResults(query, products) {
  if (!scanResult) return;

  openScanner();

  if (!products.length) {
    scanResult.innerHTML =
      "<h3>No catalogue match for this name</h3>" +
      "<p>Search: <strong>" + escapeHTML(query) + "</strong></p>" +
      '<div class="auth-card">' +
        '<p class="auth-card-title">This does not mean the product is fake</p>' +
        '<p class="auth-card-lead">TrueMark could not find this name in the starter index or public catalogues. Nigerian medicines are often missing from global catalogues.</p>' +
        "<h4>Best next steps for medicines</h4>" +
        '<ol class="auth-steps">' +
          "<li>Enter the NAFDAC number from the pack.</li>" +
          "<li>Open Greenbook or NAPAMS to check registration.</li>" +
          "<li>Scan a barcode if present, or photograph the label.</li>" +
        "</ol>" +
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
      const meta = [
        item.brand,
        item.category,
        item.barcode,
        item.nafdac_number ? "NAFDAC " + item.nafdac_number : ""
      ]
        .filter(Boolean)
        .join(" · ");
      const img = item.image_url
        ? '<img src="' +
          escapeHTML(item.image_url) +
          '" alt="" style="width:56px;height:56px;object-fit:contain;border-radius:8px;">'
        : "";
      return (
        '<button type="button" class="history-item name-search-result" data-search-index="' +
        index +
        '" style="width:100%;text-align:left;cursor:pointer;">' +
        '<div style="display:flex;gap:10px;align-items:center;">' +
        img +
        "<div><strong>" +
        escapeHTML(title) +
        "</strong><small>" +
        escapeHTML(meta || item.source || "Catalogue match") +
        "</small></div></div></button>"
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
    '<div class="auth-card">' +
      '<p class="auth-card-title">Authenticity not confirmed</p>' +
      '<p class="auth-card-lead">A catalogue name match helps identify a product record. It does not prove a physical item is genuine.</p>' +
      "<h4>What you should do next</h4>" +
      '<ol class="auth-steps">' +
        "<li>Compare name, strength and manufacturer with the physical pack.</li>" +
        "<li>Find the NAFDAC number on the pack and verify it on NAPAMS or Greenbook.</li>" +
        "<li>If the pack has a MAS scratch code, use the official SMS check.</li>" +
        "<li>Avoid packs with no NAFDAC number, mismatched details or suspicious packaging.</li>" +
      "</ol>" +
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

  scanResult.querySelectorAll("[data-search-index]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const index = Number(btn.getAttribute("data-search-index"));
      const item = products[index];
      if (!item) return;

      if (item.barcode && looksLikeBarcode(item.barcode)) {
        lookupProduct(item.barcode);
        return;
      }

      if (item.nafdac_number && String(item.nafdac_number).trim()) {
        runNafdacCheckAndShow(item.nafdac_number);
        return;
      }

      displayProduct(
        {
          product_name: item.product_name,
          brands: item.brand,
          categories: item.category,
          quantity: item.strength_or_size || "",
          countries: "",
          manufacturing_places: "",
          image_url: item.image_url
        },
        item.barcode || query,
        [{ name: item.source || "Catalogue" }]
      );
      saveScan(
        item.barcode || query,
        item.product_name || "Name search match",
        "Name search"
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

if (section) {  
    section.scrollIntoView({  
      behavior: "smooth"  
    });  
  }  
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

console.log("TrueMark 5.5 initialised successfully.");

});
