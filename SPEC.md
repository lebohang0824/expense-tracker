# Expense Tracker - Specification

## Project Overview

- **Name**: Expense Tracker
- **Type**: Single-page web application (vanilla HTML/CSS/JS)
- **Core Functionality**: Track multiple income sources and log expenses with real-time balance deduction using IndexedDB
- **Target Users**: Individuals managing personal finances

## UI/UX Specification

### Layout Structure

- **Header**: App title, current date
- **Main Dashboard**:
  - Total balance card (prominent)
  - Health indicator ring
  - Income summary section
  - Expense log section
- **Floating Action Buttons**: Add Income, Add Expense
- **Modals**: Income modal, Expense modal
- **Toast Container**: Bottom-right corner

### Visual Design

#### Color Palette

- **Background**: Deep charcoal `#0d0d0f` with subtle noise texture
- **Glass Surface**: `rgba(255, 255, 255, 0.03)` with `backdrop-filter: blur(20px)`
- **Glass Border**: `rgba(255, 255, 255, 0.08)`
- **Primary Accent**: Warm amber `#f59e0b`
- **Secondary Accent**: Soft teal `#14b8a6`
- **Danger/Expense**: Soft coral `#f87171`
- **Success/Income**: Mint green `#34d399`
- **Text Primary**: `#fafafa`
- **Text Secondary**: `#a1a1aa`
- **Text Muted**: `#71717a`

#### Typography

- **Font Family**:
  - Display: "Clash Display" (Google Fonts alternative: "Syne")
  - Body: "DM Sans"
- **Sizes**:
  - Hero balance: 4rem (clamp)
  - Section headings: 1.25rem
  - Body: 0.9375rem
  - Small/labels: 0.75rem

#### Spacing System

- Base unit: 4px
- Card padding: 24px
- Section gap: 32px
- Element gap: 16px

#### Visual Effects

- Glassmorphism: `backdrop-filter: blur(20px)`, subtle white borders
- Card shadows: `0 8px 32px rgba(0, 0, 0, 0.4)`
- Hover transitions: 0.3s cubic-bezier(0.4, 0, 0.2, 1)
- Modal entrance: scale + fade animation

### Components

#### Balance Card

- Large hero number with currency symbol
- "Available" label
- Subtle pulsing glow when healthy
- Glass background with border

#### Health Indicator

- Circular progress ring (SVG)
- Gradient stroke from coral (bad) to mint (good)
- Percentage in center
- Label: "Financial Health"
- States: Critical (<20%), Warning (20-50%), Good (50-80%), Excellent (>80%)

#### Income List

- Card with list of incomes
- Each row: source name, amount, date, delete button
- Total income summary at top

#### Expense List

- Card with list of expenses
- Each row: description, amount, date, category tag
- Most recent first

#### Modals

- Centered overlay with backdrop blur
- Glass card container
- Close button (X)
- Form inputs with floating labels
- Submit button

#### Floating Action Buttons

- Two buttons at bottom: "+ Income" (green tint), "+ Expense" (coral tint)
- Pill-shaped, glass style
- Icons: plus sign

#### Toast Notifications

- Slide in from right
- Auto-dismiss after 3s
- Glass style with accent border
- Icon + message

### Responsive Breakpoints

- Mobile: < 640px (stacked layout, smaller typography)
- Tablet: 640px - 1024px
- Desktop: > 1024px

## Functionality Specification

### Core Features

1. **Multiple Incomes**
   - Add income with: source name, amount, date (default today)
   - Store in IndexedDB object store "incomes"
   - Display as list with total

2. **Expenses**
   - Add expense with: description, amount, date (default today), category
   - Store in IndexedDB object store "expenses"
   - Display as list, most recent first

3. **Balance Calculation**
   - Total Income = sum of all incomes
   - Total Expenses = sum of all expenses
   - Available Balance = Total Income - Total Expenses

4. **Health Indicator**
   - Health % = (Available Balance / Total Income) \* 100
   - Capped at 100%, can go negative (show as 0%)
   - Visual feedback based on percentage

5. **Data Persistence**
   - All data in IndexedDB
   - Survives page refresh
   - Delete individual items

### User Interactions

- Click FAB → Open respective modal
- Fill form → Submit → Save to DB → Update UI → Show toast
- Click delete → Remove from DB → Update UI → Show toast
- Click outside modal → Close modal (optional)

### Edge Cases

- No incomes: Show prompt to add income
- Balance = 0: Health shows 0%
- Negative balance: Health shows 0%, show warning
- Empty inputs: Validation error

## Technical Implementation

### IndexedDB Structure

- Database: "Expense Tracker-db"
- Stores: "incomes", "expenses"
- Schema: { id: auto-increment, name/source, amount, date, category (expense only) }

### File Structure

- index.html (single file with embedded CSS/JS for simplicity)

## Acceptance Criteria

1. ✅ Can add multiple incomes with source and amount
2. ✅ Can add expenses with description and amount
3. ✅ Total balance updates automatically
4. ✅ Each expense deducts from available balance
5. ✅ Health indicator shows percentage with visual feedback
6. ✅ Data persists in IndexedDB across refresh
7. ✅ Modals open/close with animations
8. ✅ Toasts appear on actions
9. ✅ Glass morphism styling is applied throughout
10. ✅ Minimal, distinctive aesthetic
