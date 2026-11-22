/**
 * TrueMark API — Cloudflare Workers + D1 + Workers AI
 * Version 7.0.0 — TrueMark 2.0 Phase 2.1 — multi-source barcode intelligence
 *
 * Database-first product identification and safety-information service.
 * IMPORTANT: catalogue matches are not proof of physical authenticity.
 * NAFDAC and SON are shown as unconnected unless an authorised API is configured.
 */

const VERSION = '7.2.0';
const DEFAULT_ORIGIN = 'https://eddysparkle.github.io';
const AI_MODEL = '@cf/meta/llama-3.2-11b-vision-instruct';
const MAX_JSON_BYTES = 1_000_000;
const MAX_IMAGE_CHARS = 7_500_000;
const CACHE_SECONDS = 60 * 60 * 24;

const CATEGORIES = [
  'Food & groceries',
  'Drinks & beverages',
  'Health & medicines',
  'Medical devices',
  'Beauty & cosmetics',
  'Personal care',
  'Household products',
  'Electronics',
  'Baby & children',
  'Pet products',
  'Automotive',
  'Agriculture',
  'Apparel & accessories',
  'Other'
];

const CATALOGUES = [
  {
    key: 'open_food_facts',
    name: 'Open Food Facts',
    base: 'https://world.openfoodfacts.org',
    category: 'Food & groceries'
  },
  {
    key: 'open_beauty_facts',
    name: 'Open Beauty Facts',
    base: 'https://world.openbeautyfacts.org',
    category: 'Beauty & cosmetics'
  },
  {
    key: 'open_products_facts',
    name: 'Open Products Facts',
    base: 'https://world.openproductsfacts.org',
    category: 'Other'
  },
  {
    key: 'open_pet_food_facts',
    name: 'Open Pet Food Facts',
    base: 'https://world.openpetfoodfacts.org',
    category: 'Pet products'
  }
];

const OFFICIAL_SOURCES = [
  {
    key: 'nafdac',
    name: 'NAFDAC',
    type: 'official_regulator',
    url: 'https://nafdac.gov.ng/',
    integration: 'manual_or_authorised_api'
  },
  {
    key: 'son',
    name: 'Standards Organisation of Nigeria',
    type: 'official_regulator',
    url: 'https://son.gov.ng/',
    integration: 'manual_or_authorised_api'
  },
  {
    key: 'us_fda',
    name: 'United States FDA openFDA',
    type: 'official_regulator',
    url: 'https://open.fda.gov/apis/',
    integration: 'public_api'
  }
];

/* -------------------------------------------------------------------------- */
/* HTTP, CORS, validation and shared helpers                                  */
/* -------------------------------------------------------------------------- */

function getAllowedOrigins(env) {
  const raw = env.ALLOWED_ORIGINS || DEFAULT_ORIGIN;
  return raw.split(',').map((value) => value.trim()).filter(Boolean);
}

function corsHeaders(origin, env) {
  const allowed = getAllowedOrigins(env);
  const acceptedOrigin = origin && allowed.includes(origin) ? origin : allowed[0];

  return {
    'Access-Control-Allow-Origin': acceptedOrigin || DEFAULT_ORIGIN,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-TrueMark-Admin-Key',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };
}

function jsonResponse(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...headers
    }
  });
}

function textResponse(message, status = 200, headers = {}) {
  return new Response(message, {
    status,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      ...headers
    }
  });
}

function clean(value, maxLength = 240) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, maxLength);
}

function normalize(value) {
  return clean(value, 300)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function isoNow() {
  return new Date().toISOString();
}

function plusHours(hours) {
  return new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
}

function safeInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function errorMessage(error, fallback = 'The request could not be completed.') {
  return clean(error && error.message ? error.message : fallback, 300);
}

async function readJson(request, maximumBytes = MAX_JSON_BYTES) {
  const contentLength = Number(request.headers.get('Content-Length') || 0);
  if (contentLength > maximumBytes) {
    throw new Error('Request body is too large.');
  }

  const raw = await request.text();
  if (raw.length > maximumBytes) {
    throw new Error('Request body is too large.');
  }

  if (!raw.trim()) return {};

  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('Request body must contain valid JSON.');
  }
}

async function fetchJson(url, options = {}, timeoutMs = 9000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort('timeout'), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        ...(options.headers || {})
      }
    });

    const raw = await response.text();
    let data;

    try {
      data = raw ? JSON.parse(raw) : {};
    } catch {
      throw new Error('The connected source returned an unreadable response.');
    }

    if (!response.ok) {
      throw new Error(`External source returned HTTP ${response.status}.`);
    }

    return data;
  } finally {
    clearTimeout(timeout);
  }
}

function requireDatabase(env) {
  if (!env.DB) {
    throw new Error('D1 binding DB is missing. Bind your truemark-db database using variable name DB.');
  }
  return env.DB;
}


/* -------------------------------------------------------------------------- */
/* TrueMark 2.0 — Verification classification (honest, evidence-based)        */
/* AUTHENTICATED is reserved for manufacturer-backed unit authentication.     */
/* -------------------------------------------------------------------------- */

const CLASSIFICATION = {
  authenticated: {
    key: 'authenticated',
    label: 'Authenticated',
    severity: 0,
    meaning: 'Individual-pack authenticity was confirmed by a manufacturer-backed or authoritative authentication system.'
  },
  regulatory_verified: {
    key: 'regulatory_verified',
    label: 'Regulatory verified',
    severity: 1,
    meaning: 'Applicable regulatory registration or authorisation was confirmed. This does not authenticate the physical pack.'
  },
  information_matched: {
    key: 'information_matched',
    label: 'Information matched',
    severity: 2,
    meaning: 'Product information matches a reliable public or indexed record. Individual-pack authenticity is unconfirmed.'
  },
  caution: {
    key: 'caution',
    label: 'Caution',
    severity: 3,
    meaning: 'Information is incomplete or inconsistent. Further checks on the physical pack are required.'
  },
  high_risk: {
    key: 'high_risk',
    label: 'High risk',
    severity: 4,
    meaning: 'Strong evidence of a recall, safety issue, or other serious concern was found for related product records.'
  },
  unverified: {
    key: 'unverified',
    label: 'Unverified',
    severity: 2,
    meaning: 'There is insufficient reliable information to establish the product status. This is not proof of counterfeit.'
  }
};

function mapStatusToClassification(status) {
  const s = String(status || '').toLowerCase();
  if (s === 'authenticated' || s === 'unit_authenticated') return CLASSIFICATION.authenticated;
  if (s === 'regulatory_verified' || s === 'registration_confirmed') return CLASSIFICATION.regulatory_verified;
  if (s === 'catalogue_match' || s === 'information_matched' || s === 'found') return CLASSIFICATION.information_matched;
  if (s === 'high_risk' || s === 'recall' || s === 'recalled') return CLASSIFICATION.high_risk;
  if (s === 'needs_check' || s === 'caution' || s === 'review_required' || s === 'inconsistent') return CLASSIFICATION.caution;
  if (s === 'not_found' || s === 'unverified' || s === 'not_verified') return CLASSIFICATION.unverified;
  return CLASSIFICATION.unverified;
}

function makeResult(status, title, message, sources = [], extra = {}) {
  const classification = mapStatusToClassification(status);
  return {
    success: true,
    status,
    classification: classification.key,
    classification_label: classification.label,
    classification_meaning: classification.meaning,
    title,
    message,
    sources,
    checked_at: isoNow(),
    evidence: extra.evidence || {
      what_was_checked: extra.what_was_checked || [],
      what_matched: extra.what_matched || [],
      what_did_not_match: extra.what_did_not_match || [],
      remains_unverified: extra.remains_unverified || [
        'Physical pack authenticity',
        'Seller legitimacy',
        'Batch-specific serialisation (unless a manufacturer system confirmed it)'
      ]
    },
    disclaimer: 'A catalogue or registration-number match does not prove that the physical item is genuine. Check the seller, packaging, batch details and applicable official guidance.',
    ...extra
  };
}

function sourceInfo(name, url, type, retrievedAt = isoNow()) {
  return { name, url, type, retrieved_at: retrievedAt };
}

function safeJsonParse(value, fallback = {}) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

/* -------------------------------------------------------------------------- */
/* D1 database operations                                                     */
/* -------------------------------------------------------------------------- */

async function getProductById(db, productId) {
  return db.prepare('SELECT * FROM products WHERE id = ? LIMIT 1')
    .bind(productId)
    .first();
}

