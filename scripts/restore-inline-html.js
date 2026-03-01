#!/usr/bin/env node

// Utility script to restore dashboard-server.ts marker section back to
// reading src/html/dashboard.html from disk (undoes scripts/inline-html.js).

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const tsPath = path.join(__dirname, '../src/dashboard-server.ts')
const startMarker = '/* DASHBOARD_HTML_START */'
const endMarker = '/* DASHBOARD_HTML_END */'
const restoredBody = "  return readFileSync(path.join(__dirname, 'html', 'dashboard.html'), 'utf8')"

let tsContent
try {
  tsContent = fs.readFileSync(tsPath, 'utf8')
} catch (err) {
  console.error(`✗ Failed to read ${tsPath}:`, err.message)
  process.exit(1)
}

const startIndex = tsContent.indexOf(startMarker)
const endIndex = tsContent.indexOf(endMarker)

if (startIndex === -1 || endIndex === -1) {
  console.error(`✗ Could not find markers in ${tsPath}`)
  console.error(`  Expected: ${startMarker} ... ${endMarker}`)
  process.exit(1)
}

if (endIndex <= startIndex) {
  console.error(`✗ Marker order is invalid in ${tsPath}`)
  process.exit(1)
}

const before = tsContent.substring(0, startIndex + startMarker.length)
const between = tsContent.substring(startIndex + startMarker.length, endIndex)
const after = tsContent.substring(endIndex)
const normalizedBetween = between.trim()
const targetBetween = restoredBody.trim()

if (normalizedBetween === targetBetween) {
  console.log('✓ dashboard-server.ts marker content is already restored')
  process.exit(0)
}

const newContent = `${before}\n${restoredBody}\n  ${after}`

try {
  fs.writeFileSync(tsPath, newContent, 'utf8')
  console.log('✓ Restored dashboard-server.ts marker content to readFileSync form')
} catch (err) {
  console.error(`✗ Failed to write ${tsPath}:`, err.message)
  process.exit(1)
}
