import http from 'node:http'
import path from 'node:path'
import { existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'

export interface WorkflowInfo {
  name: string
  isAsync: boolean
  signature: string
  filePath: string
  sourceFile?: string
  sourceModule?: string
  sourceCode?: string
}

export interface ToolInfo {
  name: string
  isAsync: boolean
  signature: string
  filePath: string
  sourceCode?: string
}

export interface CodeIndex {
  workflows: WorkflowInfo[]
  tools: ToolInfo[]
}

export interface DashboardServerOptions {
  port?: number
  autoOpen?: boolean
}

export interface DashboardServer {
  url: string
  close(): Promise<void>
}

/**
 * Scan for ed_tools.ts or ed_tools.js and extract exported functions
 */
async function scanTools(cwd: string): Promise<ToolInfo[]> {
  const tools: ToolInfo[] = []
  
  const candidates = [
    path.join(cwd, 'ed_tools.ts'),
    path.join(cwd, 'ed_tools.js'),
  ]
  
  for (const toolsPath of candidates) {
    if (!existsSync(toolsPath)) {
      continue
    }
    
    try {
      const moduleUrl = pathToFileURL(toolsPath).href
      const module = await import(moduleUrl)
      
      for (const key of Object.keys(module)) {
        if (key === 'default') continue
        
        const value = module[key]
        if (typeof value === 'function') {
          const funcStr = value.toString()
          let signature = '()'
          
          const match = funcStr.match(/^(?:async\s+)?function\s*\w*\s*(\([^)]*\))|^(?:async\s+)?(\([^)]*\))\s*=>|^(?:async\s+)?\w+\s*(\([^)]*\))\s*{/)
          if (match) {
            signature = match[1] || match[2] || match[3] || '()' 
          }
          
          tools.push({
            name: key,
            isAsync: funcStr.trimStart().startsWith('async'),
            signature,
            filePath: toolsPath,
            sourceCode: funcStr.length < 2000 ? funcStr : funcStr.substring(0, 2000) + '...\n// (truncated)',
          })
        }
      }
      
      break
    } catch (error) {
      console.warn(`Warning: Failed to scan ${toolsPath}:`, error)
      continue
    }
  }
  
  return tools
}

/**
 * Scan for ed_workflow.ts or ed_workflow.js and extract exported functions
 */
async function scanWorkflows(cwd: string): Promise<WorkflowInfo[]> {
  const workflows: WorkflowInfo[] = []
  
  // Check for ed_workflow.ts first, then .js
  const candidates = [
    path.join(cwd, 'ed_workflow.ts'),
    path.join(cwd, 'ed_workflow.js'),
  ]
  
  for (const workflowPath of candidates) {
    if (!existsSync(workflowPath)) {
      continue
    }
    
    try {
      const moduleUrl = pathToFileURL(workflowPath).href
      const module = await import(moduleUrl)
      
      // Extract all exported functions
      for (const key of Object.keys(module)) {
        if (key === 'default') continue
        
        const value = module[key]
        if (typeof value === 'function') {
          // Try to get function signature
          const funcStr = value.toString()
          let signature = '()'
          
          // Extract parameters from function string
          const match = funcStr.match(/^(?:async\s+)?function\s*\w*\s*(\([^)]*\))|^(?:async\s+)?(\([^)]*\))\s*=>|^(?:async\s+)?\w+\s*(\([^)]*\))\s*{/)
          if (match) {
            signature = match[1] || match[2] || match[3] || '()'
          }
          
          // Get source information
          let sourceFile: string | undefined
          let sourceModule: string | undefined
          
          try {
            // Try to extract module information from function name/toString
            if (value.name && value.name !== key) {
              sourceModule = value.name
            }
          } catch {
            // Ignore errors
          }
          
          workflows.push({
            name: key,
            isAsync: funcStr.trimStart().startsWith('async'),
            signature,
            filePath: workflowPath,
            sourceFile,
            sourceModule,
            sourceCode: funcStr.length < 2000 ? funcStr : funcStr.substring(0, 2000) + '...\n// (truncated)',
          })
        }
      }
      
      // Successfully scanned this file, no need to try others
      break
    } catch (error) {
      console.warn(`Warning: Failed to scan ${workflowPath}:`, error)
      // Continue to try the next candidate
      continue
    }
  }
  
  return workflows
}

