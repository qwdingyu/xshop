import { afterEach, describe, expect, it } from 'vitest'
import { useStorefrontContext } from './useStorefrontContext'

const softwareStorefront = {
  id: 'sf-software',
  slug: 'software',
  name: 'Software',
  logoUrl: 'https://cdn.example.com/software.png',
  supportEmail: 'software@example.com',
  templateKey: 'compact' as const,
  isDefault: false,
  homePath: '/s/software',
}

describe('public storefront context', () => {
  const context = useStorefrontContext()

  afterEach(() => context.clearStorefront())

  it('shares the active storefront across public customer components', () => {
    context.setStorefront(softwareStorefront)

    expect(useStorefrontContext().storefront.value).toEqual(softwareStorefront)
  })

  it('clears channel branding when leaving storefront pages', () => {
    context.setStorefront(softwareStorefront)
    context.clearStorefront()

    expect(context.storefront.value).toBeNull()
  })
})
