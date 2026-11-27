/**
 * TrueMark API — Cloudflare Workers + D1 + Workers AI
 * Version 7.0.0 — TrueMark 2.0 Phase 2.1 — B2B manufacturer portal + subscriptions
 *
 * Database-first product identification and safety-information service.
 * IMPORTANT: catalogue matches are not proof of physical authenticity.
 * NAFDAC and SON are shown as unconnected unless an authorised API is configured.
 */

const VERSION = '8.3.1';
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

/** Product images: allow https URLs or compact data-URLs (manufacturer uploads). */
function cleanImageUrl(value, maxDataChars = 450000) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  if (/^https:\/\//i.test(raw) || /^http:\/\//i.test(raw)) {
    return raw.slice(0, 1000);
  }
  // data:image/...;base64,...
  if (/^data:image\/(jpeg|jpg|png|webp);base64,/i.test(raw)) {
    if (raw.length > maxDataChars) {
      return ''; // too large — do not store truncated broken image
    }
    return raw;
  }
  return '';
}



async function ensureProductImagesTable(db) {
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS product_images (
      product_id TEXT PRIMARY KEY,
      content_type TEXT NOT NULL DEFAULT 'image/jpeg',
      data_base64 TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `).run();
}

function workerPublicBase(env) {
  return clean(env.PUBLIC_API_BASE || 'https://truemark-ai.edialeeghonghon.workers.dev', 200).replace(/\/$/, '');
}

function productImagePublicUrl(env, productId) {
  return workerPublicBase(env) + '/products/' + encodeURIComponent(productId) + '/image';
}

/** Store full image; return public https URL for catalogue (never truncate data URLs into products.image_url). */
async function storeProductImage(db, env, productId, imageUrlOrData) {
  await ensureProductImagesTable(db);
  const raw = String(imageUrlOrData || '').trim();
  if (!raw) return '';

  if (/^https:\/\//i.test(raw) || /^http:\/\//i.test(raw)) {
    return raw.slice(0, 1000);
  }

  const m = raw.match(/^data:(image\/(jpeg|jpg|png|webp));base64,([A-Za-z0-9+/=\s]+)$/i);
  if (!m) return '';

  let contentType = m[1].toLowerCase();
  if (contentType === 'image/jpg' || contentType === 'image/jpeg') contentType = 'image/jpeg';
  const dataBase64 = m[3].replace(/\s+/g, '');
  if (dataBase64.length < 32) return '';
  if (dataBase64.length > 600000) {
    // ~450KB binary
    return '';
  }

  const now = isoNow();
  await db.prepare(`
    INSERT INTO product_images (product_id, content_type, data_base64, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(product_id) DO UPDATE SET
      content_type = excluded.content_type,
      data_base64 = excluded.data_base64,
      updated_at = excluded.updated_at
  `).bind(productId, contentType, dataBase64, now).run();

  return productImagePublicUrl(env, productId);
}


async function resolveProductImageUrl(db, env, productId, fallbackUrl) {
  try {
    await ensureProductImagesTable(db);
    const row = await db.prepare(
      'SELECT product_id FROM product_images WHERE product_id = ? LIMIT 1'
    ).bind(productId).first();
    if (row) return productImagePublicUrl(env, productId);
  } catch (_) {}
  const fb = String(fallbackUrl || '');
  if (fb.startsWith('data:image') && fb.length < 8000) return '';
  if (fb.startsWith('http://') || fb.startsWith('https://')) return fb;
  if (fb.startsWith('data:image') && fb.length >= 8000) return fb;
  return '';
}

async function serveProductImage(productId, env) {
  const db = requireDatabase(env);
  await ensureProductImagesTable(db);
  const row = await db.prepare(
    'SELECT content_type, data_base64 FROM product_images WHERE product_id = ? LIMIT 1'
  ).bind(productId).first();
  if (!row || !row.data_base64) {
    return jsonResponse({ success: false, error: 'Image not found.' }, 404);
  }
  try {
    const binary = Uint8Array.from(atob(row.data_base64), (c) => c.charCodeAt(0));
    return new Response(binary, {
      status: 200,
      headers: {
        'Content-Type': row.content_type || 'image/jpeg',
        'Cache-Control': 'public, max-age=86400',
        'Access-Control-Allow-Origin': '*'
      }
    });
  } catch (e) {
    return jsonResponse({ success: false, error: 'Invalid stored image.' }, 500);
  }
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

  const rows = result.results || [];
  if (rows.length >= limit) return rows;

  // Also surface approved manufacturer-registered products not yet mirrored
  try {
    await ensureBusinessTables(db);
    const remaining = limit - rows.length;
    const biz = await db.prepare(`
      SELECT bp.id, bp.name, bp.brand, bp.category, bp.description, bp.image_url,
             bp.barcode, bp.nafdac_number, bp.record_type, b.legal_name AS manufacturer,
             b.trading_name
      FROM business_products bp
      INNER JOIN businesses b ON b.id = bp.business_id
      WHERE bp.status = 'active'
        AND b.status = 'approved'
        AND (
          lower(bp.name) LIKE ?
          OR lower(COALESCE(bp.brand, '')) LIKE ?
          OR lower(COALESCE(b.legal_name, '')) LIKE ?
          OR lower(COALESCE(b.trading_name, '')) LIKE ?
          OR lower(COALESCE(bp.barcode, '')) LIKE ?
          OR lower(COALESCE(bp.nafdac_number, '')) LIKE ?
        )
      ORDER BY bp.updated_at DESC
      LIMIT ?
    `).bind(like, like, like, like, like, like, remaining).all();

    const seen = new Set(rows.map((r) => normalize(r.name) + '|' + normalize(r.brand || '')));
    for (const bp of (biz.results || [])) {
      const key = normalize(bp.name) + '|' + normalize(bp.brand || '');
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({
        id: bp.id,
        name: bp.name,
        normalized_name: normalize(bp.name),
        brand: bp.brand || '',
        manufacturer: bp.manufacturer || bp.trading_name || '',
        category: bp.category || '',
        description: bp.description || '',
        image_url: bp.image_url || '',
        country_of_origin: '',
        confidence: 'manufacturer_registered',
        record_type: bp.record_type || 'manufacturer_registered',
        barcode: bp.barcode || '',
        nafdac_number: bp.nafdac_number || '',
        source_label: 'Manufacturer registered'
      });
    }
  } catch (_) {
    // business tables may not exist yet
  }

  return rows;
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
    cleanImageUrl(product.image_url),
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

  let enrichment = {};
  try {
    enrichment = await enrichWithOptionalSources(first.product, env, barcode);
    if (enrichment.usda && !matches.some(m => m.source && m.source.key === 'usda_fdc')) {
      sources.push(sourceInfo('USDA FoodData Central', enrichment.usda.url, 'public_catalogue'));
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
  const resolved = [];
  for (const p of products) {
    const image_url = await resolveProductImageUrl(db, env, p.id, p.image_url);
    resolved.push({ ...p, image_url });
  }
  return jsonResponse({ success: true, products: resolved });
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

  const image_url = await resolveProductImageUrl(db, env, product.id, product.image_url);
  return jsonResponse({
    success: true,
    product: { ...product, image_url },
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
  const fromEnv = adminIdsFromEnv(env);
  let isAdmin = fromEnv.includes(user.id);
  if (!isAdmin) {
    try {
      isAdmin = await isPlatformAdmin(user.id, env);
    } catch (_) {
      isAdmin = false;
    }
  }
  return jsonResponse({
    success: true,
    user: {
      id: user.id,
      email: user.email,
      display_name: user.display_name || '',
      is_admin: !!isAdmin
    },
    is_admin: !!isAdmin
  });
}


/* -------------------------------------------------------------------------- */
/* API request routing                                                        */
/* -------------------------------------------------------------------------- */


/* ========================================================================== */
/* TrueMark B2B — businesses, plans, Paystack billing, admin                  */
/* Paid status never alters consumer verification honesty.                    */
/* ========================================================================== */

const PLAN_DEFAULTS = {
  starter: { max_products: 5, max_auth_codes_month: 0 },
  professional: { max_products: 50, max_auth_codes_month: 500 },
  business: { max_products: 200, max_auth_codes_month: 5000 },
  enterprise: { max_products: 999999, max_auth_codes_month: 999999 }
};

async function ensureBusinessTables(db) {
  // Lightweight ensure for critical tables if schema SQL not yet applied
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS subscription_plans (
      id TEXT PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      price_monthly_kobo INTEGER NOT NULL DEFAULT 0,
      price_annual_kobo INTEGER NOT NULL DEFAULT 0,
      currency TEXT NOT NULL DEFAULT 'NGN',
      max_products INTEGER NOT NULL DEFAULT 5,
      max_auth_codes_month INTEGER NOT NULL DEFAULT 0,
      features_json TEXT NOT NULL DEFAULT '[]',
      is_public INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL
    )
  `).run();
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS businesses (
      id TEXT PRIMARY KEY,
      owner_user_id TEXT NOT NULL,
      legal_name TEXT NOT NULL,
      trading_name TEXT NOT NULL DEFAULT '',
      email TEXT NOT NULL,
      phone TEXT NOT NULL DEFAULT '',
      country TEXT NOT NULL DEFAULT 'NG',
      registration_number TEXT NOT NULL DEFAULT '',
      website TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      rejection_reason TEXT NOT NULL DEFAULT '',
      plan_code TEXT NOT NULL DEFAULT 'starter',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      approved_at TEXT,
      approved_by TEXT
    )
  `).run();
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS business_products (
      id TEXT PRIMARY KEY,
      business_id TEXT NOT NULL,
      name TEXT NOT NULL,
      brand TEXT NOT NULL DEFAULT '',
      barcode TEXT NOT NULL DEFAULT '',
      gtin TEXT NOT NULL DEFAULT '',
      category TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      image_url TEXT NOT NULL DEFAULT '',
      nafdac_number TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'active',
      record_type TEXT NOT NULL DEFAULT 'manufacturer_registered',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `).run();
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS subscriptions (
      id TEXT PRIMARY KEY,
      business_id TEXT NOT NULL,
      plan_code TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'trialing',
      billing_cycle TEXT NOT NULL DEFAULT 'monthly',
      current_period_start TEXT,
      current_period_end TEXT,
      cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
      provider TEXT NOT NULL DEFAULT 'paystack',
      provider_subscription_code TEXT NOT NULL DEFAULT '',
      provider_customer_code TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `).run();
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS payments (
      id TEXT PRIMARY KEY,
      business_id TEXT NOT NULL,
      subscription_id TEXT,
      provider TEXT NOT NULL DEFAULT 'paystack',
      provider_reference TEXT NOT NULL UNIQUE,
      amount_kobo INTEGER NOT NULL,
      currency TEXT NOT NULL DEFAULT 'NGN',
      status TEXT NOT NULL DEFAULT 'pending',
      plan_code TEXT NOT NULL DEFAULT '',
      billing_cycle TEXT NOT NULL DEFAULT 'monthly',
      raw_json TEXT NOT NULL DEFAULT '',
      paid_at TEXT,
      created_at TEXT NOT NULL
    )
  `).run();
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS business_auth_codes (
      id TEXT PRIMARY KEY,
      business_id TEXT NOT NULL,
      product_id TEXT,
      code_hash TEXT NOT NULL,
      code_prefix TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'active',
      scan_count INTEGER NOT NULL DEFAULT 0,
      first_scan_at TEXT,
      last_scan_at TEXT,
      last_scan_country TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      UNIQUE(business_id, code_hash)
    )
  `).run();
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS admin_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `).run();

  const planCount = await db.prepare('SELECT COUNT(*) AS c FROM subscription_plans').first();
  if (!planCount || Number(planCount.c) === 0) {
    const now = isoNow();
    const plans = [
      ['plan_starter', 'starter', 'Starter', 'Free basic registration', 0, 0, 5, 0, 1],
      ['plan_professional', 'professional', 'Professional', 'Analytics and reports', 2500000, 27000000, 50, 500, 2],
      ['plan_business', 'business', 'Business', 'Geo + auth codes', 7500000, 81000000, 200, 5000, 3],
      ['plan_enterprise', 'enterprise', 'Enterprise', 'Custom', 0, 0, 999999, 999999, 4]
    ];
    for (const p of plans) {
      await db.prepare(`
        INSERT OR IGNORE INTO subscription_plans (
          id, code, name, description, price_monthly_kobo, price_annual_kobo, currency,
          max_products, max_auth_codes_month, features_json, is_public, sort_order, active, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'NGN', ?, ?, '[]', 1, ?, 1, ?)
      `).bind(p[0], p[1], p[2], p[3], p[4], p[5], p[6], p[7], p[8], now).run();
    }
  }
}