async function getProductByBarcode(db, barcode) {
  return db.prepare(`
    SELECT p.*, i.identifier_value AS barcode, i.source AS identifier_source
    FROM product_identifiers i
    INNER JOIN products p ON p.id = i.product_id
    WHERE i.identifier_type = 'barcode'
      AND i.identifier_value = ?
    LIMIT 1
  `).bind(barcode).first();
}

async function searchProducts(db, query, limit = 15) {
  const term = normalize(query);
  if (term.length < 2) return [];

  const like = `%${term}%`;
  const result = await db.prepare(`
    SELECT p.*
    FROM products p
    WHERE p.normalized_name LIKE ?
       OR lower(COALESCE(p.brand, '')) LIKE ?
       OR lower(COALESCE(p.manufacturer, '')) LIKE ?
    ORDER BY p.updated_at DESC
    LIMIT ?
  `).bind(like, like, like, limit).all();

  return result.results || [];
}

async function upsertProduct(db, product, identifiers = [], source = null) {
  const productId = clean(product.id || crypto.randomUUID(), 80);
  const name = clean(product.name || product.product_name || 'Unknown product', 240);
  const timestamp = isoNow();

  await db.prepare(`
    INSERT INTO products (
      id, name, normalized_name, brand, manufacturer, category,
      description, image_url, country_of_origin, confidence,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      normalized_name = excluded.normalized_name,
      brand = excluded.brand,
      manufacturer = excluded.manufacturer,
      category = excluded.category,
      description = excluded.description,
      image_url = excluded.image_url,
      country_of_origin = excluded.country_of_origin,
      confidence = excluded.confidence,
      updated_at = excluded.updated_at
  `).bind(
    productId,
    name,
    normalize(name),
    clean(product.brand, 160),
    clean(product.manufacturer, 200),
    clean(product.category, 120),
    clean(product.description, 1800),
    clean(product.image_url, 1000),
    clean(product.country_of_origin, 120),
    clean(product.confidence || 'catalogue'),
    timestamp,
    timestamp
  ).run();

  for (const identifier of identifiers) {
    const value = clean(identifier.value, 140);
    const type = clean(identifier.type, 40);
    if (!value || !type) continue;

    await db.prepare(`
      INSERT INTO product_identifiers (
        id, product_id, identifier_type, identifier_value, source, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(identifier_type, identifier_value) DO UPDATE SET
        product_id = excluded.product_id,
        source = excluded.source
    `).bind(
      crypto.randomUUID(),
      productId,
      type,
      value,
      clean(identifier.source || 'TrueMark', 120),
      timestamp
    ).run();
  }

  if (source) {
    await recordProductSource(db, productId, source);
  }

  return getProductById(db, productId);
}

async function recordProductSource(db, productId, source) {
  await db.prepare(`
    INSERT INTO product_sources (
      id, product_id, source_key, source_name, source_url,
      source_type, retrieved_at, evidence_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(product_id, source_key) DO UPDATE SET
      source_name = excluded.source_name,
      source_url = excluded.source_url,
      source_type = excluded.source_type,
      retrieved_at = excluded.retrieved_at,
      evidence_json = excluded.evidence_json
  `).bind(
    crypto.randomUUID(),
    productId,
    clean(source.key || normalize(source.name).replace(/ /g, '_'), 100),
    clean(source.name, 160),
    clean(source.url, 1000),
    clean(source.type || 'public_catalogue', 60),
    isoNow(),
    JSON.stringify(source.evidence || {})
  ).run();
}

async function saveVerification(db, details) {
  const id = crypto.randomUUID();
  await db.prepare(`
    INSERT INTO verification_history (
      id, product_id, product_name, barcode, category,
      status, source_summary_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    id,
    details.product_id || null,
    clean(details.product_name, 240),
    clean(details.barcode, 100),
    clean(details.category, 120),
    clean(details.status, 60),
        JSON.stringify(details.sources || []),
    isoNow()
  ).run();
  return id;
}

async function getCached(db, key) {
  const row = await db.prepare(`
    SELECT payload_json, expires_at
    FROM api_cache
    WHERE cache_key = ? AND expires_at > ?
    LIMIT 1
  `).bind(key, isoNow()).first();

  if (!row) return null;
  return safeJsonParse(row.payload_json, null);
}

async function putCached(db, key, payload, ttlHours = 24) {
  await db.prepare(`
    INSERT INTO api_cache (cache_key, payload_json, expires_at, created_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(cache_key) DO UPDATE SET
      payload_json = excluded.payload_json,
      expires_at = excluded.expires_at,
      created_at = excluded.created_at
  `).bind(key, JSON.stringify(payload), plusHours(ttlHours), isoNow()).run();
}

async function updateSourceStatus(db, sourceKey, status, error = '') {
  await db.prepare(`
    UPDATE source_registry
    SET last_status = ?, last_checked_at = ?, last_error = ?
    WHERE source_key = ?
  `).bind(status, isoNow(), clean(error, 300), sourceKey).run();
}

/* -------------------------------------------------------------------------- */
/* Public catalogue connectors                                                */
/* -------------------------------------------------------------------------- */


/* -------------------------------------------------------------------------- */
/* Barcode format validation + multi-source intelligence                      */
/* -------------------------------------------------------------------------- */

function gtinCheckDigitValid(digits) {
  const s = String(digits).replace(/\D/g, '');
  if (!/^\d{8}$|^\d{12}$|^\d{13}$|^\d{14}$/.test(s)) return false;
  let sum = 0;
  const body = s.slice(0, -1);
  const check = parseInt(s.slice(-1), 10);
  // From rightmost of body
  const rev = body.split('').reverse();
  for (let i = 0; i < rev.length; i += 1) {
    const n = parseInt(rev[i], 10);
    sum += (i % 2 === 0) ? n * 3 : n;
  }
  const calc = (10 - (sum % 10)) % 10;
  return calc === check;
}

function expandUpceToUpca(upce) {
  const d = String(upce).replace(/\D/g, '');
  if (d.length === 8) {
    // include number system + check
    const ns = d[0];
    const mid = d.slice(1, 7);
    const check = d[7];
    const last = mid[5];
    let body = '';
    if (last >= '0' && last <= '2') {
      body = mid.slice(0, 2) + last + '0000' + mid.slice(2, 5);
    } else if (last === '3') {
      body = mid.slice(0, 3) + '00000' + mid.slice(3, 5);
    } else if (last === '4') {
      body = mid.slice(0, 4) + '00000' + mid[4];
    } else {
      body = mid.slice(0, 5) + '0000' + last;
    }
    return ns + body + check;
  }
  if (d.length === 7) {
    return expandUpceToUpca('0' + d);
  }
  return null;
}

function analyzeBarcode(raw) {
  const original = clean(raw, 80);
  const digits = original.replace(/\D/g, '');
  const result = {
    original,
    digits,
    format: 'unknown',
    valid_structure: false,
    check_digit_ok: null,
    normalized_gtin13: '',
    candidates: []
  };

  if (!digits) {
    result.format = 'non_numeric';
    result.candidates = [original].filter(Boolean);
    return result;
  }

  if (digits.length === 8 && gtinCheckDigitValid(digits)) {
    result.format = 'EAN-8';
    result.valid_structure = true;
    result.check_digit_ok = true;
    result.normalized_gtin13 = digits.padStart(13, '0');
  } else if (digits.length === 12 && gtinCheckDigitValid(digits)) {
    result.format = 'UPC-A';
    result.valid_structure = true;
    result.check_digit_ok = true;
    result.normalized_gtin13 = '0' + digits;
  } else if (digits.length === 13 && gtinCheckDigitValid(digits)) {
    result.format = 'EAN-13';
    result.valid_structure = true;
    result.check_digit_ok = true;
    result.normalized_gtin13 = digits;
  } else if (digits.length === 14 && gtinCheckDigitValid(digits)) {
    result.format = 'GTIN-14';
    result.valid_structure = true;
    result.check_digit_ok = true;
    result.normalized_gtin13 = digits.slice(-13);
  } else if (digits.length === 8 || digits.length === 7) {
    const upca = expandUpceToUpca(digits.length === 7 ? '0' + digits : digits);
    if (upca && gtinCheckDigitValid(upca)) {
      result.format = 'UPC-E';
      result.valid_structure = true;
      result.check_digit_ok = true;
      result.normalized_gtin13 = '0' + upca;
    } else {
      result.format = digits.length === 8 ? 'EAN-8_or_UPC-E' : 'short_code';
      result.valid_structure = false;
      result.check_digit_ok = gtinCheckDigitValid(digits);
    }
  } else if (/^https?:\/\//i.test(original) || original.includes('http')) {
    result.format = 'QR_or_URL';
    result.valid_structure = true;
  } else {
    result.format = 'other';
    result.check_digit_ok = digits.length >= 8 ? gtinCheckDigitValid(digits) : null;
  }

  const set = new Set();
  [original, digits, result.normalized_gtin13].forEach((v) => {
    if (v) set.add(v);
  });
  if (result.normalized_gtin13 && result.normalized_gtin13.startsWith('0') && result.normalized_gtin13.length === 13) {
    set.add(result.normalized_gtin13.slice(1)); // UPC-A form
  }
  result.candidates = [...set];
  return result;
}

async function lookupUpcItemDb(barcode, env) {
  // Free trial tier: ~100 requests/day/IP, no key required.
  // Paid key via env.UPCITEMDB_KEY uses /prod/v1
  const key = env && env.UPCITEMDB_KEY ? clean(env.UPCITEMDB_KEY, 120) : '';
  const base = key
    ? 'https://api.upcitemdb.com/prod/v1/lookup'
    : 'https://api.upcitemdb.com/prod/trial/lookup';
  const headers = {
    Accept: 'application/json',
    'Accept-Encoding': 'gzip'
  };
  if (key) {
    headers.user_key = key;
    headers.key_type = '3scale';
  }
  try {
    const data = await fetchJson(
      `${base}?upc=${encodeURIComponent(barcode)}`,
      { headers },
      8000
    );
    const item = (data.items || [])[0];
    if (!item) return null;
    return {
      source: {
        key: 'upcitemdb',
        name: 'UPCitemdb',
        category: 'General products'
      },
      product: {
        name: item.title || '',
        brand: item.brand || '',
        manufacturer: item.brand || '',
        category: (item.category || item.lowest_recorded_price && 'General') || 'Other',
        description: item.description || '',
        image_url: (item.images && item.images[0]) || '',
        country_of_origin: '',
        barcode,
        confidence: 'public_catalogue'
      },
      url: `https://www.upcitemdb.com/upc/${encodeURIComponent(barcode)}`
    };
  } catch {
    return null;
  }
}

