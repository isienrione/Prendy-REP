### README_catalog_v4.md

# Party Planning Catalog v4 - JSON API Documentation

## Overview

This JSON catalog contains **116 catering products** from 3 premium Santiago caterers, structured for easy querying and filtering in your party planning application.

## File Structure

```json
{
  "version": "v4",
  "lastUpdated": "2026-02-19",
  "currency": "CLP",
  "stores": [ /* 4 store objects */ ],
  "items": [ /* 116 product objects */ ]
}
```

## Data Schemas

### Store Object

```typescript
{
  id: string;              // "novoandina", "cafediario", "manungo", "aperitivo"
  name: string;            // Display name
  url: string;             // Website URL
  type: string;            // "caterer" or "gourmet_store"
  locations: string[];     // ["Santiago"]
  notes: string;           // Description of what they specialize in
}
```

### Item Object

```typescript
{
  id: string;              // Unique slug: "novoandina-mini-sandwich-ave-palta-12"
  storeId: string;         // References store.id
  name: string;            // Display name
  category: string;        // See categories below
  role: string;            // More specific classification
  qualityTier: string;     // "budget", "standard", "premium"
  format: {
    unitType: string;      // "units", "person", "servings", "weight"
    quantity: number;      // How many units/servings
  };
  price: {
    amount: number | null; // Price in CLP
    currency: string;      // "CLP"
    basis: string;         // "per_box", "per_person", "per_pack", "per_unit"
  };
  tags: string[];          // ["chicken", "avocado", "gourmet"]
  useCases: string[];      // ["adult_birthday_home", "networking_venue"]
  source: string;          // Original store URL
}
```

## Categories & Roles

### Categories
- **finger_food** - Mini sandwiches, croissants, quiches, brochetas
- **brunch_box** - Complete brunch/breakfast boxes
- **catering_pack** - Full catering solutions (cocktail packs, mesas)
- **main_prepared** - Ready-to-eat main dishes
- **main_delivery** - Sandwiches, tacos, hamburgers for big parties
- **dessert** - Sweets, tartaletas, profiteroles, macarons
- **side** - Salads and side dishes
- **pantry** - Dips and spreads
- **cheese** - Cheeses (for future Aperitivo integration)

### Roles (examples)
- **mini_sandwich** - Mini sandwiches
- **mini_croissant** - Mini croissants
- **brunch_individual** - Single-person brunch
- **brunch_sharing** - Brunch for 2+
- **cocktail_dinner** - Complete cocktail pack that replaces dinner
- **mesa_catering** - Per-person catering mesa
- **sandwich_pack** - Bulk sandwich packs
- **individual_meal** - Single ready-to-eat meal

## Quality Tiers

- **budget** ($2,000-$6,000 per item/person) - Mañungo sandwiches, basic items
- **standard** ($6,000-$15,000) - Most Novoandina/Café Diario items
- **premium** ($15,000+) - Gourmet items, complete cocktail packs

## Use Cases

Tag each item with scenario compatibility:
- **adult_birthday_home** - Adult birthday at home
- **big_home_party** - Large informal home party (30+ people)
- **office_farewell_venue** - Office farewell/corporate event
- **networking_venue** - Professional networking event
- **family_lunch_bbq_home** - Family lunch or BBQ

## Query Examples

### 1. Get all items from Novoandina
```javascript
const novoandina = catalog.items.filter(i => i.storeId === 'novoandina');
```

### 2. Get finger food for adult birthday under $20,000
```javascript
const fingerFood = catalog.items.filter(i => 
  i.category === 'finger_food' &&
  i.useCases.includes('adult_birthday_home') &&
  i.price.amount && i.price.amount <= 20000
);
```

### 3. Get budget tier main meals for big parties
```javascript
const budgetMains = catalog.items.filter(i =>
  i.category === 'main_delivery' &&
  i.qualityTier === 'budget' &&
  i.useCases.includes('big_home_party')
);
```

### 4. Get per-person catering items
```javascript
const perPerson = catalog.items.filter(i =>
  i.format.unitType === 'person' ||
  i.price.basis === 'per_person'
);
```

### 5. Get all brunch options for 1-2 people
```javascript
const brunch = catalog.items.filter(i =>
  i.category === 'brunch_box' &&
  (i.role === 'brunch_individual' || i.role === 'brunch_sharing')
);
```

### 6. Get premium seafood items
```javascript
const seafood = catalog.items.filter(i =>
  i.tags.includes('seafood') &&
  i.qualityTier === 'premium'
);
```

### 7. Calculate total cost for event
```javascript
// Example: 15 people, Novoandina cocktail pack + drinks
const picoteo = catalog.items.find(i => 
  i.id === 'novoandina-picoteo-celebremos-para-15-15'
);
const totalCost = picoteo.price.amount; // 260,900 CLP
const perPerson = totalCost / 15; // ~17,393 CLP per person
```

## Price Calculation Patterns

### For per_box/per_pack items:
```javascript
// Mini sandwiches: 12 units for $14,900
const pricePerUnit = item.price.amount / item.format.quantity;
// = $1,242 per sandwich
```

### For per_person items:
```javascript
// Mesa Festín: $14,900 per person
const totalFor20People = item.price.amount * 20;
// = $298,000 for 20 people
```

### For bulk packs:
```javascript
// Pack 40 mechadas: $115,000
const savings = (item.price.amount / 40) < individualPrice;
// Check if bulk rate is better
```

## Integration with Planning Engine

### Scenario-Based Routing

```javascript
function recommendCaterer(scenario) {
  if (scenario.time === 'morning' || scenario.meal === 'brunch') {
    return catalog.items.filter(i => i.storeId === 'cafediario');
  }

  if (scenario.guests >= 30 && scenario.budget === 'low') {
    return catalog.items.filter(i => i.storeId === 'manungo');
  }

  if (scenario.style === 'cocktail' && scenario.cooking === 'zero') {
    return catalog.items.filter(i => 
      i.storeId === 'novoandina' &&
      i.role === 'cocktail_dinner'
    );
  }
}
```

### Budget Calculation

```javascript
function calculateEventCost(guests, tier = 'standard') {
  const tierFilters = {
    budget: { min: 4000, max: 7000 },
    standard: { min: 8000, max: 12000 },
    premium: { min: 15000, max: 40000 }
  };

  const range = tierFilters[tier];
  return {
    min: guests * range.min,
    max: guests * range.max
  };
}

// Example: 20 people, standard tier
const cost = calculateEventCost(20, 'standard');
// { min: 160000, max: 240000 } CLP
```

## Stores Summary

| Store | Items | Focus | Price Range/Person |
|-------|-------|-------|-------------------|
| Novoandina | 32 | Fancy cocktail dinners, mini sandwiches | $15,000-$40,000 |
| Café Diario | 61 | Brunch, coffee break, networking | $8,000-$25,000 |
| Mañungo | 23 | Big party main meals, sandwiches | $4,000-$7,000 |

## Next Steps

1. **Add Aperitivo items** (161 products: cheeses, charcuterie, wines) to complete gourmet supplement options
2. **Add supermarket items** from Jumbo/Lider for ingredient-based planning
3. **Create composite scenarios** combining multiple caterers (e.g., Novoandina finger food + Café Diario desserts)
4. **Build price optimization** algorithms to find best value combinations

## File Info

- **Format**: JSON
- **Encoding**: UTF-8
- **Size**: ~49 KB
- **Items**: 116 products
- **Stores**: 4 (3 active)
- **Version**: v4
- **Last Updated**: 2026-02-19

---

For questions or updates, refer to the original Excel file: `Party_Planning_Database_v4_Caterers.xlsx`
