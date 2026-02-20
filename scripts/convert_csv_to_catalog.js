import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import csv from "csv-parser";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Input CSV (400+ items)
const csvPath = path.join(__dirname, "..", "data", "party_all_items_v4.csv");

// Outputs
const prendyOutPath = path.join(__dirname, "..", "data", "prendy_catalog_v4.json");
const partyOutPath = path.join(__dirname, "..", "data", "party_catalog_v4.json");

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

function rowToCatalogItem(row, index) {
  return {
    id: row.id || row.ID || `item-${index + 1}`,
    // Use your CSV headers
    name: row["Product Name"] || "",
    description: row["Use Cases"] || "",  // simple description from use cases
    category: row["Category"] || row.category || "",
    subcategory: row["Role"] || row.role || "",
    price: row["Price (CLP)"] ? Number(row["Price (CLP)"]) : null,
    vendorName: row["Store"] || row.store || "",
    venueName: "",
    serviceType: row["Section"] || "",
    tags: (row["Tags"] || "")
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean),
  };
}

async function main() {
  try {
    const rows = await loadCsvAsJson(csvPath);
    const items = rows.map((row, i) => rowToCatalogItem(row, i));

    // Flat Prendy catalog (for AI / bulk use)
    fs.writeFileSync(prendyOutPath, JSON.stringify(items, null, 2), "utf8");

    // Structured Party catalog (used by frontend)
    const partyCatalog = {
      version: "4.0",
      currency: "CLP",
      stores: [
        {
          id: "global",
          name: "Global party catalog v4",
          locations: ["Santiago"],
          notes: "Unified catalog generated from party_all_items_v4.csv",
          items
        }
      ]
    };

    fs.writeFileSync(partyOutPath, JSON.stringify(partyCatalog, null, 2), "utf8");

    console.log(`✅ Saved ${prendyOutPath} with ${items.length} items`);
    console.log(`✅ Saved ${partyOutPath} with ${items.length} items in stores[0].items`);
  } catch (err) {
    console.error("Error converting CSV to catalogs:", err);
    process.exit(1);
  }
}

main();
