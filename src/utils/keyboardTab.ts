/** Naive UI 的页签默认是可点击 div，通过公开 tabProps 补齐键盘与焦点。 */
export function keyboardTabProps(selected: boolean) {
  return {
    role: 'button', tabindex: 0, 'aria-pressed': selected,
    class: 'focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-[-2px]',
    onKeydown: (event: KeyboardEvent) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        const target = event.currentTarget as HTMLElement
        target.click()
      }
    },
  }
}