async function probeGs1DigitalLink(gtin13) {
  // GS1 Digital Link resolver: free unauthenticated resolve attempt.
  // Many GTINs have no registered links — that is not an authenticity verdict.
  const gtin = String(gtin13 || '').replace(/\D/g, '');
  if (gtin.length !== 13) return null;
  const url = `https://id.gs1.org/01/${gtin}`;
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/ld+json, application/json, text/html',
        'User-Agent': 'TrueMark/7.2 (product-identification; +https://eddysparkle.github.io/Truemark/)'
      },
      redirect: 'follow'
    });
    const finalUrl = response.url || url;
    if (!response.ok) {
      return {
        resolved: false,
        resolver: 'id.gs1.org',
        requested: url,
        status: response.status,
        note: 'No GS1 Digital Link target returned for this GTIN.'
      };
    }
    // If still on gs1.org with error page, treat as unresolved product data
    const contentType = response.headers.get('content-type') || '';
    let linkset = null;
    if (contentType.includes('json')) {
      try {
        linkset = await response.json();
      } catch {
        linkset = null;
      }
    }
    return {
      resolved: finalUrl !== url || !!linkset,
      resolver: 'id.gs1.org',
      requested: url,
      final_url: finalUrl,
      has_linkset: !!linkset,
      note: 'GS1 Digital Link resolution indicates registered web links for this GTIN when present. It is not a product authenticity certificate.'
    };
  } catch {
    return {
      resolved: false,
      resolver: 'id.gs1.org',
      requested: url,
      note: 'GS1 resolver unreachable.'
    };
  }
}

async function lookupOpenFoodFactsUniversal(barcode) {
  // product_type=all redirects across food/beauty/pet/product databases
  try {
    const url = `https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(barcode)}.json?product_type=all&fields=code,product_name,product_name_en,brands,categories,quantity,image_url,manufacturing_places,countries,ingredients_text,generic_name,product_type`;
    const data = await fetchJson(url, {}, 8000);
    if (data.status !== 1 || !data.product) return null;
    const raw = data.product;
    const type = raw.product_type || 'food';
    const sourceKey =
      type === 'beauty' ? 'open_beauty_facts' :
      type === 'petfood' ? 'open_pet_food_facts' :
      type === 'product' ? 'open_products_facts' : 'open_food_facts';
    const sourceName =
      type === 'beauty' ? 'Open Beauty Facts' :
      type === 'petfood' ? 'Open Pet Food Facts' :
      type === 'product' ? 'Open Products Facts' : 'Open Food Facts';
    return {
      source: { key: sourceKey, name: sourceName, category: type },
      product: catalogueProduct(
        { key: sourceKey, name: sourceName, category: type },
        raw,
        barcode
      ),
      url: `https://world.openfoodfacts.org/product/${encodeURIComponent(barcode)}`
    };
  } catch {
    return null;
  }
}


function catalogueProduct(source, raw, barcode) {
  return {
    name: raw.product_name || raw.product_name_en || raw.product_name_fr || '',
    brand: raw.brands || '',
    manufacturer: raw.manufacturing_places || '',
    category: raw.categories || source.category,
    description: raw.ingredients_text || raw.generic_name || '',
    image_url: raw.image_url || '',
    country_of_origin: raw.manufacturing_places || raw.countries || '',
    barcode,
    confidence: 'public_catalogue'
  };
}

async function lookupCatalogue(source, barcode) {
  const fields = [
    'code', 'product_name', 'product_name_en', 'product_name_fr',
    'brands', 'categories', 'quantity', 'image_url',
    'manufacturing_places', 'countries', 'ingredients_text', 'generic_name'
  ].join(',');

  const url = `${source.base}/api/v2/product/${encodeURIComponent(barcode)}.json?fields=${fields}`;
  const data = await fetchJson(url, {}, 7500);

  if (data.status !== 1 || !data.product) return null;

  return {
    source,
    product: catalogueProduct(source, data.product, barcode),
    url: `${source.base}/product/${encodeURIComponent(barcode)}`
  };
}

async function lookupAllCatalogues(barcode) {
  const attempts = await Promise.allSettled(
    CATALOGUES.map((source) => lookupCatalogue(source, barcode))
  );

  return attempts
    .filter((item) => item.status === 'fulfilled' && item.value)
    .map((item) => item.value);
}

