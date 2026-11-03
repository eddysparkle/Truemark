/**
 * TrueMark API — Cloudflare Workers + D1 + Workers AI
 * Version 6.0.0
 *
 * Database-first product identification and safety-information service.
 * IMPORTANT: catalogue matches are not proof of physical authenticity.
 * NAFDAC and SON are shown as unconnected unless an authorised API is configured.
 */

const VERSION = '6.0.0';
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

function makeResult(status, title, message, sources = [], extra = {}) {
  return {
    success: true,
    status,
    title,
    message,
    sources,
    checked_at: isoNow(),
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
  const barcode = clean(barcodeValue, 80);

  if (!/^[0-9A-Za-z-]{6,80}$/.test(barcode)) {
    return makeResult('needs_check', 'Barcode needs checking', 'Enter a valid barcode and try again.');
  }

  const db = requireDatabase(env);
  const existing = await getProductByBarcode(db, barcode);

  if (existing) {
    const sources = await getProductSources(db, existing.id);
    const result = makeResult(
      'catalogue_match',
      'Product found in TrueMark',
      'A previously indexed catalogue record matches this barcode. This does not authenticate the physical item.',
      sources,
      { product: existing, record_type: 'catalogue' }
    );
    await saveVerification(db, {
      product_id: existing.id,
      product_name: existing.name,
      barcode,
      category: existing.category,
      status: result.status,
      sources
    });
    return result;
  }

  const cached = await getCached(db, `barcode:${barcode}`);
  const matches = cached || await lookupAllCatalogues(barcode);

  if (!cached) {
    await putCached(db, `barcode:${barcode}`, matches, 12);
  }

  if (!matches.length) {
    const result = makeResult(
      'not_found',
      'No catalogue match found',
      'TrueMark could not find this barcode in the connected public catalogues. This does not mean the product is fake, unsafe or unregistered.'
    );
    await saveVerification(db, {
      product_name: '', barcode, category: '', status: result.status, sources: []
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

  const sources = matches.map((match) => sourceInfo(
    match.source.name,
    match.url,
    'public_catalogue'
  ));

  const result = makeResult(
    'catalogue_match',
    'Product identified',
    'A public product catalogue contains a matching barcode. Regulatory approval, safety and physical authenticity have not been established.',
    sources,
    { product, record_type: 'catalogue' }
  );

  await saveVerification(db, {
    product_id: product.id,
    product_name: product.name,
    barcode,
    category: product.category,
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
    return jsonResponse({ success: true, products: [], message: 'Enter at least two characters.' });
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
    return jsonResponse({ success: false, error: errorMessage(error) }, 400);
  }

  const prompt = [
    'You are assisting with consumer product identification.',
    'Inspect the image and extract only details that are visibly readable.',
    'Return one JSON object with these keys:',
    'product_name, brand, category, barcode, nafdac_number, batch_number, expiry_date, confidence, notes.',
    'Use empty strings for unreadable fields. Do not invent or guess numbers.',
    'Do not decide whether the item is genuine, safe, approved or counterfeit.',
    'This is identification assistance only.'
  ].join(' ');

  try {
    const response = await env.AI.run(AI_MODEL, {
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image', image: Array.from(imageBytes) }
        ]
      }],
      max_tokens: 600
    });

    const raw = response.response || response.description || '';
    const product = extractJsonObject(raw) || {
      product_name: '',
      brand: '',
      category: '',
      barcode: '',
      nafdac_number: '',
      batch_number: '',
      expiry_date: '',
      confidence: 'low',
      notes: clean(raw, 1000)
    };

    return jsonResponse({
      success: true,
      recognized: true,
      product,
      disclaimer: 'AI may misread labels. Confirm every extracted detail against the physical packaging. Recognition is not authenticity verification.'
    });
  } catch (error) {
    return jsonResponse({
      success: false,
      error: 'Image recognition is temporarily unavailable.',
      detail: errorMessage(error)
    }, 502);
  }
}
