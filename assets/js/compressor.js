
/**
 * Image Compressor Hub - Core Engine v2.0
 * 100% client-side image compression
 * Binary search quality optimization + intelligent dimension scaling
 * Production-ready, audited, and optimized
 */

(function() {
  'use strict';

  // =====================
  // Configuration
  // =====================
  const CONFIG = {
    MAX_WIDTH: 4096,
    MAX_HEIGHT: 4096,
    MIN_QUALITY: 0.05,
    // Previously capped at 0.92, which is a low ceiling for WebP/AVIF specifically -- both are
    // efficient enough that quality 0.92 can already look near-lossless while landing well
    // under a generous target (e.g. a 500KB target ending up at 260-350KB), leaving quality
    // headroom unused. Raised so the search can use it when the target allows.
    MAX_QUALITY: 0.97,
    // How close the final size must land to the target before we stop searching, as a
    // fraction of the target (0.01 = within 1%). Kept tight so a 500KB target reliably lands
    // in the ~495-500KB range instead of stopping early with room left on the table.
    QUALITY_TOLERANCE: 0.01,
    MAX_ITERATIONS: 20,
    MAX_SCALE_ATTEMPTS: 10,
    // Hard wall-clock caps so a slow codec (AVIF encoding in particular can take 500ms-1s+ PER
    // ATTEMPT on a large canvas) can never turn a 20-iteration search into a 20-30+ second
    // freeze. Each individual binary-search call is capped at SEARCH_TIME_MS; the whole
    // compression pipeline (initial search + any rescale attempts) is capped at TOTAL_TIME_MS.
    // Hitting either cap returns the best result found so far instead of continuing to search.
    SEARCH_TIME_MS: 3000,
    TOTAL_TIME_MS: 9000,
    // The deadline above is a worst-case safety net, not the normal exit path -- without a
    // floor, a momentarily slow device/tab (background load, thermal throttling) could cut the
    // search off after only 2-3 iterations, giving a noticeably less precise result than the
    // exact same image would get a moment later. Guaranteeing this many iterations first keeps
    // results consistent run-to-run; the deadline only kicks in beyond this floor.
    MIN_ITERATIONS: 5,
    // PNG has no quality knob (it's lossless), so hitting a target size means binary-searching
    // on pixel dimensions instead, measuring the REAL encoded size at each candidate scale.
    PNG_MIN_SCALE: 0.02,
    PNG_SCALE_ITERATIONS: 16,
    // If a full-resolution decode fails (common on mobile for 48MP+ phone camera photos that
    // exceed the tab's available decode memory), retry asking the browser to decode directly
    // at this size instead of ever allocating the full-resolution pixel buffer.
    BITMAP_RESIZE_FALLBACK: 2000,
    DEFAULT_FORMAT: 'image/jpeg',
    PNG_FORMAT: 'image/png',
    WEBP_FORMAT: 'image/webp',
    AVIF_FORMAT: 'image/avif'
  };

  const TARGET_SIZES = [
    { value: 20, label: '20 KB' },
    { value: 50, label: '50 KB' },
    { value: 75, label: '75 KB' },
    { value: 100, label: '100 KB' },
    { value: 125, label: '125 KB' },
    { value: 150, label: '150 KB' },
    { value: 175, label: '175 KB' },
    { value: 200, label: '200 KB' },
    { value: 225, label: '225 KB' },
    { value: 250, label: '250 KB' },
    { value: 275, label: '275 KB' },
    { value: 300, label: '300 KB' },
    { value: 350, label: '350 KB' },
    { value: 400, label: '400 KB' },
    { value: 450, label: '450 KB' },
    { value: 500, label: '500 KB' }
  ];

  // =====================
  // Cached Feature Detection
  // =====================
  let _webpSupport = null;
  let _avifSupport = null;
  let _originalDataUrlCache = null;
  let _originalFileCache = null;
  let _previousCompressedUrl = null;

  function supportsWebP() {
    if (_webpSupport !== null) return _webpSupport;
    const canvas = document.createElement('canvas');
    canvas.width = 1; canvas.height = 1;
    const dataUrl = canvas.toDataURL(CONFIG.WEBP_FORMAT);
    _webpSupport = dataUrl.indexOf('data:image/webp') === 0;
    return _webpSupport;
  }

  function supportsAvif() {
    if (_avifSupport !== null) return Promise.resolve(_avifSupport);
    return new Promise((resolve) => {
      const canvas = document.createElement('canvas');
      canvas.width = 1; canvas.height = 1;
      canvas.toBlob((blob) => {
        // Per the HTML spec, canvas.toBlob() silently falls back to PNG when
        // the requested type isn't supported by the browser -- so a truthy
        // blob does NOT prove AVIF encoding actually happened. We must check
        // that the browser honoured the requested type.
        _avifSupport = !!blob && blob.type === CONFIG.AVIF_FORMAT;
        resolve(_avifSupport);
      }, CONFIG.AVIF_FORMAT);
    });
  }

  // =====================
  // State
  // =====================
  let state = {
    originalFile: null,
    originalDimensions: { width: 0, height: 0 },
    compressedBlob: null,
    compressedDataUrl: null,
    targetSizeKB: 50,
    isProcessing: false,
    progressStep: 0,
    progressTotal: 4
  };

  // =====================
  // DOM Elements Cache
  // =====================
  let els = {};

  // =====================
  // Utility Functions
  // =====================
  function formatBytes(bytes, decimals) {
    decimals = decimals === undefined ? 1 : decimals;
    if (bytes === 0) return '0 B';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
  }

  function formatPercent(original, compressed) {
    if (!original || !compressed || original <= 0) return '0%';
    const reduction = ((original - compressed) / original) * 100;
    return Math.round(reduction) + '%';
  }

  function getFileExtension(filename) {
    const idx = filename.lastIndexOf('.');
    return idx <= 0 ? '' : filename.slice(idx + 1).toLowerCase();
  }

  function getMimeTypeFromFile(file) {
    const ext = getFileExtension(file.name);
    const map = {
      jpg: 'image/jpeg', jpeg: 'image/jpeg',
      png: 'image/png',
      webp: 'image/webp',
      avif: 'image/avif',
      gif: 'image/gif',
      bmp: 'image/bmp'
    };
    return map[ext] || file.type || CONFIG.DEFAULT_FORMAT;
  }

  function isSupportedFormat(mimeType) {
    return ['image/jpeg','image/png','image/webp','image/avif','image/gif','image/bmp'].includes(mimeType);
  }

  function getSuggestedOutputFormat(originalMime, hasAlpha, targetKB, userFormat) {
    // If user selected a specific format, validate and use it.
    // NOTE: the <select> options carry full MIME strings ("image/jpeg",
    // "image/png", "image/webp", "image/avif"), so we must compare against
    // those exact values -- comparing against short codes like "jpg"/"webp"
    // would never match and would silently fall through to auto-detection,
    // ignoring the user's explicit choice.
    if (userFormat && userFormat !== 'auto') {
      var fmt = userFormat.toLowerCase();
      if (fmt === 'image/jpeg' || fmt === 'image/jpg' || fmt === 'jpg' || fmt === 'jpeg') {
        return CONFIG.DEFAULT_FORMAT;
      }
      if (fmt === 'image/png' || fmt === 'png') {
        return CONFIG.PNG_FORMAT;
      }
      if (fmt === 'image/webp' || fmt === 'webp') {
        return supportsWebP() ? CONFIG.WEBP_FORMAT : CONFIG.DEFAULT_FORMAT;
      }
      if (fmt === 'image/avif' || fmt === 'avif') {
        if (_avifSupport) return CONFIG.AVIF_FORMAT;
        return supportsWebP() ? CONFIG.WEBP_FORMAT : CONFIG.DEFAULT_FORMAT;
      }
    }
    // Auto mode: use existing intelligent selection
    if (hasAlpha) {
      if (supportsWebP()) return CONFIG.WEBP_FORMAT;
      return CONFIG.PNG_FORMAT;
    }
    if (targetKB <= 75 && _avifSupport) {
      return CONFIG.AVIF_FORMAT;
    }
    if (supportsWebP()) return CONFIG.WEBP_FORMAT;
    if (originalMime === CONFIG.PNG_FORMAT) return CONFIG.PNG_FORMAT;
    return CONFIG.DEFAULT_FORMAT;
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  // =====================
  // EXIF Orientation Fix
  // =====================
  // Used only by the fallback decode tiers below that deliberately skip createImageBitmap's
  // 'imageOrientation' option (in case that option itself is what a given browser build
  // chokes on) -- in that case we must determine and apply the rotation ourselves.
  function readOrientation(file) {
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = function(e) {
        try {
          const view = new DataView(e.target.result);
          if (view.getUint16(0, false) !== 0xFFD8) { resolve(1); return; }
          let length = view.byteLength;
          let offset = 2;
          while (offset < length) {
            if (view.getUint8(offset) !== 0xFF) { offset++; continue; }
            const marker = view.getUint8(offset + 1);
            if (marker === 0xD9 || marker === 0xDA) break; // EOI, SOS
            if (marker === 0xE1) { // APP1 (EXIF)
              const segmentLength = view.getUint16(offset + 2, false);
              const exifOffset = offset + 4;
              if (view.getUint32(exifOffset, false) === 0x45786966) { // "Exif"
                const tiffStart = exifOffset + 6;
                const little = view.getUint16(tiffStart, false) === 0x4949;
                const dirOffset = view.getUint32(tiffStart + 4, little) + tiffStart;
                const numEntries = view.getUint16(dirOffset, little);
                for (let i = 0; i < numEntries; i++) {
                  const entryOffset = dirOffset + 2 + i * 12;
                  if (view.getUint16(entryOffset, little) === 0x0112) {
                    resolve(view.getUint16(entryOffset + 8, little));
                    return;
                  }
                }
              }
              offset += 2 + segmentLength;
            } else if (marker >= 0xE0 && marker <= 0xEF) {
              offset += 2 + view.getUint16(offset + 2, false);
            } else if (marker >= 0xD0 && marker <= 0xD9) {
              offset += 2;
            } else {
              offset += 2 + view.getUint16(offset + 2, false);
            }
          }
        } catch (err) {
          // Silently fall back to orientation 1
        }
        resolve(1);
      };
      reader.onerror = () => resolve(1);
      reader.readAsArrayBuffer(file.slice(0, 65536));
    });
  }

  function getOrientationTransform(orientation) {
    const map = {
      1: { rotate: 0, flipH: false },
      2: { rotate: 0, flipH: true },
      3: { rotate: 180, flipH: false },
      4: { rotate: 180, flipH: true },
      5: { rotate: 90, flipH: true },
      6: { rotate: 90, flipH: false },
      7: { rotate: 270, flipH: true },
      8: { rotate: 270, flipH: false }
    };
    return map[orientation] || map[1];
  }

  // =====================
  // Image Loading
  // =====================
  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Failed to load image'));
      img.src = src;
    });
  }

  // =====================
  // Cheap header-only dimension read (no full decode)
  // =====================
  // createImageBitmap's resizeWidth/resizeHeight options do NOT preserve aspect ratio when
  // BOTH are given -- they stretch the decoded image to exactly that box (verified: an 8000x6000
  // source came out a distorted 2000x2000). To ask for a resize that keeps the correct aspect
  // ratio we must supply only ONE of the two dimensions, which means knowing in advance whether
  // the image is wider or taller. This reads just the image header (a few dozen bytes) to get
  // real width/height without decoding any pixels, so it stays cheap even for huge files.
  function readImageDimensionsFromHeader(file) {
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = function(e) {
        try {
          const view = new DataView(e.target.result);
          const len = view.byteLength;

          // PNG: 8-byte signature, then IHDR chunk with width/height as big-endian uint32s.
          if (len > 24 && view.getUint32(0) === 0x89504e47 && view.getUint32(4) === 0x0d0a1a0a) {
            resolve({ width: view.getUint32(16), height: view.getUint32(20) });
            return;
          }

          // JPEG: walk markers looking for a Start-Of-Frame segment.
          if (len > 4 && view.getUint16(0, false) === 0xFFD8) {
            let offset = 2;
            while (offset < len - 8) {
              if (view.getUint8(offset) !== 0xFF) { offset++; continue; }
              const marker = view.getUint8(offset + 1);
              if (marker === 0x01 || (marker >= 0xD0 && marker <= 0xD9)) { offset += 2; continue; }
              const segLen = view.getUint16(offset + 2, false);
              const isSOF = (marker >= 0xC0 && marker <= 0xC3) || (marker >= 0xC5 && marker <= 0xC7) ||
                            (marker >= 0xC9 && marker <= 0xCB) || (marker >= 0xCD && marker <= 0xCF);
              if (isSOF) {
                resolve({ height: view.getUint16(offset + 5, false), width: view.getUint16(offset + 7, false) });
                return;
              }
              offset += 2 + segLen;
            }
          }

          // WebP (lossy VP8, lossless VP8L, extended VP8X).
          if (len > 30 && view.getUint32(0, false) === 0x52494646 && view.getUint32(8, false) === 0x57454250) {
            const fourcc = view.getUint32(12, false);
            if (fourcc === 0x56503820) { // 'VP8 '
              resolve({ width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff });
              return;
            }
            if (fourcc === 0x56503858) { // 'VP8X'
              const w = (view.getUint8(24) | (view.getUint8(25) << 8) | (view.getUint8(26) << 16)) + 1;
              const h = (view.getUint8(27) | (view.getUint8(28) << 8) | (view.getUint8(29) << 16)) + 1;
              resolve({ width: w, height: h });
              return;
            }
            if (fourcc === 0x5650384c) { // 'VP8L'
              const b0 = view.getUint8(21), b1 = view.getUint8(22), b2 = view.getUint8(23), b3 = view.getUint8(24);
              const w = 1 + (((b1 & 0x3f) << 8) | b0);
              const h = 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6));
              resolve({ width: w, height: h });
              return;
            }
          }
        } catch (err) {
          // fall through to null below
        }
        resolve(null);
      };
      reader.onerror = () => resolve(null);
      reader.readAsArrayBuffer(file.slice(0, 65536));
    });
  }

  // =====================
  // Shared dimension capping
  // =====================
  // Used by every decode path so mobile devices never have to hold a canvas larger than they
  // can safely allocate, and so the final compressed pixel dimensions are consistent no matter
  // which decode route produced them.
  function capDimensions(w, h) {
    // Mobile crash protection: cap initial dimensions at 2560px
    const MAX_DIMENSION = 2560;
    let drawW = w, drawH = h;
    if (drawW > MAX_DIMENSION || drawH > MAX_DIMENSION) {
      if (drawW > drawH) {
        drawH = Math.round((drawH * MAX_DIMENSION) / drawW);
        drawW = MAX_DIMENSION;
      } else {
        drawW = Math.round((drawW * MAX_DIMENSION) / drawH);
        drawH = MAX_DIMENSION;
      }
    }
    // Absolute hard cap regardless of device
    if (drawW > CONFIG.MAX_WIDTH || drawH > CONFIG.MAX_HEIGHT) {
      const scale = Math.min(CONFIG.MAX_WIDTH / drawW, CONFIG.MAX_HEIGHT / drawH);
      drawW = Math.floor(drawW * scale);
      drawH = Math.floor(drawH * scale);
    }
    return { width: Math.max(1, drawW), height: Math.max(1, drawH) };
  }

  // =====================
  // Canvas Drawing with Orientation
  // =====================
  // Source-agnostic: works with anything drawImage() accepts (<img> or ImageBitmap). Needed by
  // both the legacy <img> fallback (orientation always 1 there -- modern browsers already
  // auto-rotate <img> pixels) and the createImageBitmap tiers that deliberately skip the
  // 'imageOrientation' option and so must apply EXIF rotation manually.
  function drawSourceWithOrientation(source, srcWidth, srcHeight, orientation, isBitmap) {
    const transform = getOrientationTransform(orientation);
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    const capped = capDimensions(srcWidth, srcHeight);
    const drawW = capped.width, drawH = capped.height;

    const swap = [5,6,7,8].includes(orientation);
    canvas.width = swap ? drawH : drawW;
    canvas.height = swap ? drawW : drawH;

    ctx.save();

    if (transform.flipH) {
      ctx.translate(canvas.width, 0);
      ctx.scale(-1, 1);
    }

    const cx = canvas.width / 2;
    const cy = canvas.height / 2;

    switch (transform.rotate) {
      case 90:
        ctx.translate(cx, cy);
        ctx.rotate(Math.PI / 2);
        ctx.drawImage(source, -drawW / 2, -drawH / 2, drawW, drawH);
        break;
      case 180:
        ctx.translate(cx, cy);
        ctx.rotate(Math.PI);
        ctx.drawImage(source, -drawW / 2, -drawH / 2, drawW, drawH);
        break;
      case 270:
        ctx.translate(cx, cy);
        ctx.rotate(-Math.PI / 2);
        ctx.drawImage(source, -drawW / 2, -drawH / 2, drawW, drawH);
        break;
      default:
        ctx.drawImage(source, 0, 0, drawW, drawH);
    }

    ctx.restore();
    if (isBitmap && typeof source.close === 'function') source.close();
    return canvas;
  }

  function drawImageWithOrientation(img, orientation) {
    return drawSourceWithOrientation(img, img.naturalWidth, img.naturalHeight, orientation, false);
  }

  // =====================
  // ImageBitmap decode path (preferred)
  // =====================
  function supportsCreateImageBitmap() {
    return typeof window !== 'undefined' && typeof window.createImageBitmap === 'function';
  }

  function bitmapToCanvas(bitmap) {
    const capped = capDimensions(bitmap.width, bitmap.height);
    const canvas = document.createElement('canvas');
    canvas.width = capped.width;
    canvas.height = capped.height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0, capped.width, capped.height);
    if (typeof bitmap.close === 'function') bitmap.close();
    return canvas;
  }

  // =====================
  // Decode Pipeline
  // =====================
  // Three tiers, tried in order:
  //   1. createImageBitmap at full resolution -- fast, memory-efficient, auto-orients via EXIF.
  //   2. createImageBitmap asking the browser to decode straight to a smaller size -- this is
  //      the fix for the "Failed to load image" error seen on mobile Chrome with large phone-
  //      camera photos: a plain <img> decode must allocate the FULL-resolution pixel buffer
  //      before anything else can happen, and 48MP/108MP camera sensors (8000x6000 and up)
  //      routinely exceed what a mobile tab is allowed to allocate for that -- so the decode
  //      itself fails before our own downscaling logic ever gets a chance to run. Asking
  //      createImageBitmap to resize DURING decode means that oversized buffer is never
  //      allocated in the first place.
  //   3. Legacy <img> + object URL -- for the rare browser without createImageBitmap support.
  function describeErr(err) {
    if (!err) return 'unknown error';
    var name = err.name ? err.name + ': ' : '';
    return name + (err.message || String(err));
  }

  // Tried in order, falling through on failure:
  //   1. createImageBitmap, full resolution, browser auto-orientation.
  //   2. createImageBitmap, full resolution, NO options at all -- defends against a browser
  //      build where the 'imageOrientation' option itself is what throws (rare, but cheap to
  //      guard against); we then read EXIF and rotate manually.
  //   3. createImageBitmap with a resize hint (+ auto-orientation) -- the fix for large phone-
  //      camera photos exceeding a mobile tab's decode memory budget: asking the browser to
  //      resize DURING decode means the oversized full-res buffer is never allocated.
  //   4. Same resize hint, no options -- same reasoning as (2), for the resize path.
  //   5. Legacy <img> + object URL -- for browsers without createImageBitmap, or as a last
  //      resort if every ImageBitmap attempt above failed.
  // Every failed attempt is logged to the console (invisible to normal users, visible in
  // DevTools) so a future report can be root-caused from real error names instead of guesses.
  async function decodeToCanvas(file, mimeType) {
    const diagnostics = [];

    if (supportsCreateImageBitmap()) {
      try {
        const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
        return bitmapToCanvas(bitmap);
      } catch (err) {
        diagnostics.push('bitmap-full+orientation: ' + describeErr(err));
      }

      try {
        const bitmap = await createImageBitmap(file);
        const orientation = mimeType === 'image/jpeg' ? await readOrientation(file) : 1;
        return drawSourceWithOrientation(bitmap, bitmap.width, bitmap.height, orientation, true);
      } catch (err) {
        diagnostics.push('bitmap-full-plain: ' + describeErr(err));
      }

      // Passing BOTH resizeWidth and resizeHeight stretches the image to that exact box
      // (verified: it silently distorts aspect ratio), so we read the true dimensions from
      // the file header first and only constrain whichever side is longer -- the browser
      // then computes the other side itself, preserving the original aspect ratio.
      const dims = await readImageDimensionsFromHeader(file);
      const resizeBase = {};
      if (dims && dims.width > 0 && dims.height > 0) {
        if (dims.width >= dims.height) {
          resizeBase.resizeWidth = Math.min(dims.width, CONFIG.BITMAP_RESIZE_FALLBACK);
        } else {
          resizeBase.resizeHeight = Math.min(dims.height, CONFIG.BITMAP_RESIZE_FALLBACK);
        }
      } else {
        // Couldn't read a header we recognize (e.g. GIF/BMP) -- fall back to constraining
        // width only. This still shrinks a landscape or square image correctly; a very tall
        // portrait image may decode larger than ideal, but capDimensions() below still caps
        // the final canvas either way, so this is a safe, non-distorting worst case.
        resizeBase.resizeWidth = CONFIG.BITMAP_RESIZE_FALLBACK;
      }

      try {
        const opts = Object.assign({ imageOrientation: 'from-image', resizeQuality: 'high' }, resizeBase);
        const bitmap = await createImageBitmap(file, opts);
        return bitmapToCanvas(bitmap);
      } catch (err) {
        diagnostics.push('bitmap-resize+orientation: ' + describeErr(err));
      }

      try {
        const opts = Object.assign({ resizeQuality: 'high' }, resizeBase);
        const bitmap = await createImageBitmap(file, opts);
        const orientation = mimeType === 'image/jpeg' ? await readOrientation(file) : 1;
        return drawSourceWithOrientation(bitmap, bitmap.width, bitmap.height, orientation, true);
      } catch (err) {
        diagnostics.push('bitmap-resize-plain: ' + describeErr(err));
      }
    }

    try {
      const objectUrl = URL.createObjectURL(file);
      try {
        const img = await loadImage(objectUrl);
        // Modern browsers (Chrome 81+, Safari 13.1+, Firefox 77+, Edge) already auto-rotate an
        // <img> element's decoded pixels per the file's EXIF tag, so passing orientation 1 ("no
        // extra rotation") here is correct -- reapplying our own rotation on top of the
        // browser's would double-rotate 90/270-degree photos.
        return drawImageWithOrientation(img, 1);
      } finally {
        URL.revokeObjectURL(objectUrl);
      }
    } catch (err) {
      diagnostics.push('img-fallback: ' + describeErr(err));
    }

    if (typeof console !== 'undefined' && console.warn) {
      console.warn('[CompressToKB] All image decode attempts failed for "' + (file && file.name) + '": ' + diagnostics.join(' | '));
    }
    throw new Error('All decode attempts failed');
  }

  // =====================
  // Check Transparency - ALL formats
  // =====================
  // Source-agnostic: accepts anything drawImage() accepts (canvas, <img>, ImageBitmap) plus
  // its dimensions, so it works the same regardless of which decode path produced the image.
  function hasTransparency(source, sourceWidth, sourceHeight) {
    const canvas = document.createElement('canvas');
    const w = Math.min(sourceWidth, 200);
    const h = Math.min(sourceHeight, 200);
    canvas.width = w;
    canvas.height = h;
    // willReadFrequently: true tells the browser up front that this canvas will be read back
    // via getImageData() rather than only drawn to the screen, so it can pick a backing store
    // optimized for CPU readback instead of GPU compositing. Without this, Chromium logs a
    // "Multiple readback operations..." performance warning and readback is measurably slower.
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(source, 0, 0, w, h);
    try {
      const data = ctx.getImageData(0, 0, w, h).data;
      for (let i = 3; i < data.length; i += 4) {
        if (data[i] < 255) return true;
      }
    } catch (e) {
      return false;
    }
    return false;
  }

  // =====================
  // Canvas to Blob
  // =====================
  function canvasToBlob(canvas, mimeType, quality) {
    return new Promise((resolve) => {
      canvas.toBlob((blob) => resolve(blob), mimeType, quality);
    });
  }

  // =====================
  // Estimate Scale
  // =====================
  function estimateScaleForTarget(currentBytes, targetBytes) {
    const ratio = targetBytes / Math.max(currentBytes, 1);
    return Math.sqrt(Math.max(ratio, 0.03));
  }

  // =====================
  // Scale Canvas
  // =====================
  async function scaleCanvas(sourceCanvas, scale) {
    const newWidth = Math.max(1, Math.round(sourceCanvas.width * scale));
    const newHeight = Math.max(1, Math.round(sourceCanvas.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = newWidth;
    canvas.height = newHeight;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(sourceCanvas, 0, 0, newWidth, newHeight);
    return canvas;
  }

  // =====================
  // Binary Search Compression
  // =====================
  async function compressWithBinarySearch(canvas, outputFormat, targetBytes, deadline) {
    let lowQ = CONFIG.MIN_QUALITY;
    let highQ = CONFIG.MAX_QUALITY;
    let bestBlob = null;
    let bestQuality = lowQ;
    let bestSizeDiff = Infinity;
    let bestIsUnderTarget = false;
    const hardDeadline = deadline || (Date.now() + CONFIG.SEARCH_TIME_MS);

    for (let i = 0; i < CONFIG.MAX_ITERATIONS; i++) {
      const midQ = (lowQ + highQ) / 2;
      const blob = await canvasToBlob(canvas, outputFormat, midQ);

      if (!blob) {
        // toBlob returned null - browser doesn't support this format
        break;
      }

      const sizeDiff = Math.abs(blob.size - targetBytes);
      const isUnderTarget = blob.size <= targetBytes;

      // Once we've found ANY candidate that fits within the target, an over-target candidate
      // can never replace it -- overshooting the user's requested size is never an acceptable
      // trade for a numerically closer size. Before that point, we track the closest
      // over-target attempt as a best-effort fallback (used only if the target truly can't be
      // reached by quality alone, e.g. even minimum quality is still too big).
      const isBetter = isUnderTarget
        ? (!bestIsUnderTarget || sizeDiff < bestSizeDiff)
        : (!bestIsUnderTarget && sizeDiff < bestSizeDiff);

      if (isBetter) {
        bestBlob = blob;
        bestQuality = midQ;
        bestSizeDiff = sizeDiff;
        bestIsUnderTarget = isUnderTarget;
      }

      if (blob.size > targetBytes) {
        highQ = midQ;
      } else {
        lowQ = midQ;
      }

      if (isUnderTarget && sizeDiff < targetBytes * CONFIG.QUALITY_TOLERANCE) break;

      // A slow codec (WebP/AVIF especially) can take 500ms-1s+ per attempt on a large canvas --
      // without this, a device/format combo that never hits the tolerance above would run the
      // full MAX_ITERATIONS regardless of how long that actually takes in wall-clock time. The
      // MIN_ITERATIONS floor keeps results consistent run-to-run (see CONFIG comment).
      if (i + 1 >= CONFIG.MIN_ITERATIONS && Date.now() >= hardDeadline) break;
    }

    return { blob: bestBlob, quality: bestQuality, scale: 1, canvas: canvas };
  }

  // =====================
  // PNG Target-Size Compression
  // =====================
  // PNG is lossless, so there is no quality knob to search over -- the only lever available is
  // pixel dimensions. The previous approach *estimated* a scale from the theoretical
  // uncompressed bitmap size (width * height * 4 bytes/px) and applied it once. Real PNG
  // compression ratios vary hugely with image content and are almost always far smaller than
  // that raw estimate, so that formula reliably overestimated how much shrinking was needed --
  // e.g. a 500KB target landing around 160KB. Instead we binary-search on scale and measure the
  // REAL encoded size at each candidate, the same way the lossy path searches on quality.
  // =====================
  // Resolution-based Target-Size Compression (PNG, AVIF)
  // =====================
  // Used for any format where canvas.toBlob's quality parameter doesn't (usefully) control
  // output size, so the only lever available is pixel dimensions -- same approach as the PNG
  // fix above: binary-search on scale, measuring the REAL encoded size at each candidate.
  //
  // AVIF needs this too: per the Canvas API spec, the quality argument to canvas.toBlob only
  // applies "if the requested type is image/jpeg or image/webp" -- for every other type
  // (including image/avif) the browser's default quality is used regardless of what's passed.
  // Confirmed empirically: canvas.toBlob(canvas, 'image/avif', q) produced byte-identical output
  // for q from 0.5 to 1.0. The previous code ran AVIF through the same quality-based binary
  // search as JPEG/WebP, which wasted many iterations with zero effect (each one still doing a
  // real, somewhat expensive AVIF encode) and only ever shrank the file via the outer
  // resolution-fallback loop -- slow AND imprecise. Routing AVIF here instead searches the one
  // lever that actually works, directly.
  async function compressByScaleSearch(canvas, outputFormat, targetBytes, deadline) {
    const hardDeadline = deadline || (Date.now() + CONFIG.SEARCH_TIME_MS);
    const fullBlob = await canvasToBlob(canvas, outputFormat, 1);
    if (!fullBlob) {
      return { blob: null, quality: 1, scale: 1, canvas: canvas };
    }
    // Already fits at full resolution -- that's the best possible quality, no need to shrink.
    if (fullBlob.size <= targetBytes) {
      return { blob: fullBlob, quality: 1, scale: 1, canvas: canvas };
    }

    let loScale = CONFIG.PNG_MIN_SCALE;
    let hiScale = 1;
    let bestBlob = null;
    let bestScale = loScale;
    let bestCanvas = canvas;

    for (let i = 0; i < CONFIG.PNG_SCALE_ITERATIONS; i++) {
      const midScale = (loScale + hiScale) / 2;
      const scaledCanvas = await scaleCanvas(canvas, midScale);
      const blob = await canvasToBlob(scaledCanvas, outputFormat, 1);

      if (!blob) {
        hiScale = midScale;
        continue;
      }

      if (blob.size <= targetBytes) {
        // Fits -- keep it if it's the largest (best quality) fit found so far, then try a
        // larger scale to see if we can get even closer to the target from below.
        if (!bestBlob || blob.size > bestBlob.size) {
          bestBlob = blob;
          bestScale = midScale;
          bestCanvas = scaledCanvas;
        }
        loScale = midScale;
      } else {
        hiScale = midScale;
      }

      if (hiScale - loScale < 0.004) break;
      if (i + 1 >= CONFIG.MIN_ITERATIONS && Date.now() >= hardDeadline) break;
    }

    if (!bestBlob) {
      // Even the smallest scale tried didn't fit (extremely rare -- e.g. dense noise at a very
      // small target). Return the smallest attempt as a best-effort result rather than nothing.
      const scaledCanvas = await scaleCanvas(canvas, loScale);
      const blob = await canvasToBlob(scaledCanvas, outputFormat, 1);
      return { blob, quality: 1, scale: loScale, canvas: scaledCanvas };
    }

    return { blob: bestBlob, quality: 1, scale: bestScale, canvas: bestCanvas };
  }

  // =====================
  // Progress Updates
  // =====================
  function setProgress(step, label) {
    state.progressStep = step;
    if (!els.progressLabel || !els.progressFill) return;
    const pct = Math.round((step / state.progressTotal) * 100);
    els.progressFill.style.width = pct + '%';
    els.progressLabel.textContent = label || ('Step ' + step + ' of ' + state.progressTotal);
  }

  // =====================
  // Main Compression Pipeline
  // =====================
  async function compressImage(file, targetKB) {
    const targetBytes = targetKB * 1024;
    const mimeType = getMimeTypeFromFile(file);

    if (!isSupportedFormat(mimeType)) {
      throw new Error('Unsupported file format. Please use JPG, PNG, WebP, AVIF, GIF, or BMP.');
    }

    if (file.size > 50 * 1024 * 1024) {
      throw new Error('File is too large. Maximum size is 50MB.');
    }

    setProgress(1, 'Reading image...');

    // Decode the file into an oriented, size-capped canvas. This goes through
    // createImageBitmap first (memory-efficient, auto-orients via EXIF, and retries with a
    // resize hint if the full-resolution decode fails -- the fix for "Failed to load image" on
    // mobile with large phone-camera photos), falling back to <img> for older browsers.
    let orientedCanvas;
    try {
      orientedCanvas = await decodeToCanvas(file, mimeType);
    } catch (err) {
      throw new Error('Could not load this image. It may be corrupted or in a format your browser can\'t decode. Please try a different file.');
    }

    setProgress(2, 'Analyzing image...');

    // Check transparency for ALL formats (not just PNG)
    const transparent = hasTransparency(orientedCanvas, orientedCanvas.width, orientedCanvas.height);

    // Pre-check AVIF support
    await supportsAvif();

    // Determine output format
    // Check for user-selected output format
    var formatSelect = document.getElementById('output-format-select');
    var userFormat = formatSelect ? formatSelect.value : 'auto';
    let outputFormat = getSuggestedOutputFormat(mimeType, transparent, targetKB, userFormat);

    setProgress(3, 'Compressing...');

    // Overall wall-clock budget for the ENTIRE compression pipeline below. Each individual
    // binary search is already capped at CONFIG.SEARCH_TIME_MS, but without this, a device/
    // format combo slow enough to hit that cap on every attempt could still chain several
    // attempts back-to-back into a long freeze (e.g. AVIF: several rescale attempts x several
    // seconds each). Once this is exceeded, we stop trying to get closer and ship the best
    // result found so far rather than continuing to search.
    const overallDeadline = Date.now() + CONFIG.TOTAL_TIME_MS;
    function nextDeadline() {
      return Math.min(Date.now() + CONFIG.SEARCH_TIME_MS, overallDeadline);
    }

    let result;
    let currentCanvas = orientedCanvas;

    if (outputFormat === CONFIG.PNG_FORMAT || outputFormat === CONFIG.AVIF_FORMAT) {
      // PNG is lossless, and AVIF's quality parameter is a documented no-op in the Canvas API --
      // both fit the target by measured-size binary search on scale (see compressByScaleSearch),
      // not by a quality search that has no real effect for AVIF.
      result = await compressByScaleSearch(orientedCanvas, outputFormat, targetBytes, nextDeadline());
      if (result.canvas) currentCanvas = result.canvas;
    } else {
      // Step 1: Try quality-only compression first
      result = await compressWithBinarySearch(orientedCanvas, outputFormat, targetBytes, nextDeadline());

      // Step 2: If still too large, try iterative scaling (bounded by both attempt count and
      // the overall time budget -- whichever comes first)
      let attempts = 0;
      while (
        (!result.blob || result.blob.size > targetBytes * 1.05) &&
        attempts < CONFIG.MAX_SCALE_ATTEMPTS &&
        Date.now() < overallDeadline
      ) {
        const currentSize = result.blob ? result.blob.size : (currentCanvas.width * currentCanvas.height * 3);
        let scale = estimateScaleForTarget(currentSize, targetBytes);
        // Apply diminishing scale for each attempt (gradual reduction)
        scale = Math.max(0.03, scale * Math.pow(0.92, attempts));

        currentCanvas = await scaleCanvas(currentCanvas, scale);
        result = await compressWithBinarySearch(currentCanvas, outputFormat, targetBytes, nextDeadline());
        attempts++;

        if (result.blob && result.blob.size <= targetBytes) break;
      }
    }

    // Step 3: If still too large and we used PNG, try lossy format
    // Only auto-override if user did NOT explicitly select PNG
    if ((!result.blob || result.blob.size > targetBytes) && outputFormat === CONFIG.PNG_FORMAT && !transparent && userFormat === 'auto') {
      const lossyFormat = supportsWebP() ? CONFIG.WEBP_FORMAT : CONFIG.DEFAULT_FORMAT;
      result = await compressWithBinarySearch(currentCanvas, lossyFormat, targetBytes, nextDeadline());
      if (result.blob) outputFormat = lossyFormat;
    }

    // Step 4: If still too large with JPEG, try WebP
    // Only auto-override if user did NOT explicitly select JPEG
    if ((!result.blob || result.blob.size > targetBytes) && outputFormat === CONFIG.DEFAULT_FORMAT && supportsWebP() && userFormat === 'auto') {
      result = await compressWithBinarySearch(currentCanvas, CONFIG.WEBP_FORMAT, targetBytes, nextDeadline());
      if (result.blob) outputFormat = CONFIG.WEBP_FORMAT;
    }

    if (!result.blob) {
      throw new Error('Compression failed. Your browser may not support the required image format, or the image may be too complex to compress to the target size.');
    }

    // Clean up previous blob URL to prevent memory leak
    if (_previousCompressedUrl) {
      URL.revokeObjectURL(_previousCompressedUrl);
      _previousCompressedUrl = null;
    }

    const compressedUrl = URL.createObjectURL(result.blob);
    _previousCompressedUrl = compressedUrl;

    setProgress(4, 'Done');

    return {
      blob: result.blob,
      dataUrl: compressedUrl,
      originalSize: file.size,
      compressedSize: result.blob.size,
      originalDimensions: {
        width: orientedCanvas.width,
        height: orientedCanvas.height
      },
      compressedDimensions: {
        width: result.canvas ? result.canvas.width : orientedCanvas.width,
        height: result.canvas ? result.canvas.height : orientedCanvas.height
      },
      // Always trust the actual encoded blob's MIME type over the format we
      // merely intended to request. Per the HTML spec, canvas.toBlob() can
      // silently substitute a different format (typically PNG) when the
      // requested type isn't actually supported by the browser -- so
      // outputFormat is only a request, not a guarantee. Using blob.type
      // here ensures the on-screen label and the downloaded file's
      // extension always match what was truly produced, never what was
      // merely asked for.
      format: result.blob.type || outputFormat,
      quality: result.quality,
      reachedTarget: result.blob.size <= targetBytes,
      targetSize: targetKB
    };
  }

  // =====================
  // UI Updates
  // =====================
  function showError(message) {
    if (!els.alertBox) return;
    els.alertBox.className = 'alert alert-error';
    els.alertBox.innerHTML = '<svg class="alert-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg><span>' + escapeHtml(message) + '</span>';
    els.alertBox.style.display = 'flex';
    els.alertBox.setAttribute('role', 'alert');
  }

  function showWarning(message) {
    if (!els.alertBox) return;
    els.alertBox.className = 'alert alert-warning';
    els.alertBox.innerHTML = '<svg class="alert-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/></svg><span>' + escapeHtml(message) + '</span>';
    els.alertBox.style.display = 'flex';
    els.alertBox.setAttribute('role', 'alert');
  }

  function showSuccess(message) {
    if (!els.alertBox) return;
    els.alertBox.className = 'alert alert-success';
    els.alertBox.innerHTML = '<svg class="alert-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"/></svg><span>' + escapeHtml(message) + '</span>';
    els.alertBox.style.display = 'flex';
    els.alertBox.setAttribute('role', 'status');
  }

  function clearAlert() {
    if (!els.alertBox) return;
    els.alertBox.style.display = 'none';
    els.alertBox.innerHTML = '';
    els.alertBox.removeAttribute('role');
  }

  function setProcessing(isProcessing) {
    state.isProcessing = isProcessing;
    if (els.processingOverlay) {
      els.processingOverlay.classList.toggle('active', isProcessing);
    }
    if (els.compressBtn) {
      els.compressBtn.disabled = isProcessing || !state.originalFile;
    }
  }

  function updateFileInfo(file) {
    if (!els.fileInfo) return;
    els.fileInfo.textContent = file.name + ' (' + formatBytes(file.size) + ')';
  }

  function updatePreview(result) {
    if (!els.previewArea) return;

    els.previewArea.classList.add('active');

    // Original preview (use cache if available)
    if (els.originalPreview) {
      const url = _originalDataUrlCache || '';
      if (url) {
        els.originalPreview.innerHTML = '<img src="' + url + '" alt="Original image" loading="lazy">';
      }
    }

    // Compressed preview
    if (els.compressedPreview) {
      els.compressedPreview.innerHTML = '<img src="' + result.dataUrl + '" alt="Compressed image" loading="lazy">';
    }

    // Stats bar
    if (els.originalSize) els.originalSize.textContent = formatBytes(result.originalSize);
    if (els.compressedSize) els.compressedSize.textContent = formatBytes(result.compressedSize);
    if (els.compressionPercent) {
      els.compressionPercent.innerHTML = '<span class="compression-badge">-' + formatPercent(result.originalSize, result.compressedSize) + '</span>';
    }
    if (els.targetStatus) {
      if (result.reachedTarget) {
        els.targetStatus.innerHTML = '<span style="color:var(--success);font-weight:700;">Target reached</span>';
      } else {
        els.targetStatus.innerHTML = '<span style="color:var(--warning);font-weight:700;">Best effort (' + formatBytes(result.compressedSize) + ')</span>';
      }
    }

    // Preview card meta
    if (els.originalDimensions) els.originalDimensions.textContent = result.originalDimensions.width + ' x ' + result.originalDimensions.height;
    if (els.originalSizeMeta) els.originalSizeMeta.textContent = formatBytes(result.originalSize);
    if (els.compressedDimensions) els.compressedDimensions.textContent = result.compressedDimensions.width + ' x ' + result.compressedDimensions.height;
    if (els.outputFormat) els.outputFormat.textContent = result.format.replace('image/', '').replace('jpeg', 'jpg').toUpperCase();

    // Download button
    if (els.downloadBtn) {
      els.downloadBtn.disabled = false;
      els.downloadBtn.onclick = function() {
        const link = document.createElement('a');
        link.href = result.dataUrl;
        const ext = result.format.replace('image/', '').replace('jpeg', 'jpg');
        const baseName = state.originalFile.name.replace(/\.[^/.]+$/, '');
        link.download = baseName + '-compressed-' + result.targetSize + 'kb.' + ext;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
      };
    }

    state.compressedBlob = result.blob;
    state.compressedDataUrl = result.dataUrl;

    if (!result.reachedTarget) {
      showWarning(
        'The image could not be compressed to ' + result.targetSize + 'KB without significant quality loss. ' +
        'The best achievable size is ' + formatBytes(result.compressedSize) + '. ' +
        'Consider using a smaller original image or a higher target size.'
      );
    } else {
      showSuccess('Image compressed successfully to ' + formatBytes(result.compressedSize) + '.');
    }
  }

  function resetCompressor() {
    state.originalFile = null;
    state.originalDimensions = { width: 0, height: 0 };
    state.compressedBlob = null;
    if (state.compressedDataUrl) {
      URL.revokeObjectURL(state.compressedDataUrl);
      state.compressedDataUrl = null;
    }
    if (_previousCompressedUrl) {
      URL.revokeObjectURL(_previousCompressedUrl);
      _previousCompressedUrl = null;
    }
    if (_originalDataUrlCache) {
      URL.revokeObjectURL(_originalDataUrlCache);
    }
    _originalDataUrlCache = null;
    _originalFileCache = null;

    if (els.previewArea) els.previewArea.classList.remove('active');
    if (els.fileInfo) els.fileInfo.textContent = '';
    if (els.dropZoneInput) els.dropZoneInput.value = '';
    if (els.compressBtn) els.compressBtn.disabled = true;
    if (els.downloadBtn) els.downloadBtn.disabled = true;
    if (els.originalPreview) els.originalPreview.innerHTML = '';
    if (els.compressedPreview) els.compressedPreview.innerHTML = '';
    clearAlert();
  }

  // =====================
  // Event Handlers
  // =====================
  function handleFileSelect(file) {
    if (!file) return;
    clearAlert();

    const mimeType = getMimeTypeFromFile(file);
    if (!isSupportedFormat(mimeType)) {
      showError('Please select a valid image file (JPG, PNG, WebP, AVIF, GIF, or BMP).');
      return;
    }
    if (file.size > 50 * 1024 * 1024) {
      showError('File is too large. Maximum size is 50MB.');
      return;
    }

    state.originalFile = file;
    _originalFileCache = file;
    updateFileInfo(file);
    if (els.compressBtn) els.compressBtn.disabled = false;

    // Revoke previous object URL before creating new one (prevent memory leak)
    if (_originalDataUrlCache) {
      URL.revokeObjectURL(_originalDataUrlCache);
    }
    // Use object URL for original preview (memory efficient)
    var objectUrl = URL.createObjectURL(file);
    _originalDataUrlCache = objectUrl;
    if (els.originalPreview) {
      els.originalPreview.innerHTML = '<img src="' + objectUrl + '" alt="Original image" loading="lazy">';
    }
  }

  async function handleCompress() {
    if (!state.originalFile || state.isProcessing) return;

    clearAlert();
    setProcessing(true);
    await new Promise(function(r) { setTimeout(r, 30); });

    try {
      const targetKB = parseInt(els.targetSizeSelect && els.targetSizeSelect.value ? els.targetSizeSelect.value : '50', 10);
      state.targetSizeKB = targetKB;
      const result = await compressImage(state.originalFile, targetKB);
      updatePreview(result);
    } catch (err) {
      showError(err.message || 'An error occurred during compression.');
    } finally {
      setProcessing(false);
      setProgress(0, '');
    }
  }

  function handleDragOver(e) {
    e.preventDefault();
    e.stopPropagation();
    els.dropZone && els.dropZone.classList.add('drag-over');
  }

  function handleDragLeave(e) {
    e.preventDefault();
    e.stopPropagation();
    els.dropZone && els.dropZone.classList.remove('drag-over');
  }

  function handleDrop(e) {
    e.preventDefault();
    e.stopPropagation();
    els.dropZone && els.dropZone.classList.remove('drag-over');
    var files = e.dataTransfer && e.dataTransfer.files;
    if (files && files.length > 0) handleFileSelect(files[0]);
  }

  function handleDropZoneKeyDown(e) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      els.dropZoneInput && els.dropZoneInput.click();
    }
  }

  // =====================
  // Populate Target Size Select
  // =====================
  function populateTargetSelect() {
    if (!els.targetSizeSelect) return;
    els.targetSizeSelect.innerHTML = '';
    for (var i = 0; i < TARGET_SIZES.length; i++) {
      var t = TARGET_SIZES[i];
      var opt = document.createElement('option');
      opt.value = t.value;
      opt.textContent = t.label;
      if (t.value === state.targetSizeKB) opt.selected = true;
      els.targetSizeSelect.appendChild(opt);
    }
  }

  // Listen for system theme changes
  function listenSystemTheme() {
    var mq = window.matchMedia('(prefers-color-scheme: dark)');
    if (mq.addEventListener) {
      mq.addEventListener('change', function(e) {
        try {
          var stored = localStorage.getItem('theme');
          if (!stored) {
            document.documentElement.setAttribute('data-theme', e.matches ? 'dark' : 'light');
          }
        } catch(err) {}
      });
    }
  }

  // =====================
  // Initialize
  // =====================
  function init() {
    els = {
      dropZone: document.getElementById('drop-zone'),
      dropZoneInput: document.getElementById('drop-zone-input'),
      targetSizeSelect: document.getElementById('target-size'),
      outputFormatSelect: document.getElementById('output-format-select'),
      compressBtn: document.getElementById('compress-btn'),
      downloadBtn: document.getElementById('download-btn'),
      resetBtn: document.getElementById('reset-btn'),
      previewArea: document.getElementById('preview-area'),
      originalPreview: document.getElementById('original-preview'),
      compressedPreview: document.getElementById('compressed-preview'),
      originalSize: document.getElementById('original-size'),
      compressedSize: document.getElementById('compressed-size'),
      originalDimensions: document.getElementById('original-dimensions'),
      compressedDimensions: document.getElementById('compressed-dimensions'),
      originalSizeMeta: document.getElementById('original-size-meta'),
      outputFormat: document.getElementById('output-format'),
      compressionPercent: document.getElementById('compression-percent'),
      targetStatus: document.getElementById('target-status'),
      fileInfo: document.getElementById('file-info'),
      alertBox: document.getElementById('alert-box'),
      processingOverlay: document.getElementById('processing-overlay'),
      progressFill: document.getElementById('progress-fill'),
      progressLabel: document.getElementById('progress-label'),
      themeToggle: document.getElementById('theme-toggle'),
      mobileMenuBtn: document.getElementById('mobile-menu-btn'),
      mobileNav: document.getElementById('mobile-nav')
    };

    // Theme toggle and mobile menu are handled globally by main.js on every
    // page (including pages that don't load this file), so this tool script
    // must not attach its own duplicate handlers here -- doing so previously
    // caused both handlers to fire on a single click and cancel each other
    // out, making the theme button and mobile menu appear completely broken.
    listenSystemTheme();

    // Target size from page config
    var pageTarget = window.COMPRESSOR_CONFIG && window.COMPRESSOR_CONFIG.targetSizeKB;
    if (pageTarget) state.targetSizeKB = pageTarget;
    populateTargetSelect();

    // File input
    els.dropZoneInput && els.dropZoneInput.addEventListener('change', function(e) {
      if (e.target.files && e.target.files[0]) handleFileSelect(e.target.files[0]);
    });

    // Click to browse (div-based drop zone, not label)
    els.dropZone && els.dropZone.addEventListener('click', function(e) {
      // Only trigger if click is NOT on the file input itself (which is already clickable)
      if (e.target !== els.dropZoneInput) {
        els.dropZoneInput && els.dropZoneInput.click();
      }
    });

    // Drag & drop
    els.dropZone && els.dropZone.addEventListener('dragover', handleDragOver);
    els.dropZone && els.dropZone.addEventListener('dragleave', handleDragLeave);
    els.dropZone && els.dropZone.addEventListener('drop', handleDrop);

    // Keyboard accessibility for drop zone
    els.dropZone && els.dropZone.addEventListener('keydown', handleDropZoneKeyDown);

    // Compress button
    els.compressBtn && els.compressBtn.addEventListener('click', handleCompress);
    els.resetBtn && els.resetBtn.addEventListener('click', resetCompressor);

    // Keyboard shortcut
    document.addEventListener('keydown', function(e) {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && els.compressBtn && !els.compressBtn.disabled) {
        e.preventDefault();
        handleCompress();
      }
    });
  }

  // Expose API
  window.COMPRESSOR_CONFIG = window.COMPRESSOR_CONFIG || {};
  window.ImageCompressor = {
    setTargetSize: function(kb) {
      state.targetSizeKB = kb;
      populateTargetSelect();
    },
    getState: function() { return { ...state }; },
    compress: handleCompress,
    reset: resetCompressor
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
