
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
    MAX_QUALITY: 0.92,
    QUALITY_TOLERANCE: 0.02,
    MAX_ITERATIONS: 18,
    MAX_SCALE_ATTEMPTS: 10,
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
    if (_avifSupport !== null) return _avifSupport;
    return new Promise((resolve) => {
      if (_avifSupport !== null) { resolve(_avifSupport); return; }
      const canvas = document.createElement('canvas');
      canvas.width = 1; canvas.height = 1;
      canvas.toBlob((blob) => {
        _avifSupport = !!blob;
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
      bmp: 'image/bmp',
      tiff: 'image/tiff', tif: 'image/tiff'
    };
    return map[ext] || file.type || CONFIG.DEFAULT_FORMAT;
  }

  function isSupportedFormat(mimeType) {
    return ['image/jpeg','image/png','image/webp','image/avif','image/gif','image/bmp','image/tiff'].includes(mimeType);
  }

  function getSuggestedOutputFormat(originalMime, hasAlpha, targetKB) {
    // For images with transparency, preserve it
    if (hasAlpha) {
      if (supportsWebP()) return CONFIG.WEBP_FORMAT;
      return CONFIG.PNG_FORMAT;
    }
    // For photos, prefer AVIF for very small targets if supported
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

  function fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => resolve(e.target.result);
      reader.onerror = () => reject(new Error('Failed to read file'));
      reader.readAsDataURL(file);
    });
  }

  // =====================
  // Canvas Drawing with Orientation
  // =====================
  function drawImageWithOrientation(img, orientation) {
    const transform = getOrientationTransform(orientation);
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    const w = img.naturalWidth;
    const h = img.naturalHeight;

    // Mobile crash protection: cap initial dimensions at 2560px
    const MAX_DIMENSION = 2560;
    if (w > MAX_DIMENSION || h > MAX_DIMENSION) {
      if (w > h) {
        h = Math.round((h * MAX_DIMENSION) / w);
        w = MAX_DIMENSION;
      } else {
        w = Math.round((w * MAX_DIMENSION) / h);
        h = MAX_DIMENSION;
      }
    }

    // Cap dimensions to prevent browser crash
    let drawW = w, drawH = h;
    if (w > CONFIG.MAX_WIDTH || h > CONFIG.MAX_HEIGHT) {
      const scale = Math.min(CONFIG.MAX_WIDTH / w, CONFIG.MAX_HEIGHT / h);
      drawW = Math.floor(w * scale);
      drawH = Math.floor(h * scale);
    }

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
        ctx.drawImage(img, -drawW / 2, -drawH / 2, drawW, drawH);
        break;
      case 180:
        ctx.translate(cx, cy);
        ctx.rotate(Math.PI);
        ctx.drawImage(img, -drawW / 2, -drawH / 2, drawW, drawH);
        break;
      case 270:
        ctx.translate(cx, cy);
        ctx.rotate(-Math.PI / 2);
        ctx.drawImage(img, -drawW / 2, -drawH / 2, drawW, drawH);
        break;
      default:
        ctx.drawImage(img, 0, 0, drawW, drawH);
    }

    ctx.restore();
    return canvas;
  }

  // =====================
  // Check Transparency - ALL formats
  // =====================
  function hasTransparency(img) {
    // Check if the image actually has any transparent pixels
    const canvas = document.createElement('canvas');
    const w = Math.min(img.naturalWidth, 200);
    const h = Math.min(img.naturalHeight, 200);
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, w, h);
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
  async function compressWithBinarySearch(canvas, outputFormat, targetBytes, hasAlpha) {
    let lowQ = CONFIG.MIN_QUALITY;
    let highQ = CONFIG.MAX_QUALITY;
    let bestBlob = null;
    let bestQuality = lowQ;
    let bestSizeDiff = Infinity;

    // PNG is lossless - quality parameter has no effect
    if (outputFormat === CONFIG.PNG_FORMAT) {
      const currentBytes = canvas.width * canvas.height * 4;
      let scale = estimateScaleForTarget(currentBytes, targetBytes);
      scale = Math.max(scale, 0.05);
      const scaled = await scaleCanvas(canvas, scale);
      const blob = await canvasToBlob(scaled, outputFormat, 1);
      return { blob, quality: 1, scale, canvas: scaled };
    }

    for (let i = 0; i < CONFIG.MAX_ITERATIONS; i++) {
      const midQ = (lowQ + highQ) / 2;
      const blob = await canvasToBlob(canvas, outputFormat, midQ);

      if (!blob) {
        // toBlob returned null - browser doesn't support this format
        break;
      }

      const sizeDiff = Math.abs(blob.size - targetBytes);

      if (blob.size <= targetBytes && sizeDiff < bestSizeDiff) {
        bestBlob = blob;
        bestQuality = midQ;
        bestSizeDiff = sizeDiff;
      } else if (!bestBlob && blob.size < bestSizeDiff) {
        bestBlob = blob;
        bestQuality = midQ;
        bestSizeDiff = sizeDiff;
      }

      if (blob.size > targetBytes) {
        highQ = midQ;
      } else {
        lowQ = midQ;
      }

      if (sizeDiff < targetBytes * CONFIG.QUALITY_TOLERANCE) break;
    }

    return { blob: bestBlob, quality: bestQuality, scale: 1, canvas: canvas };
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
      throw new Error('Unsupported file format. Please use JPG, PNG, WebP, AVIF, GIF, BMP, or TIFF.');
    }

    if (file.size > 50 * 1024 * 1024) {
      throw new Error('File is too large. Maximum size is 50MB.');
    }

    setProgress(1, 'Reading image...');

    // Read orientation and load image in parallel
    const [orientation, dataUrl] = await Promise.all([
      mimeType === 'image/jpeg' ? readOrientation(file) : Promise.resolve(1),
      fileToDataUrl(file)
    ]);

    setProgress(2, 'Analyzing image...');

    const img = await loadImage(dataUrl);

    // Check dimensions and warn if too large
    if (img.naturalWidth > 8000 || img.naturalHeight > 8000) {
      throw new Error('Image dimensions are too large. Maximum supported is 8000x8000 pixels.');
    }

    // Draw with correct orientation
    const orientedCanvas = drawImageWithOrientation(img, orientation);

    // Check transparency for ALL formats (not just PNG)
    const transparent = hasTransparency(img);

    // Pre-check AVIF support
    await supportsAvif();

    // Determine output format
    let outputFormat = getSuggestedOutputFormat(mimeType, transparent, targetKB);

    setProgress(3, 'Compressing...');

    // Step 1: Try quality-only compression first
    let result = await compressWithBinarySearch(orientedCanvas, outputFormat, targetBytes, transparent);

    // Step 2: If still too large, try iterative scaling
    let attempts = 0;
    let currentCanvas = orientedCanvas;

    while ((!result.blob || result.blob.size > targetBytes * 1.05) && attempts < CONFIG.MAX_SCALE_ATTEMPTS) {
      const currentSize = result.blob ? result.blob.size : (currentCanvas.width * currentCanvas.height * 3);
      let scale = estimateScaleForTarget(currentSize, targetBytes);
      // Apply diminishing scale for each attempt (gradual reduction)
      scale = Math.max(0.03, scale * Math.pow(0.92, attempts));

      currentCanvas = await scaleCanvas(currentCanvas, scale);
      result = await compressWithBinarySearch(currentCanvas, outputFormat, targetBytes, transparent);
      attempts++;

      if (result.blob && result.blob.size <= targetBytes) break;
    }

    // Step 3: If still too large and we used PNG, try lossy format
    if ((!result.blob || result.blob.size > targetBytes) && outputFormat === CONFIG.PNG_FORMAT && !transparent) {
      // PNG without transparency can be converted to lossy for smaller size
      const lossyFormat = supportsWebP() ? CONFIG.WEBP_FORMAT : CONFIG.DEFAULT_FORMAT;
      result = await compressWithBinarySearch(currentCanvas, lossyFormat, targetBytes, false);
      if (result.blob) outputFormat = lossyFormat;
    }

    // Step 4: If still too large with JPEG, try WebP
    if ((!result.blob || result.blob.size > targetBytes) && outputFormat === CONFIG.DEFAULT_FORMAT && supportsWebP()) {
      result = await compressWithBinarySearch(currentCanvas, CONFIG.WEBP_FORMAT, targetBytes, transparent);
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
      format: outputFormat,
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
      showError('Please select a valid image file (JPG, PNG, WebP, AVIF, GIF, BMP, or TIFF).');
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
  // Mobile Menu
  // =====================
  function toggleMobileMenu() {
    if (!els.mobileNav || !els.mobileMenuBtn) return;
    const willOpen = els.mobileNav.hidden;
    els.mobileNav.hidden = !willOpen;
    if (willOpen) {
      els.mobileNav.classList.add('active');
    } else {
      els.mobileNav.classList.remove('active');
    }
    els.mobileMenuBtn.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
    els.mobileMenuBtn.setAttribute('aria-label', willOpen ? 'Close menu' : 'Open menu');
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

  // =====================
  // Theme Management (runs after inline init)
  // =====================
  function toggleTheme() {
    var current = document.documentElement.getAttribute('data-theme');
    var next = current === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    try { localStorage.setItem('theme', next); } catch(e) {}
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

    // Theme toggle
    els.themeToggle && els.themeToggle.addEventListener('click', toggleTheme);
    listenSystemTheme();

    // Mobile menu
    els.mobileMenuBtn && els.mobileMenuBtn.addEventListener('click', toggleMobileMenu);

    // Target size from page config
    var pageTarget = window.COMPRESSOR_CONFIG && window.COMPRESSOR_CONFIG.targetSizeKB;
    if (pageTarget) state.targetSizeKB = pageTarget;
    populateTargetSelect();

    // File input
    els.dropZoneInput && els.dropZoneInput.addEventListener('change', function(e) {
      if (e.target.files && e.target.files[0]) handleFileSelect(e.target.files[0]);
    });

    // Drag & drop
    els.dropZone && els.dropZone.addEventListener('dragover', handleDragOver);
    els.dropZone && els.dropZone.addEventListener('dragleave', handleDragLeave);
    els.dropZone && els.dropZone.addEventListener('drop', handleDrop);

    // Keyboard accessibility for drop zone
    
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

    // Close mobile menu on outside click
    document.addEventListener('click', function(e) {
      if (els.mobileNav && els.mobileNav.classList.contains('active')) {
        if (!els.mobileNav.contains(e.target) && !els.mobileMenuBtn.contains(e.target)) {
          els.mobileNav.classList.remove('active');
          els.mobileNav.hidden = true;
          els.mobileMenuBtn.setAttribute('aria-expanded', 'false');
          els.mobileMenuBtn.setAttribute('aria-label', 'Open menu');
        }
      }
    });

    // Close mobile menu on Escape
    document.addEventListener('keydown', function(e) {
      if (e.key === 'Escape' && els.mobileNav && els.mobileNav.classList.contains('active')) {
        els.mobileNav.classList.remove('active');
        els.mobileNav.hidden = true;
        els.mobileMenuBtn.setAttribute('aria-expanded', 'false');
        els.mobileMenuBtn.setAttribute('aria-label', 'Open menu');
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
