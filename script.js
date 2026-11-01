/* =========================================================
   TRUEMARK 4.0 — PRODUCT LABEL RECOGNITION
   Browser OCR only. Recognition is not authenticity verification.
========================================================= */

document.addEventListener("DOMContentLoaded", () => {
  const $ = id => document.getElementById(id);

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

  const HISTORY_KEY = "truemarkScanHistory";

  let html5QrCode = null;
  let cameraRunning = false;
  let startingCamera = false;
  let processingScan = false;

  if (labelImageInput) {
    labelImageInput.multiple = true;
    labelImageInput.accept = "image/*";
  }

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
    return String(value ?? "").replace(/[&<>"']/g, ch => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    })[ch]);
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
        name: name || "Product label scan",
        method: method || "Scanned",
        date: new Date().toLocaleString()
      });

      localStorage.setItem(
        HISTORY_KEY,
        JSON.stringify(history.slice(0, 30))
      );

      displayHistory();
    } catch (error) {
      console.warn("Could not save scan history:", error);
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

  function openScanner() {
    if (!scannerModal) return;

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
        "Barcode scanner did not load. Check your connection and reload.";
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
        "Unable to access the camera. Check browser camera permissions.";

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

    scannerStatus.textContent =
      "Barcode detected. Looking up product information...";

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

  async function lookupProduct(barcode) {
    const fields =
      "code,product_name,brands,categories,quantity,image_url,countries,manufacturing_places";

    const url =
      `https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(barcode)}.json?fields=${fields}`;

    try {
      const response = await fetch(url);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
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

      displayProduct(product, barcode);

      saveScan(
        barcode,
        product.product_name || product.brands || "Product information found",
        "Barcode"
      );

      showToast("Product information retrieved.");

    } catch (error) {
      console.error("Product lookup error:", error);

      showProductUnavailable(barcode, error.message);

      saveScan(
        barcode,
        "Product lookup unavailable",
        "Barcode"
      );
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

  function showProductNotFound(barcode) {
    scanResult.innerHTML = `
      <h3>No matching product record</h3>

      <p>
        Barcode:
        <strong>${escapeHTML(barcode)}</strong>
      </p>

      <div class="verification-warning">
        <strong>Not enough information to verify</strong>

        <p>
          This barcode is not listed in the current database.
          That does not mean the product is counterfeit.
        </p>
      </div>

      <button
        id="scanAgain"
        class="scan-again-button"
        type="button"
      >
        Scan another product
      </button>
    `;

    scanResult.hidden = false;

    scannerStatus.textContent =
      "No matching product record was found.";

    addScanAgainButton();
  }

  function showProductUnavailable(barcode, reason) {
    scanResult.innerHTML = `
      <h3>Product lookup unavailable</h3>

      <p>
        Barcode:
        <strong>${escapeHTML(barcode)}</strong>
      </p>

      <p>
        TrueMark could not retrieve product information right now.
        ${escapeHTML(reason || "")}
      </p>

      <p>No authenticity conclusion has been made.</p>

      <button
        id="scanAgain"
        class="scan-again-button"
        type="button"
      >
        Try again
      </button>
    `;

    scanResult.hidden = false;

    scannerStatus.textContent =
      "Product information service unavailable.";

    addScanAgainButton();
  }

  function displayProduct(product, barcode) {
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
          style="
            width:140px;
            max-height:150px;
            object-fit:contain;
            margin:15px auto;
            display:block;
          "
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
          This database record may help identify a product type.
          It does not authenticate the physical item.
        </p>
      </div>

      <p class="result-note">
        Source: Open Food Facts, a community-contributed database
        mainly covering food and drinks. Its coverage and entries
        may be incomplete.
      </p>

      <button
        id="scanAgain"
        class="scan-again-button"
        type="button"
      >
        Scan another product
      </button>
    `;

    scanResult.hidden = false;

    scannerStatus.textContent =
      "Product information retrieved.";

    addScanAgainButton();
  }

  async function makeEnhancedImage(file) {
    const bitmap = await createImageBitmap(file);

    const maxSide = 2200;

    const scale = Math.min(
      2,
      maxSide / Math.max(bitmap.width, bitmap.height)
    );

    const width = Math.max(
      1,
      Math.round(bitmap.width * scale)
    );

    const height = Math.max(
      1,
      Math.round(bitmap.height * scale)
    );

    const canvas = document.createElement("canvas");

    canvas.width = width;
    canvas.height = height;

    const ctx = canvas.getContext("2d", {
      willReadFrequently: true
    });

    ctx.drawImage(bitmap, 0, 0, width, height);

    bitmap.close && bitmap.close();

    const frame = ctx.getImageData(
      0,
      0,
      width,
      height
    );

    const pixels = frame.data;

    for (let i = 0; i < pixels.length; i += 4) {
      const gray =
        0.299 * pixels[i] +
        0.587 * pixels[i + 1] +
        0.114 * pixels[i + 2];

      const contrast = Math.max(
        0,
        Math.min(255, (gray - 128) * 1.35 + 128)
      );

      pixels[i] = contrast;
      pixels[i + 1] = contrast;
      pixels[i + 2] = contrast;
    }

    ctx.putImageData(frame, 0, 0);

    return new Promise(resolve => {
      canvas.toBlob(
        blob => resolve(blob || file),
        "image/jpeg",
        0.92
      );
    });
  }

  function cleanOCRLines(text) {
    const ignored =
      /\b(directions?|apply|dosage|dose|use|using|warning|caution|keep out|children|store|inactive ingredients?|questions|comments|distributed|manufactured|made in|www\.|https?:|serving size|nutrition facts|supplement facts)\b/i;

    const seen = new Set();

    return String(text || "")
      .split(/\r?\n/)
      .map(line =>
        line
          .replace(/[|{}\[\]_*~]/g, " ")
          .replace(/\s+/g, " ")
          .trim()
      )
      .filter(line => {
        if (line.length < 3 || line.length > 90) {
          return false;
        }

        if (ignored.test(line)) {
          return false;
        }

        const letters =
          (line.match(/[A-Za-z]/g) || []).length;

        const ratio = letters / Math.max(1, line.length);

        if (ratio < 0.48) return false;

        if (/^\d[\d\s().+-]{5,}$/.test(line)) {
          return false;
        }

        const key = line.toLowerCase();

        if (seen.has(key)) return false;

        seen.add(key);

        return true;
      });
  }

  function scoreNameLine(line) {
    let score = 0;

    const words = line.split(/\s+/);

    if (words.length >= 2 && words.length <= 7) {
      score += 3;
    }

    if (line.length >= 5 && line.length <= 48) {
      score += 2;
    }

    if (/\b(5\s?%|10\s?%|2\s?%|mg|ml|tablets?|capsules?|cream|solution|spray|shampoo|lotion|toothpaste|soap|powder|oil|serum)\b/i.test(line)) {
      score += 4;
    }

    if (/\b(kirkland|signature|cetaphil|nivea|dove|rexona|samsung|detol|colgate|paracetamol|minoxidil)\b/i.test(line)) {
      score += 5;
    }

    if (/\b(inc|llc|ltd|corp|corporation|address|street|drive|road|usa|uk|nigeria)\b/i.test(line)) {
      score -= 5;
    }

    if (/\d{5,}/.test(line)) {
      score -= 3;
    }

    if (/\b(one|twice|daily|times a day|scalp|directions)\b/i.test(line)) {
      score -= 6;
    }

    return score;
  }

  function firstMatch(lines, regex) {
    for (const line of lines) {
      const match = line.match(regex);

      if (match && match[1]) {
        return match[1].trim().slice(0, 90);
      }
    }

    return "";
  }

  function identifyLabel(text) {
    const lines = cleanOCRLines(text);

    const ranked = lines
      .map(line => ({
        line,
        score: scoreNameLine(line)
      }))
      .sort((a, b) => b.score - a.score);

    const productLine =
      ranked.find(item => item.score >= 5)?.line || "";

    const brandLine = lines.find(line =>
      /\b(kirkland|signature|cetaphil|nivea|dove|rexona|samsung|detol|colgate)\b/i.test(line)
    ) || "";

    const strength = firstMatch(
      lines,
      /\b(\d+(?:\.\d+)?\s?%|\d+\s?(?:mg|mcg|g|ml))\b/i
    );

    const batch = firstMatch(
      lines,
      /\b(?:lot|batch)\s*(?:no\.?|number|#|:)?\s*([A-Z0-9-]{4,})\b/i
    );

    const expiry = firstMatch(
      lines,
      /\b(?:exp(?:iry|iration)?|use by)\s*[:#-]?\s*((?:0?[1-9]|1[0-2])[\/.-]\d{2,4}|(?:JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)[A-Z]*\s?\d{2,4})\b/i
    );

    const manufacturer = firstMatch(
      lines,
      /\b(?:manufactured by|made by)\s*[:\-]?\s*(.{3,70})/i
    );

    const distributor = firstMatch(
      lines,
      /\b(?:distributed by|distributed for)\s*[:\-]?\s*(.{3,70})/i
    );

    const importer = firstMatch(
      lines,
      /\b(?:imported by)\s*[:\-]?\s*(.{3,70})/i
    );

    let category = "";

    if (/\b(minoxidil|hair regrowth)\b/i.test(text)) {
      category = "Hair care / treatment";
    } else if (/\b(toothpaste|mouthwash)\b/i.test(text)) {
      category = "Oral care";
    } else if (/\b(shampoo|conditioner|hair oil)\b/i.test(text)) {
      category = "Hair care";
    } else if (/\b(cream|lotion|serum|skin)\b/i.test(text)) {
      category = "Beauty / personal care";
    } else if (/\b(tablet|capsule|medicine|solution)\b/i.test(text)) {
      category = "Health product";
    } else if (/\b(food|ingredients|nutrition facts)\b/i.test(text)) {
      category = "Food";
    }

    return {
      product: productLine,
      brand: brandLine,
      strength,
      category,
      manufacturer,
      distributor,
      importer,
      batch,
      expiry
    };
  }

  function renderRecognizedResult(info, photoCount, rawText) {
    const fields = [
      ["Product name", info.product],
      ["Brand", info.brand],
      ["Strength / size", info.strength],
      ["Product category", info.category],
      ["Manufacturer", info.manufacturer],
      ["Distributor", info.distributor],
      ["Importer", info.importer],
      ["Batch / lot number", info.batch],
      ["Expiry date", info.expiry]
    ];

    const hasAny = fields.some(([, value]) => value);

    scanResult.innerHTML = `
      <h3>Product label analysis</h3>

      <p>
        Analysed ${photoCount} photo${photoCount === 1 ? "" : "s"}.
        Review and correct the fields below.
      </p>

      <div class="tm4-fields">
        ${fields.map(([label, value], index) => `
          <label class="tm4-field">
            <span>${label}</span>

            <input
              type="text"
              data-field="${index}"
              value="${escapeHTML(value)}"
              placeholder="Not identified"
            >
          </label>
        `).join("")}
      </div>

      <div class="verification-warning">
        <strong>Authenticity not confirmed</strong>

        <p>
          These details were extracted from packaging photos.
          OCR can misread text, and copied packaging can display
          genuine-looking details. This is not proof that the item
          is genuine or safe.
        </p>
      </div>

      ${!hasAny ? `
        <p>
          TrueMark could not confidently identify product details.
          Take clearer close-up photos of the front, back and
          printed batch/expiry area.
        </p>
      ` : ""}

      <details class="tm4-raw">
        <summary>Show extracted text for troubleshooting</summary>
        <pre>${escapeHTML(rawText.slice(0, 5000))}</pre>
      </details>

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

    scannerStatus.textContent =
      "Review the extracted details. No authenticity check has been performed.";

    $("saveCorrections").addEventListener("click", () => {
      const values = [
        ...scanResult.querySelectorAll("[data-field]")
      ].map(input => input.value.trim());

      const name =
        values[0] ||
        values[1] ||
        "Label scanned — name not identified";

      saveScan("Label photos", name, "Multi-photo OCR");

      showToast("Your corrected scan details were saved to history.");
    });

    addScanAgainButton(
      () => labelImageInput.click(),
      "Choose more photos"
    );
  }

  async function handleLabelPhoto(event) {
    const files = Array.from(event.target.files || [])
      .filter(file => file.type.startsWith("image/"))
      .slice(0, 4);

    if (!files.length) {
      showToast("Choose one or more product label photos.");
      event.target.value = "";
      return;
    }

    await stopCamera();

    processingScan = true;

    labelScanButton.disabled = true;
    startCameraButton.disabled = true;

    scanResult.hidden = false;

    scanResult.innerHTML = `
      <h3>Analysing ${files.length} product photo(s)...</h3>
      <p>
        Keep this page open. This may take a few minutes on a phone.
      </p>
    `;

    let combinedText = "";

    try {
      if (typeof Tesseract === "undefined") {
        throw new Error("Text-reading library did not load.");
      }

      for (let i = 0; i < files.length; i++) {
        scannerStatus.textContent =
          `Reading photo ${i + 1} of ${files.length}...`;

        const enhanced = await makeEnhancedImage(files[i]);

        const result = await Tesseract.recognize(
          enhanced,
          "eng",
          {
            logger: message => {
              if (message.status === "recognizing text") {
                scannerStatus.textContent =
                  `Photo ${i + 1}/${files.length}: ${Math.round(message.progress * 100)}%`;
              }
            }
          }
        );

        combinedText +=
          `\n\n[PHOTO ${i + 1}]\n${result.data.text || ""}`;
      }

      const info = identifyLabel(combinedText);

      renderRecognizedResult(
        info,
        files.length,
        combinedText.trim()
      );

      showToast("Label analysis finished. Please review the fields.");

    } catch (error) {
      console.error("Label analysis error:", error);

      scanResult.innerHTML = `
        <h3>Could not analyse these photos</h3>

        <p>${escapeHTML(error.message || "The text-reading service failed.")}</p>

        <p>
          Try fewer, clearer photos with good lighting.
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

      scannerStatus.textContent = "Label analysis failed.";

      addScanAgainButton(
        () => labelImageInput.click(),
        "Choose photos again"
      );

    } finally {
      labelScanButton.disabled = false;
      startCameraButton.disabled = false;
      labelImageInput.value = "";
      processingScan = false;
    }
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
      if (!startingCamera && !processingScan) {
        labelImageInput.click();
      }
    });
  }

  if (labelImageInput) {
    labelImageInput.addEventListener("change", handleLabelPhoto);
  }

  if (closeScanner) {
    closeScanner.addEventListener("click", closeScannerModal);
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

      showToast(`${card.dataset.category} selected.`);
    });
  });

  const searchForm = $("searchForm");

  if (searchForm) {
    searchForm.addEventListener("submit", event => {
      event.preventDefault();

      const query = $("productSearch").value.trim();

      if (!query) {
        return showToast("Enter a product name or barcode.");
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
        section.scrollIntoView({ behavior: "smooth" });
      }
    });
  }

  displayHistory();
});
