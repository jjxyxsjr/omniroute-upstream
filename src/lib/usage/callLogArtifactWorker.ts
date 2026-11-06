import { parentPort } from "node:worker_threads";

import { protectErrorPayloadForLog, protectPayloadForLog } from "../logPayloads.ts";
import {
  writeCallArtifact,
  type CallLogArtifact,
  type CallLogArtifactWriteResult,
} from "./callLogArtifacts.ts";

/**
 * nnd.42 ① (#212): sanitize the big bodies HERE, off the request-serving
 * main thread. The queued artifact carries the RAW request/response bodies
 * (one structured clone in postMessage is the only main-thread cost); this
 * worker runs the same protect chain (clone + 4 sanitize passes) that used
 * to freeze the event loop for up to 120s under 650k-token sessions, then
 * serializes. Byte-identical output, zero fidelity loss. Failed responses
 * keep their stricter protectErrorPayloadForLog projection, keyed off
 * summary.status exactly like the old main-thread branch. Direct synchronous
 * callers of writeCallArtifact (db legacy migration, usage migration) pass
 * ALREADY-sanitized payloads and do not pass through here — no double pass.
 */
function protectArtifactBodiesInPlace(artifact: CallLogArtifact): void {
  if (artifact.requestBody !== null && artifact.requestBody !== undefined) {
    artifact.requestBody = protectPayloadForLog(artifact.requestBody);
  }
  const failedResponse = Number(artifact.summary?.status) >= 400;
  if (artifact.responseBody !== null && artifact.responseBody !== undefined) {
    artifact.responseBody = failedResponse
      ? protectErrorPayloadForLog(artifact.responseBody)
      : protectPayloadForLog(artifact.responseBody);
  }
}

type WriteRequest = {
  id: number;
  artifact: CallLogArtifact;
  environment: {
    pipelineMaxSizeKb?: string;
    chatDebugFile?: string;
    appLogLevel?: string;
    dataDir?: string;
  };
};

type WriteReply = {
  id: number;
  result: CallLogArtifactWriteResult | null;
};

function applyWriteEnvironment(environment: WriteRequest["environment"]): void {
  const values = {
    CALL_LOG_PIPELINE_MAX_SIZE_KB: environment.pipelineMaxSizeKb,
    CHAT_DEBUG_FILE: environment.chatDebugFile,
    APP_LOG_LEVEL: environment.appLogLevel,
    // The worker resolves its paths lazily like the parent; pin it to the
    // parent's resolved dir so both executors share one target.
    DATA_DIR: environment.dataDir,
  };
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

parentPort?.on("message", (request: WriteRequest) => {
  const originalConsoleError = console.error;
  let result: CallLogArtifactWriteResult | null = null;

  try {
    // The writer reads these options lazily; mirror the caller's per-write environment snapshot.
    applyWriteEnvironment(request.environment);
    // nnd.42 ①: sanitize raw bodies here (see protectArtifactBodiesInPlace).
    protectArtifactBodiesInPlace(request.artifact);
    // writeCallArtifact's legacy error includes filesystem paths. Keep worker failures generic.
    console.error = () => {};
    result = writeCallArtifact(request.artifact);
  } catch {
    result = null;
  } finally {
    console.error = originalConsoleError;
  }

  try {
    parentPort?.postMessage({ id: request.id, result } satisfies WriteReply);
  } catch {
    parentPort?.postMessage({ id: request.id, result: null } satisfies WriteReply);
  }
});
