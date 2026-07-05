#!/usr/bin/env node
/**
 * Import data/equipmentTypes.json and data/equipmentUnits.json into Firestore.
 *
 * Idempotent: safe to run multiple times.
 * - equipmentTypes: skipped if a document with the same name already exists.
 * - equipmentUnits: deduplicated by (typeName, homeRoom). For each combination
 *   we only write the difference between the expected unit count and what is
 *   already in Firestore, so a partially-failed run is topped up on the next
 *   run instead of being skipped or duplicated.
 *
 * Existing documents are discovered with paginated, projected scans: each page
 * is an independent request with a timeout and retries, and progress is logged
 * per page (one giant get() can stall silently on a bad gRPC stream).
 *
 * Usage:
 *   SERVICE_ACCOUNT_PATH=/path/to/key.json node scripts/import_to_firestore.js [--units-only]
 *
 * --units-only  Skip the equipmentTypes dedup/import phase. Only the
 *               lightweight name -> document ID map is fetched (new units
 *               still need typeId), then equipmentUnits are scanned and
 *               topped up as usual.
 */

const path = require("path");
const fs = require("fs");
// firebase-admin v14 only ships the modular API; the legacy
// admin.credential/admin.firestore namespace no longer exists.
const { initializeApp, cert } = require("firebase-admin/app");
const { getFirestore, FieldValue, FieldPath } = require("firebase-admin/firestore");

const BATCH_SIZE = 400; // Firestore max is 500; stay under it.
const SCAN_PAGE_SIZE = 2000;
const SCAN_TIMEOUT_MS = 60_000;
const SCAN_ATTEMPTS = 3;
const DATA_DIR = path.join(__dirname, "..", "data");

const UNITS_ONLY = process.argv.includes("--units-only");

if (!process.env.SERVICE_ACCOUNT_PATH) {
  console.error(
    "Error: SERVICE_ACCOUNT_PATH is not set.\n" +
      "Run with:\n" +
      "  SERVICE_ACCOUNT_PATH=/path/to/serviceAccountKey.json node scripts/import_to_firestore.js"
  );
  process.exit(1);
}

const serviceAccount = require(process.env.SERVICE_ACCOUNT_PATH);

initializeApp({
  credential: cert(serviceAccount),
  projectId: "skyline-eos",
});

const db = getFirestore();
// REST transport instead of gRPC — gRPC streams are the usual culprit when
// large collection reads hang silently.
db.settings({ preferRest: true });

