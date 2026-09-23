// Normalising product photos as they are uploaded.
//
// Uploads used to be stored exactly as they arrived, which meant the catalogue
// held anything from a 225px thumbnail to a 2.4MB 2438px original — and the
// storefront downloaded that 2.4MB in full to fill a 300px tile.
//
// What this does *not* do is make a small photo sharp. Detail that was never
// captured cannot be added back, so an undersized original is still undersized
// afterwards; MIN_GOOD_EDGE exists to say so out loud in the log rather than
// leaving it to be noticed on the shelf.

import fs from "node:fs/promises";
import path from "node:path";

import sharp from "sharp";

// Comfortably above what any tile in this app asks for, including a 2x screen
// and the modal's larger view, without storing camera-sized files forever.
export const MAX_EDGE = 1600;

// The card tile is ~300 CSS px, so a 2x display wants ~600 real pixels. Below
// that, the photo is being stretched and will look soft however it is encoded.
export const MIN_GOOD_EDGE = 600;

const WEBP_QUALITY = 85;

// Animated GIFs are passed through untouched: re-encoding them frame by frame
// is a different job, and a product photo is essentially never one.
const PASS_THROUGH = new Set([".gif"]);

/**
 * Re-encodes one uploaded file in place, replacing it with a WebP of the same
 * base name. Returns what happened so the caller can log or surface it.
 *
 * Never throws: a photo that sharp cannot read is left exactly as it arrived
 * rather than failing the upload. A slightly heavy original in the catalogue is
 * a far better outcome than an admin losing the file they just chose.
 */
export async function normalizeUpload(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  if (PASS_THROUGH.has(extension)) {
    return { path: filePath, changed: false, reason: "animated format passed through" };
  }

  try {
    const input = await fs.readFile(filePath);
    const { width = 0, height = 0 } = await sharp(input).metadata();
    const longestEdge = Math.max(width, height);

    const output = await sharp(input)
      .rotate() // Applies the EXIF orientation before that metadata is stripped.
      .resize({
        width: MAX_EDGE,
        height: MAX_EDGE,
        fit: "inside",
        // Never scale up. Enlarging here would bake the blur into the stored
        // file and hide how small the original actually was.
        withoutEnlargement: true,
      })
      .webp({ quality: WEBP_QUALITY })
      .toBuffer();

    const webpPath = filePath.replace(/\.[^.]+$/, "") + ".webp";

    // Only keep the result if it actually helped. A small, already-optimised
    // photo can come out of a WebP re-encode larger than it went in.
    if (webpPath === filePath || output.length < input.length) {
      await fs.writeFile(webpPath, output);
      if (webpPath !== filePath) await fs.unlink(filePath).catch(() => {});
      return {
        path: webpPath,
        changed: true,
        width,
        height,
        longestEdge,
        bytesBefore: input.length,
        bytesAfter: output.length,
        undersized: longestEdge > 0 && longestEdge < MIN_GOOD_EDGE,
      };
    }

    return {
      path: filePath,
      changed: false,
      width,
      height,
      longestEdge,
      bytesBefore: input.length,
      bytesAfter: input.length,
      undersized: longestEdge > 0 && longestEdge < MIN_GOOD_EDGE,
      reason: "re-encoding would have made it larger",
    };
  } catch (error) {
    return { path: filePath, changed: false, reason: `could not be processed: ${error.message}` };
  }
}

// One line per upload, so an admin who uploads a thumbnail finds out from the
// log rather than from the shelf.
export function describeUpload(result) {
  const name = path.basename(result.path);
  if (!result.changed) return `[upload] ${name} kept as-is (${result.reason || "unchanged"})`;

  const kb = (bytes) => `${Math.round(bytes / 1024)}KB`;
  const saved = Math.round((1 - result.bytesAfter / result.bytesBefore) * 100);
  const size = `${result.width}x${result.height}`;
  const warning = result.undersized
    ? ` — WARNING: ${result.longestEdge}px on its longest edge is below the ${MIN_GOOD_EDGE}px a product tile needs, so it will look soft`
    : "";

  return `[upload] ${name} ${size} ${kb(result.bytesBefore)} → ${kb(result.bytesAfter)} (${saved}% smaller)${warning}`;
}
