// --- Configuration & State ---
pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

const STATE_KEY = 'pdf_stitcher_v2_state';
const FILES_KEY = 'pdf_stitcher_v2_files';

let state = {
    docs: [],         // { id, name, pageCount }
    selectedPages: [], // { id (unique), docId, pageNum, name }
    drawings: {},     // { "docId-pageNum": [ {x,y, type: 'path', points: []} ] }
    currentDocId: null,
    zoom: 1.0,
    tool: null, // 'draw', 'erase', null
    color: '#ef4444',
    scrollTop: 0
};

let pdfFiles = {}; // { docId: ArrayBuffer } stored in IndexedDB
let pdfJsDocs = {}; // Cache of loaded PDF.js documents
let isDrawing = false;
let currentPath = [];

// --- Initialization & Persistence ---

async function init() {
    showLoader('Loading Workspace...');
    try {
        // Setup Sidebar Sortable
        Sortable.create(document.getElementById('basket-list'), {
            animation: 150,
            ghostClass: 'blue-background-class',
            onEnd: (evt) => {
                const item = state.selectedPages.splice(evt.oldIndex, 1)[0];
                state.selectedPages.splice(evt.newIndex, 0, item);
                saveState();
            }
        });

        // Setup Tabs Sortable
        const tabsTrack = document.getElementById('tabs-track');
        Sortable.create(tabsTrack, {
            animation: 150,
            onEnd: (evt) => {
                const item = state.docs.splice(evt.oldIndex, 1)[0];
                state.docs.splice(evt.newIndex, 0, item);
                saveState();
            }
        });

        // Horizontal scroll with wheel for tabs
        tabsTrack.addEventListener('wheel', (evt) => {
            if (evt.deltaY !== 0) {
                evt.preventDefault();
                tabsTrack.scrollLeft += evt.deltaY;
            }
        });

        // Load Data
        const savedState = await localforage.getItem(STATE_KEY);
        if (savedState) state = { ...state, ...savedState }; // Merge defaults
        // Migration from old drawMode
        if (state.drawMode) { state.tool = 'draw'; delete state.drawMode; }

        const savedFiles = await localforage.getItem(FILES_KEY);
        if (savedFiles) pdfFiles = savedFiles;

        // Hydrate PDF.js docs
        const promises = state.docs.map(async doc => {
            if (pdfFiles[doc.id]) {
                const data = pdfFiles[doc.id];
                pdfJsDocs[doc.id] = await pdfjsLib.getDocument({ data: data.slice(0) }).promise;
            }
        });
        await Promise.all(promises);

        renderTabs();
        renderBasket();

        // Restore visual state
        document.getElementById('zoom-level').innerText = Math.round(state.zoom * 100) + "%";
        setTool(state.tool); // Restore tool state
        if (state.color) document.getElementById('color-picker').value = state.color;

        if (state.currentDocId && pdfJsDocs[state.currentDocId]) {
            await renderViewer(state.currentDocId);
            // Restore scroll
            document.getElementById('viewer-container').scrollTop = state.scrollTop || 0;
        }

    } catch (e) {
        console.error("Init failed", e);
        alert("Could not restore previous session. Clearing data.");
        resetApp();
    } finally {
        hideLoader();
    }
}

async function saveState() {
    document.getElementById('status-text').innerText = 'Saving...';
    await localforage.setItem(STATE_KEY, state);
    await localforage.setItem(FILES_KEY, pdfFiles);
    document.getElementById('status-text').innerText = 'Saved';
    setTimeout(() => document.getElementById('status-text').innerText = '', 1000);
}

async function resetApp() {
    if(!confirm("Clear all PDFs and start over?")) return;
    await localforage.clear();
    location.reload();
}

// --- File Handling ---

