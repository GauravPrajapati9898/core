// @ts-check

/**
 * We use rollup-plugin-esbuild for faster builds, but esbuild in insolation
 * mode compiles const enums into runtime enums, bloating bundle size.
 *
 * Here we pre-process all the const enums in the project and turn them into
 * global replacements, and remove the original declarations and re-exports.
 *
 * This erases the const enums before the esbuild transform so that we can
 * leverage esbuild's speed while retaining the DX and bundle size benefits
 * of const enums.
 *
 * This file is expected to be executed with project root as cwd.
 */

import execa from 'execa'
import { readFileSync } from 'node:fs'
import { parse } from '@babel/parser'
import path from 'node:path'
import MagicString from 'magic-string'

function evaluate(exp) {
  return new Function(`return ${exp}`)()
}

/**
 * @returns {Promise<[import('rollup').Plugin, Record<string, string>]>}
 */
export async function constEnum() {
  /**
   * @type {{ ranges: Record<string, [number, number][]>, defines: Record<string, string> }}
   */
  const enumData = {
    ranges: {},
    defines: {}
  }

  const knowEnums = new Set()

  // 1. grep for files with exported const enum
  const { stdout } = await execa('git', ['grep', `export const enum`])
  const files = [...new Set(stdout.split('\n').map(line => line.split(':')[0]))]

  // 2. parse matched files to collect enum info
  for (const relativeFile of files) {
    const file = path.resolve(process.cwd(), relativeFile)
    const content = readFileSync(file, 'utf-8')
    const ast = parse(content, {
      plugins: ['typescript'],
      sourceType: 'module'
    })

    for (const node of ast.program.body) {
      if (
        node.type === 'ExportNamedDeclaration' &&
        node.declaration &&
        node.declaration.type === 'TSEnumDeclaration'
      ) {
        if (file in enumData.ranges) {
          // @ts-ignore
          enumData.ranges[file].push([node.start, node.end])
        } else {
          // @ts-ignore
          enumData.ranges[file] = [[node.start, node.end]]
        }

        const decl = node.declaration
        let lastInitialized
        for (let i = 0; i < decl.members.length; i++) {
          const e = decl.members[i]
          const id = decl.id.name
          knowEnums.add(id)
          const key = e.id.type === 'Identifier' ? e.id.name : e.id.value
          const fullKey = `${id}.${key}`
          const init = e.initializer
          if (init) {
            let value
            if (
              init.type === 'StringLiteral' ||
              init.type === 'NumericLiteral'
            ) {
              value = init.value
            }

            // e.g. 1 << 2
            if (init.type === 'BinaryExpression') {
              const resolveValue = node => {
                if (
                  node.type === 'NumericLiteral' ||
                  node.type === 'StringLiteral'
                ) {
                  return node.value
                } else if (node.type === 'MemberExpression') {
                  const exp = content.slice(node.start, node.end)
                  if (!(exp in enumData.defines)) {
                    throw new Error(
                      `unhandled enum initialization expression ${exp} in ${file}`
                    )
                  }
                  return enumData.defines[exp]
                } else {
                  throw new Error(
                    `unhandled BinaryExpression operand type ${node.type} in ${file}`
                  )
                }
              }
              const exp = `${resolveValue(init.left)}${
                init.operator
              }${resolveValue(init.right)}`
              value = evaluate(exp)
            }

            if (init.type === 'UnaryExpression') {
              // @ts-ignore assume all operands are literals
              const exp = `${init.operator}${init.argument.value}`
              value = evaluate(exp)
            }

            if (value === undefined) {
              throw new Error(
                `unhandled initializer type ${init.type} for ${fullKey} in ${file}`
              )
            }
            enumData.defines[fullKey] = JSON.stringify(value)
            lastInitialized = value
          } else {
            if (lastInitialized === undefined) {
              // first initialized
              enumData.defines[fullKey] = `0`
              lastInitialized = 0
            } else if (typeof lastInitialized === 'number') {
              enumData.defines[fullKey] = String(++lastInitialized)
            } else {
              // should not happen
              throw new Error(`wrong enum initialization sequence in ${file}`)
            }
          }
        }
      }
    }
  }

  // construct a regex for matching re-exports of known const enums
  const reExportsRE = new RegExp(
    `export {[^}]*?\\b(${[...knowEnums].join('|')})\\b[^]*?}`
  )

  // 3. during transform:
  //    3.1 files w/ const enum declaration: remove delcaration
  //    3.2 files using const enum: inject into esbuild define
  /**
   * @type {import('rollup').Plugin}
   */
  const plugin = {
    name: 'remove-const-enum',
    transform(code, id) {
      let s

      if (id in enumData.ranges) {
        s = s || new MagicString(code)
        for (const [start, end] of enumData.ranges[id]) {
          s.remove(start, end)
        }
      }

      // check for const enum re-exports that must be removed
      if (reExportsRE.test(code)) {
        s = s || new MagicString(code)
        const ast = parse(code, {
          plugins: ['typescript'],
          sourceType: 'module'
        })
        for (const node of ast.program.body) {
          if (
            node.type === 'ExportNamedDeclaration' &&
            node.exportKind !== 'type' &&
            node.source
          ) {
            for (let i = 0; i < node.specifiers.length; i++) {
              const spec = node.specifiers[i]
              if (
                spec.type === 'ExportSpecifier' &&
                spec.exportKind !== 'type' &&
                knowEnums.has(spec.local.name)
              ) {
                if (i === 0) {
                  // first
                  const next = node.specifiers[i + 1]
                  // @ts-ignore
                  s.remove(spec.start, next ? next.start : spec.end)
                } else {
                  // locate the end of prev
                  // @ts-ignore
                  s.remove(node.specifiers[i - 1].end, spec.end)
                }
              }
            }
          }
        }
      }

      if (s) {
        return {
          code: s.toString(),
          map: s.generateMap()
        }
      }
    }
  }

  return [plugin, enumData.defines]
}
