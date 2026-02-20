// scripts/convert_csv_to_catalog.js
// Convert party_all_items_v4.csv -> prendy_catalog_v4.json

import fs from 'fs';
import path from 'path';
import { parse } from 'csv-parse/sync';

const csvPath = path.join('data', 'party_all_items_v4.csv');
const csvText = fs.readFileSync(csvPath, 'utf-8');
const rows = parse(csvText, { columns: true, skip_empty_lines: true });

function slugify(str) {
  return str
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\\s-]/g, '')
    .trim()
    .replace(/\\s+/g, '-');
}

function normalizeStoreId(store) {
  const map = {
    'novoandina.cl': 'novoandina',
    'cafediario.cl': 'cafediario',
    'manungo.cl': 'manungo',
    'aperitivo.cl': 'aperitivo',
    'jumbo.cl': 'jumbo',
    'lider.cl': 'lider'
  };
  return map[store] || slugify(store || '');
}

function parseFormat(format) {
  if (!format) return { unitType: 'units', quantity: 1 };
  if (format === 'per_person') return { unitType: 'person', quantity: 1 };

  const kgMatch = String(format).match(/(\\d+(?:\\.\\d+)?)\\s*kg/i);
  if (kgMatch) {
    return { unitType: 'weight', quantity: parseFloat(kgMatch[1]) };
  }

  const num = parseInt(format, 10);
  if (!isNaN(num)) {
    return { unitType: 'units', quantity: num };
  }

  return { unitType: 'other', quantity: format };
}

const storesMap = new Map();
const items = [];

for (const row of rows) {
  const storeRaw = row['Store'] || '';
  const storeId = normalizeStoreId(storeRaw);

  if (!storesMap.has(storeId)) {
    storesMap.set(storeId, {
      id: storeId,
      name: storeRaw,
      url: '',
      type: 'vendor',
      locations: ['Santiago'],
      notes: ''
    });
  }

  const format = parseFormat(row['Format/Units']);
  const price = parseInt(row['Price (CLP)'] || '0', 10);

  const priceBasis = row['Price Basis'] || (
    format.unitType === 'person' ? 'per_person' :
    format.unitType === 'units' && format.quantity > 1 ? 'per_box' :
    'per_unit'
  );

  const name = row['Product Name'] || '';
  const id = `${storeId}-${slugify(name)}-${format.quantity || '1'}`.slice(0, 80);

  items.push({
    id,
    storeId,
    section: row['Section'] || 'catering',
    name,
    category: row['Category'] || '',
    role: row['Role'] || '',
    qualityTier: row['Quality Tier'] || 'standard',
    format,
    price: {
      amount: price || null,
      currency: 'CLP',
      basis: priceBasis
    },
    tags: (row['Tags'] || '')
      .split(',')
      .map(t => t.trim())
      .filter(Boolean),
    useCases: (row['Use Cases'] || '')
      .split(',')
      .map(u => u.trim())
      .filter(Boolean)
  });
}

const catalog = {
  version: 'v4',
  currency: 'CLP',
  stores: Array.from(storesMap.values()),
  items
};

const outPath = path.join('data', 'prendy_catalog_v4.json');
fs.writeFileSync(outPath, JSON.stringify(catalog, null, 2), 'utf-8');

console.log('✅ Saved', outPath, 'with', items.length, 'items');