async function verifyBarcode(barcodeValue, env) {
  const analysis = analyzeBarcode(barcodeValue);
  const barcode = analysis.digits || analysis.original;

  if (!barcode || barcode.length < 6) {
    return makeResult(
      'needs_check',
      'Barcode needs checking',
      'Enter or scan a valid barcode (EAN-13, UPC-A, UPC-E, EAN-8, or GTIN).',
      [],
      {
        barcode_analysis: analysis,
        next_steps: [
          'Rescan the barcode in good light',
          'Or photograph the product label for AI extraction',
          'Or search by product name'
        ]
      }
    );
  }

  const sourcesChecked = [];
  const db = requireDatabase(env);

  // 1) TrueMark D1 index
  sourcesChecked.push({ key: 'truemark_d1', name: 'TrueMark index', status: 'checked' });
  for (const candidate of analysis.candidates) {
    const existing = await getProductByBarcode(db, candidate);
    if (existing) {
      const sources = await getProductSources(db, existing.id);
      const result = makeResult(
        'catalogue_match',
        'Product found in TrueMark',
        'A previously indexed record matches this barcode. This does not authenticate the physical item.',
        sources,
        {
          product: existing,
          record_type: existing.confidence === 'user_submitted' ? 'user_submitted' : 'catalogue',
          barcode_analysis: analysis,
          sources_checked: sourcesChecked,
          evidence: {
            what_was_checked: ['TrueMark product index', 'Barcode format'],
            what_matched: ['Barcode identifier in TrueMark index'],
            remains_unverified: ['Physical pack authenticity', 'Regulatory registration for this unit']
          }
        }
      );
      await saveVerification(db, {
        product_id: existing.id,
        product_name: existing.name,
        barcode: candidate,
        category: existing.category,
        status: result.status,
        sources
      });
      return result;
    }
  }

  // 2) Open Food Facts family (multi + universal)
  let matches = [];
  const cached = await getCached(db, `barcode:v2:${analysis.normalized_gtin13 || barcode}`);
  if (cached && Array.isArray(cached.matches)) {
    matches = cached.matches;
    sourcesChecked.push({ key: 'cache', name: 'Response cache', status: 'hit' });
  } else {
    sourcesChecked.push({ key: 'open_facts', name: 'Open Food/Beauty/Products Facts', status: 'checked' });
    const openMatches = await lookupAllCatalogues(analysis.candidates[0] || barcode);
    matches.push(...openMatches);

    // Try alternate candidate codes
    for (const candidate of analysis.candidates.slice(1, 3)) {
      if (matches.length) break;
      const more = await lookupAllCatalogues(candidate);
      matches.push(...more);
    }

    // Universal product_type=all
    if (!matches.length) {
      for (const candidate of analysis.candidates.slice(0, 2)) {
        const uni = await lookupOpenFoodFactsUniversal(candidate);
        if (uni) {
          matches.push(uni);
          break;
        }
      }
    }

    // 3) UPCitemdb (free trial / optional key)
    sourcesChecked.push({ key: 'upcitemdb', name: 'UPCitemdb', status: 'checked' });
    if (!matches.length) {
      for (const candidate of analysis.candidates.slice(0, 2)) {
        const upc = await lookupUpcItemDb(candidate, env);
        if (upc) {
          matches.push(upc);
          break;
        }
      }
    }

    await putCached(db, `barcode:v2:${analysis.normalized_gtin13 || barcode}`, { matches }, 12);
  }

  // 4) GS1 Digital Link probe (informational)
  let gs1 = null;
  if (analysis.normalized_gtin13) {
    sourcesChecked.push({ key: 'gs1_digital_link', name: 'GS1 Digital Link (id.gs1.org)', status: 'probed' });
    gs1 = await probeGs1DigitalLink(analysis.normalized_gtin13);
  }

  if (!matches.length) {
    const result = makeResult(
      'not_found',
      'Not yet identified in connected catalogues',
      'This barcode was not found in TrueMark index, Open Facts databases, or UPCitemdb. That does not mean the product is fake, unregistered, or unsafe.',
      [],
      {
        product: null,
        barcode_analysis: analysis,
        sources_checked: sourcesChecked,
        gs1_digital_link: gs1,
        next_steps: [
          'Photograph the product label for AI extraction of name, brand, NAFDAC, batch and expiry',
          'Search by product name if you can read it',
          'Enter any NAFDAC number printed on the pack',
          'Submit the product for TrueMark review (user-submitted, not verified)'
        ],
        evidence: {
          what_was_checked: sourcesChecked.map((s) => s.name),
          what_matched: [],
          remains_unverified: [
            'Product identity',
            'Regulatory registration',
            'Physical authenticity'
          ]
        }
      }
    );
    await saveVerification(db, {
      product_name: '',
      barcode,
      category: '',
      status: result.status,
      sources: []
    });
    return result;
  }

  const first = matches[0];
  const product = await upsertProduct(
    db,
    first.product,
    [{ type: 'barcode', value: barcode, source: first.source.name }],
    {
      key: first.source.key,
      name: first.source.name,
      url: first.url,
      type: 'public_catalogue',
      evidence: { barcode }
    }
  );

  for (const match of matches.slice(1)) {
    await recordProductSource(db, product.id, {
      key: match.source.key,
      name: match.source.name,
      url: match.url,
      type: 'public_catalogue',
      evidence: { barcode }
    });
  }

  const sources = matches.map((match) =>
    sourceInfo(match.source.name, match.url, 'public_catalogue')
  );

  // Optional FDA recall hint by product name
  let fda_recalls = [];
  try {
    const term = first.product.name || first.product.brand || '';
    if (term && term.length >= 4) {
      fda_recalls = (await lookupFdaRecalls(env, term.split(/\s+/)[0])).slice(0, 3);
    }
  } catch (_) {}

  const result = makeResult(
    'catalogue_match',
    'Product information matched',
    'A public or indexed catalogue contains a matching barcode. Regulatory approval, safety, and physical authenticity have not been established for this unit.',
    sources,
    {
      product,
      matches: matches.map((m) => ({
        source: m.source.name,
        product: m.product,
        url: m.url
      })),
      barcode_analysis: analysis,
      sources_checked: sourcesChecked,
      gs1_digital_link: gs1,
      fda_recalls,
      record_type: 'catalogue',
      evidence: {
        what_was_checked: sourcesChecked.map((s) => s.name),
        what_matched: sources.map((s) => s.name),
        remains_unverified: [
          'Physical pack authenticity',
          'Batch-specific serialisation',
          'Country-specific regulatory status'
        ]
      }
    }
  );

  await saveVerification(db, {
    product_id: product.id,
    product_name: product.name || first.product.name,
    barcode,
    category: product.category || first.product.category,
    status: result.status,
    sources
  });

  return result;
}

async function getProductSources(db, productId) {
  const result = await db.prepare(`
    SELECT source_name AS name, source_url AS url,
           source_type AS type, retrieved_at
    FROM product_sources
    WHERE product_id = ?
    ORDER BY retrieved_at DESC
  `).bind(productId).all();
  return result.results || [];
}

/* -------------------------------------------------------------------------- */
/* Product search and catalogue persistence                                  */
/* -------------------------------------------------------------------------- */

async function searchProductsRoute(url, env) {
  const query = clean(url.searchParams.get('q'), 120);
  const limit = safeInteger(url.searchParams.get('limit'), 12, 1, 30);

  if (query.length < 2) {
    let fda_recalls = [];
  const qLower = String(query || '').toLowerCase();
  if (qLower.length >= 3 && /(minoxidil|lonart|coartem|drug|tablet|capsule|ointment|syrup|paracetamol|amoxicillin|antibiotic|malaria)/i.test(qLower)) {
    try {
      fda_recalls = await lookupFdaRecalls(env, query);
      fda_recalls = (fda_recalls || []).slice(0, 5);
    } catch (_) {
      fda_recalls = [];
    }
  }

  return jsonResponse({ success: true,
    fda_recalls, products: [], message: 'Enter at least two characters.' });
  }

  const db = requireDatabase(env);
  const products = await searchProducts(db, query, limit);
  return jsonResponse({ success: true, products });
}

async function productDetailsRoute(productId, env) {
  const db = requireDatabase(env);
  const product = await getProductById(db, clean(productId, 100));

  if (!product) {
    return jsonResponse({ success: false, error: 'Product not found.' }, 404);
  }

  const [identifiers, sources, regulatory] = await Promise.all([
    db.prepare('SELECT identifier_type, identifier_value, source FROM product_identifiers WHERE product_id = ?')
      .bind(product.id).all(),
    getProductSources(db, product.id),
    db.prepare(`SELECT agency, jurisdiction, scheme, registration_number,
      status, source_url, source_type, evidence_json, checked_at
      FROM regulatory_records WHERE product_id = ? ORDER BY checked_at DESC LIMIT 20`)
      .bind(product.id).all()
  ]);

  return jsonResponse({
    success: true,
    product,
    identifiers: identifiers.results || [],
    sources,
    regulatory_records: (regulatory.results || []).map((row) => ({
      ...row,
      evidence: safeJsonParse(row.evidence_json, {})
    }))
  });
}

/* -------------------------------------------------------------------------- */
/* AI image recognition                                                       */
/* -------------------------------------------------------------------------- */

function decodeImageDataUrl(value) {
  const image = clean(value, MAX_IMAGE_CHARS);
  const match = image.match(/^data:image\/(jpeg|jpg|png|webp);base64,([A-Za-z0-9+/=]+)$/i);

  if (!match) {
    throw new Error('Provide a JPEG, PNG or WebP image as a base64 data URL.');
  }

  const binary = atob(match[2]);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
}

function extractJsonObject(value) {
  const raw = String(value || '');
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');

  if (start < 0 || end <= start) return null;

  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
}


/* -------------------------------------------------------------------------- */
/* Pack risk rules (expiry / batch) — TrueMark 2.0 Phase 2                    */
/* Transparent heuristics only. Never invent dates.                           */
/* -------------------------------------------------------------------------- */

function parseFlexibleDate(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;

  // ISO / YYYY-MM-DD
  let m = raw.match(/^(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})$/);
  if (m) {
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    return Number.isNaN(d.getTime()) ? null : d;
  }

  // DD/MM/YYYY or DD-MM-YYYY
  m = raw.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/);
  if (m) {
    let y = +m[3];
    if (y < 100) y += 2000;
    const d = new Date(Date.UTC(y, +m[2] - 1, +m[1]));
    return Number.isNaN(d.getTime()) ? null : d;
  }

  // MM/YYYY or YYYY-MM
  m = raw.match(/^(\d{4})[\/\-.](\d{1,2})$/);
  if (m) {
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, 1));
    return Number.isNaN(d.getTime()) ? null : d;
  }
  m = raw.match(/^(\d{1,2})[\/\-.](\d{4})$/);
  if (m) {
    const d = new Date(Date.UTC(+m[2], +m[1] - 1, 1));
    return Number.isNaN(d.getTime()) ? null : d;
  }

  const t = Date.parse(raw);
  if (!Number.isNaN(t)) return new Date(t);
  return null;
}

