# UI Specification: TonyAI Enterprise

## 1. Design Philosophy
The interface must convey trust, precision, and control. It is designed for data dense sustainability, compliance, and carbon reporting workflows. The experience should be data first, highly readable, and efficient without creating cognitive overload.

## 2. Visual Identity and Color Palette

### Backgrounds
- Primary background: `Slate 50` `#F8FAFC`
- Surface and cards: `White` `#FFFFFF`

### Borders
- Default border: `Slate 200` `#E2E8F0`

### Typography
- Primary font: `Inter`
- Monospace font for values and calculation displays: `JetBrains Mono` or `Roboto Mono`

### Action Colors
- Primary and success: `Emerald 600` `#059669`
- Warning and pending: `Amber 500` `#F59E0B`
- Critical and missing: `Red 600` `#DC2626`

### Scope Colors
- Scope 1: `Blue 600`
- Scope 2: `Cyan 500`
- Scope 3: `Indigo 500`

## 3. Layout Architecture

### Sidebar
- Position: left
- Width: `280px`
- Behaviour: fixed on desktop
- Contents: primary navigation with Lucide icons

### Header
- Position: top
- Height: `64px`
- Behaviour: sticky
- Contents: breadcrumbs, global filters, notifications, and profile menu

### Main Canvas
- Default padding: `p-6`
- Max width: `1600px`
- Behaviour: responsive and centered on ultra wide screens

### Right Side Drawer
- Width: `450px`
- Behaviour: overlay panel for quick view, record detail, or matrix triggered data entry

## 4. Responsive Behaviour

### Desktop
- Sidebar always visible
- Multi column layouts enabled
- Data dense tables and cards displayed fully

### Tablet
- Sidebar collapsible
- Grids reduce to fewer columns
- Filters may wrap onto multiple lines

### Mobile
- Sidebar hidden behind menu icon
- Cards stack vertically
- Tables scroll horizontally
- Matrix becomes horizontally scrollable
- Drawers use full height slide over pattern

## 5. Component Standards

### Cards
- Bordered
- Radius: `0.75rem`
- Shadow: subtle `shadow-sm`
- Use for summary metrics, charts, status panels, and grouped content

### Tables
- Sticky headers
- Row hover states
- Condensed padding for high data density
- Strong column labels
- Clear empty state and loading state

### Forms
- Labels positioned above inputs
- Inline validation messages
- Helper text where needed
- Required fields clearly marked

### Modals
- Centered
- Backdrop blur small
- Clear Cancel and Confirm actions
- Reserved for focused tasks and confirmations

### Drawers
- Slide from right
- Used for quick detail views, history inspection, and matrix triggered drill down
- Should not replace full pages for deep workflows

## 6. Interaction Patterns

### Hover
- Interactive cells in the tracking matrix must show a tooltip such as `Click to view details`
- Clickable cards and rows should have clear hover feedback

### Loading
- Use skeleton loaders for cards, charts, and table rows
- Avoid layout shift during data fetch

### Toasts
Use for:
- Draft Saved
- Submission Successful
- Sync Complete
- Calculation Error
- Upload Complete

### Transitions
- Minimal `150ms` fade or ease transitions
- Avoid decorative or complex animations

## 7. Status and State Styling

### Success
- Emerald accents
- Positive confirmation styling

### Warning
- Amber accents
- Used for anomalies, incomplete data, pending review

### Error
- Red accents
- Used for missing data, validation failure, calculation error

### Locked
- Muted styling
- Disabled controls
- Clear lock badge

### Read Only
- Inputs disabled
- Actions hidden or muted
- Clear visual distinction from editable mode

## 8. Density and Readability Rules
- Prioritise compact but readable layouts
- Use medium to high information density on enterprise pages
- Avoid excessive whitespace in tables and reporting views
- Keep visual hierarchy clear with spacing, headings, and card grouping
- Use monospace only for values, formulas, and calculation outputs where helpful

## 9. Iconography
- Use `Lucide React` exclusively
- Sidebar icon size: `18px`
- Inline action icon size: `16px`
- Status icons should be simple and recognisable

## 10. UI Tone
The platform should feel credible, calm, structured, and professional. It should look like enterprise reporting software rather than a consumer dashboard.