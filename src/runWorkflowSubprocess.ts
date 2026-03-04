import { spawn } from 'child_process';
import { join } from 'path';
import { Readable } from 'stream';

/**
 * Run workflow logic in a subprocess using the workflow-runner-worker (fd3 IPC).
 * This utility is designed for use in Next.js API routes or any parent process.
 *
 * @param {object} input - The workflow input (requestBody, userToken, testCaseId, testCaseRunRecordId, etc)
 * @returns {Promise<any>} - Resolves with the result from the worker, or throws on error.
 *
 * Usage (in your Next.js API route):
 *   import { runWorkflowInSubprocess } from './src/runWorkflowSubprocess';
 *   const result = await runWorkflowInSubprocess({ ... });
 *   return NextResponse.json(result);
 */
export async function runWorkflowInSubprocess(input: Record<string, any>): Promise<any> {
  return new Promise((resolve, reject) => {
    // Path to the workflow worker entry point
    const workerPath = join(process.cwd(), 'src', 'workflow-runner-worker.ts');

    // Spawn the worker as a subprocess with fd3 pipe
    const child = spawn(
      process.execPath,
      [workerPath],
      {
        stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
        env: { ...process.env },
      }
    );

    // Write the input as JSON to the worker's stdin
    child.stdin.write(JSON.stringify(input));
    child.stdin.end();

    let resultData = '';
    let errorData = '';

    // Read result from fd3 (child.stdio[3])
    if (child.stdio[3] && child.stdio[3] instanceof Readable) {
      child.stdio[3].setEncoding('utf8');
      child.stdio[3].on('data', (chunk) => {
        resultData += chunk;
      });
    }

    // Optionally, collect logs from stdout/stderr for debugging
    child.stdout?.on('data', (chunk) => {
      // Optionally log or buffer
    });
    child.stderr?.on('data', (chunk) => {
      errorData += chunk;
    });

    child.on('error', (err) => {
      reject(err);
    });

    child.on('close', (code) => {
      if (resultData) {
        try {
          const parsed = JSON.parse(resultData);
          resolve(parsed);
        } catch (err) {
          reject(new Error('Failed to parse worker result: ' + err));
        }
      } else if (errorData) {
        reject(new Error('Worker error: ' + errorData));
      } else {
        reject(new Error('Worker exited with code ' + code + ' and no result.'));
      }
    });
  });
}
