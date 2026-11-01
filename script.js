const scanButton = document.getElementById("scanButton");
const navScan = document.getElementById("navScan");

const scannerModal = document.getElementById("scannerModal");
const closeScanner = document.getElementById("closeScanner");

const startCameraButton = document.getElementById("startCamera");
const scanAgainButton = document.getElementById("scanAgain");

const scannerStatus = document.getElementById("scannerStatus");
const scanResult = document.getElementById("scanResult");
const barcodeValue = document.getElementById("barcodeValue");

const historyList = document.getElementById("historyList");
const toast = document.getElementById("toast");

let html5QrCode = null;
let cameraRunning = false;
let startingCamera = false;
let processingScan = false;

const HISTORY_KEY = "truemarkScanHistory";


// TOAST MESSAGE

function showToast(message) {
    toast.textContent = message;
    toast.classList.add("show");

    clearTimeout(showToast.timer);

    showToast.timer = setTimeout(() => {
        toast.classList.remove("show");
    }, 3000);
}


// OPEN SCANNER

function openScanner() {
    scannerModal.classList.add("open");
    scannerModal.setAttribute("aria-hidden", "false");

    scanResult.hidden = true;
    startCameraButton.hidden = false;

    scannerStatus.textContent =
        "Tap Start Camera to begin scanning.";
}


// START CAMERA

async function startCamera() {

    if (cameraRunning || startingCamera) return;

    if (typeof Html5Qrcode === "undefined") {
        scannerStatus.textContent =
            "Scanner library could not load. Check your internet connection.";
        return;
    }

    startingCamera = true;

    startCameraButton.disabled = true;
    startCameraButton.textContent = "Starting camera...";

    scannerStatus.textContent = "Requesting camera permission...";

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
            onScanSuccess,
            () => {}
        );

        cameraRunning = true;

        scannerStatus.textContent =
            "Camera active. Position a barcode inside the frame.";

        startCameraButton.hidden = true;

    } catch (error) {

        console.error("Camera error:", error);

        scannerStatus.textContent =
            "Unable to access your camera. Check browser permissions.";

        startCameraButton.hidden = false;

    } finally {

        startingCamera = false;

        startCameraButton.disabled = false;

        if (!cameraRunning) {
            startCameraButton.textContent = "Try Camera Again";
        }
    }
}


// PRODUCT DATABASE LOOKUP

async function lookupProduct(barcode) {

    const fields = [
        "code",
        "product_name",
        "brands",
        "categories",
        "quantity",
        "image_url",
        "countries",
        "product_type",
        "manufacturing_places"
    ].join(",");

    const url =
        `https://world.openfoodfacts.org/api/v3/product/${encodeURIComponent(barcode)}.json?product_type=all&fields=${fields}`;

    try {

        scannerStatus.textContent =
            "Barcode detected. Looking up product information...";

        const response = await fetch(url);

        if (!response.ok) {
            throw new Error("Database request failed.");
        }

        const data = await response.json();

        if (data.status !== 1 || !data.product) {

            showProductNotFound(barcode);

            return;
        }

        displayProduct(data.product, barcode);

    } catch (error) {

        console.error("Product lookup error:", error);

        showProductUnavailable(barcode);
    }
}


// DISPLAY PRODUCT INFORMATION

function displayProduct(product, barcode) {

    const name = product.product_name || "Name unavailable";

    const brand = product.brands || "Brand unavailable";

    const category = product.categories || "Category unavailable";

    const quantity = product.quantity || "Not provided";

    const country = product.countries || "Not provided";

    const manufacturer =
        product.manufacturing_places || "Not provided";

    const image = product.image_url || "";

    scanResult.innerHTML = `
        <span class="result-check">✓</span>

        <h3>Product information found</h3>

        ${image ? `
            <img
                src="${escapeHTML(image)}"
                alt="Product image"
                style="width:140px;max-height:150px;object-fit:contain;margin:15px auto;display:block;"
            >
        ` : ""}

        <div class="product-details">

            <p><strong>Product:</strong> ${escapeHTML(name)}</p>

            <p><strong>Brand:</strong> ${escapeHTML(brand)}</p>

            <p><strong>Category:</strong> ${escapeHTML(category)}</p>

            <p><strong>Quantity:</strong> ${escapeHTML(quantity)}</p>

            <p><strong>Country:</strong> ${escapeHTML(country)}</p>

            <p><strong>Manufacturing location:</strong>
                ${escapeHTML(manufacturer)}
            </p>

            <p><strong>Barcode:</strong>
                ${escapeHTML(barcode)}
            </p>

        </div>

        <div class="verification-warning">
            <strong>Authenticity not confirmed</strong>

            <p>
                Product information was found in the database.
                This does not establish whether the physical product
                is genuine.
            </p>
        </div>

        <p class="result-note">
            Product information provided by Open Food Facts.
            Community-contributed information may be incomplete
            or inaccurate.
        </p>

        <button id="scanAgain" class="scan-again-button">
            Scan another product
        </button>
    `;

    scanResult.hidden = false;

    scannerStatus.textContent =
        "Product information retrieved.";

    document.getElementById("scanAgain")
        .addEventListener("click", resetScanner);

}


// PRODUCT NOT FOUND

