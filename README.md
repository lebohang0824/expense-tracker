# Expense Tracker

A minimal, glassmorphism-styled expense tracker that runs entirely in the browser using IndexedDB for data persistence.

## Features

- **Multiple income sources** — Add as many income streams as needed (salary, freelance, investments, etc.)
- **Expense tracking** — Record expenses with descriptions, amounts, categories, and dates
- **Real-time balance** — Available balance updates automatically as expenses are added
- **Financial health indicator** — Visual ring showing what percentage of your income remains after expenses
- **Local storage** — All data saved in IndexedDB; persists across browser sessions
- **Glassmorphism design** — Modern, translucent UI with ambient lighting effects

## How to Use

1. **Open the app** — Load `index.html` in any modern browser (Chrome, Firefox, Safari, Edge)

2. **Add income** — Click the green **+ Income** button, fill in:
   - Source name (e.g., "Salary", "Freelance")
   - Amount in Rand
   - Date
   - Click "Add Income"

3. **Add expenses** — Click the red **+ Expense** button, fill in:
   - Description (e.g., "Groceries")
   - Amount in Rand
   - Category (e.g., "Food", "Transport")
   - Date
   - Click "Add Expense"

4. **View your status** — The balance card shows available funds; the ring indicator shows financial health:
   - 50%+ — Healthy (green)
   - 20-49% — Caution (amber)
   - <20% — Critical (red)

5. **Delete items** — Click the ✕ next to any income or expense to remove it

## Data Storage

All data is stored locally in your browser's IndexedDB. No server, no account, no internet required after initial load. Data stays on your device.

## Tech Stack

- Vanilla HTML, CSS, JavaScript
- IndexedDB for persistence
- Glassmorphism UI with backdrop-filter blur
- Syne + DM Sans typography