async function requireUser(request, env) {
  const user = await getUserFromAuthHeader(request, env);
  if (!user) {
    throw new Error('AUTH_REQUIRED');
  }
  return user;
}

async function isPlatformAdmin(userId, env) {
  const db = requireDatabase(env);
  await ensureBusinessTables(db);
  const row = await db.prepare(
    "SELECT value FROM admin_settings WHERE key = 'admin_user_ids' LIMIT 1"
  ).first();
  if (!row) return false;
  try {
    const ids = JSON.parse(row.value || '[]');
    return Array.isArray(ids) && ids.includes(userId);
  } catch {
    return false;
  }
}

function adminIdsFromEnv(env) {
  const raw = clean(env.ADMIN_USER_IDS || '', 500);
  if (!raw) return [];
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

async function requireAdmin(request, env) {
  const user = await requireUser(request, env);
  const fromEnv = adminIdsFromEnv(env);
  if (fromEnv.includes(user.id)) return user;
  if (await isPlatformAdmin(user.id, env)) return user;
  throw new Error('ADMIN_REQUIRED');
}

async function getBusinessForUser(db, userId) {
  return db.prepare(
    'SELECT * FROM businesses WHERE owner_user_id = ? ORDER BY created_at DESC LIMIT 1'
  ).bind(userId).first();
}

async function getPlan(db, code) {
  return db.prepare(
    'SELECT * FROM subscription_plans WHERE code = ? AND active = 1 LIMIT 1'
  ).bind(code).first();
}

async function getActiveSubscription(db, businessId) {
  return db.prepare(
    `SELECT * FROM subscriptions
     WHERE business_id = ?
       AND status IN ('active', 'trialing')
     ORDER BY created_at DESC LIMIT 1`
  ).bind(businessId).first();
}

function subscriptionIsLive(sub) {
  if (!sub) return false;
  if (sub.status === 'active' || sub.status === 'trialing') {
    if (sub.current_period_end) {
      return new Date(sub.current_period_end).getTime() >= Date.now();
    }
    return true;
  }
  return false;
}

async function listPlansRoute(env) {
  const db = requireDatabase(env);
  await ensureBusinessTables(db);
  const { results } = await db.prepare(
    'SELECT * FROM subscription_plans WHERE active = 1 AND is_public = 1 ORDER BY sort_order ASC'
  ).all();
  return jsonResponse({
    success: true,
    plans: results || [],
    disclaimer:
      'Paid plans unlock manufacturer tools only. They never buy favourable authenticity results or suppress safety reports.'
  });
}

async function registerBusinessRoute(request, env) {
  const user = await requireUser(request, env);
  const db = requireDatabase(env);
  await ensureBusinessTables(db);
  const body = await readJson(request);
  const legal_name = clean(body.legal_name || body.company_name, 200);
  const email = clean(body.email || user.email, 160).toLowerCase();
  if (!legal_name) {
    return jsonResponse({ success: false, error: 'Company legal name is required.' }, 400);
  }

  const existing = await getBusinessForUser(db, user.id);
  if (existing && existing.status !== 'rejected') {
    return jsonResponse({
      success: true,
      business: existing,
      message: 'Business already registered.'
    });
  }

  const id = crypto.randomUUID();
  const now = isoNow();
  await db.prepare(`
    INSERT INTO businesses (
      id, owner_user_id, legal_name, trading_name, email, phone, country,
      registration_number, website, status, plan_code, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'starter', ?, ?)
  `).bind(
    id,
    user.id,
    legal_name,
    clean(body.trading_name, 200),
    email,
    clean(body.phone, 40),
    clean(body.country || 'NG', 8) || 'NG',
    clean(body.registration_number, 80),
    clean(body.website, 300),
    now,
    now
  ).run();

  const business = await db.prepare('SELECT * FROM businesses WHERE id = ?').bind(id).first();
  return jsonResponse({
    success: true,
    business,
    message: 'Application received. An administrator must approve before paid features activate.'
  });
}

async function myBusinessRoute(request, env) {
  const user = await requireUser(request, env);
  const db = requireDatabase(env);
  await ensureBusinessTables(db);
  const business = await getBusinessForUser(db, user.id);
  if (!business) {
    return jsonResponse({ success: true, business: null });
  }
  const sub = await getActiveSubscription(db, business.id);
  const plan = await getPlan(db, business.plan_code || 'starter');
  const { results: products } = await db.prepare(
    'SELECT * FROM business_products WHERE business_id = ? AND status != 'removed' ORDER BY updated_at DESC LIMIT 100'
  ).bind(business.id).all();

  return jsonResponse({
    success: true,
    business,
    subscription: sub || null,
    subscription_live: subscriptionIsLive(sub),
    plan,
    products: products || [],
    trust_rules: {
      paid_does_not_mean_authenticated: true,
      paid_cannot_suppress_reports: true,
      manufacturer_registered_is_not_regulatory_verification: true
    }
  });
}

async function addBusinessProductRoute(request, env) {
  const user = await requireUser(request, env);
  const db = requireDatabase(env);
  await ensureBusinessTables(db);
  const business = await getBusinessForUser(db, user.id);
  if (!business) {
    return jsonResponse({ success: false, error: 'Register a business first.' }, 400);
  }
  if (business.status === 'suspended') {
    return jsonResponse({ success: false, error: 'Business is suspended.' }, 403);
  }
  if (business.status === 'pending') {
    return jsonResponse({
      success: false,
      error: 'Business is pending admin approval. You can still prepare data after approval.'
    }, 403);
  }

  const plan = await getPlan(db, business.plan_code || 'starter');
  const maxProducts = plan ? Number(plan.max_products) : 5;
  const countRow = await db.prepare(
    "SELECT COUNT(*) AS c FROM business_products WHERE business_id = ? AND status = 'active'"
  ).bind(business.id).first();
  if (Number(countRow?.c || 0) >= maxProducts) {
    return jsonResponse({
      success: false,
      error: `Plan limit reached (${maxProducts} products). Upgrade to add more.`
    }, 403);
  }

  const body = await readJson(request, MAX_IMAGE_CHARS + 50000);
  const name = clean(body.name || body.product_name, 240);
  if (!name) {
    return jsonResponse({ success: false, error: 'Product name is required.' }, 400);
  }

  const now = isoNow();
  // Re-use existing product row with same name so image can be fixed without duplicates
  const existing = await db.prepare(`
    SELECT id FROM business_products
    WHERE business_id = ? AND lower(name) = lower(?) AND status = 'active'
    LIMIT 1
  `).bind(business.id, name).first();
  const id = existing?.id || crypto.randomUUID();

  let publicImageUrl = '';
  try {
    publicImageUrl = await storeProductImage(db, env, id, body.image_url);
  } catch (imgErr) {
    console.warn('TrueMark image store failed:', imgErr && imgErr.message);
    publicImageUrl = '';
  }
  if (body.image_url && !publicImageUrl) {
    console.warn('TrueMark image rejected or too large for product', id);
  }

  if (existing) {
    await db.prepare(`
      UPDATE business_products SET
        brand = COALESCE(NULLIF(?, ''), brand),
        barcode = COALESCE(NULLIF(?, ''), barcode),
        gtin = COALESCE(NULLIF(?, ''), gtin),
        category = COALESCE(NULLIF(?, ''), category),
        description = COALESCE(NULLIF(?, ''), description),
        image_url = CASE WHEN ? != '' THEN ? ELSE image_url END,
        nafdac_number = COALESCE(NULLIF(?, ''), nafdac_number),
        updated_at = ?
      WHERE id = ?
    `).bind(
      clean(body.brand, 160),
      clean(body.barcode, 80),
      clean(body.gtin, 80),
      clean(body.category, 120),
      clean(body.description, 2000),
      publicImageUrl || '',
      publicImageUrl || '',
      clean(body.nafdac_number, 80),
      now,
      id
    ).run();
  } else {
    await db.prepare(`
      INSERT INTO business_products (
        id, business_id, name, brand, barcode, gtin, category, description,
        image_url, nafdac_number, status, record_type, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 'manufacturer_registered', ?, ?)
    `).bind(
      id,
      business.id,
      name,
      clean(body.brand, 160),
      clean(body.barcode, 80),
      clean(body.gtin, 80),
      clean(body.category, 120),
      clean(body.description, 2000),
      publicImageUrl || '',
      clean(body.nafdac_number, 80),
      now,
      now
    ).run();
  }

  const product = await db.prepare('SELECT * FROM business_products WHERE id = ?').bind(id).first();

  // Mirror into consumer catalogue so name/barcode search can find it
  try {
    const identifiers = [];
    const barcode = clean(body.barcode, 80);
    const gtin = clean(body.gtin, 80);
    const nafdac = clean(body.nafdac_number, 80);
    if (barcode) identifiers.push({ type: 'barcode', value: barcode, source: 'manufacturer' });
    if (gtin && gtin !== barcode) identifiers.push({ type: 'barcode', value: gtin, source: 'manufacturer' });
    if (nafdac) identifiers.push({ type: 'nafdac', value: nafdac, source: 'manufacturer' });

    await upsertProduct(
      db,
      {
        id: id,
        name: name,
        brand: clean(body.brand, 160),
        manufacturer: clean(business.legal_name || business.trading_name || '', 200),
        category: clean(body.category, 120),
        description: clean(body.description, 2000),
        image_url: publicImageUrl || '',
        country_of_origin: clean(body.country_of_origin || 'NG', 120),
        confidence: 'manufacturer_registered'
      },
      identifiers,
      {
        key: 'manufacturer',
        name: 'Manufacturer registered',
        url: '',
        type: 'manufacturer_registered'
      }
    );
  } catch (mirrorErr) {
    console.warn('TrueMark manufacturer catalogue mirror failed:', mirrorErr && mirrorErr.message);
  }

  return jsonResponse({
    success: true,
    product: product ? { ...product, image_url: publicImageUrl || product.image_url || '' } : product,
    image_url: publicImageUrl || '',
    image_stored: Boolean(publicImageUrl),
    catalogue_indexed: true,
    record_type: 'manufacturer_registered',
    disclaimer:
      'Manufacturer-registered product data is provided by the business. It is not NAFDAC verification and does not authenticate a physical unit.'
  });
}


/** Soft-remove manufacturer product from business list and consumer catalogue. */
async function removeBusinessProductRoute(request, env) {
  const user = await requireUser(request, env);
  const db = requireDatabase(env);
  await ensureBusinessTables(db);
  const business = await getBusinessForUser(db, user.id);
  if (!business) {
    return jsonResponse({ success: false, error: 'Register a business first.' }, 400);
  }

  const body = await readJson(request);
  const productId = clean(body.product_id || body.id, 80);
  if (!productId) {
    return jsonResponse({ success: false, error: 'product_id is required.' }, 400);
  }

  const row = await db.prepare(
    'SELECT * FROM business_products WHERE id = ? AND business_id = ? LIMIT 1'
  ).bind(productId, business.id).first();

  if (!row) {
    return jsonResponse({
      success: false,
      error: 'Product not found on your business account.'
    }, 404);
  }

  const now = isoNow();
  await db.prepare(`
    UPDATE business_products
    SET status = 'removed', updated_at = ?
    WHERE id = ? AND business_id = ?
  `).bind(now, productId, business.id).run();

  // Pull out of consumer search catalogue
  try {
    await db.prepare('DELETE FROM product_identifiers WHERE product_id = ?').bind(productId).run();
  } catch (_) {}
  try {
    await db.prepare('DELETE FROM product_images WHERE product_id = ?').bind(productId).run();
  } catch (_) {}
  try {
    await db.prepare('DELETE FROM products WHERE id = ?').bind(productId).run();
  } catch (_) {}

  return jsonResponse({
    success: true,
    removed: true,
    product_id: productId,
    message: 'Product removed from your catalogue and consumer search.'
  });
}

/** Admin: remove any catalogue product (manufacturer or ingested). */
async function adminRemoveProductRoute(request, env) {
  await requireAdmin(request, env);
  const db = requireDatabase(env);
  const body = await readJson(request);
  const productId = clean(body.product_id || body.id, 80);
  const name = clean(body.name || body.product_name, 240);

  if (!productId && !name) {
    return jsonResponse({
      success: false,
      error: 'Provide product_id or name.'
    }, 400);
  }

  let ids = [];
  if (productId) {
    ids = [productId];
  } else {
    const found = await db.prepare(`
      SELECT id FROM products WHERE lower(name) = lower(?) LIMIT 20
    `).bind(name).all();
    ids = (found.results || []).map((r) => r.id);
    try {
      await ensureBusinessTables(db);
      const biz = await db.prepare(`
        SELECT id FROM business_products WHERE lower(name) = lower(?) LIMIT 20
      `).bind(name).all();
      for (const r of (biz.results || [])) {
        if (!ids.includes(r.id)) ids.push(r.id);
      }
    } catch (_) {}
  }

  if (!ids.length) {
    return jsonResponse({ success: false, error: 'No matching product found.' }, 404);
  }

  const now = isoNow();
  let removed = 0;
  for (const id of ids) {
    try {
      await ensureBusinessTables(db);
      await db.prepare(`
        UPDATE business_products SET status = 'removed', updated_at = ? WHERE id = ?
      `).bind(now, id).run();
    } catch (_) {}
    try {
      await db.prepare('DELETE FROM product_identifiers WHERE product_id = ?').bind(id).run();
    } catch (_) {}
    try {
      await ensureProductImagesTable(db);
      await db.prepare('DELETE FROM product_images WHERE product_id = ?').bind(id).run();
    } catch (_) {}
    try {
      await db.prepare('DELETE FROM products WHERE id = ?').bind(id).run();
      removed += 1;
    } catch (_) {}
  }

  return jsonResponse({
    success: true,
    removed_ids: ids,
    removed_count: removed,
    message: 'Product(s) removed from consumer catalogue.'
  });
}


async function initiatePaystackPaymentRoute(request, env) {
  const user = await requireUser(request, env);
  const secret = clean(env.PAYSTACK_SECRET_KEY || '', 200);
  if (!secret) {
    return jsonResponse({
      success: false,
      error: 'Paystack is not configured. Set PAYSTACK_SECRET_KEY on the Worker.'
    }, 503);
  }

  const db = requireDatabase(env);
  await ensureBusinessTables(db);
  const business = await getBusinessForUser(db, user.id);
  if (!business || business.status !== 'approved') {
    return jsonResponse({
      success: false,
      error: 'Business must be approved before paid checkout.'
    }, 403);
  }

  const body = await readJson(request);
  const plan_code = clean(body.plan_code, 40);
  const billing_cycle = clean(body.billing_cycle || 'monthly', 20) === 'annual' ? 'annual' : 'monthly';
  const plan = await getPlan(db, plan_code);
  if (!plan || plan_code === 'starter' || plan_code === 'enterprise') {
    return jsonResponse({
      success: false,
      error: 'Select Professional or Business plan, or contact TrueMark for Enterprise.'
    }, 400);
  }

  const amount =
    billing_cycle === 'annual'
      ? Number(plan.price_annual_kobo)
      : Number(plan.price_monthly_kobo);
  if (!amount || amount < 10000) {
    return jsonResponse({ success: false, error: 'Plan amount is not configured.' }, 400);
  }

  const reference = `tm_${business.id.slice(0, 8)}_${Date.now()}`;
  const paymentId = crypto.randomUUID();
  const now = isoNow();

  await db.prepare(`
    INSERT INTO payments (
      id, business_id, subscription_id, provider, provider_reference,
      amount_kobo, currency, status, plan_code, billing_cycle, raw_json, created_at
    ) VALUES (?, ?, NULL, 'paystack', ?, ?, ?, 'pending', ?, ?, '', ?)
  `).bind(
    paymentId,
    business.id,
    reference,
    amount,
    plan.currency || 'NGN',
    plan_code,
    billing_cycle,
    now
  ).run();

  const initRes = await fetch('https://api.paystack.co/transaction/initialize', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secret}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      email: business.email || user.email,
      amount,
      currency: plan.currency || 'NGN',
      reference,
      callback_url: clean(body.callback_url || 'https://eddysparkle.github.io/Truemark/business.html', 500),
      metadata: {
        business_id: business.id,
        plan_code,
        billing_cycle,
        payment_id: paymentId
      }
    })
  });

  const initData = await initRes.json().catch(() => ({}));
  if (!initRes.ok || !initData.status) {
    return jsonResponse({
      success: false,
      error: initData.message || 'Paystack initialize failed.'
    }, 502);
  }

  return jsonResponse({
    success: true,
    authorization_url: initData.data.authorization_url,
    access_code: initData.data.access_code,
    reference,
    amount_kobo: amount,
    currency: plan.currency || 'NGN',
    note: 'Subscription activates only after Paystack webhook or server-side verify succeeds.'
  });
}

