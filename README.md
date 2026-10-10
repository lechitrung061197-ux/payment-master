# Payment Master

Payment management system built on Google Sheets + Google Apps Script.

## Architecture

```
Google Sheet "Payment Master"
        ↕
Bound Google Apps Script
        ↕
Local source (managed by clasp)
        ↕
Git → private GitHub repository
```

Current phase: **Master only** (foundation + schema). Seller spreadsheets come in a later phase.

## Conventions

- All schema, code, comments, logs and status values are in English.
- Spreadsheet locale `en_US`, timezone `America/New_York`, currency USD.
- Apps Script runtime V8, timezone `America/New_York`.
