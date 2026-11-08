/* =========================================================
TRUEMARK 5.1 — AI PRODUCT RECOGNITION
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
      Analysed \( {photoCount} photo \){photoCount === 1 ? "" : "s"}.
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

const searchForm = $("searchForm");

if (searchForm) {
searchForm.addEventListener("submit", event => {
event.preventDefault();

const input = $("productSearch");  
  const query = input ? input.value.trim() : "";  

  if (!query) {  
    showToast("Enter a product name or barcode.");  
    return;  
  }  

  showToast(  
    "Product search will be connected in a later stage."  
  );  
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
  const napams = data.official_links?.napams || "https://registration.nafdac.gov.ng/";
  const greenbook = data.official_links?.greenbook || "https://greenbook.nafdac.gov.ng/";

  scanResult.innerHTML = `
    <h3>${escapeHTML(data.title || "NAFDAC check")}</h3>

    <p>
      <strong>Status:</strong> ${escapeHTML(data.status || "official_check_required")}
    </p>

    <div class="verification-warning" style="border-left:4px solid #0b6e4f;">
      <strong>NAFDAC number</strong>
      <p style="font-size:1.25rem;font-weight:700;letter-spacing:0.03em;">
        ${escapeHTML(number)}
      </p>
      <p>${escapeHTML(data.message || "")}</p>
    </div>

    <div class="product-details">
      <strong>How to complete the official check</strong>
      <ol>
        \( {steps.map((step) => `<li> \){escapeHTML(step)}</li>`).join("")}
      </ol>
    </div>

    <p style="display:flex;flex-direction:column;gap:8px;">
      <button id="copyNafdacBtn" class="scan-again-button" type="button">
        Copy NAFDAC number
      </button>
      <a
        class="scan-again-button"
        style="text-align:center;text-decoration:none;"
        href="${escapeHTML(napams)}"
        target="_blank"
        rel="noopener noreferrer"
      >
        Open NAPAMS Verify Product
      </a>
      <a
        class="scan-again-button"
        style="text-align:center;text-decoration:none;"
        href="${escapeHTML(greenbook)}"
        target="_blank"
        rel="noopener noreferrer"
      >
        Open NAFDAC Greenbook
      </a>
    </p>

    <div class="verification-warning">
      <strong>Registration is not authenticity</strong>
      <p>
        ${escapeHTML(
          data.disclaimer ||
            "A registration record does not prove this physical item is genuine."
        )}
      </p>
    </div>

    <button id="scanAgain" class="scan-again-button" type="button">
      Scan another product
    </button>
  `;

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

  

/* =========================
INITIALISE TRUEMARK
========================= */

displayHistory();

console.log("TrueMark 5.1 initialised successfully.");

});