async function verifyPaystackTransaction(reference, env) {
  const secret = clean(env.PAYSTACK_SECRET_KEY || '', 200);
  if (!secret) return null;
  const res = await fetch(
    `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,
    { headers: { Authorization: `Bearer ${secret}` } }
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.status) return null;
  return data.data;
}

async function activateSubscriptionFromPayment(db, payment, plan_code, billing_cycle) {
  const now = isoNow();
  const periodEnd = new Date(
    Date.now() + (billing_cycle === 'annual' ? 365 : 30) * 24 * 60 * 60 * 1000
  ).toISOString();

  const subId = crypto.randomUUID();
  await db.prepare(`
    INSERT INTO subscriptions (
      id, business_id, plan_code, status, billing_cycle,
      current_period_start, current_period_end, cancel_at_period_end,
      provider, created_at, updated_at
    ) VALUES (?, ?, ?, 'active', ?, ?, ?, 0, 'paystack', ?, ?)
  `).bind(
    subId,
    payment.business_id,
    plan_code,
    billing_cycle,
    now,
    periodEnd,
    now,
    now
  ).run();

  await db.prepare(
    'UPDATE businesses SET plan_code = ?, updated_at = ? WHERE id = ?'
  ).bind(plan_code, now, payment.business_id).run();

  await db.prepare(
    `UPDATE payments SET status = 'success', paid_at = ?, subscription_id = ? WHERE id = ?`
  ).bind(now, subId, payment.id).run();

  return subId;
}

async function paystackWebhookRoute(request, env) {
  const secret = clean(env.PAYSTACK_SECRET_KEY || '', 200);
  if (!secret) {
    return jsonResponse({ success: false, error: 'Not configured' }, 503);
  }

  const raw = await request.text();
  const signature = request.headers.get('x-paystack-signature') || '';
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-512' },
    false,
    ['sign']
  );
  const sigBuf = await crypto.subtle.sign('HMAC', key, enc.encode(raw));
  const hash = [...new Uint8Array(sigBuf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  if (hash !== signature) {
    return jsonResponse({ success: false, error: 'Invalid signature' }, 401);
  }

  let event;
  try {
    event = JSON.parse(raw);
  } catch {
    return jsonResponse({ success: false, error: 'Invalid JSON' }, 400);
  }

  const db = requireDatabase(env);
  await ensureBusinessTables(db);

  if (event.event === 'charge.success') {
    const data = event.data || {};
    const reference = clean(data.reference, 120);
    if (!reference) {
      return jsonResponse({ success: true, ignored: true });
    }

    const payment = await db.prepare(
      'SELECT * FROM payments WHERE provider_reference = ? LIMIT 1'
    ).bind(reference).first();

    if (!payment) {
      return jsonResponse({ success: true, ignored: 'unknown_reference' });
    }
    if (payment.status === 'success') {
      return jsonResponse({ success: true, duplicate: true });
    }

    // Confirm amount
    if (Number(data.amount) !== Number(payment.amount_kobo)) {
      return jsonResponse({ success: false, error: 'Amount mismatch' }, 400);
    }

    await db.prepare(
      'UPDATE payments SET raw_json = ? WHERE id = ?'
    ).bind(raw.slice(0, 8000), payment.id).run();

    await activateSubscriptionFromPayment(
      db,
      payment,
      payment.plan_code,
      payment.billing_cycle || 'monthly'
    );
  }

  return jsonResponse({ success: true });
}

async function verifyPaymentRoute(request, env) {
  // Optional client-triggered verify; still uses Paystack server API — never trust client alone
  const user = await requireUser(request, env);
  const body = await readJson(request);
  const reference = clean(body.reference, 120);
  if (!reference) {
    return jsonResponse({ success: false, error: 'reference required' }, 400);
  }

  const db = requireDatabase(env);
  await ensureBusinessTables(db);
  const payment = await db.prepare(
    'SELECT * FROM payments WHERE provider_reference = ? LIMIT 1'
  ).bind(reference).first();
  if (!payment) {
    return jsonResponse({ success: false, error: 'Payment not found' }, 404);
  }

  const business = await getBusinessForUser(db, user.id);
  if (!business || business.id !== payment.business_id) {
    return jsonResponse({ success: false, error: 'Forbidden' }, 403);
  }

  if (payment.status === 'success') {
    return jsonResponse({ success: true, status: 'success', already_active: true });
  }

  const verified = await verifyPaystackTransaction(reference, env);
  if (!verified || verified.status !== 'success') {
    return jsonResponse({ success: false, status: 'pending', error: 'Not paid yet' }, 402);
  }
  if (Number(verified.amount) !== Number(payment.amount_kobo)) {
    return jsonResponse({ success: false, error: 'Amount mismatch' }, 400);
  }

  await activateSubscriptionFromPayment(
    db,
    payment,
    payment.plan_code,
    payment.billing_cycle || 'monthly'
  );

  return jsonResponse({ success: true, status: 'success' });
}

async function adminListBusinessesRoute(request, env) {
  await requireAdmin(request, env);
  const db = requireDatabase(env);
  await ensureBusinessTables(db);
  const { results } = await db.prepare(
    'SELECT * FROM businesses ORDER BY created_at DESC LIMIT 200'
  ).all();
  return jsonResponse({ success: true, businesses: results || [] });
}

async function adminSetBusinessStatusRoute(request, env) {
  const admin = await requireAdmin(request, env);
  const db = requireDatabase(env);
  await ensureBusinessTables(db);
  const body = await readJson(request);
  const id = clean(body.business_id || body.id, 80);
  const status = clean(body.status, 20);
  if (!['approved', 'rejected', 'suspended', 'pending'].includes(status)) {
    return jsonResponse({ success: false, error: 'Invalid status' }, 400);
  }
  const now = isoNow();
  await db.prepare(`
    UPDATE businesses
    SET status = ?, rejection_reason = ?, updated_at = ?,
        approved_at = CASE WHEN ? = 'approved' THEN ? ELSE approved_at END,
        approved_by = CASE WHEN ? = 'approved' THEN ? ELSE approved_by END
    WHERE id = ?
  `).bind(
    status,
    clean(body.reason, 500),
    now,
    status,
    now,
    status,
    admin.id,
    id
  ).run();
  return jsonResponse({ success: true });
}

async function adminUpdatePlanRoute(request, env) {
  await requireAdmin(request, env);
  const db = requireDatabase(env);
  await ensureBusinessTables(db);
  const body = await readJson(request);
  const code = clean(body.code, 40);
  if (!code) {
    return jsonResponse({ success: false, error: 'code required' }, 400);
  }
  const now = isoNow();
  await db.prepare(`
    UPDATE subscription_plans SET
      name = COALESCE(?, name),
      description = COALESCE(?, description),
      price_monthly_kobo = COALESCE(?, price_monthly_kobo),
      price_annual_kobo = COALESCE(?, price_annual_kobo),
      max_products = COALESCE(?, max_products),
      max_auth_codes_month = COALESCE(?, max_auth_codes_month),
      active = COALESCE(?, active),
      updated_at = ?
    WHERE code = ?
  `).bind(
    body.name != null ? clean(body.name, 80) : null,
    body.description != null ? clean(body.description, 500) : null,
    body.price_monthly_kobo != null ? Number(body.price_monthly_kobo) : null,
    body.price_annual_kobo != null ? Number(body.price_annual_kobo) : null,
    body.max_products != null ? Number(body.max_products) : null,
    body.max_auth_codes_month != null ? Number(body.max_auth_codes_month) : null,
    body.active != null ? (body.active ? 1 : 0) : null,
    now,
    code
  ).run();
  return jsonResponse({ success: true });
}

async function adminStatsRoute(request, env) {
  await requireAdmin(request, env);
  const db = requireDatabase(env);
  await ensureBusinessTables(db);
  const businesses = await db.prepare('SELECT COUNT(*) AS c FROM businesses').first();
  const approved = await db.prepare(
    "SELECT COUNT(*) AS c FROM businesses WHERE status = 'approved'"
  ).first();
  const payments = await db.prepare(
    "SELECT COUNT(*) AS c, COALESCE(SUM(amount_kobo),0) AS revenue FROM payments WHERE status = 'success'"
  ).first();
  const reports = await db.prepare('SELECT COUNT(*) AS c FROM product_reports').first().catch(() => ({ c: 0 }));
  return jsonResponse({
    success: true,
    stats: {
      businesses: Number(businesses?.c || 0),
      approved: Number(approved?.c || 0),
      successful_payments: Number(payments?.c || 0),
      revenue_kobo: Number(payments?.revenue || 0),
      consumer_reports: Number(reports?.c || 0)
    }
  });
}

async function issueAuthCodesRoute(request, env) {
  const user = await requireUser(request, env);
  const db = requireDatabase(env);
  await ensureBusinessTables(db);
  const business = await getBusinessForUser(db, user.id);
  if (!business || business.status !== 'approved') {
    return jsonResponse({ success: false, error: 'Approved business required.' }, 403);
  }
  const sub = await getActiveSubscription(db, business.id);
  const plan = await getPlan(db, business.plan_code || 'starter');
  const allowed =
    subscriptionIsLive(sub) &&
    plan &&
    Number(plan.max_auth_codes_month) > 0 &&
    ['business', 'enterprise', 'professional'].includes(business.plan_code);
  // Professional gets limited codes; starter none
  if (!allowed && !(plan && Number(plan.max_auth_codes_month) > 0 && subscriptionIsLive(sub))) {
    return jsonResponse({
      success: false,
      error: 'Auth codes require an active plan with auth capacity (Business or higher recommended).'
    }, 403);
  }

  const body = await readJson(request);
  const count = Math.min(Math.max(Number(body.count) || 1, 1), 100);
  const product_id = clean(body.product_id, 80);
  const created = [];
  const now = isoNow();

  for (let i = 0; i < count; i += 1) {
    const plain = `TM-${crypto.randomUUID().replace(/-/g, '').slice(0, 16).toUpperCase()}`;
    const prefix = plain.slice(0, 8);
    const hashBuffer = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(plain)
    );
    const code_hash = [...new Uint8Array(hashBuffer)]
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    const id = crypto.randomUUID();
    await db.prepare(`
      INSERT INTO business_auth_codes (
        id, business_id, product_id, code_hash, code_prefix, status, scan_count, created_at
      ) VALUES (?, ?, ?, ?, ?, 'active', 0, ?)
    `).bind(id, business.id, product_id || null, code_hash, prefix, now).run();
    created.push({ id, code: plain, prefix });
  }

  return jsonResponse({
    success: true,
    codes: created,
    warning:
      'Store codes securely. TrueMark only stores hashes. Showing codes once. Unit authentication is only as strong as your packaging and distribution controls.'
  });
}

async function verifyAuthCodeRoute(request, env) {
  // Public consumer check for manufacturer-issued codes
  const body = await readJson(request);
  const code = clean(body.code || body.auth_code, 80);
  if (!code) {
    return jsonResponse({ success: false, error: 'code required' }, 400);
  }
  const db = requireDatabase(env);
  await ensureBusinessTables(db);
  const hashBuffer = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(code)
  );
  const code_hash = [...new Uint8Array(hashBuffer)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  const row = await db.prepare(
    'SELECT * FROM business_auth_codes WHERE code_hash = ? LIMIT 1'
  ).bind(code_hash).first();

  if (!row) {
    return makeResult(
      'unverified',
      'Authentication code not recognised',
      'No manufacturer-backed code matched. This does not by itself prove the product is counterfeit.',
      [],
      { authenticated: false }
    );
  }

  const now = isoNow();
  const scan_count = Number(row.scan_count || 0) + 1;
  let status = row.status;
  let classification = 'authenticated';
  let message = 'Manufacturer-backed authentication code matched.';

  if (row.status === 'revoked') {
    classification = 'high_risk';
    message = 'This authentication code was revoked by the manufacturer.';
  } else if (scan_count > 5) {
    status = 'suspicious';
    classification = 'caution';
    message =
      'Code matched but has been scanned many times. Possible sharing, leakage, or misuse — treat with caution.';
  }

  await db.prepare(`
    UPDATE business_auth_codes
    SET scan_count = ?, last_scan_at = ?, first_scan_at = COALESCE(first_scan_at, ?), status = ?
    WHERE id = ?
  `).bind(scan_count, now, now, status, row.id).run();

  return makeResult(
    classification === 'authenticated' ? 'authenticated' : classification,
    classification === 'authenticated' ? 'Unit code matched' : 'Code requires caution',
    message,
    [sourceInfo('Manufacturer auth code', '', 'manufacturer_backed')],
    {
      authenticated: classification === 'authenticated',
      scan_count,
      business_id: row.business_id,
      product_id: row.product_id,
      disclaimer:
        'Authentication reflects manufacturer-issued code status only. It is not a NAFDAC registration check.'
    }
  );
}



/* ========================================================================== */
/* TrueMark Global Product Intelligence Engine (v8) — additive adapters       */
/* Does not replace existing verifyBarcode / auth / business / paystack.      */
/* ========================================================================== */

async function lookupUsdaFdc(query, env, barcode) {
  const key = clean(env.USDA_FDC_API_KEY || '', 120);
  if (!key) return null;
  const q = clean(barcode || query, 80);
  if (!q || q.length < 3) return null;
  try {
    const url =
      'https://api.nal.usda.gov/fdc/v1/foods/search?api_key=' +
      encodeURIComponent(key) +
      '&query=' + encodeURIComponent(q) +
      '&pageSize=5&dataType=Branded';
    const data = await fetchJson(url, {}, 9000);
    const foods = data.foods || [];
    if (!foods.length) return null;
    const f = foods[0];
    return {
      source: { key: 'usda_fdc', name: 'USDA FoodData Central', category: 'Food' },
      product: {
        name: f.description || '',
        brand: f.brandOwner || f.brandName || '',
        manufacturer: f.brandOwner || '',
        category: (f.foodCategory || 'Food') + '',
        description: f.ingredients || '',
        image_url: '',
        country_of_origin: f.marketCountry || '',
        barcode: f.gtinUpc || barcode || '',
        quantity: f.packageWeight || '',
        fdc_id: f.fdcId
      },
      url: f.fdcId
        ? 'https://fdc.nal.usda.gov/fdc-app.html#/food-details/' + f.fdcId
        : 'https://fdc.nal.usda.gov/',
      nutrients: (f.foodNutrients || []).slice(0, 12).map((n) => ({
        name: n.nutrientName,
        amount: n.value,
        unit: n.unitName
      }))
    };
  } catch {
    return null;
  }
}

async function lookupPubChemCompound(name) {
  const q = clean(name, 120);
  if (!q || q.length < 2) return null;
  try {
    const url =
      'https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name/' +
      encodeURIComponent(q) +
      '/property/Title,MolecularFormula,MolecularWeight,IUPACName,CanonicalSMILES/JSON';
    const data = await fetchJson(url, {}, 9000);
    const props = data?.PropertyTable?.Properties;
    if (!props || !props.length) return null;
    const p = props[0];
    return {
      source: 'PubChem',
      query: q,
      cid: p.CID,
      title: p.Title,
      formula: p.MolecularFormula,
      weight: p.MolecularWeight,
      iupac: p.IUPACName,
      url: 'https://pubchem.ncbi.nlm.nih.gov/compound/' + p.CID,
      disclaimer:
        'PubChem identifies chemical substances. It is not a product authenticity or regulatory approval check.'
    };
  } catch {
    return null;
  }
}

function intelligenceMatrixPayload() {
  return {
    success: true,
    engine: 'TrueMark Global Product Intelligence',
    version: VERSION,
    sources: [
      { id: 'open_food_facts', status: 'live', access: 'public_api', categories: ['food'] },
      { id: 'open_beauty_facts', status: 'live', access: 'public_api', categories: ['beauty'] },
      { id: 'open_products_facts', status: 'live', access: 'public_api', categories: ['general'] },
      { id: 'open_pet_food_facts', status: 'live', access: 'public_api', categories: ['pet'] },
      { id: 'upcitemdb', status: 'live', access: 'public_api_optional_key', categories: ['general'] },
      { id: 'gs1_digital_link', status: 'live_informational', access: 'resolver', categories: ['gtin'] },
      { id: 'openfda', status: 'live', access: 'public_api', categories: ['drugs', 'recalls'] },
      { id: 'usda_fdc', status: 'live_if_key', access: 'api_key', env: 'USDA_FDC_API_KEY', categories: ['food'] },
      { id: 'pubchem', status: 'live', access: 'public_api', categories: ['ingredients'] },
      { id: 'nafdac_portals', status: 'guidance_links', access: 'portal', categories: ['ng_regulated'] },
      { id: 'son_portals', status: 'pending_partnership', access: 'portal', categories: ['ng_standards'] },
      { id: 'ncc_device', status: 'pending', access: 'portal', categories: ['telecom'] },
      { id: 'who_sf_alerts', status: 'link_intelligence', access: 'web', categories: ['medicines'] },
      { id: 'eu_safety_gate', status: 'pending', access: 'web', categories: ['nonfood'] },
      { id: 'paystack', status: 'live', access: 'secret', categories: ['billing'] }
    ],
    principles: [
      'Catalogue match is not physical authenticity',
      'Paid manufacturer plans cannot buy verification outcomes',
      'Unknown product is not classified as counterfeit',
      'One source failure must not block other sources'
    ]
  };
}

async function intelligenceIngredientRoute(request, env) {
  const body = await readJson(request);
  const name = clean(body.name || body.ingredient || body.query, 120);
  if (!name) {
    return jsonResponse({ success: false, error: 'Ingredient name required' }, 400);
  }
  const result = await lookupPubChemCompound(name);
  if (!result) {
    return jsonResponse({
      success: true,
      found: false,
      message: 'No PubChem compound matched this name.',
      query: name
    });
  }
  return jsonResponse({ success: true, found: true, compound: result });
}

async function ensureCommunityTable(db) {
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS community_submissions (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      barcode TEXT NOT NULL DEFAULT '',
      product_name TEXT NOT NULL DEFAULT '',
      brand TEXT NOT NULL DEFAULT '',
      manufacturer TEXT NOT NULL DEFAULT '',
      category TEXT NOT NULL DEFAULT '',
      nafdac_number TEXT NOT NULL DEFAULT '',
      notes TEXT NOT NULL DEFAULT '',
      image_meta TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      reviewer_note TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      reviewed_at TEXT
    )
  `).run();
  await db.prepare(
    'CREATE INDEX IF NOT EXISTS idx_community_status ON community_submissions(status)'
  ).run();
}

