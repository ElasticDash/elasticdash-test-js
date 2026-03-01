#!/usr/bin/env node

// Build script to inline dashboard.html into dashboard-server.ts
// 
// This script reads src/html/dashboard.html and injects it into
// getDashboardHtml() function in src/dashboard-server.ts between
// the marker comments DASHBOARD_HTML_START and DASHBOARD_HTML_END.
// 
// Run this before TypeScript compilation to ensure the HTML is bundled.

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const htmlPath = path.join(__dirname, '../src/html/dashboard.html')
const tsPath = path.join(__dirname, '../src/dashboard-server.ts')

// Read the HTML file
let html
try {
  html = fs.readFileSync(htmlPath, 'utf8')
} catch (err) {
  console.error(`✗ Failed to read ${htmlPath}:`, err.message)
  process.exit(1)
}

// Escape the HTML for TypeScript template literal
// We need to escape:
// - Backslashes: \ → \\
// - Backticks: ` → \`
// - Dollar signs (for template literals): $ → \$
const escaped = html
  .replace(/\\/g, '\\\\')
  .replace(/`/g, '\\`')
  .replace(/\$/g, '\\$')

// Read the TypeScript file
let tsContent
try {
  tsContent = fs.readFileSync(tsPath, 'utf8')
} catch (err) {
  console.error(`✗ Failed to read ${tsPath}:`, err.message)
  process.exit(1)
}

// Replace content between markers
const startMarker = '/* DASHBOARD_HTML_START */'
const endMarker = '/* DASHBOARD_HTML_END */'

const startIndex = tsContent.indexOf(startMarker)
const endIndex = tsContent.indexOf(endMarker)

if (startIndex === -1 || endIndex === -1) {
  console.error(`✗ Could not find markers in ${tsPath}`)
  console.error(`  Expected: ${startMarker} ... ${endMarker}`)
  process.exit(1)
}

// Construct the new TypeScript content
const before = tsContent.substring(0, startIndex + startMarker.length)
const after = tsContent.substring(endIndex)
const newContent = `${before}\n  return \`${escaped}\`\n  ${after}`

// Write the updated TypeScript file
try {
  fs.writeFileSync(tsPath, newContent, 'utf8')
  console.log('✓ Dashboard HTML inlined into dashboard-server.ts')
} catch (err) {
  console.error(`✗ Failed to write ${tsPath}:`, err.message)
  process.exit(1)
}
