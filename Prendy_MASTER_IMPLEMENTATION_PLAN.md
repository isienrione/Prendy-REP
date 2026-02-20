# 🧭 Prendy: AI-Driven Event Blueprint System  
## Implementation Masterplan & Reference (v2026.02)

---

## TABLE OF CONTENTS

1. [Overview & System Architecture](#overview--system-architecture)
2. [Setup: Repo, Overlays, Branches, and Preview](#setup-repo-overlays-branches-and-preview)
3. [Detailed Overlay Workflow](#detailed-overlay-workflow)  
   - Edit, Preview, Review, Promote, Tag, Version, Rollback
4. [Admin UI and n8n (Process, Recommendations, Integration)](#admin-ui-and-n8n-process-recommendations-integration)
5. [Timeline & Phase Table](#timeline--phase-table)
6. [Overlay File Format & Example](#overlay-file-format--example)
7. [Validation, Testing, and Review Checklist](#validation-testing-and-review-checklist)
8. [Common Errors & Solutions](#common-errors--solutions)
9. [Scaling, Upgrades & Future Roadmap](#scaling-upgrades--future-roadmap)
10. [SOP: Day-to-Day Operations (Summary Table)](#sop-day-to-day-operations-summary-table)
11. [Reference & Troubleshooting](#reference--troubleshooting)

---

## 1. Overview & System Architecture

- **Purpose:**  
  Build a robust, scalable, highly human-curated system for generating actionable, “buyable” event blueprints—detailed supplies, venues, recipes, all mapped to real Chilean vendors and best practices.
- **Core Components:**  
  - Github repo (code, overlays)
  - Netlify (frontend deploy & preview)
  - Per-category/scenario overlays (YAML/JSON)
  - Admin UI (invite-based, eventually multi-admin)
  - n8n instance (your server, for flow logic)
  - Optional: Blueprint API, protected backend, public user UI

---

## 2. Setup: Repo, Overlays, Branches, Preview

### A. Project Structure
```
/overlays/
  charcuterie-bbq.yaml
  cheese-elegant.yaml
  cocktails-brunch.yaml
src/  (your UI, admin, generator, etc)
n8n/  (hosted automations, optional)
```
### B. Branching Policy
- Main branch = production overlays
- Feature branches = overlay edits (e.g. `feature/cheese-bbq-update`)
- Pull Requests (PRs) = route for validation and merge

### C. Netlify Preview
- Each branch deploys its own preview web UI.
- Preview overlays are NOT live until merged.

---

## 3. Detailed Overlay Workflow

### 3.1 Draft/Edit (Local or UI Admin)
- Create feature branch for your overlay update.
- Add/edit overlay(s) in `/overlays/` (use text editor or UI).
  
### 3.2 Preview & Validation
- Commit and push branch.
- Netlify auto-builds and gives you a preview link.
- Test overlay:
  - Does it show required products, must-includes, bans?
  - Do “AI suggestion” and your curation properly merge?
  - Logic: substitutes, context notes, pricing, make sense?
  
### 3.3 PR & Mainline Promotion
- Open PR for your feature branch (each overlay/category can be its own).
- Self-review and merge (you approve for now).
- Main branch overlays are now “production.”  
- Netlify deploys the main version immediately (auto-deploy).
- (Optional) Tag the merge as a release (e.g. “charcuterie-bbq-v1.0”).

### 3.4 Rollback & Recovery
- If you spot an issue, revert to previous tag/commit (via GitHub/CLI).
- Overlays can always be rolled back one-by-one.

---

## 4. Admin UI and n8n (Process, Recommendations, Integration)

### 4.1 Admin UI
- Invite-based (for now, just you; later team).
- Features: per-overlay editing, must-include/ban toggles, notes, substitutes, in-table images/SKUs.
- Change overlay in UI → saves to preview branch.

### 4.2 n8n Integration (When Ready)
- n8n on private server.
- Sample flows:
  - Adjust menu for allergies (e.g., vegan events).
  - Add products if Chilean summer is forecast.
  - Modify overlays dynamically based on complex event context.
- n8n can read overlays from repo (via API, webhook, or file sync).
- **MVP caution:** Start overlays as static files. Gradually amplify logic via n8n as your scenarios and decision trees grow.

---

## 5. Timeline & Phase Table

| Phase  | Actions                                             | Time       | Owner    | Notes                                        |
|--------|-----------------------------------------------------|------------|----------|----------------------------------------------|
| 1      | Setup, create overlays, build admin UI              | Days 1–7   | You      | Acceptable to skip n8n for MVP               |
| 2      | Overlay-to-blueprint merge logic, Netlify previews  | Days 8–14  | You/Dev  | All overlays as granular YAML/JSON           |
| 3      | Real scenario pilots, add n8n for BBQ, brunch flow  | Wks 3–5    | You      | Invite, multi-admin test, feedback rounds    |
| 4      | Expand overlays, full n8n, start frontend planning  | Weeks 6+   | You/team | Move to database if needed, advanced logic   |

---

## 6. Overlay File Format & Example

```yaml
scenario: "bbq"
category: "charcuterie"
items:
  - name: "Ile de France Camembert 132g"
    must_include: true
    preferred_vendor: "Jumbo"
    price_clp: 3990
    sku: "12345"
    curator_notes: "Soft cheese is a must—pairs with fig jam."
    substitutes:
      - "President Brie 125g"
  - name: "Colun Queso Mantecoso 200g"
    must_include: true
    preferred_vendor: "Lider"
    curator_notes: "Classic Chilean favorite."
  - name: "Santa Rosa Queso Azul 140g"
    must_include: false
    preferred_vendor: "Rappi"
    curator_notes: "Optional for gourmet events."
  - name: "Pronto Charcutería Set Jamón y Salame"
    must_include: false
    ban: true
    curator_notes: "Skip unless vendor requirement."
notes: "For vegan guests, swap for almond cheese and hummus."
last_updated: "2026-02-17"
```

---

## 7. Validation, Testing, and Review Checklist

- [ ] Must-includes tagged
- [ ] Substitutes listed for all essentials
- [ ] Clear curator_notes
- [ ] No YAML/JSON errors (use online linter)
- [ ] Only desired overlays in PR
- [ ] Preview test (Netlify) successful
- [ ] Tag version (for releases or rollbacks)

---

## 8. Common Errors & Solutions

| Error                                  | Solution                                               |
|-----------------------------------------|--------------------------------------------------------|
| Overlay doesn’t load (syntax error)     | Validate YAML/JSON online before PR/merge              |
| Deployed overlay missing items          | Check must_include, check PR diffs                     |
| Conflicting edits from multiple editors | Merge one overlay per branch/PR, reviewers for scale   |
| Overlay lost/overwritten                | Recover from git log/tag; always PR and tag changes    |
| Admin UI doesn’t update overlay         | Check branch, API, cache; retry push/commit            |

---

## 9. Scaling, Upgrades & Future Roadmap

- Move overlays/content to database when team/usage grows.
- Enable RBAC (Role-based access control) for admin UI.
- Develop UI for scenario-based image inspiration boards.
- Integrate with vendor APIs (for pricing, live stock, etc.).
- Advanced n8n flows (dynamic adaptation, notification, analytics).
- Full audit log and rollback for all overlay edits.
- Customer-facing plan builder and feedback loop.

---

## 10. Day-to-Day SOP (Summary Table)

| Task                  | Tool/Step                  | Frequency     |
|-----------------------|---------------------------|--------------|
| Edit overlay          | Local editor / Admin UI   | Weekly       |
| Push feature branch   | GitHub, Netlify           | Per change   |
| Preview/validate      | Netlify                   | Per change   |
| Merge/PR to main      | GitHub/Online UI          | 1–2x/week    |
| Tag version           | GitHub release/tag        | Each merge   |
| Rollback if needed    | Git revert/tag            | As needed    |
| Add logic in n8n      | n8n instance UI           | Monthly      |

---

## 11. Reference & Troubleshooting

- Always check overlay syntax with [YAML Validator](https://yamlchecker.com/) before PR.
- One overlay/scenario per PR = clarity, easy troubleshooting.
- Rollback: Use `git revert` or restore previous tag.
- Scaling: Database and real-time UI only needed if overlays >30 or >5 admins.
- Security: Private repo, invite-only admin UI, review logs.

---

**How to Save for Your iPad:**
1. Copy-all from this file or your browser/assistant chat.
2. Paste into your Notes, Pages, Notion, GoodNotes, Google Docs, or Microsoft Word app.
3. (Optional) Add “Table of Contents” functionality for easy in-app nav.
4. As you work, duplicate for each project phase and mark checkboxes as you go!

---

**If you need breaking up into multiple files or want this as pure Markdown for an app like Obsidian/Notion, let me know—this format is maximally copy-friendly for all systems.**
