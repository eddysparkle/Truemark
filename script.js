/* ==========================================
   TRUEMARK — SMART PRODUCT SCANNER
   Version 3.1
   Barcode + Enhanced OCR + Product Search
   Improved Diagnostics + Date Recognition
========================================== */

document.addEventListener("DOMContentLoaded", () => {

    // ========================================
    // 1. ELEMENTS
    // ========================================

    const scanButton = document.getElementById("scanButton");
    const navScan = document.getElementById("navScan");
    const scannerModal = document.getElementById("scannerModal");
    const closeScanner = document.getElementById("closeScanner");

    const startCamera = document.getElementById("startCamera");
    const labelScanButton = document.getElementById("labelScanButton");
    const labelImageInput = document.getElementById("labelImageInput");

    const reader = document.getElementById("reader");
    const scannerStatus = document.getElementById("scannerStatus");
    const scanResult = document.getElementById("scanResult");

    const searchForm = document.getElementById("searchForm");
    const productSearch = document.getElementById("productSearch");

    const historyList = document.getElementById("historyList");
    const viewHistory = document.getElementById("viewHistory");

    const toast = document.getElementById("toast");

    // ========================================
    // 2. APPLICATION STATE
    // ========================================

    let html5QrCode = null;
    let cameraRunning = false;
    let processingScan = false;
    let toastTimer = null;

    const HISTORY_KEY = "truemarkScanHistory";

    // ========================================
    // 3. GENERAL HELPERS
    // ========================================

    function escapeHTML(value) {

        return String(value ?? "").replace(/[&<>"']/g, char => ({
            "&": "&amp;",
            "<": "&lt;",
            ">": "&gt;",
            '"': "&quot;",
            "'": "&#039;"
        })[char]);

    }

    function setStatus(message) {

        if (scannerStatus) {
            scannerStatus.textContent = message;
        }

    }

    function showToast(message) {

        if (!toast) return;

        toast.textContent = message;
        toast.classList.add("show");

        clearTimeout(toastTimer);

        toastTimer = setTimeout(() => {
            toast.classList.remove("show");
        }, 3000);

    }

    function getHistory() {

        try {

            const history = JSON.parse(
                localStorage.getItem(HISTORY_KEY) || "[]"
            );

            return Array.isArray(history) ? history : [];

        } catch (error) {

            console.warn("History retrieval error:", error);
            return [];

        }

    }

    function saveHistory(item) {

        const history = getHistory();

        history.unshift({
            ...item,
            date: new Date().toISOString()
        });

        try {

            localStorage.setItem(
                HISTORY_KEY,
                JSON.stringify(history.slice(0, 30))
            );

        } catch (error) {

            console.warn("History storage error:", error);

        }

        renderHistory();

    }

    // ========================================
    // 4. VERIFICATION ENGINE
    // ========================================

    function verifyProductInformation(product) {

        if (
            typeof TrueMarkVerification === "undefined" ||
            typeof TrueMarkVerification.verifyProduct !== "function"
        ) {

            return {
                status: "engine_unavailable",
                title: "Verification service unavailable",
                message: "TrueMark could not load its verification engine.",
                verified: false
            };

        }

        try {

            return TrueMarkVerification.verifyProduct(product);

        } catch (error) {

            console.error("Verification error:", error);

            return {
                status: "verification_error",
                title: "Verification could not be completed",
                message: "An error occurred while checking product information.",
                verified: false
            };

        }

    }

    // ========================================
    // 5. VERIFICATION DISPLAY
    // ========================================

    function getVerificationHTML(result) {

        let warning = "";

        if (result.warning) {

            warning = `
                <p class="verification-warning">
                    ${escapeHTML(result.warning)}
                </p>
            `;

        }

        let checks = "";

        if (result.checks) {

            checks = `
                <div class="verification-checks">

                    <h4>Information comparison</h4>

                    ${Object.entries(result.checks).map(([key, value]) => `

                        <p>
                            ${escapeHTML(key)}:
                            ${value ? "Match" : "Mismatch"}
                        </p>

                    `).join("")}

                </div>
            `;

        }

        return `
            <div class="verification-result">

                <h3>${escapeHTML(result.title)}</h3>

                <p>${escapeHTML(result.message)}</p>

                ${warning}
                ${checks}

            </div>
        `;

    }

    // ========================================
    // 6. PRODUCT RESULT
    // ========================================

    function displayProduct(product, source = "barcode") {

        const verification = verifyProductInformation(product);

        const name = escapeHTML(
            product.name || "Unknown product"
        );

        const brand = escapeHTML(
            product.brand || "Not identified"
        );

        const manufacturer = escapeHTML(
            product.manufacturer || "Not available"
        );

        const image = product.image
            ? `
                <img
                    src="${escapeHTML(product.image)}"
                    alt="${name}"
                    class="product-image"
                    onerror="this.style.display='none'"
                >
            `
            : "";

        if (!scanResult) return;

        scanResult.hidden = false;

        scanResult.innerHTML = `
            <div class="product-details">

                ${image}

                <h3>${name}</h3>

                <p><strong>Brand:</strong> ${brand}</p>

                <p>
                    <strong>Manufacturer:</strong>
                    ${manufacturer}
                </p>

                <p>
                    <strong>Barcode:</strong>
                    ${escapeHTML(product.barcode || "Not available")}
                </p>

                ${getVerificationHTML(verification)}

                <p class="verification-warning">
                    Product identification does not automatically
                    authenticate the physical item.
                </p>

                <button
                    type="button"
                    class="scan-again-button"
                    id="scanAgainButton"
                >
                    Scan another product
                </button>

            </div>
        `;

        saveHistory({

            name: product.name || "Unknown product",
            brand: product.brand || "",
            barcode: product.barcode || "",
            source,
            status: verification.status

        });

        document.getElementById("scanAgainButton")
            ?.addEventListener("click", resetScanner);

    }

    function displayNotFound(barcode) {

        if (!scanResult) return;

        scanResult.hidden = false;

        scanResult.innerHTML = `
            <div class="verification-result">

                <h3>Product information not found</h3>

                <p>
                    TrueMark could not find a matching product record
                    for this barcode.
                </p>

                <p class="verification-warning">
                    This does not mean the product is counterfeit.
                </p>

                <p>Barcode: ${escapeHTML(barcode)}</p>

                <button
                    type="button"
                    class="scan-again-button"
                    id="scanAgainButton"
                >
                    Scan another product
                </button>

            </div>
        `;

        saveHistory({

            name: "Unknown product",
            barcode,
            source: "barcode",
            status: "not_found"

        });

        document.getElementById("scanAgainButton")
            ?.addEventListener("click", resetScanner);

    }

    // ========================================
    // 7. BARCODE DATABASE LOOKUP
    // ========================================

    async function lookupBarcode(barcode) {

        setStatus("Checking product information...");

        if (!barcode) {

            setStatus("No barcode was detected.");
            return;

        }

        try {

            const url =
                `https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(barcode)}.json?fields=code,product_name,brands,categories,quantity,image_url,manufacturing_places`;

            const response = await fetch(url, {
                method: "GET",
                headers: {
                    "Accept": "application/json"
                }
            });

            if (!response.ok) {

                throw new Error(
                    `Database returned HTTP ${response.status} ${response.statusText}.`
                );

            }

            let data;

            try {

                data = await response.json();

            } catch {

                throw new Error(
                    "The product database returned an invalid response."
                );

            }

            if (data.status !== 1 || !data.product) {

                displayNotFound(barcode);

                setStatus(
                    "Product information search completed."
                );

                return;

            }

            const item = data.product;

            displayProduct({

                name: item.product_name || "",
                brand: item.brands || "",

                // Manufacturing places are not manufacturers.
                manufacturer: "",

                barcode: item.code || barcode,
                image: item.image_url || "",
                categories: item.categories || "",
                quantity: item.quantity || ""

            });

            setStatus(
                "Product information retrieved. Authenticity not confirmed."
            );

        } catch (error) {

            console.error("Barcode lookup error:", error);

            if (scanResult) {

                scanResult.hidden = false;

                scanResult.innerHTML = `
                    <div class="verification-result">

                        <h3>Database connection unavailable</h3>

                        <p>
                            TrueMark could not retrieve product information.
                        </p>

                        <p class="verification-warning">
                            No authenticity conclusion has been made.
                        </p>

                        <p class="diagnostic-message">
                            ${escapeHTML(error.message || "Unknown connection error.")}
                        </p>

                        <button
                            type="button"
                            class="scan-again-button"
                            id="scanAgainButton"
                        >
                            Try again
                        </button>

                    </div>
                `;

                document.getElementById("scanAgainButton")
                    ?.addEventListener("click", resetScanner);

            }

            setStatus(
                "Product lookup failed. Check your internet connection and try again."
            );

        }

    }

    // ========================================
    // 8. CAMERA MANAGEMENT
    // ========================================

    async function stopCamera() {

        if (!html5QrCode || !cameraRunning) {
            return;
        }

        try {

            await html5QrCode.stop();

        } catch (error) {

            console.warn("Camera stop:", error);

        }

        cameraRunning = false;

    }

    // ========================================
    // 9. BARCODE SCANNER
    // ========================================

    async function startBarcodeScanner() {

        if (!reader) {

            setStatus("Scanner display could not be found.");
            return;

        }

        if (typeof Html5Qrcode === "undefined") {

            setStatus(
                "Barcode scanner library could not load. Refresh the page and try again."
            );

            return;

        }

        await stopCamera();

        scanResult.hidden = true;
        reader.innerHTML = "";

        processingScan = false;

        setStatus("Starting camera...");

        try {

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

                async decodedText => {

                    if (processingScan) return;

                    processingScan = true;

                    setStatus(
                        "Barcode detected. Checking product..."
                    );

                    await stopCamera();

                    await lookupBarcode(decodedText);

                },

                () => {}

            );

            cameraRunning = true;

            setStatus(
                "Position the barcode inside the scanning area."
            );

        } catch (error) {

            console.error("Camera error:", error);

            cameraRunning = false;

            setStatus(
                "Unable to access camera. Check browser permissions and ensure the site uses HTTPS."
            );

        }

    }

    // ========================================
    // 10. SMART OCR — TEXT NORMALISATION
    // ========================================

    function normalizeOCRText(text) {

        return String(text || "")

            .replace(/\r/g, "\n")

            .replace(/[ \t]+/g, " ")

            .replace(/\n{3,}/g, "\n\n")

            .trim();

    }

    // ========================================
    // 11. IMAGE ENHANCEMENT
    // ========================================

    async function prepareOCRImage(file, mode = "enhanced") {

        const image = await createImageBitmap(file);

        try {

            const longestSide = Math.max(
                image.width,
                image.height
            );

            const scale = Math.max(
                1,
                Math.min(3, 2400 / longestSide)
            );

            const canvas = document.createElement("canvas");

            canvas.width = Math.round(image.width * scale);
            canvas.height = Math.round(image.height * scale);

            const context = canvas.getContext("2d", {
                willReadFrequently: true
            });

            if (!context) {

                throw new Error(
                    "Image processing is unavailable in this browser."
                );

            }

            context.drawImage(
                image,
                0,
                0,
                canvas.width,
                canvas.height
            );

            const imageData = context.getImageData(
                0,
                0,
                canvas.width,
                canvas.height
            );

            const pixels = imageData.data;

            for (let i = 0; i < pixels.length; i += 4) {

                let gray =
                    0.299 * pixels[i] +
                    0.587 * pixels[i + 1] +
                    0.114 * pixels[i + 2];

                if (mode === "high-contrast") {

                    gray = (gray - 128) * 1.7 + 128;

                } else {

                    gray = (gray - 128) * 1.35 + 128;

                }

                gray = Math.max(0, Math.min(255, gray));

                pixels[i] = gray;
                pixels[i + 1] = gray;
                pixels[i + 2] = gray;

            }

            context.putImageData(imageData, 0, 0);

            return canvas;

        } finally {

            image.close();

        }

    }

    // ========================================
    // 12. MULTIPLE OCR PASSES
    // ========================================

    async function runSmartOCR(file) {

        const results = [];

        const modes = [
            "enhanced",
            "high-contrast"
        ];

        for (const mode of modes) {

            setStatus(
                mode === "enhanced"
                    ? "Enhancing product photograph..."
                    : "Running additional text recognition..."
            );

            const canvas = await prepareOCRImage(file, mode);

            const result = await Tesseract.recognize(
                canvas,
                "eng",
                {

                    logger: message => {

                        if (message.status === "recognizing text") {

                            const progress = Math.round(
                                message.progress * 100
                            );

                            setStatus(
                                `Analysing product label: ${progress}%`
                            );

                        }

                    }

                }
            );

            results.push({

                text: normalizeOCRText(result.data.text),

                confidence: Number(
                    result.data.confidence || 0
                ),

                mode

            });

        }

        results.sort((a, b) => {

            const scoreA =
                a.confidence + (a.text.length > 20 ? 5 : 0);

            const scoreB =
                b.confidence + (b.text.length > 20 ? 5 : 0);

            return scoreB - scoreA;

        });

        return results[0];

    }

    // ========================================
    // 13. IMPROVED DATE RECOGNITION
    // ========================================

    function isValidDateMatch(value) {

        const cleaned = String(value || "")
            .trim()
            .replace(/,/g, "");

        // Reject phone-number-like values.
        if (/^\d{1,2}-\d{3,}-\d+$/.test(cleaned)) {
            return false;
        }

        // Numeric dates: DD/MM/YYYY, MM/YYYY, YYYY-MM-DD.
        let match = cleaned.match(
            /^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})$/
        );

        if (match) {

            const first = Number(match[1]);
            const second = Number(match[2]);
            const year = Number(match[3]);

            return (
                first >= 1 && first <= 31 &&
                second >= 1 && second <= 12 &&
                year >= 2000 && year <= 2099
            );

        }

        match = cleaned.match(
            /^(\d{4})[\/.-](\d{1,2})(?:[\/.-](\d{1,2}))?$/
        );

        if (match) {

            const year = Number(match[1]);
            const month = Number(match[2]);
            const day = match[3] ? Number(match[3]) : 1;

            return (
                year >= 2000 && year <= 2099 &&
                month >= 1 && month <= 12 &&
                day >= 1 && day <= 31
            );

        }

        // Month/year formats such as 11/2027.
        match = cleaned.match(
            /^(\d{1,2})[\/.-](\d{4})$/
        );

        if (match) {

            const month = Number(match[1]);
            const year = Number(match[2]);

            return (
                month >= 1 &&
                month <= 12 &&
                year >= 2000 &&
                year <= 2099
            );

        }

        // Month name formats such as NOV 2027.
        const monthNames =
            "JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC";

        const monthYearPattern = new RegExp(
            `^(?:${monthNames})[A-Z]*\\s+\\d{4}$`,
            "i"
        );

        if (monthYearPattern.test(cleaned)) {
            return true;
        }

        // Formats such as NOV 11 2027 or 11 NOV 2027.
        const monthDayYearPattern = new RegExp(
            `^(?:(?:${monthNames})[A-Z]*\\s+\\d{1,2}\\s+\\d{4}|\\d{1,2}\\s+(?:${monthNames})[A-Z]*\\s+\\d{4})$`,
            "i"
        );

        return monthDayYearPattern.test(cleaned);

    }

    function findDates(text) {

        const lines = text.split("\n");

        const results = [];

        const datePattern =
            /\b(?:\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4}|\d{1,2}[\/.-]\d{4}|\d{4}[\/.-]\d{1,2}(?:[\/.-]\d{1,2})?|\d{1,2}\s+[A-Z]{3,9}\s+\d{4}|[A-Z]{3,9}\s+\d{1,2},?\s+\d{4}|[A-Z]{3,9}\s+\d{4})\b/gi;

        const keywords = {

            expiry:
                /\b(EXP|EXPIRY|EXPIRES|USE BY|BEST BEFORE|BBE)\b/i,

            manufacturing:
                /\b(MFG|MFD|MANUFACTURED|PRODUCTION DATE)\b/i

        };

        lines.forEach((line, index) => {

            const matches = [...line.matchAll(datePattern)];

            matches.forEach(match => {

                const value = match[0].trim();

                if (!isValidDateMatch(value)) {
                    return;
                }

                const previousLine = lines[index - 1] || "";
                const nextLine = lines[index + 1] || "";

                const context =
                    `${previousLine} ${line} ${nextLine}`;

                if (keywords.expiry.test(context)) {

                    results.push({

                        type: "expiry",
                        value,
                        confidence: "contextual"

                    });

                } else if (keywords.manufacturing.test(context)) {

                    results.push({

                        type: "manufacturing",
                        value,
                        confidence: "contextual"

                    });

                } else {

                    results.push({

                        type: "possible_date",
                        value,
                        confidence: "unconfirmed"

                    });

                }

            });

        });

        // Remove duplicate detections.
        return results.filter((date, index, array) => {

            return array.findIndex(item =>
                item.type === date.type &&
                item.value === date.value
            ) === index;

        });

    }

    // ========================================
    // 14. BATCH / LOT RECOGNITION
    // ========================================

    function findBatchNumber(text) {

        const lines = text.split("\n");

        const patterns = [

            /\b(?:BATCH|LOT)\s*(?:NO|NUMBER|#)?\s*[:.#-]?\s*([A-Z0-9][A-Z0-9/-]{2,})/i,

            /\b(?:BATCH|LOT)\s*[:#]\s*([A-Z0-9/-]{3,})/i

        ];

        for (const line of lines) {

            for (const pattern of patterns) {

                const match = line.match(pattern);

                if (match) {

                    return {

                        value: match[1],
                        confidence: "contextual"

                    };

                }

            }

        }

        return null;

    }

    // ========================================
    // 15. NAFDAC RECOGNITION
    // ========================================

    function findNafdacNumber(text) {

        const match = text.match(

            /\bNAFDAC\b[\s\S]{0,25}?([A-Z0-9/-]{4,})/i

        );

        return match ? match[1] : null;

    }

    // ========================================
    // 16. PRODUCT NAME RECOGNITION
    // ========================================

    function findPossibleProductName(text) {

        const lines = text

            .split("\n")

            .map(line => line.trim())

            .filter(line => line.length >= 4);

        const ignoredWords =

            /\b(directions|ingredients|warning|caution|distributed|manufactured|storage|keep|apply|dosage|questions|comments|inactive|active|contents|www\.|phone|address|instructions|before use)\b/i;

        const candidates = lines.filter(line => {

            if (ignoredWords.test(line)) return false;

            if (/^[^a-zA-Z]*$/.test(line)) return false;

            if (line.length > 100) return false;

            return true;

        });

        return candidates.slice(0, 2).join(" ") || "";

    }

    // ========================================
    // 17. MANUFACTURER RECOGNITION
    // ========================================

    function findManufacturer(text) {

        const match = text.match(

            /\b(?:manufactured by|distributed by|made by)\s*[:\-]?\s*([^\n]{3,100})/i

        );

        return match ? match[1].trim() : null;

    }

    // ========================================
    // 18. COMBINE EXTRACTED INFORMATION
    // ========================================

    function extractLabelInformation(text) {

        const normalized = normalizeOCRText(text);

        const dates = findDates(normalized);

        const expiry = dates.find(
            date => date.type === "expiry"
        );

        const manufacturing = dates.find(
            date => date.type === "manufacturing"
        );

        const possibleDates = dates.filter(
            date => date.type === "possible_date"
        );

        const batch = findBatchNumber(normalized);

        return {

            extractedText: normalized,

            possibleProductName:
                findPossibleProductName(normalized),

            manufacturer:
                findManufacturer(normalized),

            batchNumber:
                batch ? batch.value : null,

            batchConfidence:
                batch ? batch.confidence : "not detected",

            expiryDate:
                expiry ? expiry.value : null,

            manufacturingDate:
                manufacturing ? manufacturing.value : null,

            possibleOtherDates:
                possibleDates.map(date => date.value),

            nafdacNumber:
                findNafdacNumber(normalized)

        };

    }

    // ========================================
    // 19. SMART LABEL RESULT DISPLAY
    // ========================================

    function displaySmartLabelResult(
        information,
        verification,
        confidence
    ) {

        const displayField = (label, value, note = "") => {

            return `

                <div class="smart-field">

                    <span class="smart-field-label">
                        ${escapeHTML(label)}
                    </span>

                    <strong class="smart-field-value">
                        ${escapeHTML(value || "Not identified")}
                    </strong>

                    ${note ? `
                        <small>${escapeHTML(note)}</small>
                    ` : ""}

                </div>

            `;

        };

        const possibleDates =
            information.possibleOtherDates || [];

        if (!scanResult) return;

        scanResult.hidden = false;

        scanResult.innerHTML = `

            <div class="ocr-result smart-ocr-result">

                <h3>Product label analysis</h3>

                <p class="ocr-confidence">
                    OCR recognition confidence:
                    ${Math.round(confidence)}%
                </p>

                <div class="smart-information-grid">

                    ${displayField(
                        "Possible product name",
                        information.possibleProductName
                    )}

                    ${displayField(
                        "Manufacturer / Distributor",
                        information.manufacturer
                    )}

                    ${displayField(
                        "Batch / Lot number",
                        information.batchNumber,
                        information.batchConfidence
                    )}

                    ${displayField(
                        "Expiry date",
                        information.expiryDate
                    )}

                    ${displayField(
                        "Manufacturing date",
                        information.manufacturingDate
                    )}

                    ${displayField(
                        "NAFDAC number",
                        information.nafdacNumber
                    )}

                </div>

                ${possibleDates.length ? `

                    <div class="possible-dates">

                        <h4>Other dates detected</h4>

                        <p>
                            ${possibleDates
                                .map(escapeHTML)
                                .join(", ")}
                        </p>

                        <small>
                            These dates have not been classified.
                        </small>

                    </div>

                ` : ""}

                ${getVerificationHTML(verification)}

                <h4>Recognised packaging text</h4>

                <pre class="ocr-text">${escapeHTML(
                    information.extractedText
                )}</pre>

                <p class="verification-warning">

                    OCR results may contain errors. Extracted information
                    has not been confirmed against official records.
                    Product identification is not proof of authenticity.

                </p>

                <button
                    type="button"
                    class="scan-again-button"
                    id="scanAgainButton"
                >
                    Scan another label
                </button>

            </div>

        `;

        document.getElementById("scanAgainButton")
            ?.addEventListener("click", resetScanner);

    }

    // ========================================
    // 20. SMART LABEL SCANNING
    // ========================================

    async function scanLabel(file) {

        if (!file) return;

        if (typeof Tesseract === "undefined") {

            setStatus(
                "Text recognition library could not load."
            );

            return;

        }

        if (!file.type.startsWith("image/")) {

            showToast(
                "Please select a valid product photograph."
            );

            return;

        }

        await stopCamera();

        if (scanResult) {

            scanResult.hidden = false;

            scanResult.innerHTML = `

                <div class="ocr-result">

                    <h3>TrueMark is analysing your product</h3>

                    <p>
                        Enhancing the image and recognising packaging information.
                    </p>

                </div>

            `;

        }

        if (labelScanButton) {
            labelScanButton.disabled = true;
        }

        if (startCamera) {
            startCamera.disabled = true;
        }

        try {

            const bestResult = await runSmartOCR(file);

            const extractedText = bestResult.text;

            if (!extractedText || extractedText.length < 3) {

                throw new Error(
                    "TrueMark could not recognise enough text."
                );

            }

            const information =
                extractLabelInformation(extractedText);

            // OCR alone cannot identify a trusted product record.
            const verification = verifyProductInformation({

                name: "",
                brand: "",
                manufacturer: ""

            });

            displaySmartLabelResult(

                information,
                verification,
                bestResult.confidence

            );

            saveHistory({

                name: information.possibleProductName ||
                    "Label photograph",

                source: "label",

                status: verification.status,

                batchNumber: information.batchNumber || "",

                expiryDate: information.expiryDate || ""

            });

            setStatus(
                "Label analysis completed. Authenticity not confirmed."
            );

        } catch (error) {

            console.error("Smart OCR error:", error);

            if (scanResult) {

                scanResult.hidden = false;

                scanResult.innerHTML = `

                    <div class="ocr-result">

                        <h3>Label recognition unsuccessful</h3>

                        <p>${escapeHTML(error.message)}</p>

                        <p>
                            Try taking a clearer photograph with the product
                            label facing the camera.
                        </p>

                        <button
                            type="button"
                            class="scan-again-button"
                            id="scanAgainButton"
                        >
                            Try another photograph
                        </button>

                    </div>

                `;

            }

            setStatus(
                "Could not recognise the product label."
            );

            document.getElementById("scanAgainButton")
                ?.addEventListener("click", resetScanner);

        } finally {

            if (labelScanButton) {
                labelScanButton.disabled = false;
            }

            if (startCamera) {
                startCamera.disabled = false;
            }

            if (labelImageInput) {
                labelImageInput.value = "";
            }

        }

    }

    // ========================================
    // 21. PRODUCT SEARCH
    // ========================================

    async function searchProducts(query) {

        if (!query || !query.trim()) {

            showToast(
                "Enter a product name or barcode."
            );

            return;

        }

        showToast(
            "Searching product database..."
        );

        try {

            const url =

                "https://world.openfoodfacts.org/cgi/search.pl?" +

                new URLSearchParams({

                    search_terms: query.trim(),
                    search_simple: "1",
                    action: "process",
                    json: "1",
                    page_size: "10",
                    fields: "product_name,brands,code,image_url"

                });

            const response = await fetch(url, {
                method: "GET",
                headers: {
                    "Accept": "application/json"
                }
            });

            if (!response.ok) {

                throw new Error(
                    `Search service returned HTTP ${response.status}.`
                );

            }

            const data = await response.json();

            const products = Array.isArray(data.products)
                ? data.products
                : [];

            if (!scanResult) return;

            scanResult.hidden = false;

            if (!products.length) {

                scanResult.innerHTML = `

                    <div class="verification-result">

                        <h3>No product information found</h3>

                        <p>
                            No matching product was found in the
                            available database.
                        </p>

                        <p class="verification-warning">
                            This does not mean the product is counterfeit.
                        </p>

                    </div>

                `;

            } else {

                scanResult.innerHTML = `

                    <div class="product-details">

                        <h3>Search results</h3>

                        ${products.map(product => `

                            <div class="history-item">

                                <strong>
                                    ${escapeHTML(
                                        product.product_name ||
                                        "Unknown product"
                                    )}
                                </strong>

                                <p>
                                    Brand:
                                    ${escapeHTML(product.brands || "Unknown")}
                                </p>

                                <p>
                                    Barcode:
                                    ${escapeHTML(product.code || "Unavailable")}
                                </p>

                            </div>

                        `).join("")}

                        <p class="verification-warning">

                            These are product information results,
                            not authenticity confirmations.

                        </p>

                    </div>

                `;

            }

            openScanner();

            setStatus(
                "Product search completed."
            );

        } catch (error) {

            console.error("Search error:", error);

            showToast(
                error.message || "Product search is temporarily unavailable."
            );

        }

    }

    // ========================================
    // 22. HISTORY
    // ========================================

    function renderHistory() {

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

        historyList.innerHTML = history.slice(0, 5)

            .map(item => {

                const date = new Date(item.date);

                return `

                    <div class="history-item">

                        <div>

                            <strong>
                                ${escapeHTML(item.name)}
                            </strong>

                            <p>

                                ${escapeHTML(

                                    item.source === "label"
                                        ? "Label OCR · Label photo"
                                        : "Barcode scan"

                                )}

                            </p>

                            <small>
                                ${escapeHTML(date.toLocaleString())}
                            </small>

                        </div>

                        <span class="history-status">
                            Scanned
                        </span>

                    </div>

                `;

            }).join("");

    }

    // ========================================
    // 23. SCANNER MODAL
    // ========================================

    function openScanner() {

        if (!scannerModal) return;

        scannerModal.classList.add("open");

        scannerModal.setAttribute(
            "aria-hidden",
            "false"
        );

        if (scanResult) {
            scanResult.hidden = true;
        }

        if (reader) {
            reader.innerHTML = "";
        }

        processingScan = false;

        setStatus(
            "Choose a scanning method to begin."
        );

    }

    async function closeScannerModal() {

        await stopCamera();

        if (!scannerModal) return;

        scannerModal.classList.remove("open");

        scannerModal.setAttribute(
            "aria-hidden",
            "true"
        );

        if (reader) {
            reader.innerHTML = "";
        }

        processingScan = false;

    }

    function resetScanner() {

        stopCamera().then(() => {

            if (reader) {
                reader.innerHTML = "";
            }

            if (scanResult) {
                scanResult.hidden = true;
            }

            processingScan = false;

            setStatus(
                "Choose a scanning method to begin."
            );

        });

    }

    // ========================================
    // 24. EVENT LISTENERS
    // ========================================

    if (scanButton) {

        scanButton.addEventListener(
            "click",
            openScanner
        );

    }

    if (navScan) {

        navScan.addEventListener(
            "click",
            openScanner
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

    if (startCamera) {

        startCamera.addEventListener(
            "click",
            startBarcodeScanner
        );

    }

    if (labelScanButton && labelImageInput) {

        labelScanButton.addEventListener("click", () => {

            labelImageInput.click();

        });

        labelImageInput.addEventListener("change", event => {

            const file = event.target.files[0];

            if (file) {

                scanLabel(file);

            }

        });

    }

    if (searchForm && productSearch) {

        searchForm.addEventListener("submit", event => {

            event.preventDefault();

            searchProducts(productSearch.value);

        });

    }

    if (viewHistory) {

        viewHistory.addEventListener("click", () => {

            document.getElementById("history")
                ?.scrollIntoView({

                    behavior: "smooth"

                });

        });

    }

    document.querySelectorAll(".category-card")
        .forEach(button => {

            button.addEventListener("click", () => {

                const category = button.dataset.category;

                if (productSearch) {

                    productSearch.value = category;

                }

                searchProducts(category);

            });

        });

    document.querySelectorAll(".nav-item[data-target]")
        .forEach(button => {

            button.addEventListener("click", () => {

                const target = document.getElementById(
                    button.dataset.target
                );

                if (target) {

                    target.scrollIntoView({

                        behavior: "smooth"

                    });

                }

                document.querySelectorAll(".nav-item")
                    .forEach(item => {

                        item.classList.remove("active");

                    });

                button.classList.add("active");

            });

        });

    // ========================================
    // 25. INITIALISE
    // ========================================

    renderHistory();

    console.log(
        "TrueMark Smart Scanner v3.1 initialised."
    );

    console.log(

        typeof TrueMarkVerification !== "undefined"

            ? "TrueMark verification engine connected."

            : "Warning: verification engine unavailable."

    );

});
