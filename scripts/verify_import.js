#!/usr/bin/env node
/**
 * Verify the Firestore import against the parser's expected output.
 *
 * Usage:
 *   SERVICE_ACCOUNT_PATH=/path/to/serviceAccountKey.json node scripts/verify_import.js
 */

// firebase-admin v14 only ships the modular API; the legacy
// admin.credential/admin.firestore namespace no longer exists.
const { initializeApp, cert } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");

// Expected values from the scripts/parse_inventory.py summary.
const EXPECTED_TYPES = 1349;
const EXPECTED_UNITS = 21377;

if (!process.env.SERVICE_ACCOUNT_PATH) {
  console.error(
    "Error: SERVICE_ACCOUNT_PATH is not set.\n" +
      "Run with:\n" +
      "  SERVICE_ACCOUNT_PATH=/path/to/serviceAccountKey.json node scripts/verify_import.js"
  );
  process.exit(1);
}

const serviceAccount = require(process.env.SERVICE_ACCOUNT_PATH);

initializeApp({
  credential: cert(serviceAccount),
  projectId: "skyline-eos",
});

const db = getFirestore();

async function main() {
  const discrepancies = [];

  // ---- Totals (server-side aggregate counts, no document reads) ----
  const [typeCountSnap, unitCountSnap] = await Promise.all([
    db.collection("equipmentTypes").count().get(),
    db.collection("equipmentUnits").count().get(),
  ]);
  const typeCount = typeCountSnap.data().count;
  const unitCount = unitCountSnap.data().count;

  console.log("=".repeat(60));
  console.log("TOTALS");
  console.log("=".repeat(60));
  console.log(`equipmentTypes: ${typeCount} (expected ${EXPECTED_TYPES})`);
  console.log(`equipmentUnits: ${unitCount} (expected ${EXPECTED_UNITS})`);
  if (typeCount !== EXPECTED_TYPES) {
    discrepancies.push(
      `equipmentTypes count is ${typeCount}, expected ${EXPECTED_TYPES} (diff ${typeCount - EXPECTED_TYPES})`
    );
  }
  if (unitCount !== EXPECTED_UNITS) {
    discrepancies.push(
      `equipmentUnits count is ${unitCount}, expected ${EXPECTED_UNITS} (diff ${unitCount - EXPECTED_UNITS})`
    );
  }

  // ---- Units per room + top types (one projected scan) ----
  const unitsSnap = await db
    .collection("equipmentUnits")
    .select("typeName", "homeRoom")
    .get();

  const perRoom = new Map();
  const perType = new Map();
  for (const d of unitsSnap.docs) {
    const room = d.get("homeRoom");
    const type = d.get("typeName");
    perRoom.set(room, (perRoom.get(room) || 0) + 1);
    perType.set(type, (perType.get(type) || 0) + 1);
  }

  console.log("\n" + "=".repeat(60));
  console.log("UNITS PER ROOM");
  console.log("=".repeat(60));
  for (const room of [...perRoom.keys()].sort()) {
    console.log(`  ${room}: ${perRoom.get(room)}`);
  }

  console.log("\n" + "=".repeat(60));
  console.log("TOP 20 EQUIPMENT TYPES BY UNIT COUNT");
  console.log("=".repeat(60));
  const top20 = [...perType.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20);
  for (const [name, n] of top20) {
    console.log(`  ${String(n).padStart(6)}  ${name}`);
  }

  // ---- Spot check 5 random equipmentType documents ----
  const typeIdsSnap = await db.collection("equipmentTypes").select().get();
  const ids = typeIdsSnap.docs.map((d) => d.id);
  const sampleIds = [];
  while (sampleIds.length < Math.min(5, ids.length)) {
    const id = ids[Math.floor(Math.random() * ids.length)];
    if (!sampleIds.includes(id)) sampleIds.push(id);
  }

  console.log("\n" + "=".repeat(60));
  console.log("SPOT CHECK: 5 RANDOM equipmentType DOCUMENTS");
  console.log("=".repeat(60));
  for (const id of sampleIds) {
    const doc = await db.collection("equipmentTypes").doc(id).get();
    const data = doc.data();
    console.log(`\n  ${doc.id}`);
    for (const [field, value] of Object.entries(data)) {
      const printable =
        value && typeof value.toDate === "function" ? value.toDate().toISOString() : JSON.stringify(value);
      console.log(`    ${field}: ${printable}`);
    }
    for (const required of ["name", "section", "category", "createdAt"]) {
      if (!(required in data)) {
        discrepancies.push(`equipmentType ${doc.id} is missing field '${required}'`);
      }
    }
  }

  // ---- Verdict ----
  console.log("\n" + "=".repeat(60));
  console.log("VERIFICATION RESULT");
  console.log("=".repeat(60));
  if (discrepancies.length === 0) {
    console.log("PASS — all counts match expected values.");
  } else {
    console.log(`FAIL — ${discrepancies.length} discrepancy(ies):`);
    discrepancies.forEach((d) => console.log(`  - ${d}`));
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("Verification failed:", err);
  process.exit(1);
});