document.getElementById('file-input').onchange = async (e) => {
    showLoader('Processing PDFs...');
    const files = Array.from(e.target.files);

    for (const file of files) {
        const buffer = await file.arrayBuffer();
        const id = 'doc_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);

        try {
            const pdfDoc = await pdfjsLib.getDocument({ data: buffer.slice(0) }).promise;

            // Store
            pdfFiles[id] = buffer;
            pdfJsDocs[id] = pdfDoc;

            state.docs.push({
                id: id,
                name: file.name,
                pageCount: pdfDoc.numPages
            });
        } catch(err) {
            console.error("Error loading PDF", file.name, err);
            alert(`Error loading ${file.name}`);
        }
    }

    if (!state.currentDocId && state.docs.length > 0) {
        state.currentDocId = state.docs[state.docs.length - 1].id;
    } else if(state.docs.length > 0) {
        // Switch to the newly added one
            state.currentDocId = state.docs[state.docs.length - 1].id;
    }

    saveState();
    renderTabs();
    renderViewer(state.currentDocId);
    hideLoader();
};

// --- Tabs & Navigation ---

function renderTabs() {
    const track = document.getElementById('tabs-track');
    track.innerHTML = '';
    state.docs.forEach(doc => {
        const el = document.createElement('div');
        el.className = `doc-tab ${doc.id === state.currentDocId ? 'active' : ''}`;
        el.innerHTML = `
            <span>${doc.name}</span>
            <div class="close-tab" onclick="event.stopPropagation(); closeDoc('${doc.id}')">✕</div>
        `;
        el.onclick = () => {
            state.currentDocId = doc.id;
            state.scrollTop = 0; // Reset scroll on tab switch
            saveState();
            renderTabs();
            renderViewer(doc.id);
        };
        track.appendChild(el);
    });
}

function closeDoc(id) {
    state.docs = state.docs.filter(d => d.id !== id);
    delete pdfFiles[id];
    delete pdfJsDocs[id];
    // Clean up selected pages from this doc
    state.selectedPages = state.selectedPages.filter(p => p.docId !== id);

    if (state.currentDocId === id) {
        state.currentDocId = state.docs.length ? state.docs[0].id : null;
    }
    saveState();
    renderTabs();
    renderBasket();
    renderViewer(state.currentDocId);
}

// --- Viewer & Rendering ---

function changeZoom(delta) {
    state.zoom = Math.max(0.5, Math.min(3.0, state.zoom + delta));
    document.getElementById('zoom-level').innerText = Math.round(state.zoom * 100) + "%";
    saveState();
    renderViewer(state.currentDocId);
}

async function renderViewer(docId) {
    const container = document.getElementById('viewer-container');
    container.innerHTML = '';

    if (!docId || !pdfJsDocs[docId]) {
        container.innerHTML = document.getElementById('empty-state').outerHTML;
        document.getElementById('empty-state').style.display = 'block';
        return;
    }

    const pdfDoc = pdfJsDocs[docId];
    const docMeta = state.docs.find(d => d.id === docId);

    for (let i = 1; i <= pdfDoc.numPages; i++) {
        // Create DOM structure
        const wrapper = document.createElement('div');
        wrapper.className = `page-wrapper ${state.tool === 'draw' ? 'draw-mode' : (state.tool === 'erase' ? 'erase-mode' : '')}`;
        wrapper.dataset.pageNum = i;

        // Fetch viewport
        const page = await pdfDoc.getPage(i);
        const viewport = page.getViewport({ scale: state.zoom });

        wrapper.style.width = `${viewport.width}px`;
        wrapper.style.height = `${viewport.height}px`;

        // 1. PDF Canvas
        const canvas = document.createElement('canvas');
        canvas.className = 'pdf-canvas';
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        const ctx = canvas.getContext('2d');

        // 2. Text Layer
        const textLayerDiv = document.createElement('div');
        textLayerDiv.className = 'textLayer';
        textLayerDiv.style.width = `${viewport.width}px`;
        textLayerDiv.style.height = `${viewport.height}px`;
        textLayerDiv.style.position = 'absolute';
        textLayerDiv.style.top = '0';
        textLayerDiv.style.left = '0';

        // 3. Drawing Canvas
        const drawCanvas = document.createElement('canvas');
        drawCanvas.className = 'draw-canvas';
        drawCanvas.id = `draw-${docId}-${i}`;
        drawCanvas.width = viewport.width;
        drawCanvas.height = viewport.height;
        setupDrawingEvents(drawCanvas, docId, i, viewport.width / page.getViewport({scale:1}).width);

        // Controls
        const meta = document.createElement('div');
        meta.className = 'page-meta';
        meta.innerText = i;

        const controls = document.createElement('div');
        controls.className = 'page-controls';

        const isAdded = state.selectedPages.some(p => p.docId === docId && p.pageNum === i);
        const btn = document.createElement('button');
        btn.className = `add-btn ${isAdded ? 'added' : ''}`;
        btn.innerHTML = isAdded ? '✓ Added' : '+ Add Page';
        btn.onclick = () => togglePageSelection(docId, i, docMeta.name, btn);

        controls.appendChild(btn);
        wrapper.appendChild(meta);
        wrapper.appendChild(canvas);
        wrapper.appendChild(textLayerDiv);
        wrapper.appendChild(drawCanvas);
        wrapper.appendChild(controls);
        container.appendChild(wrapper);

        // Async Render
        page.render({ canvasContext: ctx, viewport }).promise.then(() => {
            // Render Text
            page.getTextContent().then(textContent => {
                pdfjsLib.renderTextLayer({
                    textContentSource: textContent,
                    container: textLayerDiv,
                    viewport: viewport,
                    textDivs: []
                });
            });
            // Render existing drawings
            redrawCanvas(drawCanvas, docId, i);
        });
    }
}

