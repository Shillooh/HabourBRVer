import { el, icon } from './dom';

/**
 * Enables smooth click-and-drag horizontal scrolling on a row container.
 * When dragging past threshold, button click events are captured and suppressed
 * so cards are not activated accidentally.
 */
export function enableDragScroll(scroller: HTMLElement): () => void {
  let isDown = false;
  let startX = 0;
  let startScrollLeft = 0;
  let isDragging = false;
  let pointerId = -1;

  const onPointerDown = (e: PointerEvent) => {
    // Only primary mouse button (button 0); touch devices already have native touch-scroll
    if (e.button !== 0 || e.pointerType === 'touch') return;
    isDown = true;
    isDragging = false;
    startX = e.clientX;
    startScrollLeft = scroller.scrollLeft;
    pointerId = e.pointerId;
  };

  const onPointerMove = (e: PointerEvent) => {
    if (!isDown) return;
    const deltaX = e.clientX - startX;
    if (!isDragging && Math.abs(deltaX) > 6) {
      isDragging = true;
      scroller.classList.add('tvl-is-dragging');
      if (scroller.setPointerCapture && pointerId !== -1) {
        try { scroller.setPointerCapture(pointerId); } catch { /* ignore capture errors */ }
      }
    }
    if (isDragging) {
      e.preventDefault();
      scroller.scrollLeft = startScrollLeft - deltaX;
    }
  };

  const endDrag = (_e: PointerEvent) => {
    if (!isDown) return;
    isDown = false;
    if (isDragging) {
      scroller.classList.remove('tvl-is-dragging');
      if (scroller.releasePointerCapture && pointerId !== -1) {
        try { scroller.releasePointerCapture(pointerId); } catch { /* ignore */ }
      }
      // Suppress the click that follows mouse up
      const suppressClick = (clickEvent: MouseEvent) => {
        clickEvent.preventDefault();
        clickEvent.stopPropagation();
        clickEvent.stopImmediatePropagation();
      };
      scroller.addEventListener('click', suppressClick, { capture: true, once: true });
      setTimeout(() => {
        scroller.removeEventListener('click', suppressClick, { capture: true });
        isDragging = false;
      }, 50);
    }
    pointerId = -1;
  };

  const preventNativeDrag = (e: DragEvent) => {
    e.preventDefault();
  };

  scroller.addEventListener('pointerdown', onPointerDown);
  scroller.addEventListener('pointermove', onPointerMove);
  scroller.addEventListener('pointerup', endDrag);
  scroller.addEventListener('pointercancel', endDrag);
  scroller.addEventListener('dragstart', preventNativeDrag);

  return () => {
    scroller.removeEventListener('pointerdown', onPointerDown);
    scroller.removeEventListener('pointermove', onPointerMove);
    scroller.removeEventListener('pointerup', endDrag);
    scroller.removeEventListener('pointercancel', endDrag);
    scroller.removeEventListener('dragstart', preventNativeDrag);
  };
}

/**
 * Attaches left/right smooth scroll navigation buttons to a horizontal row
 * and enables intuitive mouse click-and-drag horizontal scrolling.
 */
export function attachRowScrollButtons(header: HTMLElement, scroller: HTMLElement): HTMLElement {
  const container = el('div', 'tvl-home-row-scroll-buttons tvl-scroll-hidden');

  const prev = el('button', 'tvl-scroll-button tvl-scroll-prev');
  prev.type = 'button';
  prev.tabIndex = -1;
  prev.setAttribute('aria-label', 'Rolar para a esquerda');
  prev.append(icon('chevronLeft'));

  const next = el('button', 'tvl-scroll-button tvl-scroll-next');
  next.type = 'button';
  next.tabIndex = -1;
  next.setAttribute('aria-label', 'Rolar para a direita');
  next.append(icon('chevronRight'));

  const update = () => {
    const maxScroll = scroller.scrollWidth - scroller.clientWidth;
    if (maxScroll <= 4) {
      container.classList.add('tvl-scroll-hidden');
      return;
    }
    container.classList.remove('tvl-scroll-hidden');
    prev.disabled = scroller.scrollLeft <= 4;
    next.disabled = scroller.scrollLeft >= maxScroll - 4;
  };

  const scrollAmount = () => Math.max(240, Math.floor(scroller.clientWidth * 0.75));

  prev.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    scroller.scrollBy({ left: -scrollAmount(), behavior: 'smooth' });
  });

  next.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    scroller.scrollBy({ left: scrollAmount(), behavior: 'smooth' });
  });

  scroller.addEventListener('scroll', update, { passive: true });

  if (typeof ResizeObserver !== 'undefined') {
    const observer = new ResizeObserver(update);
    observer.observe(scroller);
  } else {
    window.addEventListener('resize', update, { passive: true });
  }

  // Enable click and drag scrolling
  enableDragScroll(scroller);

  // Check state immediately and after layout rendering
  update();
  setTimeout(update, 50);
  setTimeout(update, 250);
  setTimeout(update, 600);

  container.append(prev, next);
  header.append(container);
  return container;
}