async function communitySubmitRoute(request, env) {
  const body = await readJson(request);
  const db = requireDatabase(env);
  await ensureCommunityTable(db);
  let userId = null;
  try {
    const user = await getUserFromAuthHeader(request, env);
    if (user) userId = user.id;
  } catch (_) {}

  const product_name = clean(body.product_name || body.name, 240);
  const barcode = clean(body.barcode, 80);
  if (!product_name && !barcode) {
    return jsonResponse({
      success: false,
      error: 'Provide at least a product name or barcode.'
    }, 400);
  }

  const id = crypto.randomUUID();
  const now = isoNow();
  await db.prepare(`
    INSERT INTO community_submissions (
      id, user_id, barcode, product_name, brand, manufacturer, category,
      nafdac_number, notes, image_meta, status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
  `).bind(
    id,
    userId,
    barcode,
    product_name,
    clean(body.brand, 160),
    clean(body.manufacturer, 160),
    clean(body.category, 120),
    clean(body.nafdac_number, 80),
    clean(body.notes, 1000),
    clean(body.image_meta, 500),
    now
  ).run();

  return jsonResponse({
    success: true,
    submission_id: id,
    status: 'pending',
    disclaimer:
      'Community submissions enter a review queue. They are not verified, genuine, or regulator-approved until independently reviewed.'
  });
}