function loadJson(filename) {
  const filePath = path.join(DATA_DIR, filename);
  if (!fs.existsSync(filePath)) {
    console.error(`Error: ${filePath} not found. Run scripts/parse_inventory.py first.`);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

const unitKey = (u) => `${u.typeName}|||${u.homeRoom}`;

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms / 1000}s`)),
      ms
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Page through a collection with a field projection, invoking onDoc per doc.
 * Each page has its own timeout and retries so a stalled request is retried
 * (and reported) instead of hanging the whole run.
 */
async function scanCollection(collectionName, fields, onDoc) {
  console.log(`Scanning existing ${collectionName} (pages of ${SCAN_PAGE_SIZE})...`);
  const started = Date.now();
  let lastDoc = null;
  let scanned = 0;
  let page = 1;

  for (;;) {
    let query = db
      .collection(collectionName)
      .orderBy(FieldPath.documentId())
      .select(...fields)
      .limit(SCAN_PAGE_SIZE);
    if (lastDoc) query = query.startAfter(lastDoc);

    let snap;
    for (let attempt = 1; ; attempt++) {
      try {
        snap = await withTimeout(
          query.get(),
          SCAN_TIMEOUT_MS,
          `[${collectionName}] scan page ${page}`
        );
        break;
      } catch (err) {
        if (attempt >= SCAN_ATTEMPTS) {
          throw new Error(
            `[${collectionName}] scan page ${page} failed after ${SCAN_ATTEMPTS} attempts: ${err.message}`
          );
        }
        console.warn(
          `  [${collectionName}] scan page ${page} attempt ${attempt} failed ` +
            `(${err.message}) — retrying...`
        );
      }
    }

    if (snap.empty) break;
    snap.docs.forEach(onDoc);
    scanned += snap.size;
    lastDoc = snap.docs[snap.docs.length - 1];
    console.log(
      `  [${collectionName}] scanned ${scanned} docs ` +
        `(page ${page}, ${((Date.now() - started) / 1000).toFixed(1)}s elapsed)`
    );
    if (snap.size < SCAN_PAGE_SIZE) break;
    page++;
  }

  console.log(
    `  [${collectionName}] scan complete: ${scanned} docs in ` +
      `${((Date.now() - started) / 1000).toFixed(1)}s`
  );
  return scanned;
}

async function commitBatches(collectionName, writes) {
  // writes: array of { ref, data }
  const totalBatches = Math.ceil(writes.length / BATCH_SIZE);
  for (let i = 0; i < writes.length; i += BATCH_SIZE) {
    const batch = db.batch();
    for (const { ref, data } of writes.slice(i, i + BATCH_SIZE)) {
      batch.set(ref, data);
    }
    await batch.commit();
    console.log(
      `  [${collectionName}] batch ${Math.floor(i / BATCH_SIZE) + 1}/${totalBatches} committed ` +
        `(${Math.min(i + BATCH_SIZE, writes.length)}/${writes.length} docs)`
    );
  }
}

async function main() {
  const types = loadJson("equipmentTypes.json");
  const units = loadJson("equipmentUnits.json");
  const errors = [];

  // ---- equipmentTypes ----
  // Even with --units-only we need name -> document ID, because every new
  // unit document stores a typeId. This is a single small page (~1,349 docs).
  const typeIdByName = new Map();
  if (UNITS_ONLY) {
    console.log("--units-only: skipping equipmentTypes import, fetching type ID map only.");
  }
  await scanCollection("equipmentTypes", ["name"], (d) =>
    typeIdByName.set(d.get("name"), d.id)
  );

  let typeWrites = [];
  let skippedTypes = 0;
  if (!UNITS_ONLY) {
    for (const t of types) {
      if (typeIdByName.has(t.name)) {
        console.log(`skipped: ${t.name}`);
        skippedTypes++;
        continue;
      }
      const ref = db.collection("equipmentTypes").doc();
      typeIdByName.set(t.name, ref.id);
      typeWrites.push({
        ref,
        data: { ...t, createdAt: FieldValue.serverTimestamp() },
      });
    }
    console.log(`\nWriting ${typeWrites.length} new equipmentTypes (${skippedTypes} skipped)...`);
    await commitBatches("equipmentTypes", typeWrites);
  }

  // ---- equipmentUnits ----
  console.log("");
  const existingCounts = new Map();
  await scanCollection("equipmentUnits", ["typeName", "homeRoom"], (d) => {
    const key = unitKey({ typeName: d.get("typeName"), homeRoom: d.get("homeRoom") });
    existingCounts.set(key, (existingCounts.get(key) || 0) + 1);
  });

  // Group expected units by (typeName, homeRoom).
  const expectedByKey = new Map();
  for (const u of units) {
    const key = unitKey(u);
    if (!expectedByKey.has(key)) expectedByKey.set(key, { sample: u, count: 0 });
    expectedByKey.get(key).count++;
  }

  const unitWrites = [];
  let skippedUnits = 0;
  for (const [key, { sample, count }] of expectedByKey) {
    if (!typeIdByName.has(sample.typeName)) {
      errors.push(`No equipmentType found for unit typeName: ${sample.typeName}`);
      continue;
    }
    const existing = existingCounts.get(key) || 0;
    const toWrite = Math.max(0, count - existing);
    if (existing > 0) {
      skippedUnits += Math.min(existing, count);
      console.log(
        `skipped: ${sample.typeName} @ ${sample.homeRoom} ` +
          `(${existing} existing${toWrite > 0 ? `, topping up ${toWrite}` : ""})`
      );
    }
    for (let i = 0; i < toWrite; i++) {
      unitWrites.push({
        ref: db.collection("equipmentUnits").doc(),
        data: { ...sample, typeId: typeIdByName.get(sample.typeName) },
      });
    }
  }

  console.log(`\nWriting ${unitWrites.length} new equipmentUnits (${skippedUnits} skipped)...`);
  await commitBatches("equipmentUnits", unitWrites);

  console.log("\n" + "=".repeat(60));
  console.log("IMPORT SUMMARY" + (UNITS_ONLY ? " (--units-only)" : ""));
  console.log("=".repeat(60));
  if (UNITS_ONLY) {
    console.log("equipmentTypes: import phase skipped");
  } else {
    console.log(`equipmentTypes written: ${typeWrites.length} (skipped ${skippedTypes})`);
  }
  console.log(`equipmentUnits written: ${unitWrites.length} (skipped ${skippedUnits})`);
  console.log(`Total documents written: ${typeWrites.length + unitWrites.length}`);
  console.log(`Errors (${errors.length}):`);
  errors.forEach((e) => console.log(`  - ${e}`));
  if (errors.length === 0) console.log("  (none)");
}

main().catch((err) => {
  console.error("Import failed:", err);
  process.exit(1);
});
