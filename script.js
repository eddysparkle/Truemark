/* ==========================================
   TRUEMARK — PRODUCT SCANNER & VERIFICATION
   Version 2.0
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

    function showToast(message) {
        toast.textContent = message;
        toast.classList.add("show");

        clearTimeout(toastTimer);

        toastTimer = setTimeout(() => {
            toast.classList.remove("show");
        }, 3000);
    }

    function normalize(value) {
        return String(value || "")
            .trim()
            .toLowerCase()
            .replace(/\s+/g, " ");
    }

    function getHistory() {
        try {
            return JSON.parse(
                localStorage.getItem(HISTORY_KEY) || "[]"
            );
        } catch {
            return [];
        }
    }

    function saveHistory(item) {
        const history = getHistory();

        history.unshift({
            ...item,
            date: new Date().toISOString()
        });

        localStorage.setItem(
            HISTORY_KEY,
            JSON.stringify(history.slice(0, 30))
        );

        renderHistory();
    }

    // ========================================
    // 4. VERIFICATION ENGINE CONNECTION
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
                message: "An error occurred while checking the available product information.",
                verified: false
            };
        }
    }

    // ========================================
    // 5. DISPLAY VERIFICATION RESULT
    // ========================================

    function getVerificationHTML(result) {

        const title = escapeHTML(result.title);
        const message = escapeHTML(result.message);

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
                <h3>${title}</h3>
                <p>${message}</p>
                ${warning}
                ${checks}
            </div>
        `;
    }

    // ========================================
    // 6. PRODUCT RESULT DISPLAY
    // ========================================

    function displayProduct(product, source = "barcode") {

        const verification = verifyProductInformation(product);

        const name = escapeHTML(product.name || "Unknown product");
        const brand = escapeHTML(product.brand || "Not identified");
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
                    Product identification and matching records do not
                    automatically authenticate the physical item.
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

        const scanAgainButton = document.getElementById(
            "scanAgainButton"
        );

        scanAgainButton.addEventListener("click", resetScanner);
    }

    function displayNotFound(barcode) {

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
                    The product may simply be missing from the database.
                </p>

                <p>
                    Barcode: ${escapeHTML(barcode)}
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
            name: "Unknown product",
            barcode,
            source: "barcode",
            status: "not_found"
        });

        document.getElementById("scanAgainButton")
            .addEventListener("click", resetScanner);
    }

    // ========================================
    // 7. OPEN FOOD FACTS LOOKUP
    // ========================================

    async function lookupBarcode(barcode) {

        scannerStatus.textContent =
            "Checking available product information...";

        try {

            const response = await fetch(
                `https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(barcode)}.json?fields=code,product_name,brands,categories,quantity,image_url,manufacturing_places`
            );

            if (!response.ok) {
                throw new Error("Product database unavailable.");
            }

            const data = await response.json();

            if (
                data.status !== 1 ||
                !data.product
            ) {
                displayNotFound(barcode);
                scannerStatus.textContent =
                    "Product information search completed.";

                return;
            }

            const item = data.product;

            displayProduct({
                name: item.product_name || "",
                brand: item.brands || "",
                manufacturer: item.manufacturing_places || "",
                barcode: item.code || barcode,
                image: item.image_url || "",
                categories: item.categories || "",
                quantity: item.quantity || ""
            });

            scannerStatus.textContent =
                "Product information retrieved.";

        } catch (error) {

            console.error("Barcode lookup error:", error);

            scanResult.hidden = false;

            scanResult.innerHTML = `
                <div class="verification-result">
                    <h3>Database connection unavailable</h3>

                    <p>
                        TrueMark could not retrieve product information.
                    </p>

                    <p class="verification-warning">
                        Please check your internet connection and try again.
                        No authenticity conclusion has been made.
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
                .addEventListener("click", resetScanner);

            scannerStatus.textContent =
                "Product lookup could not be completed.";
        }
    }

    // ========================================
    // 8. BARCODE SCANNER
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

    async function startBarcodeScanner() {

        if (typeof Html5Qrcode === "undefined") {
            scannerStatus.textContent =
                "Barcode scanner library could not load.";

            return;
        }

        await stopCamera();

        scanResult.hidden = true;
        reader.innerHTML = "";

        processingScan = false;

        scannerStatus.textContent =
            "Starting camera...";

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

                    scannerStatus.textContent =
                        "Barcode detected. Checking product...";

                    await stopCamera();

                    await lookupBarcode(decodedText);
                },

                () => {}
            );

            cameraRunning = true;

            scannerStatus.textContent =
                "Position the barcode inside the scanning area.";

        } catch (error) {

            console.error("Camera error:", error);

            scannerStatus.textContent =
                "Unable to access camera. Check browser permissions.";
        }
    }

    // ========================================
    // 9. LABEL OCR
    // ========================================

    function extractLabelInformation(text) {

        const lines = text
            .split(/\r?\n/)
            .map(line => line.trim())
            .filter(line => line.length > 1);

        const batchMatch = text.match(
            /\b(?:LOT|BATCH|BATCH NO|LOT NO)\s*[:#.-]?\s*([A-Z0-9-]{3,})/i
        );

        const expiryMatch = text.match(
            /\b(?:EXP|EXPIRY|EXPIRES|USE BY)\s*[:#.-]?\s*([A-Z0-9/-]{4,})/i
        );

        const manufacturedMatch = text.match(
            /\b(?:MFG|MFD|MANUFACTURED)\s*[:#.-]?\s*([A-Z0-9/-]{4,})/i
        );

        const nafdacMatch = text.match(
            /\b(?:NAFDAC)\s*(?:REG(?:ISTRATION)?\.?\s*(?:NO\.?)?)?\s*[:#.-]?\s*([A-Z0-9/-]{4,})/i
        );

        return {
            extractedText: text,

            possibleProductName: lines.slice(0, 3).join(" "),

            batchNumber: batchMatch ? batchMatch[1] : null,

            expiryDate: expiryMatch ? expiryMatch[1] : null,

            manufacturingDate: manufacturedMatch
                ? manufacturedMatch[1]
                : null,

            nafdacNumber: nafdacMatch
                ? nafdacMatch[1]
                : null
        };
    }

    async function scanLabel(file) {

        if (!file) return;

        if (typeof Tesseract === "undefined") {

            scannerStatus.textContent =
                "Text recognition library could not load.";

            return;
        }

        await stopCamera();

        scanResult.hidden = false;

        scanResult.innerHTML = `
            <div class="ocr-result">
                <h3>Reading product label...</h3>
                <p>Please wait while TrueMark examines the photograph.</p>
            </div>
        `;

        scannerStatus.textContent =
            "Extracting text from product packaging...";

        labelScanButton.disabled = true;
        startCamera.disabled = true;

        try {

            const result = await Tesseract.recognize(
                file,
                "eng",
                {
                    logger: message => {

                        if (message.status === "recognizing text") {

                            const progress = Math.round(
                                message.progress * 100
                            );

                            scannerStatus.textContent =
                                `Reading label: ${progress}%`;
                        }
                    }
                }
            );

            const extractedText = result.data.text.trim();

            if (!extractedText) {

                throw new Error(
                    "No readable text was detected."
                );
            }

            const information =
                extractLabelInformation(extractedText);

            const verification = verifyProductInformation({
                name: "",
                brand: "",
                manufacturer: ""
            });

            const batch = information.batchNumber
                ? escapeHTML(information.batchNumber)
                : "Not identified";

            const expiry = information.expiryDate
                ? escapeHTML(information.expiryDate)
                : "Not identified";

            const manufactured = information.manufacturingDate
                ? escapeHTML(information.manufacturingDate)
                : "Not identified";

            const nafdac = information.nafdacNumber
                ? escapeHTML(information.nafdacNumber)
                : "Not identified";

            scanResult.innerHTML = `
                <div class="ocr-result">

                    <h3>Label text extracted</h3>

                    <div class="product-details">

                        <h4>Extracted product information</h4>

                        <p>
                            <strong>Possible product name:</strong>
                            ${escapeHTML(
                                information.possibleProductName ||
                                "Not identified"
                            )}
                        </p>

                        <p>
                            <strong>Batch / Lot number:</strong>
                            ${batch}
                        </p>

                        <p>
                            <strong>Expiry date:</strong>
                            ${expiry}
                        </p>

                        <p>
                            <strong>Manufacturing date:</strong>
                            ${manufactured}
                        </p>

                        <p>
                            <strong>NAFDAC number:</strong>
                            ${nafdac}
                        </p>

                    </div>

                    ${getVerificationHTML(verification)}

                    <h4>Original extracted text</h4>

                    <pre class="ocr-text">${escapeHTML(extractedText)}</pre>

                    <p class="verification-warning">
                        OCR can misread packaging. Extracted numbers and
                        dates have not been checked against official records.
                        No authenticity or safety confirmation has been made.
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

            saveHistory({
                name: information.possibleProductName ||
                    "Label photograph",
                source: "label",
                status: verification.status,
                batchNumber: information.batchNumber || "",
                expiryDate: information.expiryDate || ""
            });

            scannerStatus.textContent =
                "Label information extracted. No authenticity check performed.";

            document.getElementById("scanAgainButton")
                .addEventListener("click", resetScanner);

        } catch (error) {

            console.error("OCR error:", error);

            scanResult.innerHTML = `
                <div class="ocr-result">

                    <h3>Unable to read label</h3>

                    <p>
                        ${escapeHTML(error.message)}
                    </p>

                    <p>
                        Try taking another photograph with better lighting
                        and keeping the label in focus.
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

            scannerStatus.textContent =
                "Label recognition was unsuccessful.";

            document.getElementById("scanAgainButton")
                .addEventListener("click", resetScanner);

        } finally {

            labelScanButton.disabled = false;
            startCamera.disabled = false;

            labelImageInput.value = "";
        }
    }

    // ========================================
    // 10. PRODUCT SEARCH
    // ========================================

    async function searchProducts(query) {

        if (!query.trim()) {
            showToast("Enter a product name or barcode.");
            return;
        }

        showToast("Searching product database...");

        try {

            const url =
                "https://world.openfoodfacts.org/cgi/search.pl?" +
                new URLSearchParams({
                    search_terms: query,
                    search_simple: "1",
                    action: "process",
                    json: "1",
                    page_size: "10",
                    fields: "product_name,brands,code,image_url"
                });

            const response = await fetch(url);

            if (!response.ok) {
                throw new Error("Search service unavailable.");
            }

            const data = await response.json();

            const products = data.products || [];

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

            scannerStatus.textContent =
                "Product search completed.";

        } catch (error) {

            console.error("Search error:", error);

            showToast("Product search is temporarily unavailable.");
        }
    }

    // ========================================
    // 11. SCAN HISTORY
    // ========================================

    function renderHistory() {

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
                                ${date.toLocaleString()}
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
    // 12. OPEN AND CLOSE SCANNER
    // ========================================

    function openScanner() {

        scannerModal.classList.add("active");

        scannerModal.setAttribute("aria-hidden", "false");

        scanResult.hidden = true;

        reader.innerHTML = "";

        processingScan = false;

        scannerStatus.textContent =
            "Choose a scanning method to begin.";
    }

    async function closeScannerModal() {

        await stopCamera();

        scannerModal.classList.remove("active");

        scannerModal.setAttribute("aria-hidden", "true");

        reader.innerHTML = "";

        processingScan = false;
    }

    function resetScanner() {

        stopCamera().then(() => {

            reader.innerHTML = "";

            scanResult.hidden = true;

            processingScan = false;

            scannerStatus.textContent =
                "Choose a scanning method to begin.";

        });
    }

    // ========================================
    // 13. EVENT LISTENERS
    // ========================================

    scanButton.addEventListener("click", openScanner);

    navScan.addEventListener("click", openScanner);

    closeScanner.addEventListener(
        "click",
        closeScannerModal
    );

    scannerModal.addEventListener("click", event => {

        if (event.target === scannerModal) {
            closeScannerModal();
        }

    });

    startCamera.addEventListener(
        "click",
        startBarcodeScanner
    );

    labelScanButton.addEventListener("click", () => {

        labelImageInput.click();

    });

    labelImageInput.addEventListener("change", event => {

        const file = event.target.files[0];

        if (file) {
            scanLabel(file);
        }

    });

    searchForm.addEventListener("submit", event => {

        event.preventDefault();

        searchProducts(productSearch.value);

    });

    viewHistory.addEventListener("click", () => {

        document.getElementById("history")
            .scrollIntoView({
                behavior: "smooth"
            });

    });

    document.querySelectorAll(".category-card")
        .forEach(button => {

            button.addEventListener("click", () => {

                const category = button.dataset.category;

                productSearch.value = category;

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
                    .forEach(item => item.classList.remove("active"));

                button.classList.add("active");

            });

        });

    // ========================================
    // 14. INITIALISE
    // ========================================

    renderHistory();

    console.log("TrueMark scanner initialised.");

    console.log(
        typeof TrueMarkVerification !== "undefined"
            ? "TrueMark verification engine connected."
            : "Warning: verification engine unavailable."
    );

});