async function adminCommunityListRoute(request, env) {
  await requireAdmin(request, env);
  const db = requireDatabase(env);
  await ensureCommunityTable(db);
  const { results } = await db.prepare(
    `SELECT * FROM community_submissions ORDER BY created_at DESC LIMIT 100`
  ).all();
  return jsonResponse({ success: true, submissions: results || [] });
}

async function adminCommunityReviewRoute(request, env) {
  const admin = await requireAdmin(request, env);
  const body = await readJson(request);
  const id = clean(body.id || body.submission_id, 80);
  const status = clean(body.status, 20);
  if (!['approved', 'rejected', 'pending'].includes(status)) {
    return jsonResponse({ success: false, error: 'Invalid status' }, 400);
  }
  const db = requireDatabase(env);
  await ensureCommunityTable(db);
  const now = isoNow();
  await db.prepare(`
    UPDATE community_submissions
    SET status = ?, reviewer_note = ?, reviewed_at = ?
    WHERE id = ?
  `).bind(status, clean(body.note, 500), now, id).run();

  // If approved with enough data, upsert into products as user_submitted provenance
  if (status === 'approved') {
    const row = await db.prepare(
      'SELECT * FROM community_submissions WHERE id = ?'
    ).bind(id).first();
    if (row && (row.product_name || row.barcode)) {
      await upsertProduct(
        db,
        {
          name: row.product_name || 'Community product',
          brand: row.brand || '',
          manufacturer: row.manufacturer || '',
          category: row.category || 'Other',
          description: row.notes || '',
          image_url: '',
          country_of_origin: '',
          barcode: row.barcode || '',
          quantity: '',
          confidence: 'user_submitted'
        },
        row.barcode
          ? [{ type: 'barcode', value: row.barcode, source: 'community' }]
          : [],
        {
          key: 'community',
          name: 'Community submission (approved)',
          url: '',
          type: 'user_submitted',
          evidence: { submission_id: id, reviewer: admin.id }
        }
      );
    }
  }

  return jsonResponse({ success: true });
}

