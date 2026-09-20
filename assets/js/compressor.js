(function() {
  'use strict';

  // Elements
  const dropZone = document.getElementById('drop-zone');
  const fileInput = document.getElementById('drop-zone-input');
  const fileInfo = document.getElementById('file-info');
  const targetSizeSelect = document.getElementById('target-size');
  const compressBtn = document.getElementById('compress-btn');
  const alertBox = document.getElementById('alert-box');
  const previewArea = document.getElementById('preview-area');
  const processingOverlay = document.getElementById('processing-overlay');
  const progressFill = document.getElementById('progress-fill');
  const progressLabel = document.getElementById('progress-label');

  // Preview elements
  const originalPreview = document.getElementById('original-preview');
  const compressedPreview = document.getElementById('compressed-preview');
  const originalSize = document.getElementById('original-size');
  const originalSizeMeta = document.getElementById('original-size-meta');
  const originalDimensions = document.getElementById('original-dimensions');
  const compressedSize = document.getElementById('compressed-size');
  const compressedDimensions = document.getElementById('compressed-dimensions');
  const outputFormat = document.getElementById('output-format');
  const compressionPercent = document.getElementById('compression-percent');
  const targetStatus = document.getElementById('target-status');
  const downloadBtn = document.getElementById('download-btn');
  const resetBtn = document.getElementById('reset-btn');

  let currentFile = null;
  let originalImage = null;
  let compressedBlob = null;
  let compressedUrl = null;
  let originalUrl = null;

  // Set default target size from page configuration
  if (window.COMPRESSOR_CONFIG && window.COMPRESSOR_CONFIG.targetSizeKB) {
    if (targetSizeSelect) {
      targetSizeSelect.value = String(window.COMPRESSOR_CONFIG.targetSizeKB);
    }
  }

  // Format Bytes helper
  function formatBytes(bytes) {
    if (bytes === 0) return '0 KB';
    const kb = bytes / 1024;
    if (kb >= 1024) {
      return (kb / 1024).toFixed(2) + ' MB';
    }
    return kb.toFixed(1) + ' KB';
  }

  function showAlert(message, type) {
    if (!alertBox) return;
    alertBox.className = 'alert alert-' + (type || 'error');
    alertBox.textContent = message;
    alertBox.style.display = 'block';
  }

  function hideAlert() {
    if (alertBox) alertBox.style.display = 'none';
  }

  // File Selection
  function handleFile(file) {
    hideAlert();
    if (!file) return;

    if (!file.type.startsWith('image/')) {
      showAlert('Please upload a valid image file (JPG, PNG, WebP, etc.).', 'error');
      return;
    }

    if (file.size > 50 * 1024 * 1024) {
      showAlert('File is larger than 50MB. Please select a smaller file.', 'error');
      return;
    }

    currentFile = file;
    if (fileInfo) {
      fileInfo.textContent = 'Selected: ' + file.name + ' (' + formatBytes(file.size) + ')';
    }

    if (compressBtn) compressBtn.disabled = false;

    // Load original image preview
    if (originalUrl) URL.revokeObjectURL(originalUrl);
    originalUrl = URL.createObjectURL(file);

    const img = new Image();
    img.onload = function() {
      originalImage = img;
      if (originalDimensions) originalDimensions.textContent = img.naturalWidth + ' × ' + img.naturalHeight;
      if (originalSize) originalSize.textContent = formatBytes(file.size);
      if (originalSizeMeta) originalSizeMeta.textContent = formatBytes(file.size);

      if (originalPreview) {
        originalPreview.innerHTML = '';
        const previewImg = document.createElement('img');
        previewImg.src = originalUrl;
        previewImg.alt = 'Original preview';
        originalPreview.appendChild(previewImg);
      }
    };
    img.src = originalUrl;
  }

  // Drag & Drop
  if (dropZone && fileInput) {
    ['dragenter', 'dragover'].forEach(eventName => {
      dropZone.addEventListener(eventName, function(e) {
        e.preventDefault();
        dropZone.classList.add('drag-over');
      }, false);
    });

    ['dragleave', 'drop'].forEach(eventName => {
      dropZone.addEventListener(eventName, function(e) {
        e.preventDefault();
        dropZone.classList.remove('drag-over');
      }, false);
    });

    dropZone.addEventListener('drop', function(e) {
      if (e.dataTransfer && e.dataTransfer.files.length > 0) {
        fileInput.files = e.dataTransfer.files;
        handleFile(e.dataTransfer.files[0]);
      }
    });

    fileInput.addEventListener('change', function() {
      if (fileInput.files && fileInput.files.length > 0) {
        handleFile(fileInput.files[0]);
      }
    });
  }

  // Check if image has transparency
  function hasAlphaChannel(ctx, width, height) {
    try {
      const imgData = ctx.getImageData(0, 0, width, height).data;
      for (let i = 3; i < imgData.length; i += 4) {
        if (imgData[i] < 255) return true;
      }
    } catch (e) {}
    return false;
  }

  // Core Compression Process
  async function startCompression() {
    if (!currentFile || !originalImage) return;

    hideAlert();
    if (processingOverlay) processingOverlay.classList.add('active');
    if (progressFill) progressFill.style.width = '10%';
    if (progressLabel) progressLabel.textContent = 'Analyzing image...';

    const targetKB = parseInt(targetSizeSelect.value, 10);
    const targetBytes = targetKB * 1024;

    setTimeout(async function() {
      try {
        let width = originalImage.naturalWidth;
        let height = originalImage.naturalHeight;

        const canvas = document.createElement('canvas');
        let ctx = canvas.getContext('2d');
        canvas.width = width;
        canvas.height = height;
        ctx.drawImage(originalImage, 0, 0);

        // Determine output MIME type
        const isPng = currentFile.type === 'image/png';
        const hasAlpha = isPng && hasAlphaChannel(ctx, Math.min(width, 100), Math.min(height, 100));
        let mimeType = 'image/jpeg';

        // Check if WebP is supported
        const isWebpSupported = canvas.toDataURL('image/webp').indexOf('data:image/webp') === 0;
        if (isWebpSupported) {
          mimeType = 'image/webp'; // Best compression for web & transparency
        } else if (hasAlpha) {
          mimeType = 'image/png';
        }

        let bestBlob = null;
        let attempts = 0;
        let currentScale = 1.0;

        // Helper to convert canvas to blob promise
        const getBlob = (cvs, q) => new Promise(res => cvs.toBlob(res, mimeType, q));

        // Binary Search for optimal quality & dimension scaling
        while (attempts < 6) {
          attempts++;
          let minQ = 0.05;
          let maxQ = 0.95;
          let lastValidBlob = null;

          if (progressFill) progressFill.style.width = (attempts * 15 + 20) + '%';
          if (progressLabel) progressLabel.textContent = 'Optimizing quality (Pass ' + attempts + ')...';

          for (let i = 0; i < 7; i++) {
            const midQ = (minQ + maxQ) / 2;
            const testBlob = await getBlob(canvas, midQ);

            if (testBlob.size <= targetBytes) {
              lastValidBlob = testBlob;
              minQ = midQ; // Try higher quality
            } else {
              maxQ = midQ; // Reduce quality
            }
          }

          if (lastValidBlob) {
            bestBlob = lastValidBlob;
            break; // Target successfully achieved!
          }

          // If lowest quality is still too large, downscale dimensions
          const testMinBlob = await getBlob(canvas, 0.08);
          if (testMinBlob.size > targetBytes) {
            currentScale *= Math.max(0.65, Math.sqrt(targetBytes / testMinBlob.size) * 0.92);
            width = Math.max(80, Math.floor(originalImage.naturalWidth * currentScale));
            height = Math.max(80, Math.floor(originalImage.naturalHeight * currentScale));

            canvas.width = width;
            canvas.height = height;
            ctx = canvas.getContext('2d');
            ctx.drawImage(originalImage, 0, 0, width, height);
          } else {
            bestBlob = testMinBlob;
            break;
          }
        }

        if (!bestBlob) {
          bestBlob = await getBlob(canvas, 0.05);
        }

        // Show Results
        compressedBlob = bestBlob;
        if (compressedUrl) URL.revokeObjectURL(compressedUrl);
        compressedUrl = URL.createObjectURL(compressedBlob);

        if (compressedPreview) {
          compressedPreview.innerHTML = '';
          const compImg = document.createElement('img');
          compImg.src = compressedUrl;
          compImg.alt = 'Compressed preview';
          compressedPreview.appendChild(compImg);
        }

        if (compressedSize) compressedSize.textContent = formatBytes(compressedBlob.size);
        if (compressedDimensions) compressedDimensions.textContent = canvas.width + ' × ' + canvas.height;
        if (outputFormat) outputFormat.textContent = mimeType.replace('image/', '').toUpperCase();

        const reduction = Math.max(0, ((currentFile.size - compressedBlob.size) / currentFile.size) * 100);
        if (compressionPercent) compressionPercent.textContent = '-' + reduction.toFixed(1) + '%';

        if (targetStatus) {
          if (compressedBlob.size <= targetBytes) {
            targetStatus.textContent = 'Matched (≤ ' + targetKB + 'KB)';
            targetStatus.className = 'stat-value success';
          } else {
            targetStatus.textContent = formatBytes(compressedBlob.size);
            targetStatus.className = 'stat-value';
          }
        }

        if (previewArea) previewArea.classList.add('active');
        if (downloadBtn) downloadBtn.disabled = false;

      } catch (err) {
        console.error(err);
        showAlert('An error occurred during compression. Please try again.', 'error');
      } finally {
        if (processingOverlay) processingOverlay.classList.remove('active');
      }
    }, 150);
  }

  if (compressBtn) {
    compressBtn.addEventListener('click', startCompression);
  }

  // Download Handler
  if (downloadBtn) {
    downloadBtn.addEventListener('click', function() {
      if (!compressedBlob) return;
      const a = document.createElement('a');
      const ext = (compressedBlob.type === 'image/webp') ? '.webp' : (compressedBlob.type === 'image/png') ? '.png' : '.jpg';
      const originalName = currentFile ? currentFile.name.substring(0, currentFile.name.lastIndexOf('.')) : 'image';
      a.href = compressedUrl;
      a.download = originalName + '-compressed-' + targetSizeSelect.value + 'kb' + ext;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    });
  }

  // Reset Handler
  if (resetBtn) {
    resetBtn.addEventListener('click', function() {
      currentFile = null;
      originalImage = null;
      compressedBlob = null;
      if (fileInput) fileInput.value = '';
      if (fileInfo) fileInfo.textContent = '';
      if (compressBtn) compressBtn.disabled = true;
      if (downloadBtn) downloadBtn.disabled = true;
      if (previewArea) previewArea.classList.remove('active');
      hideAlert();
    });
  }
})();
