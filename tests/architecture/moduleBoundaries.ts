import { readdir, readFile } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'

const projectRoot = process.cwd()
const modulesRoot = resolve(projectRoot, 'src/modules')
const sharedRoot = resolve(projectRoot, 'src/shared')

function isInside(root: string, target: string) {
  const pathFromRoot = relative(root, target)

  return pathFromRoot !== '' && !pathFromRoot.startsWith(`..${sep}`) && !isAbsolute(pathFromRoot)
}

function owningModule(filePath: string) {
  const absolutePath = resolve(projectRoot, filePath)

  if (!isInside(modulesRoot, absolutePath)) {
    return null
  }

  return relative(modulesRoot, absolutePath).split(sep)[0] ?? null
}

export function getModuleImportViolation(importerPath: string, specifier: string) {
  const importer = resolve(projectRoot, importerPath)
  const sourceModule = owningModule(importer)

  if (specifier.startsWith('#modules/')) {
    const modulePath = specifier.slice('#modules/'.length)
    const [targetModule, ...internalPath] = modulePath.split('/')

    if (!targetModule || internalPath.length > 0) {
      return `Import ${specifier} bypasses the module public entry point.`
    }

    if (isInside(sharedRoot, importer)) {
      return `Shared infrastructure cannot depend on business module ${targetModule}.`
    }

    if (sourceModule === targetModule) {
      return `Module ${sourceModule} must use a relative import for its own code.`
    }

    return null
  }

  if (!specifier.startsWith('.')) {
    return null
  }

  const targetModule = owningModule(resolve(dirname(importer), specifier))

  if (!targetModule || targetModule === sourceModule) {
    return null
  }

  if (isInside(sharedRoot, importer)) {
    return `Shared infrastructure cannot depend on business module ${targetModule}.`
  }

  return `Relative import crosses into module ${targetModule}. Use #modules/${targetModule}.`
}

async function findTypeScriptFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = await Promise.all(
    entries.map((entry) => {
      const entryPath = resolve(directory, entry.name)

      return entry.isDirectory() ? findTypeScriptFiles(entryPath) : [entryPath]
    }),
  )

  return files.flat().filter((filePath) => /\.[cm]?ts$/.test(filePath))
}

function moduleSpecifiers(sourceText: string) {
  const specifiers = new Set<string>()
  const patterns = [
    /^\s*(?:import|export)\s+(?:type\s+)?[^;'"]*?\bfrom\s*['"]([^'"\r\n]+)['"]/gm,
    /^\s*import\s*['"]([^'"\r\n]+)['"]/gm,
    /\bimport\s*\(\s*['"]([^'"\r\n]+)['"]\s*\)/g,
  ]

  for (const pattern of patterns) {
    for (const match of sourceText.matchAll(pattern)) {
      if (match[1]) {
        specifiers.add(match[1])
      }
    }
  }

  return specifiers
}

export async function collectModuleImportViolations() {
  const roots = ['src', 'database', 'tests'].map((directory) => resolve(projectRoot, directory))
  const files = (await Promise.all(roots.map(findTypeScriptFiles))).flat()
  const violations: string[] = []

  for (const filePath of files) {
    const sourceText = await readFile(filePath, 'utf8')

    for (const specifier of moduleSpecifiers(sourceText)) {
      const violation = getModuleImportViolation(filePath, specifier)

      if (violation) {
        violations.push(`${relative(projectRoot, filePath)}: ${violation}`)
      }
    }
  }

  return violations.sort()
}