function assessPackRisk(product = {}) {
  const flags = [];
  let level = 'none'; // none | caution | high_risk
  const expiryRaw = clean(product.expiry_date || product.expiry || '', 40);
  const mfgRaw = clean(product.manufacturing_date || product.mfg_date || '', 40);
  const batchRaw = clean(product.batch_number || product.lot || '', 80);

  const expiry = parseFlexibleDate(expiryRaw);
  const mfg = parseFlexibleDate(mfgRaw);
  const now = new Date();

  if (expiryRaw && !expiry) {
    flags.push({
      code: 'expiry_unparsed',
      severity: 'caution',
      message: 'An expiry-like value was read but could not be parsed. Confirm the date on the pack.'
    });
    level = 'caution';
  }

  if (expiry) {
    const msDay = 24 * 60 * 60 * 1000;
    const daysLeft = Math.floor((expiry.getTime() - now.getTime()) / msDay);
    if (daysLeft < 0) {
      flags.push({
        code: 'expired',
        severity: 'high_risk',
        message: 'The printed expiry date appears to be in the past. Do not use expired medicines or sensitive products.'
      });
      level = 'high_risk';
    } else if (daysLeft <= 90) {
      flags.push({
        code: 'expiring_soon',
        severity: 'caution',
        message: 'The printed expiry date appears to be within about 90 days. Confirm on the pack before buying or using.'
      });
      if (level !== 'high_risk') level = 'caution';
    }
  }

  if (mfg && expiry && mfg.getTime() > expiry.getTime()) {
    flags.push({
      code: 'mfg_after_expiry',
      severity: 'high_risk',
      message: 'Manufacturing date appears after expiry date — likely a misread or suspicious labelling. Confirm both dates on the pack.'
    });
    level = 'high_risk';
  }

  if (batchRaw) {
    // Heuristic only: extremely short or placeholder-like batches
    if (/^(n\/a|na|none|null|0000|xxxx)$/i.test(batchRaw)) {
      flags.push({
        code: 'batch_placeholder',
        severity: 'caution',
        message: 'Batch/lot value looks like a placeholder. Confirm the batch printed on the pack.'
      });
      if (level === 'none') level = 'caution';
    }
  } else if (expiryRaw || mfgRaw) {
    flags.push({
      code: 'batch_missing',
      severity: 'caution',
      message: 'No batch/lot was read from the image. Many regulated packs show a batch — check the physical pack.'
    });
    if (level === 'none') level = 'caution';
  }

  return {
    level,
    flags,
    inputs: {
      expiry_date: expiryRaw,
      manufacturing_date: mfgRaw,
      batch_number: batchRaw
    },
    disclaimer: 'Risk flags are heuristics from extracted text only. OCR can misread dates. Always confirm on the physical pack.'
  };
}

async function recognizeProduct(body, env) {
  if (!env.AI) {
    return jsonResponse({
      success: false,
      error: 'Workers AI binding AI is not configured.'
    }, 503);
  }

  let imageBytes;

  try {
    imageBytes = decodeImageDataUrl(body.image);
  } catch (error) {
    return jsonResponse({
      success: false,
      error: errorMessage(error)
    }, 400);
  }

  const prompt = [
    'You are assisting with consumer product identification for Nigeria and international markets.',
    'Inspect the product packaging image carefully: cartons, blister packs, bottles, sachets and tubes.',
    'Extract only details that are clearly visible. Prefer the largest product title on the front of the pack.',
    '',
    'CRITICAL FIELD RULES:',
    '1. brand = commercial brand only (examples: Lonart, Coartem, Nixoderm, Emzor).',
    '   Never use words like Tablets, Suspension, Forte, Perfumed, Medicated, Original as the brand by themselves.',
    '2. product_name = brand + form/strength when visible (example: Lonart Tablets 20mg/120mg).',
    '3. strength_or_size = dose or net content (20mg/120mg, 80/480, 15g, 5%).',
    '4. nafdac_number = any visible NAFDAC registration text. Copy exactly.',
    '5. batch_number = only Batch/Lot labels, not strength.',
    '6. manufacturing_date and expiry_date = only if clearly labelled; keep original format.',
    '7. Never invent numbers, dates or registration values.',
    '',
    'Return one JSON object with keys:',
    'product_name, brand, category, manufacturer, strength_or_size, barcode, nafdac_number, batch_number, manufacturing_date, expiry_date, country_of_origin, confidence, notes.',
    'Use empty strings when unreadable. confidence: high|medium|low.',
    'Do not judge authenticity. Return valid JSON only, no Markdown.'
  ].join(' ');

  try {
    const response = await env.AI.run(AI_MODEL, {
      prompt: prompt,
      image: Array.from(imageBytes),
      max_tokens: 700
    });

    const raw = response.response || response.description || '';
    const product = extractJsonObject(raw) || {
      product_name: '',
      brand: '',
      category: '',
      manufacturer: '',
      strength_or_size: '',
      barcode: '',
      nafdac_number: '',
      batch_number: '',
      manufacturing_date: '',
      expiry_date: '',
      country_of_origin: '',
      confidence: 'low',
      notes: clean(raw, 1000)
    };

    const pack_risk = assessPackRisk(product);
    let classification = 'unverified';
    if (pack_risk.level === 'high_risk') classification = 'high_risk';
    else if (pack_risk.level === 'caution') classification = 'caution';
    else if (product.product_name || product.brand) classification = 'information_matched';

    return jsonResponse({
      success: true,
      recognized: true,
      product,
      pack_risk,
      classification,
      classification_label: mapStatusToClassification(classification).label,
      classification_meaning: mapStatusToClassification(classification).meaning,
      disclaimer: 'AI may misread labels. Confirm every extracted detail against the physical packaging. Recognition is not authenticity verification.'
    });
  } catch (error) {
    console.error('TrueMark AI recognition failed:', errorMessage(error));
    return jsonResponse({
      success: false,
      error: 'Image recognition is temporarily unavailable.',
      detail: errorMessage(error)
    }, 502);
  }
}

async function lookupFdaRecalls(env, productTerm = '') {
  const term = clean(productTerm, 100);
  const search = term
    ? `&search=product_description:%22${encodeURIComponent(term)}%22`
    : '';
  const url = `https://api.fda.gov/drug/enforcement.json?limit=15${search}${fdaApiKeyQuery(env)}`;

  try {
    const data = await fetchJson(url, {}, 9000);
    return (data.results || []).map((item) => ({
      source: 'US FDA',
      product_name: item.product_description || '',
      reason: item.reason_for_recall || '',
      classification: item.classification || '',
      status: item.status || '',
      recall_date: item.recall_initiation_date || '',
      recalling_firm: item.recalling_firm || '',
      code_info: item.code_info || '',
      source_url: 'https://open.fda.gov/apis/drug/enforcement/'
    }));
  } catch {
    return [];
  }
}

async function lookupFdaNdc(query, env) {
  const q = clean(query, 100);
  if (!q) return [];
  const url = `https://api.fda.gov/drug/ndc.json?search=product_ndc:%22${encodeURIComponent(q)}%22&limit=10${fdaApiKeyQuery(env)}`;
  try {
    const data = await fetchJson(url, {}, 9000);
    return (data.results || []).map((item) => ({
      brand_name: item.brand_name || '',
      generic_name: item.generic_name || '',
      labeler_name: item.labeler_name || '',
      product_ndc: item.product_ndc || '',
      marketing_status: item.marketing_status || '',
      listing_expiration_date: item.listing_expiration_date || ''
    }));
  } catch {
    return [];
  }
}

async function verifyFdaNdc(body, env) {
  const ndc = clean(body.ndc || body.product_ndc || body.number || body.product_name || body.name, 100);
  if (!ndc) {
    return makeResult('needs_check', 'NDC required', 'Enter a US National Drug Code to search.');
  }

  const records = await lookupFdaNdc(ndc, env);
  const found = records.length > 0;

  return makeResult(
    found ? 'record_found' : 'needs_check',
    found ? 'FDA NDC listing found' : 'No matching NDC listing returned',
    found
      ? 'The FDA NDC database returned a listing. An NDC listing alone does not mean that FDA has approved the drug.'
      : 'No matching NDC listing was returned. This does not by itself establish that the product is counterfeit.',
    [sourceInfo('US FDA openFDA NDC', 'https://open.fda.gov/apis/drug/ndc/', 'official_regulator')],
    { records }
  );
}

/* -------------------------------------------------------------------------- */
/* General verification and history                                          */
/* -------------------------------------------------------------------------- */

