import { describe, expect, it } from 'vitest'
import {
  adminBuyLinkFailureMessage,
  canCopyPersistedStorefrontBuyLink,
  mappingBuyLinkGateMessage,
  resolveAdminBuyLink,
} from './resolve-admin-buy-link'

const software = {
  id: 'sf_software',
  name: 'Software',
  homePath: '/s/software',
  active: true,
}
const shop = {
  id: 'sf_default',
  name: 'Default',
  homePath: '/shop',
  active: true,
}
const inactive = {
  id: 'sf_old',
  name: 'Old',
  homePath: '/s/old',
  active: false,
}

const activeProduct = {
  id: 'prod-1',
  slug: 'useai',
  active: true,
  storefronts: [
    { id: 'sf_software', visible: true },
    { id: 'sf_default', visible: true },
  ],
}

describe('resolveAdminBuyLink', () => {
  it('builds a channel-scoped buy URL when the filtered storefront is visible and active', () => {
    const result = resolveAdminBuyLink({
      product: activeProduct,
      filterStorefrontId: 'sf_software',
      storefronts: [software, shop],
      origin: 'https://shop.example',
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.url).toBe('https://shop.example/s/software?product=useai')
    expect(result.storefront.id).toBe('sf_software')
    expect(result.productKey).toBe('useai')
  })

  it('uses the single visible mapping when no filter is set', () => {
    const result = resolveAdminBuyLink({
      product: {
        id: 'prod-2',
        slug: 'vip',
        active: true,
        storefronts: [{ id: 'sf_default', visible: true }],
      },
      storefronts: [shop],
      origin: 'https://shop.example',
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.url).toBe('https://shop.example/shop?product=vip')
  })

  it('refuses multi-channel products without an explicit filter (no silent default hop)', () => {
    const result = resolveAdminBuyLink({
      product: activeProduct,
      storefronts: [software, shop],
      origin: 'https://shop.example',
    })
    expect(result).toEqual({ ok: false, reason: 'multi_channel_ambiguous' })
    expect(adminBuyLinkFailureMessage('multi_channel_ambiguous')).toMatch(/多个渠道/)
  })

  it('refuses inactive products even if mappings exist', () => {
    const result = resolveAdminBuyLink({
      product: { ...activeProduct, active: false },
      filterStorefrontId: 'sf_software',
      storefronts: [software],
      origin: 'https://shop.example',
    })
    expect(result).toEqual({ ok: false, reason: 'product_inactive' })
  })

  it('refuses invisible mappings and inactive storefronts', () => {
    const invisibleOnly = resolveAdminBuyLink({
      product: {
        id: 'prod-1',
        slug: 'useai',
        active: true,
        storefronts: [{ id: 'sf_software', visible: false }],
      },
      filterStorefrontId: 'sf_software',
      storefronts: [software],
      origin: 'https://shop.example',
    })
    // 无任何可见映射时 fail closed（不静默改道）
    expect(invisibleOnly.ok).toBe(false)
    if (invisibleOnly.ok) return
    expect(invisibleOnly.reason).toBe('no_visible_mapping')

    const wrongFilter = resolveAdminBuyLink({
      product: {
        id: 'prod-1',
        slug: 'useai',
        active: true,
        storefronts: [
          { id: 'sf_default', visible: true },
          { id: 'sf_software', visible: false },
        ],
      },
      filterStorefrontId: 'sf_software',
      storefronts: [software, shop],
      origin: 'https://shop.example',
    })
    expect(wrongFilter.ok).toBe(false)
    if (wrongFilter.ok) return
    expect(wrongFilter.reason).toBe('filter_not_visible')

    const inactiveChannel = resolveAdminBuyLink({
      product: {
        id: 'prod-1',
        slug: 'useai',
        active: true,
        storefronts: [{ id: 'sf_old', visible: true }],
      },
      filterStorefrontId: 'sf_old',
      storefronts: [inactive],
      origin: 'https://shop.example',
    })
    expect(inactiveChannel.ok).toBe(false)
    if (inactiveChannel.ok) return
    expect(inactiveChannel.reason).toBe('storefront_inactive')
  })

  it('falls back to product id when slug is empty', () => {
    const result = resolveAdminBuyLink({
      product: {
        id: 'prod-raw',
        slug: '  ',
        active: true,
        storefronts: [{ id: 'sf_default', visible: true }],
      },
      storefronts: [shop],
      origin: 'https://shop.example',
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.url).toBe('https://shop.example/shop?product=prod-raw')
  })
})

describe('canCopyPersistedStorefrontBuyLink', () => {
  const active = { channelActive: true, productActive: true }

  it('allows copy only when draft matches a persisted selected+visible mapping', () => {
    expect(canCopyPersistedStorefrontBuyLink({
      ...active,
      draft: { selected: true, visible: true },
      persisted: { selected: true, visible: true },
    })).toEqual({ ok: true })
  })

  it('refuses unsaved new mappings so operators cannot copy 404 dead links', () => {
    const notPersisted = canCopyPersistedStorefrontBuyLink({
      ...active,
      draft: { selected: true, visible: true },
      persisted: null,
    })
    expect(notPersisted).toEqual({ ok: false, reason: 'not_persisted' })
    expect(mappingBuyLinkGateMessage('not_persisted')).toMatch(/保存/)
  })

  it('refuses dirty drafts that diverge from the server snapshot', () => {
    expect(canCopyPersistedStorefrontBuyLink({
      ...active,
      draft: { selected: true, visible: false },
      persisted: { selected: true, visible: true },
    })).toEqual({ ok: false, reason: 'draft_dirty' })

    expect(canCopyPersistedStorefrontBuyLink({
      ...active,
      draft: { selected: false, visible: true },
      persisted: { selected: true, visible: true },
    })).toEqual({ ok: false, reason: 'draft_dirty' })
  })

  it('refuses invisible persisted mappings and inactive product/channel', () => {
    expect(canCopyPersistedStorefrontBuyLink({
      ...active,
      draft: { selected: true, visible: false },
      persisted: { selected: true, visible: false },
    })).toEqual({ ok: false, reason: 'not_visible' })

    expect(canCopyPersistedStorefrontBuyLink({
      channelActive: true,
      productActive: false,
      draft: { selected: true, visible: true },
      persisted: { selected: true, visible: true },
    })).toEqual({ ok: false, reason: 'product_inactive' })

    expect(canCopyPersistedStorefrontBuyLink({
      channelActive: false,
      productActive: true,
      draft: { selected: true, visible: true },
      persisted: { selected: true, visible: true },
    })).toEqual({ ok: false, reason: 'storefront_inactive' })
  })
})