/**
 * Open URL in default browser (platform-aware)
 */
function openBrowser(url: string): void {
  const platform = process.platform
  
  if (platform === 'darwin') {
    spawn('open', [url], { detached: true, stdio: 'ignore' })
  } else if (platform === 'linux') {
    spawn('xdg-open', [url], { detached: true, stdio: 'ignore' })
  } else if (platform === 'win32') {
    spawn('cmd', ['/c', 'start', url], { detached: true, stdio: 'ignore', shell: true })
  }
}

/**
 * Get the dashboard HTML page
 */
function getDashboardHtml(): string {
  // Use function to avoid template literal issues in TypeScript
  return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>ElasticDash Dashboard</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f5f5f5; color: #333; }
        .container { max-width: 1200px; margin: 0 auto; padding: 20px; }
        header { background: white; padding: 20px; border-radius: 8px; margin-bottom: 20px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
        h1 { font-size: 28px; margin-bottom: 8px; color: #1a1a1a; }
        .subtitle { font-size: 14px; color: #666; margin-bottom: 16px; }
        .search-box { display: flex; gap: 10px; }
        input[type="text"] { flex: 1; padding: 10px 12px; border: 1px solid #ddd; border-radius: 6px; font-size: 14px; }
        input[type="text"]:focus { outline: none; border-color: #0066cc; box-shadow: 0 0 0 3px rgba(0, 102, 204, 0.1); }
        .result-count { padding: 10px 12px; background: #f0f0f0; border-radius: 6px; font-size: 14px; color: #666; }
        .workflows-list { background: white; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); overflow: hidden; max-height: 65vh; display: flex; flex-direction: column; }
        .workflows-table { width: 100%; border-collapse: collapse; }
        .workflows-table thead { background: #f5f5f5; position: sticky; top: 0; z-index: 10; }
        .workflows-table th { padding: 12px 16px; text-align: left; font-weight: 600; font-size: 13px; color: #333; border-bottom: 2px solid #ddd; }
        .workflows-table td { padding: 12px 16px; border-bottom: 1px solid #eee; }
        .workflows-table tbody tr { cursor: pointer; transition: background-color 0.2s; }
        .workflows-table tbody tr:hover { background-color: #f9f9f9; }
        .workflow-name-cell { font-family: Monaco, monospace; font-weight: 600; color: #0066cc; }
        .workflow-path-cell { font-family: Monaco, monospace; font-size: 12px; color: #666; }
        .async-badge { display: inline-block; background: #e8f3ff; color: #0066cc; padding: 2px 8px; border-radius: 4px; font-size: 11px; margin-left: 8px; }
        .modal { display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0, 0, 0, 0.5); z-index: 1000; align-items: center; justify-content: center; }
        .modal.open { display: flex; }
        .modal-content { background: white; border-radius: 12px; width: 92%; max-width: 1100px; max-height: 90vh; overflow-y: auto; padding: 30px; }
        .modal-header { display: flex; justify-content: space-between; margin-bottom: 20px; padding-bottom: 15px; border-bottom: 1px solid #eee; }
        .modal-title { font-size: 20px; font-weight: 600; }
        .modal-close { background: none; border: none; font-size: 24px; cursor: pointer; color: #999; }
        .modal-intro { background: #f0f7ff; border-left: 4px solid #0066cc; padding: 12px 15px; border-radius: 4px; margin-bottom: 20px; font-size: 14px; }
        .upload-area { border: 2px dashed #ddd; border-radius: 8px; padding: 30px; text-align: center; cursor: pointer; background: #fafafa; }
        .upload-area:hover { border-color: #0066cc; background: #f0f7ff; }
        .upload-icon { font-size: 32px; margin-bottom: 12px; }
        input[type="file"] { display: none; }
        .upload-status { margin-top: 20px; padding: 12px; border-radius: 6px; display: none; }
        .upload-status.success { display: block; background: #e8f5e9; color: #2e7d32; }
        .upload-status.error { display: block; background: #ffebee; color: #c62828; }
        .hidden { display: none !important; }
        .trace-viewer { display: none; margin-top: 20px; }
        .trace-viewer.visible { display: block; }
        .trace-layout { display: grid; grid-template-columns: 40% 60%; gap: 16px; min-height: 420px; }
        .trace-left, .trace-right { background: #f9f9f9; border-radius: 8px; padding: 14px; border: 1px solid #eee; }
        .trace-section-title { font-size: 14px; font-weight: 600; margin-bottom: 10px; }
        .observation-table-wrap { max-height: 460px; overflow: auto; background: white; border-radius: 6px; border: 1px solid #eee; }
        .observation-table { width: 100%; border-collapse: collapse; }
        .observation-table thead { background: #f5f5f5; position: sticky; top: 0; z-index: 1; }
        .observation-table th { text-align: left; font-size: 12px; font-weight: 600; color: #555; padding: 10px 12px; border-bottom: 1px solid #e8e8e8; }
        .observation-table td { font-size: 13px; padding: 10px 12px; border-bottom: 1px solid #f0f0f0; }
        .observation-table tbody tr { cursor: pointer; }
        .observation-table tbody tr:hover { background: #f7fbff; }
        .observation-table tbody tr.selected { background: #e8f3ff; }
        .obs-type { display: inline-block; padding: 2px 8px; border-radius: 12px; font-size: 11px; background: #e6e6e6; color: #333; }
        .obs-type.tool { background: #e8f7ef; color: #1f7a44; }
        .obs-type.ai { background: #e8f1ff; color: #1f5fbf; }
        .detail-sections { display: flex; flex-direction: column; gap: 12px; height: 486.5px; overflow-y: auto; }
        .detail-section { background: white; border: 1px solid #eee; border-radius: 6px; padding: 10px; }
        .detail-title { font-size: 12px; font-weight: 600; margin-bottom: 8px; color: #555; text-transform: uppercase; letter-spacing: 0.02em; }
        .detail-pre { margin: 0; font-family: Monaco, monospace; font-size: 12px; line-height: 1.45; white-space: pre-wrap; word-break: break-word; background: #fafafa; border-radius: 4px; padding: 10px; border: 1px solid #f0f0f0; min-height: 56px; max-height: 400px; overflow-y: auto; }
        .modal-footer { display: none; margin-top: 24px; padding-top: 20px; border-top: 1px solid #eee; gap: 12px; justify-content: space-between; }
        .modal-footer.visible { display: flex; }
        .btn { padding: 10px 20px; border-radius: 6px; font-size: 14px; font-weight: 500; cursor: pointer; transition: all 0.2s; border: none; }
        .btn-secondary { background: #f0f0f0; color: #333; }
        .btn-secondary:hover { background: #e0e0e0; }
        .btn-primary { background: #0066cc; color: white; }
        .btn-primary:hover { background: #0052a3; }
        .btn:disabled { opacity: 0.6; cursor: not-allowed; }
        .btn-primary:disabled:hover { background: #0066cc; }
        .btn-secondary:disabled:hover { background: #f0f0f0; }
        .obs-checkbox { width: 18px; height: 18px; cursor: pointer; }
        @media (max-width: 900px) {
          .trace-layout { grid-template-columns: 1fr; }
          .observation-table-wrap { max-height: 260px; }
        }
    </style>
</head>
<body>
    <div class="container">
        <header>
            <h1>Workflow Functions</h1>
            <div class="subtitle">Select a workflow to debug with trace analysis</div>
            <div class="search-box">
                <input type="text" id="searchInput" placeholder="Search by name or path..." autocomplete="off">
                <div class="result-count"><span id="resultCount">0</span> workflows</div>
            </div>
        </header>
        <div class="workflows-list">
            <table class="workflows-table">
                <thead><tr><th style="width: 35%">Function Name</th><th>File Path</th></tr></thead>
                <tbody id="workflowsTableBody"><tr><td colspan="2" style="text-align: center; padding: 40px;">Loading...</td></tr></tbody>
            </table>
        </div>
    </div>
    <div id="traceModal" class="modal">
        <div class="modal-content">
            <div class="modal-header">
                <h2 class="modal-title">Import Trace for Analysis</h2>
                <button class="modal-close" id="closeModal">&times;</button>
            </div>
            <div class="modal-intro"><strong>Debug workflow:</strong> Upload a Langfuse trace JSON to analyze LLM calls and tool invocations.</div>
            <div id="uploadArea" class="upload-area">
                <div class="upload-icon">📤</div>
                <div>Drop trace file here or click to select</div>
                <input type="file" id="traceFile" accept=".json" />
            </div>
            <div id="uploadStatus" class="upload-status"></div>
            <div id="traceViewer" class="trace-viewer">
              <div class="trace-layout">
                <div class="trace-left">
                  <div class="trace-section-title">Observations</div>
                  <div class="observation-table-wrap">
                    <table class="observation-table">
                      <thead id="observationTableHead"><tr><th style="width: 65%;">Name</th><th>Type</th><th>Action</th></tr></thead>
                      <tbody id="observationTableBody"></tbody>
                    </table>
                  </div>
                </div>
                <div class="trace-right">
                  <div id="observationDetail"></div>
                </div>
              </div>
            </div>
            <div id="modalFooter" class="modal-footer">
                <button class="btn btn-secondary" id="changeTraceBtn">Change Trace File</button>
                <button class="btn btn-primary" id="nextBtn">Next</button>
            </div>
        </div>
    </div>
    <script>
        console.log("[Dashboard] Script starting...");
        let allWorkflows = [], codeIndex = {workflows: [], tools: []}, selectedWorkflow = null;
        let currentObservations = [], selectedObservationIndex = -1;
        const tbody = document.getElementById("workflowsTableBody");
        const countEl = document.getElementById("resultCount");
        const modal = document.getElementById("traceModal");
        const uploadArea = document.getElementById("uploadArea");
        const fileInput = document.getElementById("traceFile");
        const modalFooter = document.getElementById("modalFooter");
        const uploadStatus = document.getElementById("uploadStatus");
        const traceViewer = document.getElementById("traceViewer");
        const observationTableBody = document.getElementById("observationTableBody");
        const observationDetail = document.getElementById("observationDetail");
        const modalTitle = document.querySelector(".modal-title");
        console.log("[Dashboard] DOM elements loaded, tbody:", tbody);
        
        let currentStep = 0; // 0=upload, 3=mark, 4=verify, 5=validate
        let checkedObservations = new Set();
        
          document.getElementById("closeModal").onclick = () => {
            modal.classList.remove("open");
            resetTraceModal();
          };
          modal.onclick = (e) => {
            if (e.target === modal) {
              modal.classList.remove("open");
              resetTraceModal();
            }
          };
        
        document.getElementById("changeTraceBtn").onclick = () => {
          if (currentStep === 3) {
            resetTraceModal();
          } else if (currentStep === 4) {
            // Go back to Step 3
            currentStep = 3;
            updateModalTitle();
            updateFooterButtons();
            renderObservationTable();
          }
        };
        
        document.getElementById("nextBtn").onclick = () => {
          if (currentStep === 3) {
            // Validate that at least one checkbox is checked
            if (checkedObservations.size === 0) {
              alert("Please select at least one step to mark as broken");
              return;
            }
            // Move to Step 4
            currentStep = 4;
            updateModalTitle();
            updateFooterButtons();
            renderObservationTable();
          } else if (currentStep === 4) {
            // Move to Step 5
            currentStep = 5;
            updateModalTitle();
            updateFooterButtons();
            renderObservationTable();
            console.log("[Dashboard] Moving to Step 5: Validate updated flow");
            // TODO: Implement Step 5 UI
          }
        };
        
        uploadArea.onclick = () => fileInput.click();
        
        fileInput.onchange = (e) => {
            if (!e.target.files[0]) return;
            const file = e.target.files[0];
            // Always clear file input so same file can be uploaded again
            fileInput.value = "";
            // Clear observations before loading new trace
            resetTraceModal();
            const reader = new FileReader();
            reader.onload = (e) => {
              try {
                const data = JSON.parse(e.target.result);
                uploadStatus.className = "upload-status";
                uploadStatus.textContent = "";
                displayTrace(data);
              } catch (err) {
                uploadArea.classList.remove("hidden");
                traceViewer.classList.remove("visible");
                uploadStatus.className = "upload-status error";
                uploadStatus.textContent = "Invalid JSON";
              }
            };
            reader.readAsText(file);
          };
        
        function displayTrace(data) {
            let obs = [];
            if (Array.isArray(data)) {
                obs = data.filter(o => 
                    (o.type === "GENERATION" || o.type === "TOOL" || o.type === "SPAN") &&
                    (o.input !== null && o.input !== undefined) &&
                    (o.output !== null && o.output !== undefined)
                );
            } else {
                const trace = data.trace || data;
                obs = (data.observations || trace.observations || []).filter(o => 
                    (o.type === "GENERATION" || o.type === "TOOL" || o.type === "SPAN") &&
                    (o.input !== null && o.input !== undefined) &&
                    (o.output !== null && o.output !== undefined)
                );
            }
            // Sort by timestamp ascending
            obs = obs.sort((a, b) => {
                const timeA = new Date(a.startTime || a.createdAt || 0).getTime();
                const timeB = new Date(b.startTime || b.createdAt || 0).getTime();
                return timeA - timeB;
            });
            currentObservations = obs;
            selectedObservationIndex = -1;
            checkedObservations.clear();
            observationDetail.innerHTML = "";
            uploadArea.classList.add("hidden");
            traceViewer.classList.add("visible");
            modalFooter.classList.add("visible");
            currentStep = 3;
            updateModalTitle();
            updateFooterButtons();
            renderObservationTable();
        }

          function renderObservationTable() {
            const obsToRender = currentStep === 4 ? Array.from(checkedObservations).map(idx => currentObservations[idx]) : currentObservations;
            const indices = currentStep === 4 ? Array.from(checkedObservations) : currentObservations.map((_, i) => i);
            
            if (!obsToRender.length) {
              observationTableBody.innerHTML = '<tr><td colspan="3" style="padding: 16px; color: #777;">No observations found.</td></tr>';
              return;
            }

            observationTableBody.innerHTML = obsToRender.map((obs, displayIndex) => {
              const actualIndex = indices[displayIndex];
              const isSelected = actualIndex === selectedObservationIndex;
              const isChecked = checkedObservations.has(actualIndex);
              const name = obs.name || obs.id || ("Observation " + (displayIndex + 1));
              const type = obs.type || "UNKNOWN";
              const typeClass = type === "TOOL" ? "tool" : "ai";
              
              if (currentStep === 3) {
                // Step 3: Mark broken - show checkboxes
                return \`<tr class="\${isSelected ? "selected" : ""}">
                  <td style="width: 40px;"><input type="checkbox" class="obs-checkbox" value="\${actualIndex}" \${isChecked ? "checked" : ""}></td>
                  <td onclick="selectObservation(\${actualIndex})">\${esc(name)}</td>
                  <td><span class="obs-type \${typeClass}">\${esc(type)}</span></td>
                </tr>\`;
              } else if (currentStep === 4) {
                // Step 4: Verify - show rerun button in Action column
                return \`<tr class="\${isSelected ? "selected" : ""}">
                  <td onclick="selectObservation(\${actualIndex})">\${esc(name)}</td>
                  <td><span class="obs-type \${typeClass}">\${esc(type)}</span></td>
                  <td><button class="btn btn-primary rerun-btn" data-index="\${actualIndex}">Rerun</button><span class="rerun-spinner" style="display:none;margin-left:8px;"><span class="spinner"></span></span></td>
                </tr>\`;
              }
            }).join("");
            
            // Add checkbox event listeners for Step 3
            if (currentStep === 3) {
              document.querySelectorAll(".obs-checkbox").forEach(checkbox => {
                checkbox.onchange = (e) => {
                  const idx = parseInt(e.target.value);
                  if (e.target.checked) {
                    checkedObservations.add(idx);
                  } else {
                    checkedObservations.delete(idx);
                  }
                };
              });
            }
          }

          function selectObservation(index) {
            selectedObservationIndex = index;
            renderObservationTable();
            const obs = currentObservations[index];
            const inputText = toDisplayText(obs.input, obs.type);
            const outputText = toDisplayText(obs.output, obs.type);
            const mockFilePath = "/mock/path/relevant-function.ts";

            observationDetail.innerHTML = \`<div class="detail-sections">
              <div class="detail-section">
                <div class="detail-title">File Path</div>
                <pre class="detail-pre">\${esc(mockFilePath)}</pre>
              </div>
              <div class="detail-section">
                <div class="detail-title">Input</div>
                <pre class="detail-pre">\${esc(inputText)}</pre>
              </div>
              <div class="detail-section">
                <div class="detail-title">Output</div>
                <pre class="detail-pre">\${esc(outputText)}</pre>
              </div>
            </div>\`;
          }

          function toDisplayText(value, type) {
            if (value === null || value === undefined || value === "") {
              return "No data";
            }
            if (typeof value === "string") {
              return value;
            }
            if (type === "GENERATION" && value.messages) {
              return JSON.stringify(value.messages, null, 2);
            }
            if (type === "GENERATION" && value.role && value.content) {
              return value.content || "No content";
            }
            try {
              return JSON.stringify(value, null, 2);
            } catch {
              return String(value);
            }
          }

          function resetTraceModal() {
            uploadArea.classList.remove("hidden");
            traceViewer.classList.remove("visible");
            modalFooter.classList.remove("visible");
            uploadStatus.className = "upload-status";
            uploadStatus.textContent = "";
            fileInput.value = "";
            currentObservations = [];
            selectedObservationIndex = -1;
            checkedObservations.clear();
            observationTableBody.innerHTML = "";
            observationDetail.innerHTML = "";
            currentStep = 0;
            updateModalTitle();
          }
          
          function updateModalTitle() {
            const titles = {
              0: "Import Trace for Analysis",
              3: "Step 3: Mark broken step",
              4: "Step 4: Verify your fix",
              5: "Step 5: Validate updated flow with live data"
            };
            modalTitle.textContent = titles[currentStep] || "Import Trace for Analysis";
          }
          
          function updateFooterButtons() {
            const changeBtn = document.getElementById("changeTraceBtn");
            const nextBtn = document.getElementById("nextBtn");
            
            if (currentStep === 3) {
              changeBtn.textContent = "Change Trace File";
              nextBtn.textContent = "Next";
              nextBtn.disabled = false;
            } else if (currentStep === 4) {
              changeBtn.textContent = "Select Different Steps";
              nextBtn.textContent = "Fix Works as Expected";
              nextBtn.disabled = false;
            } else if (currentStep === 5) {
              // Step 5 - buttons can be hidden or disabled
              changeBtn.style.display = "none";
              nextBtn.style.display = "none";
            }
          }
        
        fetch("/api/workflows").then(r => r.json()).then(d => {
            console.log("[Dashboard] Workflows fetched:", d);
            allWorkflows = d.workflows || [];
            console.log("[Dashboard] Calling render with", allWorkflows.length, "workflows");
            render();
        }).catch(err => {
            console.error("Failed to fetch workflows:", err);
            tbody.innerHTML = '<tr><td colspan="2" style="text-align: center; padding: 40px; color: #c62828;">Error loading workflows</td></tr>';
        });
        
        fetch("/api/code-index").then(r => r.json()).then(d => {
            codeIndex = d;
            console.log("Code index:", d);
        }).catch(err => {
            console.error("Failed to fetch code index:", err);
        });
        
        function render(search = "") {
            console.log("[Dashboard] render() called with search:", search, "workflows:", allWorkflows.length);
            const filtered = search ? allWorkflows.filter(w => 
                w.name.toLowerCase().includes(search.toLowerCase()) || 
                w.filePath.toLowerCase().includes(search.toLowerCase())
            ) : allWorkflows;
            countEl.textContent = filtered.length;
            console.log("[Dashboard] Rendering", filtered.length, "workflows");
            tbody.innerHTML = filtered.length ? filtered.map((w, i) => \`<tr onclick="showModal(\${i},'\${search}')">
                <td><div class="workflow-name-cell">\${esc(w.name)}\${w.isAsync ? '<span class="async-badge">async</span>' : ""}</div></td>
                <td><div class="workflow-path-cell">\${esc(w.filePath)}</div></td>
            </tr>\`).join("") : \`<tr><td colspan="2" style="text-align: center; padding: 40px; color: #999;">No workflows found</td></tr>\`;
            console.log("[Dashboard] tbody updated");
        }
        
        function showModal(index, search) {
            const filtered = search ? allWorkflows.filter(w => 
                w.name.toLowerCase().includes(search.toLowerCase()) || 
                w.filePath.toLowerCase().includes(search.toLowerCase())
            ) : allWorkflows;
            selectedWorkflow = filtered[index];
            modal.classList.add("open");
          resetTraceModal();
        }
        
        window.showModal = showModal;
        window.selectObservation = selectObservation;
        function esc(t) { const d = document.createElement("div"); d.textContent = t; return d.innerHTML; }
        window.esc = esc;
        
        document.getElementById("searchInput").oninput = (e) => render(e.target.value);
    </script>
</body>
</html>`
}

/**
 * Start the dashboard server
 */
export async function startDashboardServer(
  cwd: string,
  options: DashboardServerOptions = {}
): Promise<DashboardServer> {
  const port = options.port ?? 4573
  const autoOpen = options.autoOpen ?? true
  
  // Scan workflows and tools once at startup
  const workflows = await scanWorkflows(cwd)
  const tools = await scanTools(cwd)
  const codeIndex: CodeIndex = { workflows, tools }
  
  console.log(`[elasticdash] Scanned: ${workflows.length} workflows, ${tools.length} tools`)
  
  // Create HTTP server
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host}`)
    
    if (url.pathname === '/api/workflows') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ workflows }))
    } else if (url.pathname === '/api/code-index') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(codeIndex))
    } else {
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end(getDashboardHtml())
    }
  })
  
  // Start listening
  await new Promise<void>((resolve, reject) => {
    server.listen(port, () => resolve())
    server.on('error', reject)
  })
  
  const url = `http://localhost:${port}`
  
  // Auto-open browser
  if (autoOpen) {
    openBrowser(url)
  }
  
  return {
    url,
    async close() {
      return new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) reject(err)
          else resolve()
        })
      })
    },
  }
}
