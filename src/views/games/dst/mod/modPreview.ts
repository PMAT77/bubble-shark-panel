import { NImage } from 'naive-ui'
import { h } from 'vue'

export function renderModPreview(previewImage: string | null) {
  if (!previewImage) {
    return h('div', {
      class: 'flex size-12 items-center justify-center rounded bg-muted text-xs text-muted-foreground',
    }, '无图')
  }
  return h(NImage, {
    src: previewImage,
    width: 48,
    height: 48,
    objectFit: 'cover',
    lazy: true,
    previewDisabled: false,
    class: 'rounded',
  })
}
