// Conservative inventory: candidates require manual review, never automatic deletion.
// --check verifies the supported English UI and installer, not transcript languages.
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const root = fileURLToPath(new URL('../src', import.meta.url))
const localeRoot = join(root, 'i18n/locales')
const translations = JSON.parse(readFileSync(join(localeRoot, 'en.json'), 'utf8'))
const keys = new Set(Object.keys(translations))
const referenced = new Set(), patterns = [], dynamic = [], missing = []
const han = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/
const invalid = Object.entries(translations)
  .filter(([key, value]) => !key || typeof value !== 'string' || !value.trim())
  .map(([key]) => `Invalid translation: ${key}`)
for (const [key, value] of Object.entries(translations)) {
  if (typeof value === 'string' && han.test(value)) {
    invalid.push(`Unexpected Han characters in English UI string: ${key}`)
  }
}
const localeFiles = readdirSync(localeRoot).filter(name => name.endsWith('.json')).sort()
if (localeFiles.join(',') !== 'en.json') invalid.push(`Unexpected UI locales: ${localeFiles.join(', ')}`)
const tauriConfig = JSON.parse(readFileSync(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8'))
const nsis = tauriConfig.bundle?.windows?.nsis
if (nsis?.displayLanguageSelector !== false || JSON.stringify(nsis?.languages) !== '["English"]') {
  invalid.push('The NSIS installer must select English without a language selection page')
}
const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const file = join(dir, entry.name)
    if (entry.isDirectory()) { walk(file); continue }
    if (!/\.tsx?$/.test(file)) continue
    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
    const location = node => `${relative(root, file)}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`
    function visit(node) {
      if (file.endsWith('.tsx') && !file.includes('__tests__')) {
        if (ts.isJsxText(node) && han.test(node.text)) {
          invalid.push(`Unexpected hardcoded Han UI text: ${location(node)}`)
        }
        if (ts.isJsxAttribute(node) && node.initializer && ts.isStringLiteral(node.initializer)
          && ['title', 'placeholder', 'aria-label', 'alt', 'label'].includes(node.name.text)
          && han.test(node.initializer.text)) {
          invalid.push(`Unexpected hardcoded Han UI attribute: ${location(node)}`)
        }
      }
      if (ts.isStringLiteralLike(node) && keys.has(node.text)) referenced.add(node.text)
      if (ts.isTemplateExpression(node)) {
        const pattern = '^' + escape(node.head.text) + node.templateSpans.map(span => '.*' + escape(span.literal.text)).join('') + '$'
        // An empty prefix cannot constrain a key inventory.
        if (node.head.text.includes('.')) patterns.push(new RegExp(pattern))
      }
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken
        && ts.isStringLiteralLike(node.left) && node.left.text.endsWith('.')) {
        patterns.push(new RegExp('^' + escape(node.left.text)))
      }
      if (ts.isCallExpression(node) && node.expression.getText(source) === 't' && node.arguments.length) {
        const argument = node.arguments[0]
        if (ts.isStringLiteralLike(argument)) {
          if (!keys.has(argument.text)) missing.push(`${location(node)} ${argument.text}`)
        } else dynamic.push(`${location(node)} ${argument.getText(source)}`)
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
}
walk(root)
function native(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const file = join(dir, entry.name)
    if (entry.isDirectory()) native(file)
    else if (file.endsWith('.rs')) {
      const source = readFileSync(file, 'utf8')
      for (const key of keys) if (source.includes(`"${key}"`)) referenced.add(key)
    }
  }
}
native(fileURLToPath(new URL('../src-tauri/src', import.meta.url)))
for (const key of keys) if (patterns.some(pattern => pattern.test(key))) referenced.add(key)
const candidates = [...keys].filter(key => !referenced.has(key))
if (process.argv.includes('--check')) {
  for (const error of [...invalid, ...missing]) console.error(error)
  if (invalid.length || missing.length) process.exitCode = 1
  else console.log(`English UI: ${keys.size} translation keys, no missing keys; NSIS English-only.`)
} else {
  process.stdout.write(JSON.stringify({ total: keys.size, referenced: referenced.size, invalid, missing, dynamic, candidates }, null, 2) + '\n')
  if (invalid.length || missing.length) process.exitCode = 1
}
