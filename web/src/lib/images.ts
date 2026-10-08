import type { Block, Design } from "../api/client";
import { flattenBlocks, replaceBlock } from "./tree";

/**
 * Uploaded images are re-saved at the size they are placed at, so a 2000 px
 * logo shown at 140 px does not travel inside every email at full size.
 *
 * Images are kept at twice their displayed width so they stay sharp on
 * high-resolution screens (phones, Retina displays), and never enlarged. The
 * first upload is kept as `original`, so making an image bigger later
 * re-saves it from the full-size file rather than from a shrunken copy.
 * GIFs are left alone, because redrawing one would drop its animation. WEBP
 * is re-saved as PNG, which Outlook on Windows can show.
 */
export const SHARPNESS = 2;

type Sized = Extract<Block, { type: "image" | "banner" }>;

export const isUpload = (src: string) => /^\/uploads\/[A-Za-z0-9._-]+$/.test(src);
const extOf = (src: string) => (src.split(".").pop() ?? "").toLowerCase();

export function defaultWidth(block: Sized): number {
  return Math.round(block.width ?? (block.type === "banner" ? 460 : 140));
}

const loaded = new Map<string, Promise<HTMLImageElement>>();

export function loadImage(src: string): Promise<HTMLImageElement> {
  let hit = loaded.get(src);
  if (!hit) {
    hit = new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error(`Could not load ${src}`));
      img.src = src;
    });
    hit.catch(() => loaded.delete(src));
    loaded.set(src, hit);
  }
  return hit;
}

/** What saving will do with an image, for the inspector. */
export type FitPlan = {
  natural: { width: number; height: number };
  shown: { width: number; height: number };
  /** The file's size after saving, or null when the file is kept as it is. */
  saved: { width: number; height: number } | null;
  note: string;
};

export function planFit(block: Sized, natural: { width: number; height: number }): FitPlan {
  const width = defaultWidth(block);
  const shown = { width, height: Math.round((width * natural.height) / natural.width) };
  const source = block.original || block.src;
  const ext = extOf(source);
  if (!isUpload(source)) return { natural, shown, saved: null, note: "Linked images are loaded from the web as they are and not resized." };
  if (ext === "gif") return { natural, shown, saved: null, note: "GIFs are kept as uploaded, so any animation survives." };
  const target = Math.min(natural.width, Math.round(width * SHARPNESS));
  const saved = { width: target, height: Math.round((target * natural.height) / natural.width) };
  if (target === natural.width && ext !== "webp") {
    return {
      natural,
      shown,
      saved: null,
      note:
        natural.width < width * SHARPNESS
          ? `The file is smaller than ${SHARPNESS}× the size shown, so it is kept as it is and may look soft on high-resolution screens.`
          : "The file already fits, so it is kept as it is."
    };
  }
  return { natural, shown, saved, note: `Saved at ${SHARPNESS}× the size shown, so it stays sharp on high-resolution screens.` };
}

/** Draw the image at the target size, halving in steps so a large reduction stays smooth. */
async function scale(img: HTMLImageElement, width: number, height: number, type: string): Promise<Blob> {
  let source: CanvasImageSource = img;
  let w = img.naturalWidth;
  let h = img.naturalHeight;
  const draw = (tw: number, th: number) => {
    const canvas = document.createElement("canvas");
    canvas.width = tw;
    canvas.height = th;
    const g = canvas.getContext("2d")!;
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = "high";
    g.drawImage(source, 0, 0, tw, th);
    return canvas;
  };
  while (w / 2 >= width) {
    w = Math.round(w / 2);
    h = Math.round(h / 2);
    source = draw(w, h);
  }
  const out = draw(width, height);
  return new Promise((resolve, reject) =>
    out.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("Could not encode the resized image"))), type, 0.9)
  );
}

export type Upload = (file: File) => Promise<{ url: string }>;

async function fitImage(block: Sized, upload: Upload): Promise<Sized> {
  const source = block.original || block.src;
  if (!isUpload(source)) return block;
  let img: HTMLImageElement;
  try {
    img = await loadImage(source);
  } catch {
    return block;
  }
  const natural = { width: img.naturalWidth, height: img.naturalHeight };
  if (!natural.width || !natural.height) return block;
  const plan = planFit(block, natural);
  const height = plan.shown.height;
  if (!plan.saved) return { ...block, src: source, original: undefined, height };

  // Already re-saved at this size by an earlier save.
  if (block.src !== source && isUpload(block.src)) {
    const current = await loadImage(block.src).catch(() => null);
    if (current && current.naturalWidth === plan.saved.width) return { ...block, original: source, height };
  }

  const type = extOf(source) === "jpg" || extOf(source) === "jpeg" ? "image/jpeg" : "image/png";
  const blob = await scale(img, plan.saved.width, plan.saved.height, type);
  const stem = (source.split("/").pop() ?? "image").replace(/^\d+_/, "").replace(/\.[a-z0-9]+$/i, "");
  const file = new File([blob], `${stem}-${plan.saved.width}w.${type === "image/jpeg" ? "jpg" : "png"}`, { type });
  const { url } = await upload(file);
  return { ...block, src: url, original: source, height };
}

/** The design with every uploaded image re-saved to fit where it is placed. */
export async function fitImages(design: Design, upload: Upload): Promise<Design> {
  let blocks = design.blocks;
  const images = flattenBlocks(blocks)
    .map(({ block }) => block)
    .filter((b): b is Sized => b.type === "image" || b.type === "banner");
  for (const image of images) {
    const fitted = await fitImage(image, upload);
    if (fitted !== image) blocks = replaceBlock(blocks, fitted);
  }
  return blocks === design.blocks ? design : { ...design, blocks };
}
