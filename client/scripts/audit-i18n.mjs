// Conservative inventory: candidates require manual review, never automatic deletion.
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const root = fileURLToPath(new URL('../src', import.meta.url))
const keys = new Set(Object.keys(JSON.parse(readFileSync(join(root, 'i18n/locales/en.json'), 'utf8'))))
const referenced = new Set(), patterns = [], dynamic = [], missing = []
const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const file = join(dir, entry.name)
    if (entry.isDirectory()) { walk(file); continue }
    if (!/\.tsx?$/.test(file)) continue
    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
    const location = node => `${relative(root, file)}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`
    function visit(node) {
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
process.stdout.write(JSON.stringify({ total: keys.size, referenced: referenced.size, missing, dynamic, candidates }, null, 2) + '\n')
if (missing.length) process.exitCode = 1