function handleScroll() {
    if(state.currentDocId) {
        state.scrollTop = document.getElementById('viewer-container').scrollTop;
        // Debounce save? Skipping for now to avoid lag, saved on other actions
    }
}

// --- Selection Logic ---

function togglePageSelection(docId, pageNum, docName, btnElement) {
    const existingIdx = state.selectedPages.findIndex(p => p.docId === docId && p.pageNum === pageNum);

    if (existingIdx > -1) {
        state.selectedPages.splice(existingIdx, 1);
        btnElement.classList.remove('added');
        btnElement.innerText = '+ Add Page';
    } else {
        state.selectedPages.push({
            id: Date.now() + Math.random(),
            docId,
            pageNum,
            name: docName
        });
        btnElement.classList.add('added');
        btnElement.innerText = '✓ Added';
    }
    saveState();
    renderBasket();
}

function renderBasket() {
    const list = document.getElementById('basket-list');
    list.innerHTML = '';
    document.getElementById('queue-count').innerText = `${state.selectedPages.length} Pages`;
    document.getElementById('download-btn').disabled = state.selectedPages.length === 0;

    state.selectedPages.forEach((item, index) => {
        const el = document.createElement('div');
        el.className = 'basket-item';

        // Hover events
        el.onmouseenter = (e) => showHoverPreview(e, item);
        el.onmouseleave = hideHoverPreview;

        el.innerHTML = `
            <div class="basket-thumb">
                </div>
            <div class="basket-info">
                <div class="page-num">Page ${item.pageNum}</div>
                <div class="doc-name">${item.name}</div>
            </div>
            <button style="border:none; background:none; cursor:pointer; color:#94a3b8;" onclick="removePage(${index})">✕</button>
        `;
        list.appendChild(el);
    });
}

function removePage(index) {
    const item = state.selectedPages[index];
    state.selectedPages.splice(index, 1);
    saveState();
    renderBasket();
    // If current viewer shows this page, update button
    if (state.currentDocId === item.docId) {
        renderViewer(state.currentDocId);
    }
}

// --- Hover Preview ---
async function showHoverPreview(e, item) {
    const preview = document.getElementById('hover-preview');
    preview.style.display = 'block';
    preview.style.left = (e.clientX + 20) + 'px';
    preview.style.top = Math.min(e.clientY - 50, window.innerHeight - 300) + 'px'; // Prevent going offscreen
    preview.innerHTML = '<div style="padding:10px; font-size:12px;">Loading...</div>';

    if(pdfJsDocs[item.docId]) {
        const page = await pdfJsDocs[item.docId].getPage(item.pageNum);
        const viewport = page.getViewport({ scale: 0.8 }); // Increased scale
        const canvas = document.createElement('canvas');
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;

        // Draw annotations on top
        redrawCanvas(canvas, item.docId, item.pageNum);

        preview.innerHTML = '';
        preview.appendChild(canvas);
    }
}