async function enrichWithOptionalSources(product, env, barcode) {
  const extra = { usda: null, pubchem_hint: null, who_guidance: null };
  try {
    if (product?.name || barcode) {
      extra.usda = await lookupUsdaFdc(product?.name || '', env, barcode || product?.barcode);
    }
  } catch (_) {}
  try {
    // Single-ingredient hint only when description looks like a pure ingredient line
    const ing = clean(product?.description || '', 80).split(',')[0];
    if (ing && ing.length >= 4 && ing.length <= 40 && !/\d{6,}/.test(ing)) {
      extra.pubchem_hint = await lookupPubChemCompound(ing);
    }
  } catch (_) {}
  extra.who_guidance = {
    name: 'WHO Medical Product Alerts',
    url: 'https://www.who.int/teams/regulation-prequalification/incidents-and-SF/full-list-of-who-medical-product-alerts',
    note: 'Check manually for substandard/falsified medicine alerts related to this product class. Not an automated match.'
  };
  return extra;
}


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
      features: ['product_remove', 'business_portal', 'manufacturer_images'],
      routes_hint: {
        business_remove: 'POST /business/products/remove',
        admin_remove: 'POST /admin/products/remove'
      },
      timestamp: isoNow()
    });
  }


  // Early product-remove routes (must work even if later B2B block fails to reach)
  if (path === '/business/products/remove' && method === 'POST') {
    try { return await removeBusinessProductRoute(request, env); }
    catch (e) {
      if (String(errorMessage(e)).includes('AUTH')) return jsonResponse({ success: false, error: 'Sign in required' }, 401);
      return jsonResponse({ success: false, error: errorMessage(e) }, 400);
    }
  }
  if (path === '/admin/products/remove' && method === 'POST') {
    try { return await adminRemoveProductRoute(request, env); }
    catch (e) {
      if (String(errorMessage(e)).includes('ADMIN')) return jsonResponse({ success: false, error: 'Admin only' }, 403);
      if (String(errorMessage(e)).includes('AUTH')) return jsonResponse({ success: false, error: 'Sign in required' }, 401);
      return jsonResponse({ success: false, error: errorMessage(e) }, 400);
    }
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

  // Manufacturer / catalogue product image (binary)
  const imageMatch = path.match(/^\/products\/([^/]+)\/image$/);
  if (imageMatch && method === 'GET') {
    return serveProductImage(decodeURIComponent(imageMatch[1]), env);
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

  
  // ---- B2B / billing / admin ----
  if (path === '/business/plans' && method === 'GET') {
    return listPlansRoute(env);
  }
  if (path === '/business/register' && method === 'POST') {
    try { return await registerBusinessRoute(request, env); }
    catch (e) {
      if (errorMessage(e) === 'AUTH_REQUIRED') return jsonResponse({ success: false, error: 'Sign in required' }, 401);
      throw e;
    }
  }
  if (path === '/business/me' && method === 'GET') {
    try { return await myBusinessRoute(request, env); }
    catch (e) {
      if (errorMessage(e) === 'AUTH_REQUIRED') return jsonResponse({ success: false, error: 'Sign in required' }, 401);
      throw e;
    }
  }
  if (path === '/business/products' && method === 'POST') {
    try { return await addBusinessProductRoute(request, env); }
    catch (e) {
      if (String(errorMessage(e)).includes('AUTH')) return jsonResponse({ success: false, error: 'Sign in required' }, 401);
      return jsonResponse({ success: false, error: errorMessage(e) }, 400);
    }
  }

  if (path === '/business/products/remove' && method === 'POST') {
    try { return await removeBusinessProductRoute(request, env); }
    catch (e) {
      if (errorMessage(e) === 'AUTH_REQUIRED') return jsonResponse({ success: false, error: 'Sign in required' }, 401);
      throw e;
    }
  }
  if (path === '/business/checkout' && method === 'POST') {
    try { return await initiatePaystackPaymentRoute(request, env); }
    catch (e) {
      if (errorMessage(e) === 'AUTH_REQUIRED') return jsonResponse({ success: false, error: 'Sign in required' }, 401);
      throw e;
    }
  }
  if (path === '/business/verify-payment' && method === 'POST') {
    try { return await verifyPaymentRoute(request, env); }
    catch (e) {
      if (errorMessage(e) === 'AUTH_REQUIRED') return jsonResponse({ success: false, error: 'Sign in required' }, 401);
      throw e;
    }
  }
  if (path === '/business/auth-codes' && method === 'POST') {
    try { return await issueAuthCodesRoute(request, env); }
    catch (e) {
      if (errorMessage(e) === 'AUTH_REQUIRED') return jsonResponse({ success: false, error: 'Sign in required' }, 401);
      throw e;
    }
  }
  if (path === '/verify/auth-code' && method === 'POST') {
    return verifyAuthCodeRoute(request, env);
  }
  if (path === '/webhooks/paystack' && method === 'POST') {
    return paystackWebhookRoute(request, env);
  }
  if (path === '/admin/products/remove' && method === 'POST') {
    try { return await adminRemoveProductRoute(request, env); }
    catch (e) {
      if (String(errorMessage(e)).includes('ADMIN')) return jsonResponse({ success: false, error: 'Admin only' }, 403);
      if (String(errorMessage(e)).includes('AUTH')) return jsonResponse({ success: false, error: 'Sign in required' }, 401);
      return jsonResponse({ success: false, error: errorMessage(e) }, 400);
    }
  }

  if (path === '/admin/businesses' && method === 'GET') {
    try { return await adminListBusinessesRoute(request, env); }
    catch (e) {
      if (String(errorMessage(e)).includes('ADMIN')) return jsonResponse({ success: false, error: 'Admin only' }, 403);
      if (errorMessage(e) === 'AUTH_REQUIRED') return jsonResponse({ success: false, error: 'Sign in required' }, 401);
      throw e;
    }
  }
  if (path === '/admin/businesses/status' && method === 'POST') {
    try { return await adminSetBusinessStatusRoute(request, env); }
    catch (e) {
      if (String(errorMessage(e)).includes('ADMIN')) return jsonResponse({ success: false, error: 'Admin only' }, 403);
      if (errorMessage(e) === 'AUTH_REQUIRED') return jsonResponse({ success: false, error: 'Sign in required' }, 401);
      throw e;
    }
  }
  if (path === '/admin/plans' && method === 'POST') {
    try { return await adminUpdatePlanRoute(request, env); }
    catch (e) {
      if (String(errorMessage(e)).includes('ADMIN')) return jsonResponse({ success: false, error: 'Admin only' }, 403);
      if (errorMessage(e) === 'AUTH_REQUIRED') return jsonResponse({ success: false, error: 'Sign in required' }, 401);
      throw e;
    }
  }
  
  if (path === '/admin/session' && method === 'GET') {
    const user = await getUserFromAuthHeader(request, env);
    if (!user) {
      return jsonResponse({ success: false, error: 'Sign in required', is_admin: false }, 401);
    }
    const fromEnv = adminIdsFromEnv(env);
    let isAdmin = fromEnv.includes(user.id);
    if (!isAdmin) {
      try { isAdmin = await isPlatformAdmin(user.id, env); } catch (_) { isAdmin = false; }
    }
    return jsonResponse({
      success: true,
      is_admin: !!isAdmin,
      user: { id: user.id, email: user.email, display_name: user.display_name || '' },
      admin_url: isAdmin ? 'https://eddysparkle.github.io/Truemark/admin.html' : null
    });
  }


  if (path === '/admin/stats' && method === 'GET') {
    try { return await adminStatsRoute(request, env); }
    catch (e) {
      if (String(errorMessage(e)).includes('ADMIN')) return jsonResponse({ success: false, error: 'Admin only' }, 403);
      if (errorMessage(e) === 'AUTH_REQUIRED') return jsonResponse({ success: false, error: 'Sign in required' }, 401);
      throw e;
    }
  }


  
  if (path === '/intelligence/matrix' && method === 'GET') {
    return jsonResponse(intelligenceMatrixPayload());
  }
  if (path === '/intelligence/ingredient' && method === 'POST') {
    return intelligenceIngredientRoute(request, env);
  }
  if (path === '/community/submit' && method === 'POST') {
    return communitySubmitRoute(request, env);
  }
  if (path === '/admin/community' && method === 'GET') {
    try { return await adminCommunityListRoute(request, env); }
    catch (e) {
      if (String(errorMessage(e)).includes('ADMIN')) return jsonResponse({ success: false, error: 'Admin only' }, 403);
      if (errorMessage(e) === 'AUTH_REQUIRED') return jsonResponse({ success: false, error: 'Sign in required' }, 401);
      throw e;
    }
  }
  if (path === '/admin/community/review' && method === 'POST') {
    try { return await adminCommunityReviewRoute(request, env); }
    catch (e) {
      if (String(errorMessage(e)).includes('ADMIN')) return jsonResponse({ success: false, error: 'Admin only' }, 403);
      if (errorMessage(e) === 'AUTH_REQUIRED') return jsonResponse({ success: false, error: 'Sign in required' }, 401);
      throw e;
    }
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

