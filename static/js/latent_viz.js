(function () {
  'use strict';

  var DATA_PATH = './visualizations/step_120000/tsne_data.json';
  var FRAMES_PATH = './visualizations/step_120000/frames/';
  var VIDEO_PATH = './visualizations/step_120000/batch_videos/';
  var ITEMS_PER_PAGE = 6;

  var vizData = null;
  var currentMode = 'translation';
  var areaIndices = [];
  var areaPage = 1;

  // Overlay trace management: traces beyond index 0 are overlays.
  // We always rebuild them as a group to avoid index confusion.
  var overlayCount = 0;

  // Animation state
  var animTimer = null;
  var animPlaying = false;
  var animStep = -1;          // -1 = pause (GIF frame 0), 0-14 = latent action steps
  var animInterval = 500;     // ms per tick, matches GIF frame delay (16 ticks x 500ms = 8s)
  var animSpeedLevel = 2;     // index into SPEEDS
  var batchPoints = [];       // [{x, y, pointIdx, timestep}, ...] sorted by timestep
  var SPEEDS = [0.25, 0.5, 1.0, 2.0, 4.0];

  function pad(n, w) {
    var s = '' + n;
    while (s.length < w) s = '0' + s;
    return s;
  }

  function frameSrc(batchIdx, frameIdx) {
    return FRAMES_PATH + 'b' + pad(batchIdx, 3) + '_f' + pad(frameIdx, 2) + '.jpg';
  }

  function batchGifPath(batchIdx) {
    return VIDEO_PATH + 'batch_' + pad(batchIdx, 3) + '.gif';
  }

  function yawDirection(val) {
    if (val < -0.01) return 'Left';
    if (val > 0.01) return 'Right';
    return 'Straight';
  }

  function buildHoverText(d, i) {
    return 'Batch ' + d.batch[i] + ' | T=' + d.timestep[i] +
      '<br>Speed: ' + d.translation_mag[i].toFixed(3) +
      '<br>Yaw: ' + d.yaw[i].toFixed(4) + ' (' + yawDirection(d.yaw[i]) + ')';
  }

  function getColorConfig(d) {
    if (currentMode === 'translation') {
      var tMin = d.translation_mag[0], tMax = d.translation_mag[0];
      for (var j = 1; j < d.translation_mag.length; j++) {
        if (d.translation_mag[j] < tMin) tMin = d.translation_mag[j];
        if (d.translation_mag[j] > tMax) tMax = d.translation_mag[j];
      }
      return {
        color: d.translation_mag,
        colorscale: 'Viridis',
        cmin: tMin, cmax: tMax,
        colorbar: {
          title: { text: 'Speed', font: { family: 'Google Sans, sans-serif', size: 12 } },
          thickness: 14, len: 0.6, tickfont: { size: 10 }
        }
      };
    }
    var maxAbs = 0;
    for (var i = 0; i < d.yaw.length; i++) {
      var a = Math.abs(d.yaw[i]);
      if (a > maxAbs) maxAbs = a;
    }
    var rdbuReversed = [
      [0, '#2166ac'], [0.1, '#4393c3'], [0.2, '#92c5de'],
      [0.3, '#d1e5f0'], [0.4, '#f7f7f7'], [0.5, '#f7f7f7'],
      [0.6, '#fddbc7'], [0.7, '#f4a582'], [0.8, '#d6604d'],
      [0.9, '#b2182b'], [1, '#67001f']
    ];
    return {
      color: d.yaw,
      colorscale: rdbuReversed,
      cmin: -maxAbs, cmax: maxAbs,
      colorbar: {
        title: { text: 'Yaw (rad)', font: { family: 'Google Sans, sans-serif', size: 12 } },
        thickness: 14, len: 0.6, tickfont: { size: 10 }
      }
    };
  }

  // ── Plot setup ──

  function buildPlot(d) {
    var hover = [];
    for (var i = 0; i < d.x.length; i++) hover.push(buildHoverText(d, i));

    var cc = getColorConfig(d);
    var trace = {
      x: d.x, y: d.y,
      mode: 'markers', type: 'scatter',
      marker: {
        size: 7, opacity: 0.75,
        line: { width: 0.5, color: 'rgba(0,0,0,0.15)' },
        color: cc.color, colorscale: cc.colorscale, colorbar: cc.colorbar
      },
      selected: { marker: { opacity: 1, size: 10 } },
      unselected: { marker: { opacity: 0.3 } },
      text: hover, hoverinfo: 'text',
      hoverlabel: {
        bgcolor: '#fff', bordercolor: '#3273dc',
        font: { family: 'Google Sans, Noto Sans, sans-serif', size: 12, color: '#333' }
      }
    };
    if (cc.cmin !== undefined) {
      trace.marker.cmin = cc.cmin;
      trace.marker.cmax = cc.cmax;
    }

    var layout = {
      autosize: true,
      margin: { l: 20, r: 40, t: 16, b: 20 },
      hovermode: 'closest',
      dragmode: 'select',
      paper_bgcolor: 'rgba(0,0,0,0)',
      plot_bgcolor: 'rgba(0,0,0,0)',
      xaxis: { showticklabels: false, showgrid: false, zeroline: false },
      yaxis: { showticklabels: false, showgrid: false, zeroline: false, scaleanchor: 'x', scaleratio: 0.75 }
    };

    var config = {
      responsive: true,
      displayModeBar: true,
      displaylogo: false,
      scrollZoom: true,
      modeBarButtonsToRemove: [
        'autoScale2d', 'hoverClosestCartesian', 'hoverCompareCartesian',
        'toggleSpikelines', 'toImage'
      ]
    };

    overlayCount = 0;
    Plotly.newPlot('viz-plot', [trace], layout, config);

    var plotEl = document.getElementById('viz-plot');
    plotEl.on('plotly_click', onPointClick);
    plotEl.on('plotly_selected', onAreaSelect);
    plotEl.on('plotly_deselect', resetSelection);
  }

  function resetSelection() {
    // Toggle dragmode to force Plotly to fully clear selection state
    Plotly.relayout('viz-plot', { dragmode: 'zoom' }).then(function () {
      Plotly.relayout('viz-plot', { dragmode: 'select' });
    });
  }

  function updateColors() {
    var cc = getColorConfig(vizData);
    Plotly.restyle('viz-plot', {
      'marker.color': [cc.color],
      'marker.colorscale': [cc.colorscale],
      'marker.colorbar': [cc.colorbar],
      'marker.cmin': [cc.cmin],
      'marker.cmax': [cc.cmax]
    }, [0]);
  }

  // ── Overlay management ──

  function clearOverlays() {
    if (overlayCount > 0) {
      var indices = [];
      for (var i = 0; i < overlayCount; i++) indices.push(i + 1);
      Plotly.deleteTraces('viz-plot', indices);
      overlayCount = 0;
    }
  }

  function getBatchPoints(batchIdx) {
    var d = vizData;
    var pts = [];
    for (var i = 0; i < d.batch.length; i++) {
      if (d.batch[i] === batchIdx) {
        pts.push({ x: d.x[i], y: d.y[i], pointIdx: i, timestep: d.timestep[i] });
      }
    }
    pts.sort(function (a, b) { return a.timestep - b.timestep; });
    return pts;
  }

  function showBatchTrajectory(batchIdx, startStep) {
    clearOverlays();
    var pts = getBatchPoints(batchIdx);
    batchPoints = pts;
    if (!pts.length) return;

    var tx = [], ty = [];
    for (var i = 0; i < pts.length; i++) { tx.push(pts[i].x); ty.push(pts[i].y); }

    // Trace 1: all batch points as small solid filled dots
    var dotsTrace = {
      x: tx, y: ty,
      mode: 'markers',
      type: 'scatter',
      marker: {
        size: 8,
        color: '#e63946',
        opacity: 0.6
      },
      hoverinfo: 'skip', showlegend: false
    };

    // Trace 2: current-position marker (larger, fully opaque, white border)
    var si = startStep || 0;
    var curTrace = {
      x: [pts[si].x], y: [pts[si].y],
      mode: 'markers',
      type: 'scatter',
      marker: {
        size: 16,
        color: '#e63946',
        opacity: 1,
        line: { width: 2.5, color: '#fff' }
      },
      hoverinfo: 'skip', showlegend: false
    };

    Plotly.addTraces('viz-plot', [dotsTrace, curTrace]);
    overlayCount = 2;
  }

  function moveCurrentMarker(stepIdx) {
    if (!batchPoints.length || overlayCount < 2) return;
    var pt = batchPoints[stepIdx];
    Plotly.restyle('viz-plot', { x: [[pt.x]], y: [[pt.y]], 'marker.opacity': [1] }, [2]);
  }

  function hideCurrentMarker() {
    if (!batchPoints.length || overlayCount < 2) return;
    Plotly.restyle('viz-plot', { 'marker.opacity': [0] }, [2]);
  }

  // ── Animation controls ──

  function stopAnimation() {
    if (animTimer) { clearInterval(animTimer); animTimer = null; }
    animPlaying = false;
    var icon = document.getElementById('viz-anim-icon');
    if (icon) { icon.className = 'fas fa-play'; }
  }

  function startAnimation() {
    if (!batchPoints.length) return;
    animPlaying = true;
    var icon = document.getElementById('viz-anim-icon');
    if (icon) { icon.className = 'fas fa-pause'; }

    animTimer = setInterval(function () {
      animStep++;
      if (animStep >= batchPoints.length) animStep = -1;
      if (animStep >= 0) {
        renderAnimStep();
      } else {
        hideCurrentMarker();
      }
    }, animInterval / SPEEDS[animSpeedLevel]);
  }

  function renderAnimStep() {
    moveCurrentMarker(animStep);
    var pt = batchPoints[animStep];

    // Update slider
    var slider = document.getElementById('viz-anim-slider');
    if (slider) slider.value = animStep;

    // Update label
    var label = document.getElementById('viz-anim-label');
    if (label) label.textContent = 'T=' + pt.timestep + ' / ' + (batchPoints.length + 1);

  }

  function initAnimUI() {
    animStep = -1;
    animSpeedLevel = 2;

    var slider = document.getElementById('viz-anim-slider');
    if (slider) {
      slider.max = batchPoints.length - 1;
      slider.value = 0;
    }

    var speedLabel = document.getElementById('viz-anim-speed-label');
    if (speedLabel) speedLabel.textContent = SPEEDS[animSpeedLevel] + 'x';

    hideCurrentMarker();
    stopAnimation();
    startAnimation();
  }

  // ── Panel helpers ──

  function showPanel(id) {
    var el = document.getElementById(id);
    el.classList.add('is-visible');
    el.style.display = 'block';
    if (!el.classList.contains('viz-overlay')) {
      setTimeout(function () {
        el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }, 50);
    }
  }

  function hidePanel(id) {
    var el = document.getElementById(id);
    el.classList.remove('is-visible');
    el.style.display = 'none';
  }

  // ── Event handlers ──

  function onPointClick(ev) {
    if (!ev || !ev.points || !ev.points.length) return;
    var pt = ev.points[0];
    if (pt.curveNumber !== 0) return;
    var idx = pt.pointIndex;
    var d = vizData;
    var batchIdx = d.batch[idx];

    stopAnimation();
    hidePanel('viz-area-panel');

    showBatchTrajectory(batchIdx, 0);
    showPanel('viz-detail-panel');

    var gifImg = document.getElementById('viz-batch-gif');
    gifImg.src = '';
    gifImg.src = batchGifPath(batchIdx);
    initAnimUI();
  }

  function shuffleArray(arr) {
    for (var i = arr.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
    }
    return arr;
  }

  function onAreaSelect(ev) {
    if (!ev || !ev.points || !ev.points.length) return;

    areaIndices = [];
    for (var i = 0; i < ev.points.length; i++) {
      if (ev.points[i].curveNumber === 0) {
        areaIndices.push(ev.points[i].pointIndex);
      }
    }
    if (!areaIndices.length) return;

    shuffleArray(areaIndices);

    stopAnimation();
    hidePanel('viz-detail-panel');
    clearOverlays();
    areaPage = 1;
    renderAreaGrid();
    showPanel('viz-area-panel');
    resetSelection();
  }

  function renderAreaGrid() {
    var total = areaIndices.length;
    var totalPages = Math.ceil(total / ITEMS_PER_PAGE);
    var start = (areaPage - 1) * ITEMS_PER_PAGE;
    var end = Math.min(start + ITEMS_PER_PAGE, total);
    var pageItems = areaIndices.slice(start, end);

    document.getElementById('viz-area-count').textContent = total + ' points selected';
    document.getElementById('viz-page-info').textContent = 'Page ' + areaPage + ' of ' + totalPages;
    document.getElementById('viz-prev-page').disabled = areaPage <= 1;
    document.getElementById('viz-next-page').disabled = areaPage >= totalPages;

    var grid = document.getElementById('viz-area-grid');
    var html = '';
    for (var i = 0; i < pageItems.length; i++) {
      var idx = pageItems[i];
      var d = vizData;
      var b = d.batch[idx];
      var t = d.timestep[idx];
      html +=
        '<div class="viz-frame-card" onclick="vizAreaCardClick(' + idx + ')">' +
        '<div class="viz-frame-pair">' +
        '<img src="' + frameSrc(b, t - 1) + '" alt="Frame t-1" loading="lazy" />' +
        '<img src="' + frameSrc(b, t) + '" alt="Frame t" loading="lazy" />' +
        '</div>' +
        '<div class="viz-frame-card-label">' +
        '<span>Scene ' + b + ', T=' + t + '</span>' +
        '<span class="viz-fc-badge" style="background:#eef3ff;color:#3273dc;">Pt ' + idx + '</span>' +
        '</div></div>';
    }
    grid.innerHTML = html;
  }

  // ── Globals for HTML onclick handlers ──

  window.vizSetMode = function (mode) {
    if (mode === currentMode) return;
    currentMode = mode;
    var btns = document.querySelectorAll('.viz-toggle');
    for (var i = 0; i < btns.length; i++) {
      btns[i].classList.toggle('active', btns[i].getAttribute('data-mode') === mode);
    }
    updateColors();
  };

  window.vizCloseDetail = function () {
    stopAnimation();
    hidePanel('viz-detail-panel');
    clearOverlays();
    batchPoints = [];
  };

  window.vizCloseArea = function () {
    hidePanel('viz-area-panel');
    areaIndices = [];
  };

  window.vizClearSelection = function () {
    stopAnimation();
    hidePanel('viz-detail-panel');
    hidePanel('viz-area-panel');
    clearOverlays();
    batchPoints = [];
    areaIndices = [];
    Plotly.update('viz-plot',
      { selectedpoints: [null] },
      { selections: [], dragmode: 'select' },
      [0]
    );
  };

  window.vizChangePage = function (dir) {
    var totalPages = Math.ceil(areaIndices.length / ITEMS_PER_PAGE);
    var next = areaPage + dir;
    if (next >= 1 && next <= totalPages) {
      areaPage = next;
      renderAreaGrid();
    }
  };

  window.vizAreaCardClick = function (idx) {
    var d = vizData;
    var batchIdx = d.batch[idx];

    stopAnimation();

    showBatchTrajectory(batchIdx, 0);
    showPanel('viz-detail-panel');

    var gifImg = document.getElementById('viz-batch-gif');
    gifImg.src = '';
    gifImg.src = batchGifPath(batchIdx);
    initAnimUI();
  };

  window.vizAnimToggle = function () {
    if (animPlaying) {
      stopAnimation();
    } else {
      startAnimation();
    }
  };

  window.vizAnimSeek = function (val) {
    var wasPlaying = animPlaying;
    stopAnimation();
    animStep = parseInt(val, 10);
    renderAnimStep();
    if (wasPlaying) startAnimation();
  };

  window.vizAnimSpeed = function (dir) {
    var wasPlaying = animPlaying;
    stopAnimation();
    animSpeedLevel = Math.max(0, Math.min(SPEEDS.length - 1, animSpeedLevel + dir));
    var label = document.getElementById('viz-anim-speed-label');
    if (label) label.textContent = SPEEDS[animSpeedLevel] + 'x';
    if (wasPlaying) startAnimation();
  };

  // ── Init ──

  function setLoaderProgress(pct) {
    var fill = document.getElementById('viz-loader-fill');
    if (fill) fill.style.width = pct + '%';
    var text = document.getElementById('viz-loader-text');
    if (text) text.textContent = pct < 100 ? 'Loading visualization...' : 'Rendering...';
  }

  function loadViz() {
    var plotEl = document.getElementById('viz-plot');
    if (!plotEl) return;

    setLoaderProgress(10);

    fetch(DATA_PATH)
      .then(function (r) {
        setLoaderProgress(40);
        return r.json();
      })
      .then(function (d) {
        setLoaderProgress(70);
        vizData = d;
        requestAnimationFrame(function () {
          buildPlot(d);
          setLoaderProgress(100);
          var loader = document.getElementById('viz-loader');
          if (loader) loader.style.display = 'none';
        });
      })
      .catch(function (err) {
        console.error('Failed to load latent viz data:', err);
        plotEl.innerHTML = '<p style="text-align:center;padding:40px;color:#999;">Failed to load visualization data.</p>';
      });
  }

  function init() {
    var section = document.getElementById('latent-action-viz');
    if (!section) return;

    if ('IntersectionObserver' in window) {
      var observer = new IntersectionObserver(function (entries) {
        if (entries[0].isIntersecting) {
          observer.disconnect();
          loadViz();
        }
      }, { rootMargin: '200px' });
      observer.observe(section);
    } else {
      loadViz();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