function showProductNotFound(barcode) {

    scanResult.innerHTML = `

        <h3>Product not found</h3>

        <p>Barcode: <strong>${escapeHTML(barcode)}</strong></p>

        <div class="verification-warning">
            <strong>Insufficient information</strong>

            <p>
                We could not find this barcode in our current
                product database. This does not mean the product
                is counterfeit.
            </p>
        </div>

        <button id="scanAgain" class="scan-again-button">
            Scan another product
        </button>
    `;

    scanResult.hidden = false;

    scannerStatus.textContent =
        "No matching product record was found.";

    document.getElementById("scanAgain")
        .addEventListener("click", resetScanner);
}


// DATABASE CONNECTION FAILED

function showProductUnavailable(barcode) {

    scanResult.innerHTML = `

        <h3>Lookup unavailable</h3>

        <p>Barcode: <strong>${escapeHTML(barcode)}</strong></p>

        <p>
            We could not connect to the product database.
            Please check your internet connection and try again.
        </p>

        <button id="scanAgain" class="scan-again-button">
            Try another scan
        </button>
    `;

    scanResult.hidden = false;

    scannerStatus.textContent =
        "Product database connection unavailable.";

    document.getElementById("scanAgain")
        .addEventListener("click", resetScanner);
}


// SAVE SCAN HISTORY

function saveScan(barcode, productName) {

    let history = JSON.parse(
        localStorage.getItem(HISTORY_KEY) || "[]"
    );

    history.unshift({

        barcode: barcode,

        name: productName || "Product information unavailable",

        date: new Date().toLocaleString()

    });

    history = history.slice(0, 30);

    localStorage.setItem(
        HISTORY_KEY,
        JSON.stringify(history)
    );

    displayHistory();
}


// DISPLAY HISTORY

function displayHistory() {

    const history = JSON.parse(
        localStorage.getItem(HISTORY_KEY) || "[]"
    );

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
                <small>${escapeHTML(item.barcode)}</small>
                <small>${escapeHTML(item.date)}</small>
            </div>

            <span class="history-badge">
                Scanned
            </span>

        </div>

    `).join("");
}


// HTML ESCAPING

function escapeHTML(value) {

    return String(value).replace(/[&<>"']/g, character => {

        const entities = {
            "&": "&amp;",
            "<": "&lt;",
            ">": "&gt;",
            '"': "&quot;",
            "'": "&#39;"
        };

        return entities[character];
    });
}


// HANDLE BARCODE DETECTION

async function onScanSuccess(decodedText) {

    if (!cameraRunning || processingScan) return;

    processingScan = true;

    cameraRunning = false;

    const barcode = decodedText;

    barcodeValue.textContent = barcode;

    scanResult.hidden = true;

    scannerStatus.textContent =
        "Barcode detected. Retrieving product information...";

    try {

        if (html5QrCode && html5QrCode.isScanning) {
            await html5QrCode.stop();
        }

    } catch (error) {

        console.error("Camera stop error:", error);
    }

    await lookupProduct(barcode);

    saveScan(barcode, "Barcode: " + barcode);

    showToast("Barcode scanned successfully!");

}


// RESET SCANNER

async function resetScanner() {

    await stopCamera();

    document.getElementById("reader").innerHTML = "";

    scanResult.hidden = true;

    scannerStatus.textContent =
        "Ready to scan another product.";

    startCameraButton.hidden = false;

    startCameraButton.textContent = "Start Camera";

    processingScan = false;

    await startCamera();
}


// STOP CAMERA

async function stopCamera() {

    if (html5QrCode && html5QrCode.isScanning) {

        try {
            await html5QrCode.stop();
        } catch (error) {
            console.error(error);
        }
    }

    cameraRunning = false;

    html5QrCode = null;
}


// CLOSE SCANNER

async function closeScannerModal() {

    if (startingCamera) {
        showToast("Please wait for the camera to finish starting.");
        return;
    }

    await stopCamera();

    processingScan = false;

    scannerModal.classList.remove("open");

    scannerModal.setAttribute("aria-hidden", "true");

    document.getElementById("reader").innerHTML = "";
}


// EVENT LISTENERS

scanButton.addEventListener("click", openScanner);

navScan.addEventListener("click", openScanner);

startCameraButton.addEventListener("click", startCamera);

closeScanner.addEventListener("click", closeScannerModal);

scannerModal.addEventListener("click", event => {

    if (event.target === scannerModal) {
        closeScannerModal();
    }
});


// CATEGORY SELECTION

document.querySelectorAll(".category-card").forEach(card => {

    card.addEventListener("click", () => {

        document.querySelectorAll(".category-card").forEach(item => {
            item.classList.remove("selected");
        });

        card.classList.add("selected");

        showToast(card.dataset.category + " selected.");
    });
});


// SEARCH

document.getElementById("searchForm")
    .addEventListener("submit", event => {

        event.preventDefault();

        const query = document
            .getElementById("productSearch")
            .value.trim();

        if (!query) {
            showToast("Enter a product name or barcode.");
            return;
        }

        showToast("Product search will be connected in the next stage.");
    });


// NAVIGATION

document.querySelectorAll(".nav-item[data-target]")
    .forEach(button => {

        button.addEventListener("click", () => {

            const target = document.getElementById(
                button.dataset.target
            );

            if (target) {
                target.scrollIntoView({
                    behavior: "smooth",
                    block: "start"
                });
            }

            document.querySelectorAll(".nav-item")
                .forEach(item => item.classList.remove("active"));

            button.classList.add("active");
        });
    });


// VIEW HISTORY

document.getElementById("viewHistory")
    .addEventListener("click", () => {

        document.getElementById("history").scrollIntoView({
            behavior: "smooth"
        });
    });


// INITIALIZE

displayHistory();
