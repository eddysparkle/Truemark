/* =========================================
   TRUEMARK VERIFICATION ENGINE
   Version 1.0
========================================= */

const TrueMarkVerification = (() => {

    // Only records from trusted, authorised sources
    // should eventually be added to this database.

    const trustedRecords = [];

    function normalize(value) {
        return String(value || "")
            .trim()
            .toLowerCase()
            .replace(/\s+/g, " ");
    }

    function verifyProduct(product) {

        if (!product || !product.name) {
            return {
                status: "insufficient_data",
                title: "Insufficient product information",
                message: "TrueMark could not identify enough information to check this product.",
                verified: false
            };
        }

        const productName = normalize(product.name);
        const brand = normalize(product.brand);

        const matches = trustedRecords.filter(record => {

            return (
                normalize(record.name) === productName &&
                normalize(record.brand) === brand
            );

        });

        if (matches.length === 0) {
            return {
                status: "not_verified",
                title: "Authenticity not confirmed",
                message: "No matching authoritative product record is currently available in TrueMark.",
                verified: false,
                warning: "This does not mean the product is counterfeit."
            };
        }

        const record = matches[0];

        const checks = {
            productName: productName === normalize(record.name),
            brand: brand === normalize(record.brand),
            manufacturer:
                normalize(product.manufacturer) ===
                normalize(record.manufacturer)
        };

        const allMatch = Object.values(checks).every(Boolean);

        if (!allMatch) {
            return {
                status: "review_required",
                title: "Further verification required",
                message: "Some product details do not match the available trusted record.",
                verified: false,
                checks
            };
        }

        return {
            status: "product_information_verified",
            title: "Product information verified",
            message: "The supplied product information matches a trusted product record. The physical item's authenticity has not been confirmed.",
            verified: false,
            checks
        };
    }

    return {
        verifyProduct
    };

})();