function hideHoverPreview() {
    document.getElementById('hover-preview').style.display = 'none';
}

// --- Drawing & Annotation ---

function setColor(c) {
    state.color = c;
    saveState();
}

function setTool(toolName) {
    if (state.tool === toolName) state.tool = null; // Toggle off
    else state.tool = toolName;

    document.getElementById('draw-toggle').classList.toggle('active', state.tool === 'draw');
    document.getElementById('erase-toggle').classList.toggle('active', state.tool === 'erase');
    document.getElementById('text-toggle').classList.toggle('active', state.tool === 'text');

    const wrappers = document.querySelectorAll('.page-wrapper');
    wrappers.forEach(w => {
        w.classList.remove('draw-mode', 'erase-mode', 'text-mode');
        if (state.tool === 'draw') w.classList.add('draw-mode');
        if (state.tool === 'erase') w.classList.add('erase-mode');
        if (state.tool === 'text') w.classList.add('text-mode');
    });
    saveState();
}

function setupDrawingEvents(canvas, docId, pageNum, scaleFactor) {
    const key = `${docId}-${pageNum}`;
    const ctx = canvas.getContext('2d');
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    // Color set dynamically on draw

    const getPos = (e) => {
        const rect = canvas.getBoundingClientRect();
        // Handle touch or mouse
        const clientX = e.touches ? e.touches[0].clientX : e.clientX;
        const clientY = e.touches ? e.touches[0].clientY : e.clientY;
        return {
            x: (clientX - rect.left),
            y: (clientY - rect.top)
        };
    };

    const addTextAt = (x, y) => {
        const wrapper = canvas.parentElement;
        const input = document.createElement('textarea');
        input.style.position = 'absolute';
        input.style.left = x + 'px';
        input.style.top = y + 'px';
        input.style.zIndex = 100;
        input.style.background = 'transparent';
        input.style.border = '1px solid #3b82f6';
        input.style.color = state.color || '#000000';
        input.style.fontSize = '16px';
        input.style.fontFamily = 'Arial, sans-serif';
        input.style.minWidth = '150px';
        input.style.minHeight = '40px';
        input.style.padding = '4px';

        wrapper.appendChild(input);
        input.focus();

        const save = () => {
            const text = input.value.trim();
            if (text) {
                if (!state.drawings[key]) state.drawings[key] = [];
                state.drawings[key].push({
                    type: 'text',
                    x: x / canvas.width,
                    y: y / canvas.height,
                    text: text,
                    size: 16 / canvas.height,
                    color: state.color || '#000000'
                });
                saveState();
                redrawCanvas(canvas, docId, pageNum);
            }
            if (input.parentNode) input.parentNode.removeChild(input);
        };

        input.addEventListener('blur', save);
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                input.blur();
            }
            if (e.key === 'Escape') {
                if (input.parentNode) input.parentNode.removeChild(input);
            }
        });
    };

    const start = (e) => {
        if (!state.tool) return;
        if (e.type === 'mousedown' && e.button !== 0) return; // Only left click
        e.preventDefault();

        isDrawing = true;
        const pos = getPos(e);

        if (state.tool === 'draw') {
             currentPath = [{ x: pos.x, y: pos.y }];
             ctx.strokeStyle = state.color || '#ef4444';
             ctx.beginPath();
             ctx.moveTo(pos.x, pos.y);
        } else if (state.tool === 'erase') {
             eraseAt(pos.x, pos.y, canvas.width, canvas.height, key);
        } else if (state.tool === 'text') {
             addTextAt(pos.x, pos.y);
             isDrawing = false;
        }
    };

    const move = (e) => {
        if (!isDrawing || !state.tool) return;
        e.preventDefault();
        const pos = getPos(e);

        if (state.tool === 'draw') {
            currentPath.push({ x: pos.x, y: pos.y });
            ctx.lineTo(pos.x, pos.y);
            ctx.stroke();
        } else if (state.tool === 'erase') {
             eraseAt(pos.x, pos.y, canvas.width, canvas.height, key);
        }
    };

    const end = (e) => {
        if (!isDrawing) return;
        isDrawing = false;

        if (state.tool === 'draw') {
            ctx.closePath();

            // Only save if path has points
            if (currentPath.length > 0) {
                if (!state.drawings[key]) state.drawings[key] = [];

                const w = canvas.width;
                const h = canvas.height;
                const normalizedPath = currentPath.map(p => ({ x: p.x/w, y: p.y/h }));

                state.drawings[key].push({ points: normalizedPath, color: state.color || '#ef4444' });
                saveState();
            }
            currentPath = [];
        }
    };

    const eraseAt = (x, y, w, h, key) => {
         const items = state.drawings[key];
         if(!items) return;

         const threshold = 10; // pixels

         const initialLen = items.length;
         state.drawings[key] = items.filter(item => {
             if (item.type === 'text') {
                 const tx = item.x * w;
                 const ty = item.y * h;
                 const fontSize = item.size * h;
                 ctx.font = `${fontSize}px Arial`;
                 const textWidth = ctx.measureText(item.text.split('\n')[0]).width; // simplified width check

                 // Expand hit box slightly
                 return !(x >= tx - 10 && x <= tx + textWidth + 10 &&
                          y >= ty - 10 && y <= ty + fontSize * (item.text.split('\n').length) + 10);
             } else {
                 return !item.points.some((p, idx, arr) => {
                     if (idx === 0) return false;
                     const p1 = {x: arr[idx-1].x * w, y: arr[idx-1].y * h};
                     const p2 = {x: p.x * w, y: p.y * h};
                     return distToSegment({x,y}, p1, p2) < threshold;
                 });
             }
         });

         if (state.drawings[key].length !== initialLen) {
             ctx.clearRect(0, 0, w, h);
             redrawCanvas(canvas, docId, pageNum); // Reuse redraw
             saveState();
         }
    };

    function distToSegment(p, v, w) {
        function sqr(x) { return x * x }
        function dist2(v, w) { return sqr(v.x - w.x) + sqr(v.y - w.y) }
        var l2 = dist2(v, w);
        if (l2 == 0) return Math.sqrt(dist2(p, v));
        var t = ((p.x - v.x) * (w.x - v.x) + (p.y - v.y) * (w.y - v.y)) / l2;
        t = Math.max(0, Math.min(1, t));
        return Math.sqrt(dist2(p, { x: v.x + t * (w.x - v.x), y: v.y + t * (w.y - v.y) }));
    }

    canvas.addEventListener('mousedown', start);
    canvas.addEventListener('mousemove', move);
    canvas.addEventListener('mouseup', end);
    canvas.addEventListener('mouseout', end);
    // Touch support
    canvas.addEventListener('touchstart', start);
    canvas.addEventListener('touchmove', move);
    canvas.addEventListener('touchend', end);
}