async function verifyGeneral(body, env) {
  const barcode = clean(body.barcode || body.code, 80);
  if (barcode) return verifyBarcode(barcode, env);

  const category = clean(body.category || body.product_category, 120);
  const categoryLower = category.toLowerCase();
  const nafdacNumber = body.nafdac_number || body.registration_number;

  if (/medicine|drug|pharma|medical/.test(categoryLower) && nafdacNumber) {
    return verifyNAFDAC(body, env);
  }

  if (/food|drink|beverage|cosmetic|beauty|personal care/.test(categoryLower) && nafdacNumber) {
    return verifyNAFDAC(body, env);
  }

  const name = clean(body.product_name || body.name, 240);
  if (!name) {
    return makeResult(
      'needs_check',
      'Product information required',
      'Provide a product name, barcode or registration number.'
    );
  }

  const db = requireDatabase(env);
  const matches = await searchProducts(db, name, 10);

  if (!matches.length) {
    const result = makeResult(
      'not_found',
      'No matching product record',
      'TrueMark has no matching product in its current database. This is not proof that the product is fake.'
    );

    await saveVerification(db, {
      product_name: name,
      category,
      status: result.status,
      sources: []
    });

    return result;
  }

  const sources = [];
  for (const match of matches) {
    const productSources = await getProductSources(db, match.id);
    sources.push(...productSources);
  }

  const result = makeResult(
    'catalogue_match',
    'Possible product matches found',
    'These database records may match the supplied product. Compare the brand, packaging, manufacturer and identifiers carefully.',
    sources,
    { products: matches }
  );

  await saveVerification(db, {
    product_name: name,
    category,
    status: result.status,
    sources
  });

  return result;
}

/* -------------------------------------------------------------------------- */
/* Recall information                                                         */
/* -------------------------------------------------------------------------- */


/* -------------------------------------------------------------------------- */
/* TrueMark 2.0 — Consumer suspicious-product reports                         */
/* -------------------------------------------------------------------------- */

async function ensureReportsTable(db) {
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS product_reports (
      id TEXT PRIMARY KEY,
      product_name TEXT NOT NULL DEFAULT '',
      brand TEXT NOT NULL DEFAULT '',
      barcode TEXT NOT NULL DEFAULT '',
      registration_number TEXT NOT NULL DEFAULT '',
      batch_number TEXT NOT NULL DEFAULT '',
      purchase_location TEXT NOT NULL DEFAULT '',
      purchase_date TEXT NOT NULL DEFAULT '',
      concern TEXT NOT NULL DEFAULT '',
      country TEXT NOT NULL DEFAULT 'NG',
      status TEXT NOT NULL DEFAULT 'received',
      created_at TEXT NOT NULL,
      user_id TEXT
    )
  `).run();
  await db.prepare(`
    CREATE INDEX IF NOT EXISTS idx_reports_created ON product_reports(created_at)
  `).run();
}


async function submitProductRoute(request, env) {
  const db = requireDatabase(env);
  const body = await readJson(request);
  const name = clean(body.product_name || body.name, 240);
  const barcode = clean(body.barcode || body.code, 80);
  if (!name && !barcode) {
    return jsonResponse({
      success: false,
      error: 'Provide a product name and/or barcode.'
    }, 400);
  }

  const product = await upsertProduct(
    db,
    {
      name: name || `Unnamed (${barcode})`,
      brand: clean(body.brand, 160),
      manufacturer: clean(body.manufacturer, 200),
      category: clean(body.category, 120) || 'Other',
      description: clean(body.notes || body.description, 1800),
      image_url: '',
      country_of_origin: clean(body.country_of_origin, 120),
      confidence: 'user_submitted'
    },
    barcode
      ? [{ type: 'barcode', value: barcode, source: 'user_submitted' }]
      : [],
    {
      key: 'user_submitted',
      name: 'User submitted',
      url: '',
      type: 'user_submitted',
      evidence: {
        nafdac_number: clean(body.nafdac_number || body.registration_number, 80),
        batch_number: clean(body.batch_number, 80),
        note: 'User-submitted. Not independently verified.'
      }
    }
  );

  return jsonResponse({
    success: true,
    record_type: 'user_submitted',
    product,
    message: 'Product submitted to TrueMark for review. User-submitted records are not independently verified and must not be treated as authenticity proof.',
    classification: 'unverified',
    classification_label: 'Unverified',
    checked_at: isoNow()
  });
}


async function createReportRoute(request, env) {
  const db = requireDatabase(env);
  await ensureReportsTable(db);
  const body = await readJson(request);
  const product_name = clean(body.product_name || body.name, 240);
  const concern = clean(body.concern || body.description, 2000);
  if (!product_name && !clean(body.barcode, 80) && !clean(body.registration_number || body.nafdac_number, 80)) {
    return jsonResponse({
      success: false,
      error: 'Provide at least a product name, barcode, or registration number.'
    }, 400);
  }
  if (!concern || concern.length < 10) {
    return jsonResponse({
      success: false,
      error: 'Describe the concern in at least 10 characters.'
    }, 400);
  }
  const id = crypto.randomUUID();
  await db.prepare(`
    INSERT INTO product_reports (
      id, product_name, brand, barcode, registration_number, batch_number,
      purchase_location, purchase_date, concern, country, status, created_at, user_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'received', ?, NULL)
  `).bind(
    id,
    product_name,
    clean(body.brand, 160),
    clean(body.barcode, 80),
    clean(body.registration_number || body.nafdac_number, 80),
    clean(body.batch_number || body.lot, 80),
    clean(body.purchase_location || body.seller, 240),
    clean(body.purchase_date, 40),
    concern,
    clean(body.country || 'NG', 8) || 'NG',
    isoNow()
  ).run();

  return jsonResponse({
    success: true,
    report_id: id,
    status: 'received',
    message: 'Report received. TrueMark does not publicly accuse brands or sellers based solely on unverified consumer reports. Official channels remain NAFDAC and other competent authorities.',
    checked_at: isoNow()
  });
}

function regulatorsRoute() {
  return jsonResponse({
    success: true,
    version: VERSION,
    note: 'Connector catalogue for TrueMark 2.0. Availability does not imply live automated verification for every product.',
    connectors: [
      {
        id: 'ng-nafdac',
        country: 'NG',
        name: 'NAFDAC',
        categories: ['medicines', 'food', 'cosmetics', 'chemicals'],
        access: 'no_public_product_api',
        integration: 'deep_links_manual_check',
        portals: [
          'https://registration.nafdac.gov.ng/',
          'https://greenbook.nafdac.gov.ng/',
          'https://nafdac.gov.ng/'
        ],
        limitations: 'No authorised public bulk registration API for third-party apps. A missing lookup is not proof of counterfeit.'
      },
      {
        id: 'ng-son',
        country: 'NG',
        name: 'Standards Organisation of Nigeria',
        categories: ['standards', 'compulsory products'],
        access: 'limited_public',
        integration: 'manual_or_authorised_api',
        portals: ['https://son.gov.ng/'],
        limitations: 'No general consumer product authenticity API exposed for TrueMark.'
      },
      {
        id: 'us-openfda',
        country: 'US',
        name: 'openFDA',
        categories: ['drugs', 'food', 'devices', 'recalls'],
        access: 'public_api',
        integration: 'live',
        base_url: 'https://api.fda.gov/',
        endpoints: [
          'drug/enforcement.json',
          'food/enforcement.json',
          'device/enforcement.json',
          'drug/ndc.json'
        ],
        limitations: 'US-centric. FDA does not pre-approve all foods/cosmetics. Recalls may be batch-specific.'
      },
      {
        id: 'global-openfoodfacts',
        country: 'GLOBAL',
        name: 'Open Food / Beauty / Products Facts',
        categories: ['food', 'beauty', 'general', 'pet'],
        access: 'public_api',
        integration: 'live',
        base_url: 'https://world.openfoodfacts.org/api/',
        limitations: 'Community-contributed. Coverage uneven in Nigeria. Not a regulatory database.'
      },
      {
        id: 'eu-safety-gate',
        country: 'EU',
        name: 'EU Safety Gate',
        categories: ['consumer products'],
        access: 'public_web_partial_api',
        integration: 'planned',
        portals: ['https://ec.europa.eu/safety-gate/'],
        limitations: 'Requires careful parsing; not a universal product register.'
      },
      {
        id: 'uk-mhra',
        country: 'GB',
        name: 'MHRA / OPSS',
        categories: ['medicines', 'devices', 'consumer safety'],
        access: 'public_web',
        integration: 'planned',
        portals: [
          'https://www.gov.uk/government/organisations/medicines-and-healthcare-products-regulatory-agency'
        ],
        limitations: 'No single free universal product authenticity API for all consumer goods.'
      },
      {
        id: 'ca-health',
        country: 'CA',
        name: 'Health Canada',
        categories: ['drugs', 'devices', 'recalls'],
        access: 'public_web_open_data',
        integration: 'planned',
        portals: ['https://www.canada.ca/en/health-canada.html'],
        limitations: 'Category-specific datasets; not a global barcode oracle.'
      },
      {
        id: 'au-tga',
        country: 'AU',
        name: 'TGA / ARTG',
        categories: ['therapeutic goods'],
        access: 'public_search',
        integration: 'planned',
        portals: ['https://www.tga.gov.au/'],
        limitations: 'Therapeutic goods focus; not all consumer products.'
      },
      {
        id: 'in-cdsco-fssai',
        country: 'IN',
        name: 'CDSCO / FSSAI',
        categories: ['drugs', 'food'],
        access: 'public_web',
        integration: 'planned',
        portals: ['https://cdsco.gov.in/', 'https://www.fssai.gov.in/'],
        limitations: 'Partnership or careful official channels required for reliable automation.'
      },
      {
        id: 'africa-regulators',
        country: 'AF',
        name: 'Selected African NRAs',
        categories: ['medicines'],
        access: 'mostly_public_web',
        integration: 'planned_modular',
        examples: ['FDA Ghana', 'SAHPRA', 'PPB Kenya', 'NDA Uganda', 'TMDA', 'Rwanda FDA'],
        limitations: 'Heterogeneous systems; many lack open product APIs.'
      }
    ]
  });
}


async function recallsRoute(url, env) {
  const query = clean(url.searchParams.get('q'), 100);

  // Curated NAFDAC guidance + official channels (not a live private API scrape)
  const nafdac_alerts = [
    {
      source: 'NAFDAC',
      product_name: 'Official NAFDAC safety & SF product alerts',
      reason: 'Review NAFDAC public alerts for substandard and falsified products before buying high-risk items (especially medicines).',
      classification: 'guidance',
      status: 'active',
      recall_date: '',
      recalling_firm: 'NAFDAC',
      source_url: 'https://nafdac.gov.ng/'
    },
    {
      source: 'NAFDAC',
      product_name: 'Verify registration numbers on NAPAMS',
      reason: 'A printed NAFDAC number is not proof the physical pack is genuine. Confirm on official portals and compare name/manufacturer with the pack.',
      classification: 'guidance',
      status: 'active',
      recall_date: '',
      recalling_firm: 'NAFDAC',
      source_url: 'https://registration.nafdac.gov.ng/'
    },
    {
      source: 'NAFDAC',
      product_name: 'Medicines Greenbook search',
      reason: 'For medicines, search Greenbook by product name or registration number and match strength, form and manufacturer.',
      classification: 'guidance',
      status: 'active',
      recall_date: '',
      recalling_firm: 'NAFDAC',
      source_url: 'https://greenbook.nafdac.gov.ng/'
    },
    {
      source: 'NAFDAC',
      product_name: 'Report suspected fake or substandard products',
      reason: 'Report to NAFDAC with product details, place of purchase and photos where possible. Hotline 0800-1-623322 · sf.alert@nafdac.gov.ng',
      classification: 'report',
      status: 'active',
      recall_date: '',
      recalling_firm: 'NAFDAC',
      source_url: 'https://nafdac.gov.ng/'
    }
  ];

  let fda_recalls = [];
  try {
    fda_recalls = await lookupFdaRecalls(env, query);
  } catch (error) {
    console.warn('FDA recalls unavailable:', errorMessage(error));
  }

  return jsonResponse({
    success: true,
    nafdac_alerts,
    fda_recalls,
    recalls: fda_recalls,
    count: nafdac_alerts.length + fda_recalls.length,
    sources: {
      nafdac: 'Official NAFDAC portals and public guidance (not a private live alert API)',
      fda: 'US FDA openFDA drug enforcement'
    },
    message: 'NAFDAC items are official-channel guidance. FDA items are US openFDA enforcement records. Always confirm on the regulator site.'
  });
}

async function ensureUserHistoryTable(db) {
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS user_scan_history (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      identifier TEXT,
      product_name TEXT,
      method TEXT,
      created_at TEXT NOT NULL
    )
  `).run();
  await db.prepare(`
    CREATE INDEX IF NOT EXISTS idx_user_scan_history_user
    ON user_scan_history(user_id, created_at)
  `).run();
}

