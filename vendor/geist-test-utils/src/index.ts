import slugify from 'sluga'

declare const testIdBrand: unique symbol

export type DataTestId = string & {
  [testIdBrand]: true
}

export interface TestIdProps {
  'data-testid'?: DataTestId
}

const separator = '/'
const slugCache = new Map<string, string>()

function cachedSlugify(value: string): string {
  const cachedValue = slugCache.get(value)
  if (cachedValue) return cachedValue

  const slug = slugify(value)
  slugCache.set(value, slug)
  return slug
}

function generateTestId(
  scope: string,
  name: string,
  ...rest: string[]
): DataTestId
function generateTestId(testId: DataTestId, ...rest: string[]): DataTestId
function generateTestId(
  testIdOrScope: DataTestId | string,
  name: string,
  ...rest: string[]
): DataTestId {
  return [...testIdOrScope.split(separator), name, ...rest]
    .filter(Boolean)
    .map(cachedSlugify)
    .join(separator) as DataTestId
}

declare global {
  interface Window {
    loadedForTest: Set<string> | undefined
  }
}

export function markLoadedForTest(id: string): void {
  if (typeof window === 'undefined') return

  const loadedComponents =
    window.loadedForTest ?? (window.loadedForTest = new Set<string>())
  loadedComponents.add(id)
}

export const tid = generateTestId
