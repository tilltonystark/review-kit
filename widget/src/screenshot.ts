/**
 * Captures what the reviewer sees: the current viewport, with the selected
 * element outlined in red and private fields covered. Uses html-to-image,
 * which lets the browser render the page itself, so modern CSS comes out
 * right. Loaded on demand, so visitors never download it.
 */

/** Fields that may hold personal data, plus anything the site marks private. */
const PRIVATE = 'input:not([type="button"]):not([type="submit"]):not([type="checkbox"]):not([type="radio"]), textarea, select, [data-review-private], [contenteditable="true"]';

export async function captureViewport(target: Element, ignore: Element): Promise<string | null> {
  try {
    const { toCanvas } = await import("html-to-image");
    const width = window.innerWidth;
    const height = window.innerHeight;
    // Readable but small enough to upload quickly on a phone connection.
    const pixelRatio = Math.min(window.devicePixelRatio || 1, width < 640 ? 2 : 1.25);

    const canvas = await Promise.race([
      toCanvas(document.body, {
        width,
        height,
        pixelRatio,
        backgroundColor: getComputedStyle(document.body).backgroundColor || "#fff",
        style: {
          transform: `translate(${-window.scrollX}px, ${-window.scrollY}px)`,
          transformOrigin: "0 0",
        },
        filter: (node) => node !== ignore,
      }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), 12000)),
    ]);

    const ctx = canvas.getContext("2d");
    if (ctx) {
      ctx.save();
      ctx.scale(pixelRatio, pixelRatio);
      // Cover private fields that are on screen.
      ctx.fillStyle = "#c9ced6";
      for (const el of Array.from(document.querySelectorAll(PRIVATE))) {
        const r = el.getBoundingClientRect();
        if (r.width && r.height && r.bottom > 0 && r.top < height && r.right > 0 && r.left < width) {
          ctx.fillRect(r.x, r.y, r.width, r.height);
        }
      }
      const rect = target.getBoundingClientRect();
      ctx.lineWidth = 3;
      ctx.strokeStyle = "#e5484d";
      ctx.strokeRect(rect.x - 2, rect.y - 2, rect.width + 4, rect.height + 4);
      ctx.restore();
    }
    return canvas.toDataURL("image/jpeg", 0.78);
  } catch (error) {
    console.warn("[review-kit] screenshot failed", error);
    return null;
  }
}