function redrawCanvas(canvas, docId, pageNum) {
    const key = `${docId}-${pageNum}`;
    const items = state.drawings[key];
    if (!items) return;

    const ctx = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;

    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    items.forEach(item => {
        if (item.type === 'text') {
            const fontSize = item.size * h;
            ctx.font = `${fontSize}px Arial`;
            ctx.fillStyle = item.color || '#000000';
            ctx.textBaseline = 'top';
            const lines = item.text.split('\n');
            lines.forEach((line, index) => {
                ctx.fillText(line, item.x * w, item.y * h + (index * fontSize * 1.2));
            });
            // no restore needed for strokeStyle as we set fillStyle, but if we change unexpected context props, we should be careful.
        } else {
            const points = item.points || (item.length ? item : null);
            if(!points || points.length < 1) return;
            ctx.strokeStyle = item.color || '#ef4444';
            ctx.beginPath();
            ctx.moveTo(points[0].x * w, points[0].y * h);
            for(let i=1; i<points.length; i++) {
                ctx.lineTo(points[i].x * w, points[i].y * h);
            }
            ctx.stroke();
        }
    });
}

function clearCurrentPageDraw() {
    if (!state.currentDocId) return;
    // Find visible page? or just clear the first one?
    // Let's implement a "click button, then click page to clear" or just clear all on current doc?
    // Simpler: Ask user.
    if(confirm("Clear drawings on ALL pages of this document?")) {
        // Remove keys starting with currentDocId
            Object.keys(state.drawings).forEach(k => {
                if(k.startsWith(state.currentDocId)) delete state.drawings[k];
            });
            saveState();
            renderViewer(state.currentDocId);
    }
}

