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

    scannerStatus.textContent =
        "Tap Start Camera to begin scanning.";

    startCameraButton.hidden = false;

}


// START CAMERA

async function startCamera() {

    if (cameraRunning || startingCamera) return;

    if (typeof Html5Qrcode === "undefined") {

        scannerStatus.textContent =
            "Scanner library could not load. Check your internet connection and reload the page.";

        return;

    }

    startingCamera = true;

    startCameraButton.disabled = true;
    startCameraButton.textContent = "Starting camera...";

    scannerStatus.textContent =
        "Requesting camera permission...";

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
            "Unable to access your camera. Allow camera permission in your browser and try again.";

        startCameraButton.hidden = false;

    } finally {

        startingCamera = false;

        startCameraButton.disabled = false;

        if (!cameraRunning) {
            startCameraButton.textContent = "Try Camera Again";
        }

    }

}


// SAVE SCAN HISTORY

function saveScan(barcode) {

    let history = JSON.parse(
        localStorage.getItem(HISTORY_KEY) || "[]"
    );

    const scan = {

        barcode: barcode,

        date: new Date().toLocaleString()

    };

    history.unshift(scan);

    history = history.slice(0, 30);

    localStorage.setItem(
        HISTORY_KEY,
        JSON.stringify(history)
    );

    displayHistory();

}


// DISPLAY SCAN HISTORY

function displayHistory() {

    const history = JSON.parse(
        localStorage.getItem(HISTORY_KEY) || "[]"
    );

    if (history.length === 0) {

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
                <strong>${escapeHTML(item.barcode)}</strong>
                <small>${escapeHTML(item.date)}</small>
            </div>

            <span class="history-badge">
                Barcode scanned
            </span>

        </div>

    `).join("");

}


// BASIC HTML ESCAPING

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


// HANDLE SUCCESSFUL BARCODE SCAN

async function onScanSuccess(decodedText) {

    if (!cameraRunning) return;

    cameraRunning = false;

    const scannedBarcode = decodedText;

    scannerStatus.textContent = "Barcode successfully scanned.";

    barcodeValue.textContent = scannedBarcode;

    scanResult.hidden = false;

    startCameraButton.hidden = true;

    saveScan(scannedBarcode);

    showToast("Barcode scanned successfully!");

    try {

        if (html5QrCode && html5QrCode.isScanning) {
            await html5QrCode.stop();
        }

    } catch (error) {

        console.error("Camera stop error:", error);

    }

}


// CLOSE SCANNER

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


async function closeScannerModal() {

    if (startingCamera) {
        showToast("Please wait for the camera to finish starting.");
        return;
    }

    await stopCamera();

    scannerModal.classList.remove("open");

    scannerModal.setAttribute("aria-hidden", "true");

    document.getElementById("reader").innerHTML = "";

}


// EVENT LISTENERS

scanButton.addEventListener("click", openScanner);

navScan.addEventListener("click", openScanner);

startCameraButton.addEventListener("click", startCamera);

closeScanner.addEventListener("click", closeScannerModal);

scanAgainButton.addEventListener("click", async () => {

    await stopCamera();

    document.getElementById("reader").innerHTML = "";

    scanResult.hidden = true;

    scannerStatus.textContent =
        "Ready to scan another product.";

    startCameraButton.hidden = false;

    startCameraButton.textContent = "Start Camera";

    await startCamera();

});


// CLOSE MODAL BY TAPPING OUTSIDE

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

document.getElementById("searchForm").addEventListener("submit", event => {

    event.preventDefault();

    const query = document.getElementById("productSearch").value.trim();

    if (!query) {

        showToast("Enter a product name or barcode.");

        return;

    }

    showToast("Product database connection is our next stage.");

});


// BOTTOM NAVIGATION

document.querySelectorAll(".nav-item[data-target]").forEach(button => {

    button.addEventListener("click", () => {

        const target = document.getElementById(button.dataset.target);

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


// VIEW HISTORY

document.getElementById("viewHistory").addEventListener("click", () => {

    document.getElementById("history").scrollIntoView({
        behavior: "smooth"
    });

});


// INITIALIZE DASHBOARD

displayHistory();
