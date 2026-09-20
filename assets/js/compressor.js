
/* ===================================================
   Compress To KB - Client-Side Engine (compressor.js)
   Fast, Privacy-First, Binary Search Optimizer
   =================================================== */

(() => {
  // Elements
  const dropZone = document.getElementById('drop-zone');
  const fileInput = document.getElementById('drop-zone-input');
  const fileInfo = document.getElementById('file-info');
  const targetSelect = document.getElementById('target-size');
  const compressBtn = document.getElementById('compress-btn');
  const overlay = document.getElementById('processing-overlay');
  const progressFill = document.getElementById('progress-fill');
  const progressLabel = document.getElementById('progress-label');
  const alertBox = document.getElementById('alert-box');

  const previewArea = document.getElementById('preview-area');
  const originalPreview = document.getElementById('original-preview');
  const compressedPreview = document.getElementById('compressed-preview');

  const originalSizeElem = document.getElementById('original-size');
  const compressedSizeElem = document.getElementById('compressed-size');
  const compressionPercentElem = document.getElementById('compression-percent');
  const targetStatusElem = document.getElementById('target-status');

  const originalDimsElem = document.getElementById('original-dimensions');
  const originalSizeMetaElem = document.getElementById('original-size-meta');
  const compressedDimsElem = document.getElementById('compressed-dimensions');
  const outputFormatElem = document.getElementById('output-format');

  const downloadBtn = document.getElementById('download-btn');
  const resetBtn = document.getElementById('reset-btn');

  // State
  let currentFile = null;
  let sourceImage = null;
  let compressedBlob = null;
  let compressedUrl = null;

  // Auto-select target size based on page config
  if (window.COMPRESSOR_CONFIG && window.COMPRESSOR_CONFIG.targetSizeKB && targetSelect) {
    targetSelect.value = String(window.COMPRESSOR_CONFIG.targetSizeKB);
  }

  // Helpers
  const formatSize = (bytes) => {
    if (bytes < 1024) return bytes + ' B';
    const kb = (bytes / 1024).toFixed(1);
    if (kb < 1024) return kb + ' KB';
    return (kb / 1024).toFixed(2) + ' MB';
  };

  const showAlert = (msg, type = 'error') => {
    alertBox.className = `alert alert-${type}`;
    alertBox.textContent = msg;
    alertBox.style.display = 'block';
  };

  const clearAlert = () => {
    alertBox.style.display = 'none';
    alertBox.textContent = '';
  };

  // Drag & Drop
  ['dragenter', 'dragover'].forEach(eventName => {
    dropZone.addEventListener(eventName, (e) => {
      e.preventDefault();
      dropZone.classList.add('drag-over');
    });
  });

  ['dragleave', 'drop'].forEach(eventName => {
    dropZone.addEventListener(eventName, (e) => {
      e.preventDefault();
      dropZone.classList.remove('drag-over');
    });
  });

  dropZone.addEventListener('drop', (e) => {
    const files = e.dataTransfer.files;
    if (files && files.length > 0) handleFile(files[0]);
  });

  fileInput.addEventListener('change', (e) => {
    if (e.target.files && e.target.files.length > 0) handleFile(e.target.files[0]);
  });

  // Load File
  function handleFile(file) {
    clearAlert();
    if (!file.type.startsWith('image/')) {
      showAlert('Please upload a valid image file (JPG, PNG, WebP, AVIF, etc.).');
      return;
    }
    if (file.size > 50 * 1024 * 1024) {
      showAlert('File size exceeds the 50MB limit. Please choose a smaller image.');
      return;
    }

    currentFile = file;
    fileInfo.textContent = `${file.name} (${formatSize(file.size)})`;

    const reader = new FileReader();
    reader.onload = (event) => {
      const img = new Image();
      img.onload = () => {
        sourceImage = img;
        compressBtn.disabled = false;
        showInitialPreview(file, img);
      };
      img.src = event.target.result;
    };
    reader.readAsDataURL(file);
  }

  function showInitialPreview(file, img) {
    originalSizeElem.textContent = formatSize(file.size);
    originalSizeMetaElem.textContent = formatSize(file.size);
    originalDimsElem.textContent = `${img.naturalWidth} × ${img.naturalHeight}`;

    originalPreview.innerHTML = '';
    const previewImg = document.createElement('img');
    previewImg.src = img.src;
    previewImg.alt = "Original Image Preview";
    originalPreview.appendChild(previewImg);

    previewArea.classList.add('active');
  }

  // Detect Alpha Transparency
  function hasAlphaTransparency(canvas) {
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const imgData = ctx.getImageData(0, 0, Math.min(canvas.width, 100), Math.min(canvas.height, 100)).data;
    for (let i = 3; i < imgData.length; i += 4) {
      if (imgData[i] < 255) return true;
    }
    return false;
  }

  // Compression Algorithm (Binary Search Quality + Dimension Scaling)
  async function compressImage() {
    if (!sourceImage) return;

    overlay.classList.add('active');
    clearAlert();
    progressFill.style.width = '10%';
    progressLabel.textContent = 'Preparing image...';

    const targetKB = parseInt(targetSelect.value, 10);
    const targetBytes = targetKB * 1024;

    let width = sourceImage.naturalWidth;
    let height = sourceImage.naturalHeight;

    let canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    let ctx = canvas.getContext('2d');
    ctx.drawImage(sourceImage, 0, 0, width, height);

    const isTransparent = hasAlphaTransparency(canvas);
    // Modern browsers best target: WebP retains high visual fidelity & transparency at low KB
    let outputFormat = isTransparent ? 'image/webp' : 'image/jpeg';

    let bestBlob = null;
    let attempts = 0;
    const maxAttempts = 18;

    let scale = 1.0;

    // Loop for dimension downscaling if quality alone cannot meet strict targets (e.g. 20KB)
    for (let scalePass = 0; scalePass < 3; scalePass++) {
      if (scalePass > 0) {
        // Reduce dimensions proportionally
        const factor = Math.sqrt(targetBytes / (bestBlob ? bestBlob.size : targetBytes * 2)) * 0.95;
        scale = Math.min(0.9, Math.max(0.2, factor));
        width = Math.round(canvas.width * scale);
        height = Math.round(canvas.height * scale);

        const scaledCanvas = document.createElement('canvas');
        scaledCanvas.width = width;
        scaledCanvas.height = height;
        const sCtx = scaledCanvas.getContext('2d');
        sCtx.drawImage(canvas, 0, 0, width, height);
        canvas = scaledCanvas;
      }

      let low = 0.05;
      let high = 0.95;

      while (low <= high && attempts < maxAttempts) {
        attempts++;
        const mid = (low + high) / 2;
        progressFill.style.width = `${Math.min(90, attempts * 5 + scalePass * 20)}%`;
        progressLabel.textContent = `Optimizing quality (${attempts} iterations)...`;

        const blob = await new Promise(resolve => canvas.toBlob(resolve, outputFormat, mid));
        if (!blob) break;

        if (blob.size <= targetBytes) {
          bestBlob = blob;
          low = mid + 0.05; // Try to get higher quality while staying under target
        } else {
          high = mid - 0.05; // Reduce quality
        }

        // If very close to target (within 3% below target), accept immediately
        if (blob.size <= targetBytes && blob.size >= targetBytes * 0.96) {
          bestBlob = blob;
          break;
        }
      }

      if (bestBlob && bestBlob.size <= targetBytes) break;
    }

    // Fallback if still slightly over
    if (!bestBlob) {
      bestBlob = await new Promise(resolve => canvas.toBlob(resolve, outputFormat, 0.1));
    }

    progressFill.style.width = '100%';
    progressLabel.textContent = 'Finalizing...';

    setTimeout(() => {
      overlay.classList.remove('active');
      renderResults(bestBlob, canvas.width, canvas.height, outputFormat, targetKB);
    }, 200);
  }

  function renderResults(blob, width, height, format, targetKB) {
    compressedBlob = blob;
    if (compressedUrl) URL.revokeObjectURL(compressedUrl);
    compressedUrl = URL.createObjectURL(blob);

    compressedSizeElem.textContent = formatSize(blob.size);
    compressedDimsElem.textContent = `${width} × ${height}`;

    const reduction = Math.max(0, Math.round(((currentFile.size - blob.size) / currentFile.size) * 100));
    compressionPercentElem.textContent = `-${reduction}%`;

    const targetBytes = targetKB * 1024;
    if (blob.size <= targetBytes) {
      targetStatusElem.textContent = `Passed (≤ ${targetKB}KB)`;
      targetStatusElem.className = 'stat-value success';
    } else {
      targetStatusElem.textContent = `${formatSize(blob.size)} (Target: ${targetKB}KB)`;
      targetStatusElem.className = 'stat-value';
      showAlert(`Image reached ${formatSize(blob.size)}. Complex high-resolution images might require a higher KB target to avoid extreme blur.`, 'warning');
    }

    outputFormatElem.textContent = format.replace('image/', '').toUpperCase();

    compressedPreview.innerHTML = '';
    const cImg = document.createElement('img');
    cImg.src = compressedUrl;
    cImg.alt = "Compressed Image Preview";
    compressedPreview.appendChild(cImg);

    downloadBtn.disabled = false;
  }

  // Event Listeners
  compressBtn.addEventListener('click', compressImage);

  downloadBtn.addEventListener('click', () => {
    if (!compressedBlob) return;
    const targetKB = targetSelect.value;
    const originalName = currentFile.name.substring(0, currentFile.name.lastIndexOf('.')) || 'image';
    const ext = outputFormatElem.textContent.toLowerCase();

    const a = document.createElement('a');
    a.href = compressedUrl;
    a.download = `${originalName}-compressed-${targetKB}kb.${ext}`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  });

  resetBtn.addEventListener('click', () => {
    currentFile = null;
    sourceImage = null;
    compressedBlob = null;
    if (compressedUrl) URL.revokeObjectURL(compressedUrl);
    compressedUrl = null;

    fileInput.value = '';
    fileInfo.textContent = '';
    compressBtn.disabled = true;
    downloadBtn.disabled = true;
    previewArea.classList.remove('active');
    clearAlert();
  });
})();
