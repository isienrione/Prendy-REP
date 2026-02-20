import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import csv from "csv-parser";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Paths
const csvPath = path.join(__dirname, "..", "data", "party_all_items_v4.csv");
const outPath = path.join(__dirname, "..", "data", "prendy_catalog_v4.json");

function loadCsvAsJson(csvFilePath) {
  return new Promise((resolve, reject) => {
    const rows = [];
    fs.createReadStream(csvFilePath)
      .pipe(csv())
      .on("data", (row) => rows.push(row))
      .on("end", () => resolve(rows))
      .on("error", (err) => reject(err));
  });
}

function rowToCatalogItem(row) {
  return {
    id: row.id || row.ID || "",
    name: row.name || row.Name || "",
    description: row.description || row.Description || "",
    category: row.category || row.Category || "",
    subcategory: row.subcategory || row.Subcategory || "",
    price: row.price ? Number(row.price) : null,
    vendorName: row.vendorName || row.VendorName || "",
    venueName: row.venueName || row.VenueName || "",
    serviceType: row.serviceType || row.ServiceType || "",
    tags: (row.tags || row.Tags || "")
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean),
  };
}

async function main() {
  try {
    const rows = await loadCsvAsJson(csvPath);
    const items = rows.map(rowToCatalogItem);

    fs.writeFileSync(outPath, JSON.stringify(items, null, 2), "utf8");
    console.log(`✅ Saved ${outPath} with ${items.length} items`);
  } catch (err) {
    console.error("Error converting CSV to catalog JSON:", err);
    process.exit(1);
  }
}

main();
