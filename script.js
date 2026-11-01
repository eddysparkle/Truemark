const scanButton = document.getElementById("scanButton");
const navScan = document.getElementById("navScan");
const scannerModal = document.getElementById("scannerModal");
const closeScanner = document.getElementById("closeScanner");
const startCameraButton = document.getElementById("startCamera");
const labelScanButton = document.getElementById("labelScanButton");
const labelImageInput = document.getElementById("labelImageInput");
const scannerStatus = document.getElementById("scannerStatus");
const scanResult = document.getElementById("scanResult");
const historyList = document.getElementById("historyList");
const toast = document.getElementById("toast");

let html5QrCode = null;
let cameraRunning = false;
let startingCamera = false;
let processingScan = false;

const HISTORY_KEY = "truemarkScanHistory";

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("show");

  clearTimeout(showToast.timer);

  showToast.timer = setTimeout(() => {
    toast.classList.remove("show");
  }, 3000);
}

function escapeHTML(value) {
  return String(value ?? "").replace(/[&<>"']/g, character => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[character]);
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
  const history = getHistory();

  history.unshift({
    barcode: identifier || "No barcode",
    name: name || "Product label scan",
    method: method || "Scanned",
    date: new Date().toLocaleString()
  });

  localStorage.setItem(
    HISTORY_KEY,
    JSON.stringify(history.slice(0, 30))
  );

  displayHistory();
}

function displayHistory() {
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
        <small>${escapeHTML(item.method || "Scanned")} · ${escapeHTML(item.barcode)}</small>
        <small>${escapeHTML(item.date)}</small>
      </div>
      <span class="history-badge">Scanned</span>
    </div>
  `).join("");
}

function openScanner() {
  processingScan = false;

  scanResult.hidden = true;
  scanResult.innerHTML = "";

  startCameraButton.hidden = false;
  startCameraButton.disabled = false;
  startCameraButton.textContent = "Scan barcode";

  scannerStatus.textContent =
    "Choose a scanning method to begin.";

  scannerModal.classList.add("open");
  scannerModal.setAttribute("aria-hidden", "false");
}

async function startCamera() {
  if (cameraRunning || startingCamera) return;

  if (typeof Html5Qrcode === "undefined") {
    scannerStatus.textContent =
      "Barcode scanner library did not load. Check your internet connection and reload the page.";

    return;
  }

  startingCamera = true;

  startCameraButton.disabled = true;
  startCameraButton.textContent = "Starting camera...";

  scannerStatus.textContent =
    "Requesting camera permission...";

  try {
    document.getElementById("reader").innerHTML = "";

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
      "Unable to access the camera. Check browser permissions and try again.";

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

  document.getElementById("reader").innerHTML = "";
}

async function onScanSuccess(decodedText) {
  if (!cameraRunning || processingScan) return;

  processingScan = true;
  cameraRunning = false;

  scannerStatus.textContent =
    "Barcode detected. Looking up product information...";

  try {
    if (html5QrCode && html5QrCode.isScanning) {
      await html5QrCode.stop();
    }

  } catch (error) {
    console.warn("Could not stop scanner:", error);
  }

  html5QrCode = null;

  await lookupProduct(decodedText);
}

async function lookupProduct(barcode) {
  const fields =
    "code,product_name,brands,categories,quantity,image_url,countries,manufacturing_places";

  const url =
    `https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(barcode)}.json?fields=${fields}`;

  try {
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`Database returned ${response.status}`);
    }

    const data = await response.json();

    if (data.status !== 1 || !data.product) {
      showProductNotFound(barcode);

      saveScan(
        barcode,
        "Product not found in current database",
        "Barcode"
      );

      return;
    }

    const product = data.product;

    const productName =
      product.product_name ||
      product.brands ||
      "Product information found";

    displayProduct(product, barcode);

    saveScan(barcode, productName, "Barcode");

    showToast("Product information retrieved.");

  } catch (error) {
    console.error("Product lookup error:", error);

    showProductUnavailable(barcode);

    saveScan(
      barcode,
      "Product lookup unavailable",
      "Barcode"
    );
  }
}

function showProductNotFound(barcode) {
  scanResult.innerHTML = `
    <h3>No matching product record</h3>

    <p>
      Barcode: <strong>${escapeHTML(barcode)}</strong>
    </p>

    <div class="verification-warning">
      <strong>
        Insufficient information — not a counterfeit verdict
      </strong>

      <p>
        We could not find this barcode in the current food-product
        database. The product may be genuine and simply not listed here.
      </p>
    </div>

    <button id="scanAgain" class="scan-again-button" type="button">
      Scan another product
    </button>
  `;

  scanResult.hidden = false;

  scannerStatus.textContent =
    "No matching product record was found.";

  document
    .getElementById("scanAgain")
    .addEventListener("click", resetScanner);
}

function showProductUnavailable(barcode) {
  scanResult.innerHTML = `
    <h3>Product lookup unavailable</h3>

    <p>
      Barcode: <strong>${escapeHTML(barcode)}</strong>
    </p>

    <p>
      TrueMark could not connect to the product information service.
      Check your internet connection and try again.
    </p>

    <button id="scanAgain" class="scan-again-button" type="button">
      Try again
    </button>
  `;

  scanResult.hidden = false;

  scannerStatus.textContent =
    "Product database connection unavailable.";

  document
    .getElementById("scanAgain")
    .addEventListener("click", resetScanner);
}

function displayProduct(product, barcode) {
  const name =
    product.product_name || "Name unavailable";

  const brand =
    product.brands || "Brand unavailable";

  const category =
    product.categories || "Category unavailable";

  const quantity =
    product.quantity || "Not provided";

  const country =
    product.countries || "Not provided";

  const manufacturer =
    product.manufacturing_places || "Not provided";

  const image =
    product.image_url || "";

  scanResult.innerHTML = `
    <span class="result-check">✓</span>

    <h3>Product information found</h3>

    ${
      image
        ? `<img
            src="${escapeHTML(image)}"
            alt="Product reference image"
            style="width:140px;max-height:150px;object-fit:contain;margin:15px auto;display:block;"
          >`
        : ""
    }

    <div class="product-details">
      <p><strong>Product:</strong> ${escapeHTML(name)}</p>
      <p><strong>Brand:</strong> ${escapeHTML(brand)}</p>
      <p><strong>Category:</strong> ${escapeHTML(category)}</p>
      <p><strong>Quantity:</strong> ${escapeHTML(quantity)}</p>
      <p><strong>Countries listed:</strong> ${escapeHTML(country)}</p>
      <p><strong>Manufacturing location:</strong> ${escapeHTML(manufacturer)}</p>
      <p><strong>Barcode:</strong> ${escapeHTML(barcode)}</p>
    </div>

    <div class="verification-warning">
      <strong>Authenticity not confirmed</strong>

      <p>
        This community product record helps identify the product type.
        It does not verify the specific physical item in your hand.
      </p>
    </div>

    <p class="result-note">
      Product information supplied by Open Food Facts. Coverage and
      community-submitted details may be incomplete or inaccurate.
      This database is mainly useful for food and drinks.
    </p>

    <button id="scanAgain" class="scan-again-button" type="button">
      Scan another product
    </button>
  `;

  scanResult.hidden = false;

  scannerStatus.textContent =
    "Product information retrieved.";

  document
    .getElementById("scanAgain")
    .addEventListener("click", resetScanner);
}

async function handleLabelPhoto(event) {
  const image =
    event.target.files && event.target.files[0];

  if (!image) return;

  if (!image.type.startsWith("image/")) {
    showToast("Please choose an image of the product label.");
    event.target.value = "";
    return;
  }

  await stopCamera();

  processingScan = true;

  labelScanButton.disabled = true;
  startCameraButton.disabled = true;

  scanResult.hidden = false;

  scanResult.innerHTML = `
    <h3>Reading product label...</h3>
    <p>
      Keep this page open. Text extraction may take a little time on your phone.
    </p>
  `;

  scannerStatus.textContent =
    "Preparing label image...";

  try {
    if (typeof Tesseract === "undefined") {
      throw new Error("OCR library did not load.");
    }

    const result = await Tesseract.recognize(
      image,
      "eng",
      {
        logger: message => {
          if (message.status === "recognizing text") {
            scannerStatus.textContent =
              `Reading label: ${Math.round(message.progress * 100)}%`;

          } else if (message.status) {
            scannerStatus.textContent = message.status;
          }
        }
      }
    );

    const extractedText =
      (result.data.text || "").trim();

    displayLabelResult(extractedText, image.name);

    const guessedName =
      guessProductName(extractedText);

    saveScan(
      "Label photo",
      guessedName || "Product label photographed",
      "Label OCR"
    );

    showToast("Label text extraction finished.");

  } catch (error) {
    console.error("OCR error:", error);

    scanResult.innerHTML = `
      <h3>Could not read this label</h3>

      <p>
        The text-reading service may not have loaded, or the image
        may be difficult to read. Try a sharper, well-lit photo.
      </p>

      <button id="scanAgain" class="scan-again-button" type="button">
        Choose another photo
      </button>
    `;

    scanResult.hidden = false;

    scannerStatus.textContent =
      "Label reading was unsuccessful.";

    document
      .getElementById("scanAgain")
      .addEventListener("click", () => labelImageInput.click());

  } finally {
    labelScanButton.disabled = false;
    startCameraButton.disabled = false;
    labelImageInput.value = "";
    processingScan = false;
  }
}

function guessProductName(text) {
  const lines = text
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);

  return lines.slice(0, 2).join(" ").slice(0, 100);
}

function displayLabelResult(text) {
  if (!text) {
    scanResult.innerHTML = `
      <h3>No readable text found</h3>

      <p>
        Try taking a closer, sharper photograph with good lighting
        and less glare.
      </p>

      <button id="scanAgain" class="scan-again-button" type="button">
        Try another photo
      </button>
    `;

    scanResult.hidden = false;

    scannerStatus.textContent =
      "No text could be extracted.";

    document
      .getElementById("scanAgain")
      .addEventListener("click", () => labelImageInput.click());

    return;
  }

  scanResult.innerHTML = `
    <span class="result-check">✓</span>

    <h3>Label text extracted</h3>

    <div class="ocr-result">
      <h4>Text read from the packaging</h4>
      <pre>${escapeHTML(text)}</pre>
    </div>

    <div class="verification-warning">
      <strong>Authenticity not confirmed</strong>

      <p>
        TrueMark has read visible text from this photograph.
        OCR can make mistakes, and copied packaging can contain
        genuine-looking details. This result does not confirm
        that the product is genuine or safe.
      </p>
    </div>

    <p class="result-note">
      Check the extracted text against the manufacturer's and
      relevant regulator's official records. Do not use this OCR
      result alone to decide whether a medicine is genuine.
    </p>

    <button id="scanAgain" class="scan-again-button" type="button">
      Scan another label
    </button>
  `;

  scanResult.hidden = false;

  scannerStatus.textContent =
    "Label information extracted. No authenticity check has been performed.";

  document
    .getElementById("scanAgain")
    .addEventListener("click", () => labelImageInput.click());
}

async function resetScanner() {
  await stopCamera();

  processingScan = false;

  scanResult.hidden = true;
  scanResult.innerHTML = "";

  startCameraButton.hidden = false;
  startCameraButton.disabled = false;
  startCameraButton.textContent = "Scan barcode";

  scannerStatus.textContent =
    "Choose a scanning method to begin.";
}

async function closeScannerModal() {
  if (startingCamera) {
    showToast("Please wait for the camera to finish starting.");
    return;
  }

  await stopCamera();

  processingScan = false;

  scannerModal.classList.remove("open");
  scannerModal.setAttribute("aria-hidden", "true");
}

scanButton.addEventListener("click", openScanner);
navScan.addEventListener("click", openScanner);

startCameraButton.addEventListener("click", startCamera);

labelScanButton.addEventListener("click", () => {
  if (startingCamera) return;

  labelImageInput.click();
});

labelImageInput.addEventListener("change", handleLabelPhoto);

closeScanner.addEventListener("click", closeScannerModal);

scannerModal.addEventListener("click", event => {
  if (event.target === scannerModal) {
    closeScannerModal();
  }
});

document.querySelectorAll(".category-card").forEach(card => {
  card.addEventListener("click", () => {
    document
      .querySelectorAll(".category-card")
      .forEach(item => item.classList.remove("selected"));

    card.classList.add("selected");

    showToast(`${card.dataset.category} selected.`);
  });
});

document
  .getElementById("searchForm")
  .addEventListener("submit", event => {
    event.preventDefault();

    const query =
      document.getElementById("productSearch").value.trim();

    if (!query) {
      showToast("Enter a product name or barcode.");
      return;
    }

    showToast("Product search will be connected in a later stage.");
  });

document.querySelectorAll(".nav-item[data-target]").forEach(button => {
  button.addEventListener("click", () => {
    const target =
      document.getElementById(button.dataset.target);

    if (target) {
      target.scrollIntoView({
        behavior: "smooth",
        block: "start"
      });
    }

    document
      .querySelectorAll(".nav-item")
      .forEach(item => item.classList.remove("active"));

    button.classList.add("active");
  });
});

document
  .getElementById("viewHistory")
  .addEventListener("click", () => {
    document
      .getElementById("history")
      .scrollIntoView({ behavior: "smooth" });
  });

displayHistory();