async function getHistoryRoute(request, env) {
  const user = await getUserFromAuthHeader(request, env);
  if (!user) {
    return jsonResponse({ success: false, error: 'Not signed in.' }, 401);
  }
  const db = requireDatabase(env);
  await ensureUserHistoryTable(db);
  const result = await db
    .prepare(
      `SELECT id, identifier, product_name, method, created_at
       FROM user_scan_history
       WHERE user_id = ?
       ORDER BY created_at DESC
       LIMIT 50`
    )
    .bind(user.id)
    .all();
  return jsonResponse({
    success: true,
    history: result.results || []
  });
}

async function postHistoryRoute(request, env) {
  const user = await getUserFromAuthHeader(request, env);
  if (!user) {
    return jsonResponse({ success: false, error: 'Not signed in.' }, 401);
  }
  const body = await readJson(request);
  const db = requireDatabase(env);
  await ensureUserHistoryTable(db);
  const id = crypto.randomUUID();
  const now = isoNow();
  await db
    .prepare(
      `INSERT INTO user_scan_history (id, user_id, identifier, product_name, method, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .bind(
      id,
      user.id,
      clean(body.identifier || body.barcode, 120),
      clean(body.product_name || body.name, 240),
      clean(body.method, 80),
      now
    )
    .run();
  return jsonResponse({ success: true, id, created_at: now });
}

async function clearHistoryRoute(request, env) {
  const user = await getUserFromAuthHeader(request, env);
  if (!user) {
    return jsonResponse({ success: false, error: 'Not signed in.' }, 401);
  }
  const db = requireDatabase(env);
  await ensureUserHistoryTable(db);
  await db.prepare('DELETE FROM user_scan_history WHERE user_id = ?').bind(user.id).run();
  return jsonResponse({ success: true });
}

/* -------------------------------------------------------------------------- */
/* Source registry                                                            */
/* -------------------------------------------------------------------------- */

async function sourcesRoute(env) {
  const db = requireDatabase(env);

  const result = await db.prepare(`
    SELECT source_key, source_name, source_type, source_url,
           last_status, last_checked_at, last_error
    FROM source_registry
    ORDER BY source_name
  `).all();

  return jsonResponse({
    success: true,
    sources: result.results || [],
    additional_sources: OFFICIAL_SOURCES
  });
}


/* -------------------------------------------------------------------------- */
/* Auth — users & sessions (D1 tables: users, sessions)                        */
/* -------------------------------------------------------------------------- */

const SESSION_DAYS = 30;

function normalizeEmail(value) {
  return clean(value, 180).toLowerCase();
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function bytesToHex(bytes) {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(hex) {
  const cleanHex = String(hex || '').replace(/[^a-f0-9]/gi, '');
  const out = new Uint8Array(cleanHex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(cleanHex.substr(i * 2, 2), 16);
  }
  return out;
}

async function randomToken(bytes = 32) {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return bytesToHex(buf);
}

async function hashPassword(password, saltHex) {
  const enc = new TextEncoder();
  const salt = hexToBytes(saltHex);
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    enc.encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt,
      iterations: 100000,
      hash: 'SHA-256'
    },
    keyMaterial,
    256
  );
  return bytesToHex(new Uint8Array(bits));
}

async function createSession(db, userId) {
  const token = await randomToken(32);
  const created = isoNow();
  const expires = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  await db
    .prepare(
      'INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)'
    )
    .bind(token, userId, created, expires)
    .run();
  return { token, expires_at: expires };
}

async function getUserFromAuthHeader(request, env) {
  const header = request.headers.get('Authorization') || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  const token = match ? clean(match[1], 128) : '';
  if (!token) return null;

  const db = requireDatabase(env);
  const row = await db
    .prepare(
      `SELECT u.id, u.email, u.display_name, s.expires_at
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token = ?`
    )
    .bind(token)
    .first();

  if (!row) return null;
  if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) {
    await db.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run();
    return null;
  }
  return {
    id: row.id,
    email: row.email,
    display_name: row.display_name || '',
    token
  };
}

async function signupRoute(request, env) {
  const body = await readJson(request);
  const email = normalizeEmail(body.email);
  const password = String(body.password || '');
  const displayName = clean(body.display_name || body.name || '', 80);

  if (!isValidEmail(email)) {
    return jsonResponse({ success: false, error: 'Enter a valid email address.' }, 400);
  }
  if (password.length < 8) {
    return jsonResponse({ success: false, error: 'Password must be at least 8 characters.' }, 400);
  }
  if (password.length > 72) {
    return jsonResponse({ success: false, error: 'Password is too long.' }, 400);
  }

  const db = requireDatabase(env);
  const existing = await db.prepare('SELECT id FROM users WHERE email = ?').bind(email).first();
  if (existing) {
    return jsonResponse({ success: false, error: 'An account with this email already exists.' }, 409);
  }

  const salt = await randomToken(16);
  const passwordHash = await hashPassword(password, salt);
  const id = crypto.randomUUID();
  const now = isoNow();

  await db
    .prepare(
      `INSERT INTO users (id, email, password_salt, password_hash, display_name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(id, email, salt, passwordHash, displayName, now, now)
    .run();

  const session = await createSession(db, id);
  return jsonResponse({
    success: true,
    user: { id, email, display_name: displayName },
    token: session.token,
    expires_at: session.expires_at
  });
}

async function loginRoute(request, env) {
  const body = await readJson(request);
  const email = normalizeEmail(body.email);
  const password = String(body.password || '');

  if (!isValidEmail(email) || !password) {
    return jsonResponse({ success: false, error: 'Email and password are required.' }, 400);
  }

  const db = requireDatabase(env);
  const user = await db
    .prepare('SELECT id, email, display_name, password_salt, password_hash FROM users WHERE email = ?')
    .bind(email)
    .first();

  if (!user) {
    return jsonResponse({ success: false, error: 'Invalid email or password.' }, 401);
  }

  const attempt = await hashPassword(password, user.password_salt);
  if (attempt !== user.password_hash) {
    return jsonResponse({ success: false, error: 'Invalid email or password.' }, 401);
  }

  const session = await createSession(db, user.id);
  return jsonResponse({
    success: true,
    user: {
      id: user.id,
      email: user.email,
      display_name: user.display_name || ''
    },
    token: session.token,
    expires_at: session.expires_at
  });
}

async function logoutRoute(request, env) {
  const header = request.headers.get('Authorization') || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  let token = match ? clean(match[1], 128) : '';
  if (!token) {
    try {
      const body = await readJson(request);
      token = clean(body.token, 128);
    } catch {
      token = '';
    }
  }
  if (token) {
    const db = requireDatabase(env);
    await db.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run();
  }
  return jsonResponse({ success: true });
}

async function meRoute(request, env) {
  const user = await getUserFromAuthHeader(request, env);
  if (!user) {
    return jsonResponse({ success: false, error: 'Not signed in.' }, 401);
  }
  return jsonResponse({
    success: true,
    user: {
      id: user.id,
      email: user.email,
      display_name: user.display_name || ''
    }
  });
}


/* -------------------------------------------------------------------------- */
/* API request routing                                                        */
/* -------------------------------------------------------------------------- */

async function handleRequest(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const method = request.method.toUpperCase();

  if (method === 'OPTIONS') {
    return new Response(null, { status: 204 });
  }

  if (path === '/' && method === 'GET') {
    return jsonResponse({
      success: true,
      service: 'TrueMark API',
      version: VERSION,
      message: 'Product identification and safety-information API',
      endpoints: [
        'GET /health',
        'GET /categories',
        'GET /sources',
        'POST /recognize',
        'POST /verify',
        'POST /verify/nafdac',
        'POST /verify/son',
        'POST /verify/fda-ndc',
        'POST /verify/barcode',
        'GET /recalls',
        'GET /products/search?q=product',
        'GET /products/:id',
        'POST /auth/signup',
        'POST /auth/login',
        'POST /auth/logout',
        'GET /auth/me',
        'GET /auth/history',
        'POST /auth/history',
        'DELETE /auth/history',
        'GET /alerts',
        'GET /admin/sync/status'
      ]
    });
  }

  if (path === '/health' && method === 'GET') {
    let database = 'not_configured';

    if (env.DB) {
      try {
        await env.DB.prepare('SELECT 1 AS ok').first();
        database = 'connected';
      } catch {
        database = 'error';
      }
    }

    return jsonResponse({
      success: database === 'connected',
      service: 'TrueMark API',
      version: VERSION,
      database,
      ai: env.AI ? 'configured' : 'not_configured',
      timestamp: isoNow()
    });
  }

  if (path === '/categories' && method === 'GET') {
    return jsonResponse({ success: true, categories: CATEGORIES });
  }

  if (path === '/sources' && method === 'GET') {
    return sourcesRoute(env);
  }

  
  


      
  if (path === '/recognize' && method === 'POST') {
    const body = await readJson(request, MAX_IMAGE_CHARS + 10000);
    return recognizeProduct(body, env);
  }

  if (path === '/verify' && method === 'POST') {
    const body = await readJson(request);
    const result = await verifyGeneral(body, env);
    return jsonResponse(result);
  }

  if (path === '/verify/nafdac' && method === 'POST') {
  const body = await readJson(request);
  return verifyNAFDAC(body, env);
}

  if (path === '/verify/son' && method === 'POST') {
    const body = await readJson(request);
    return jsonResponse(await verifySON(body, env));
  }

  if (path === '/verify/fda-ndc' && method === 'POST') {
    const body = await readJson(request);
    return jsonResponse(await verifyFdaNdc(body, env));
  }

  if (path === '/verify/barcode' && method === 'POST') {
    const body = await readJson(request);
    return jsonResponse(await verifyBarcode(body.barcode || body.code, env));
  }

  if (path === '/recalls' && method === 'GET') {
    return recallsRoute(url, env);
  }

  if (path === '/products/search' && method === 'GET') {
    return searchProductsRoute(url, env);
  }

if (path.startsWith('/products/barcode/') && method === 'GET') {
  const barcode = decodeURIComponent(
    path.slice('/products/barcode/'.length)
  );
  return jsonResponse(await verifyBarcode(barcode, env));
}

  
  const productMatch = path.match(/^\/products\/([^/]+)$/);
  if (productMatch && method === 'GET') {
    return productDetailsRoute(decodeURIComponent(productMatch[1]), env);
  }

  if (path === '/admin/sync/status' && method === 'GET') {
    return jsonResponse({
      success: true,
      message: 'Automated regulator synchronisation is not configured.',
      sources: OFFICIAL_SOURCES
    });
  }

  if (path === '/auth/signup' && method === 'POST') {
    return signupRoute(request, env);
  }

  if (path === '/auth/login' && method === 'POST') {
    return loginRoute(request, env);
  }

  if (path === '/auth/logout' && method === 'POST') {
    return logoutRoute(request, env);
  }

  if (path === '/auth/me' && method === 'GET') {
    return meRoute(request, env);
  }

  if (path === '/auth/history' && method === 'GET') {
    return getHistoryRoute(request, env);
  }

  if (path === '/auth/history' && method === 'POST') {
    return postHistoryRoute(request, env);
  }

  if (path === '/auth/history' && method === 'DELETE') {
    return clearHistoryRoute(request, env);
  }

  if (path === '/alerts' && method === 'GET') {
    return recallsRoute(url, env);
  }

  if (path === '/products/submit' && method === 'POST') {
    return submitProductRoute(request, env);
  }

  if (path === '/reports' && method === 'POST') {
    return createReportRoute(request, env);
  }

  if (path === '/regulators' && method === 'GET') {
    return regulatorsRoute();
  }

  return jsonResponse({
    success: false,
    error: 'Endpoint not found.',
    path
  }, 404);
}

/* -------------------------------------------------------------------------- */
/* Worker entry point                                                         */
/* -------------------------------------------------------------------------- */

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin');
    const allowedOrigins = getAllowedOrigins(env);

    if (origin && !allowedOrigins.includes(origin)) {
      return jsonResponse({
        success: false,
        error: 'Origin not authorised.'
      }, 403, corsHeaders(origin, env));
    }

    const headers = corsHeaders(origin, env);

    try {
      const response = await handleRequest(request, env);
      const mergedHeaders = new Headers(response.headers);

      for (const [key, value] of Object.entries(headers)) {
        mergedHeaders.set(key, value);
      }

      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: mergedHeaders
      });
    } catch (error) {
      const status = /valid JSON|too large|Provide a JPEG/i.test(errorMessage(error)) ? 400 : 500;

      return jsonResponse({
        success: false,
        error: errorMessage(error),
        service: 'TrueMark API',
        version: VERSION
      }, status, headers);
    }
  }
};

