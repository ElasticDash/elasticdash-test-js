const { parentPort, workerData } = require('worker_threads');
const { fileURLToPath } = require('url');

(async () => {
  try {
    const url = workerData.url;
    console.log(`Worker processing: ${url}`);

    // url is already a file:// URL — convert directly to a filesystem path
    const filePath = url.startsWith('file://') ? fileURLToPath(url) : url;
    console.log(`Resolved path: ${filePath}`);

    // Notify parent that the task is complete
    parentPort.postMessage(`Cache cleared for ${url}`);
  } catch (error) {
    console.error(`Worker encountered an error:`, error);
    parentPort.postMessage(`Error: ${error.message}`);
  }
})();