// --- Export Logic (The Heavy Lifting) ---

async function exportPDF() {
    const btn = document.getElementById('download-btn');
    btn.disabled = true;
    btn.innerText = "Generating...";
    showLoader("Stitching and burning drawings...");

    try {
        const mergedPdf = await PDFLib.PDFDocument.create();

        for (const item of state.selectedPages) {
            // 1. Load Source
            const srcBytes = pdfFiles[item.docId];
            const srcDoc = await PDFLib.PDFDocument.load(srcBytes);

            // 2. Copy Page
            const [copiedPage] = await mergedPdf.copyPages(srcDoc, [item.pageNum - 1]);
            const embeddedPage = mergedPdf.addPage(copiedPage);

            // 3. Handle Drawings
            const drawKey = `${item.docId}-${item.pageNum}`;
            if (state.drawings[drawKey] && state.drawings[drawKey].length > 0) {
                // To burn drawings, we need to generate a transparent PNG of the drawing
                // We can use a temporary canvas for this
                const { width, height } = embeddedPage.getSize();

                const tempCanvas = document.createElement('canvas');
                // Render high res for quality
                const scale = 2;
                tempCanvas.width = width * scale;
                tempCanvas.height = height * scale;
                const ctx = tempCanvas.getContext('2d');
                ctx.scale(scale, scale);

                // Draw paths
                ctx.lineWidth = 2;
                ctx.lineJoin = 'round';
                ctx.lineCap = 'round';

                state.drawings[drawKey].forEach(pathData => {
                        if (pathData.type === 'text') {
                             const fontSize = pathData.size * height;
                             ctx.font = `${fontSize}px Arial`;
                             ctx.fillStyle = pathData.color || '#000000';
                             ctx.textBaseline = 'top';
                             const lines = pathData.text.split('\n');
                             lines.forEach((line, index) => {
                                 ctx.fillText(line, pathData.x * width, pathData.y * height + (index * fontSize * 1.2));
                             });
                        } else {
                            const points = pathData.points;
                            if(!points || points.length < 1) return;
                            ctx.strokeStyle = pathData.color || '#ef4444';
                            ctx.beginPath();
                            ctx.moveTo(points[0].x * width, points[0].y * height);
                            for(let i=1; i<points.length; i++) {
                                ctx.lineTo(points[i].x * width, points[i].y * height);
                            }
                            ctx.stroke();
                        }
                });

                // Convert to PNG blob
                const pngUrl = tempCanvas.toDataURL('image/png');
                const pngImageBytes = await fetch(pngUrl).then(res => res.arrayBuffer());
                const embeddedImage = await mergedPdf.embedPng(pngImageBytes);

                // Draw image on top of page
                embeddedPage.drawImage(embeddedImage, {
                    x: 0,
                    y: 0,
                    width: width,
                    height: height,
                });
            }
        }

        const pdfBytes = await mergedPdf.save();
        const blob = new Blob([pdfBytes], { type: 'application/pdf' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = "stitched_pro.pdf";
        a.click();

    } catch (e) {
        console.error(e);
        alert("Export failed: " + e.message);
    } finally {
        hideLoader();
        btn.disabled = false;
        btn.innerText = "Download Merged PDF";
    }
}

function showLoader(text) {
    document.getElementById('loader').style.display = 'flex';
    document.getElementById('loader-text').innerText = text;
}
function hideLoader() {
    document.getElementById('loader').style.display = 'none';
}

// Start
init();
