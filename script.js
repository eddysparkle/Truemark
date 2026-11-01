const scanButton = document.getElementById("scanButton");
const searchInput = document.getElementById("productSearch");
const messageBox = document.getElementById("messageBox");

function showMessage(message) {
    messageBox.textContent = message;
    messageBox.classList.add("show");

    setTimeout(() => {
        messageBox.classList.remove("show");
    }, 3000);
}

// Scanner placeholder
scanButton.addEventListener("click", () => {
    showMessage("Camera scanner integration is our next development stage.");
});

// Category selection
document.querySelectorAll(".category").forEach(category => {
    category.addEventListener("click", () => {

        document.querySelectorAll(".category").forEach(item => {
            item.classList.remove("selected");
        });

        category.classList.add("selected");

        const name = category.dataset.category;

        showMessage(name + " products selected.");
    });
});

// Search interaction
searchInput.addEventListener("input", () => {
    const query = searchInput.value.trim();

    if (query.length > 2) {
        showMessage("Product search will connect to our database soon.");
    }
});

// Navigation
document.querySelectorAll(".nav-item").forEach(item => {
    item.addEventListener("click", () => {

        document.querySelectorAll(".nav-item").forEach(nav => {
            nav.classList.remove("active");
        });

        item.classList.add("active");

        const page = item.dataset.page;

        if (page === "home") {
            window.scrollTo({ top: 0, behavior: "smooth" });
        } else if (page === "scan") {
            scanButton.click();
        } else if (page === "history") {
            document.querySelector(".recent-section").scrollIntoView({
                behavior: "smooth"
            });
        } else if (page === "alerts") {
            document.querySelector(".alert-card").scrollIntoView({
                behavior: "smooth"
            });
        }
    });
});

document.getElementById("viewHistory").addEventListener("click", () => {
    showMessage("Your scan history will appear here.");
});
