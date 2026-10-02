/** True when a point lies on the element's scrollbar rather than its content box. */
export function onScrollbar(
  el: { clientWidth: number; clientHeight: number },
  origin: { left: number; top: number },
  x: number,
  y: number,
): boolean {
  return x - origin.left >= el.clientWidth || y - origin.top >= el.clientHeight
}
